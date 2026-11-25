/**
 * 统一 HTTP 客户端：默认请求头、超时、重试与错误归一。
 *
 * 只用 Node 18+ 自带的全局 `fetch`（零外部依赖）；Node 的 fetch 已经解了
 * gzip/deflate，所以这里**不做任何手工解压**。弹幕接口需要 `accept-encoding:
 * identity`，由 API 层在 headers 里显式覆盖。
 *
 * @module @local/bilibili/http
 */

import { BiliError, CODES } from './errors.js';

/** 默认桌面 Chrome UA（B 站对空 UA/爬虫 UA 更容易风控）。 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 默认 Referer：B 站的播放/弹幕/图片接口都校验它。 */
export const DEFAULT_REFERER = 'https://www.bilibili.com/';

/** 默认语言头。 */
export const DEFAULT_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9';

/** 网络类错误最多等多久再重试（毫秒上限）。 */
const MAX_BACKOFF_MS = 2000;

/**
 * 默认睡眠。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 睡完 resolve。
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 造一个状态码错误。
 * @param {number} status - HTTP 状态码。
 * @param {string} url - 请求地址。
 * @param {string} snippet - 响应体前 200 字符（可能为空）。
 * @param {unknown} cause - 原始错误。
 * @returns {BiliError} 错误。
 */
function httpError(status, url, snippet, cause) {
  /** @type {string} */
  let hint = '';
  /** @type {boolean} */
  let retryable = false;
  if (status === 412) {
    hint = '请求被 B 站风控拦截：关闭代理/VPN，等 1 分钟再试；持续失败说明本机 IP 被临时限制。';
  } else if (status === 429) {
    hint = '请求过于频繁：等 10–30 秒再重试，不要连续刷。';
    retryable = true;
  } else if (status === 403) {
    hint = 'B 站拒绝访问（可能需要登录态、Referer 或链接已过期）。';
  } else if (status === 404) {
    hint = '接口或资源不存在（可能已改版/删除，或区域限制）。';
  } else if (status >= 500) {
    hint = 'B 站服务端错误：稍后重试。';
    retryable = true;
  }
  const suffix = snippet === '' ? '' : `：${snippet}`;
  return new BiliError(`B 站返回 HTTP ${status}（${url}）${suffix}`, {
    code: CODES.HTTP,
    hint,
    retryable,
    cause,
    status,
  });
}

/**
 * 造一个网络错误。
 * @param {unknown} cause - fetch 抛出的错误。
 * @param {string} url - 请求地址。
 * @returns {BiliError} 错误。
 */
function networkError(cause, url) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new BiliError(`访问 B 站失败（${url}）：${detail}`, {
    code: CODES.NETWORK,
    hint: '检查网络/代理/DNS；B 站在部分网络环境下会拒绝直连。',
    retryable: true,
    cause,
  });
}

/**
 * 造一个超时错误。
 * @param {number} timeoutMs - 超时毫秒。
 * @param {string} url - 请求地址。
 * @param {unknown} cause - 原始错误。
 * @returns {BiliError} 错误。
 */
function timeoutError(timeoutMs, url, cause) {
  return new BiliError(`请求 B 站超时（${timeoutMs}ms，${url}）`, {
    code: CODES.TIMEOUT,
    hint: '网络慢或 B 站响应慢：稍后重试，或在插件配置里调大 requestTimeoutMs。',
    retryable: true,
    cause,
  });
}

/**
 * 造一个取消错误（保留原错，方便上层区分「用户取消」与「超时」）。
 * @param {AbortSignal | undefined} signal - 调用方信号。
 * @param {unknown} cause - fetch 抛出的错误。
 * @returns {Error} 取消错误。
 */
function abortError(signal, cause) {
  if (cause instanceof Error && cause.name === 'AbortError') return cause;
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('请求已取消', 'AbortError');
}

/**
 * 造 HTTP 客户端。
 * @param {{ timeoutMs?: number, userAgent?: string, fetchImpl?: typeof fetch,
 *   logger?: { warn?: Function }, sleep?: (ms: number) => Promise<void>, now?: () => number }} [options] - 依赖。
 * @returns {{
 *   getJson: (url: string, options?: { headers?: Record<string, string>, signal?: AbortSignal, retries?: number }) => Promise<any>,
 *   getText: (url: string, options?: { headers?: Record<string, string>, signal?: AbortSignal, retries?: number }) => Promise<string>,
 *   getBytes: (url: string, options?: { headers?: Record<string, string>, signal?: AbortSignal }) => Promise<Uint8Array>,
 *   open: (url: string, options?: { headers?: Record<string, string>, signal?: AbortSignal }) => Promise<{ status: number, headers: Headers, body: ReadableStream<Uint8Array> | null, contentLength?: number, url?: string }>,
 *   readonly userAgent: string }} 客户端。
 */
export function createHttpClient(options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('当前运行环境没有可用的 fetch：需要 Node 18 及以上。');
  }
  const rawTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.trunc(rawTimeout) : 15000;
  const userAgent = typeof options.userAgent === 'string' && options.userAgent.trim() !== ''
    ? options.userAgent.trim()
    : DEFAULT_USER_AGENT;
  const logger = options.logger;
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;

  /**
   * 记一条告警（日志坏掉不影响请求）。
   * @param {string} message - 文本。
   */
  function warn(message) {
    try {
      logger?.warn?.(message);
    } catch {
      // 忽略。
    }
  }

  /**
   * 合并请求头：默认头打底，调用方覆盖（键大小写不敏感）。
   * @param {Record<string, string> | undefined} headers - 调用方头。
   * @returns {Record<string, string>} 合并后的头。
   */
  function buildHeaders(headers) {
    /** @type {Record<string, string>} */
    const merged = {
      'user-agent': userAgent,
      referer: DEFAULT_REFERER,
      'accept-language': DEFAULT_ACCEPT_LANGUAGE,
    };
    if (headers !== null && typeof headers === 'object') {
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined || value === null) continue;
        merged[String(key).toLowerCase()] = String(value);
      }
    }
    return merged;
  }

  /**
   * 发一次请求（带超时与取消联动），并把非 2xx 归一成 `BiliError`。
   * @param {string} url - 请求地址。
   * @param {{ headers?: Record<string, string>, signal?: AbortSignal }} requestOptions - 选项。
   * @returns {Promise<Response>} 响应。
   */
  async function once(url, requestOptions) {
    const external = requestOptions.signal;
    if (external !== undefined && external.aborted) throw abortError(external, undefined);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (external !== undefined) external.addEventListener('abort', onExternalAbort, { once: true });

    /** @type {Response} */
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: buildHeaders(requestOptions.headers),
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (cause) {
      if (external !== undefined && external.aborted) throw abortError(external, cause);
      if (timedOut) throw timeoutError(timeoutMs, url, cause);
      throw networkError(cause, url);
    } finally {
      clearTimeout(timer);
      if (external !== undefined) external.removeEventListener('abort', onExternalAbort);
    }

    const status = typeof response.status === 'number' ? response.status : 0;
    if (status < 200 || status >= 300) {
      /** @type {string} */
      let snippet = '';
      try {
        const text = await response.text();
        snippet = typeof text === 'string' ? text.replace(/\s+/g, ' ').slice(0, 200) : '';
      } catch {
        // 读错误响应体失败无所谓。
      }
      throw httpError(status, url, snippet, undefined);
    }
    return response;
  }

  /**
   * 带重试地发请求：网络错误/超时/5xx/429 重试，其余直接抛。
   * @param {string} url - 地址。
   * @param {{ headers?: Record<string, string>, signal?: AbortSignal, retries?: number }} requestOptions - 选项。
   * @returns {Promise<Response>} 响应。
   */
  async function request(url, requestOptions) {
    const rawRetries = Number(requestOptions.retries);
    const retries = Number.isFinite(rawRetries) && rawRetries > 0 ? Math.trunc(rawRetries) : 0;
    const attempts = retries + 1;
    /** @type {unknown} */
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await once(url, requestOptions);
      } catch (error) {
        lastError = error;
        const cancelled = requestOptions.signal !== undefined && requestOptions.signal.aborted;
        const retryable = error instanceof BiliError && error.retryable;
        if (cancelled || !retryable || attempt + 1 >= attempts) throw error;
        const delay = Math.min(MAX_BACKOFF_MS, 300 * 2 ** attempt);
        warn(`[bilibili] 请求失败，${delay}ms 后重试（第 ${attempt + 1}/${retries} 次）：${error instanceof Error ? error.message : String(error)}`);
        await sleep(delay);
      }
    }
    throw lastError;
  }

  return {
    /**
     * GET 一个 JSON 接口。
     * @param {string} url - 地址。
     * @param {{ headers?: Record<string, string>, signal?: AbortSignal, retries?: number }} [getOptions] - 选项。
     * @returns {Promise<any>} 解析后的 JSON。
     * @throws {BiliError} 网络/超时/HTTP/JSON 解析失败时。
     */
    async getJson(url, getOptions = {}) {
      const response = await request(url, {
        headers: { accept: 'application/json, text/plain, */*', ...getOptions.headers },
        signal: getOptions.signal,
        retries: getOptions.retries ?? 2,
      });
      /** @type {string} */
      let text;
      try {
        text = await response.text();
      } catch (cause) {
        throw new BiliError(`读取 B 站响应失败（${url}）`, {
          code: CODES.NETWORK,
          hint: '连接在读取响应体时中断：稍后重试。',
          retryable: true,
          cause,
        });
      }
      try {
        return JSON.parse(text);
      } catch (cause) {
        throw new BiliError(`B 站返回的不是合法 JSON（${url}）`, {
          code: CODES.API,
          hint: '接口可能被风控拦截或已改版；稍后重试，或先 bili_status 看状态。',
          cause,
        });
      }
    },

    /**
     * GET 一个 JSON 接口并连同响应头一起返回。
     *
     * 扫码登录的 Cookie 现在由轮询响应的 `Set-Cookie` 下发（`data.url` 可能为空），
     * 所以调用方需要拿到响应头。
     * @param {string} url - 地址。
     * @param {{ headers?: Record<string, string>, signal?: AbortSignal, retries?: number }} [getOptions] - 选项。
     * @returns {Promise<{ json: any, headers: Headers, status: number }>} JSON、响应头与状态码。
     * @throws {BiliError} 网络/超时/HTTP/JSON 解析失败时。
     */
    async getJsonDetailed(url, getOptions = {}) {
      const response = await request(url, {
        headers: { accept: 'application/json, text/plain, */*', ...getOptions.headers },
        signal: getOptions.signal,
        retries: getOptions.retries ?? 0,
      });
      /** @type {string} */
      let text;
      try {
        text = await response.text();
      } catch (cause) {
        throw new BiliError(`读取 B 站响应失败（${url}）`, {
          code: CODES.NETWORK,
          hint: '连接在读取响应体时中断：稍后重试。',
          retryable: true,
          cause,
        });
      }
      /** @type {any} */
      let json;
      try {
        json = JSON.parse(text);
      } catch (cause) {
        throw new BiliError(`B 站返回的不是合法 JSON（${url}）`, {
          code: CODES.API,
          hint: '接口可能被风控拦截或已改版；稍后重试，或先 bili_status 看状态。',
          cause,
        });
      }
      return { json, headers: response.headers, status: response.status };
    },

    /**
     * GET 一段文本。
     * @param {string} url - 地址。
     * @param {{ headers?: Record<string, string>, signal?: AbortSignal, retries?: number }} [getOptions] - 选项。
     * @returns {Promise<string>} 文本。
     * @throws {BiliError} 网络/超时/HTTP 失败时。
     */
    async getText(url, getOptions = {}) {
      const response = await request(url, {
        headers: { accept: 'text/html,application/xhtml+xml,text/plain,*/*', ...getOptions.headers },
        signal: getOptions.signal,
        retries: getOptions.retries ?? 1,
      });
      try {
        return await response.text();
      } catch (cause) {
        throw new BiliError(`读取 B 站响应失败（${url}）`, {
          code: CODES.NETWORK,
          hint: '连接在读取响应体时中断：稍后重试。',
          retryable: true,
          cause,
        });
      }
    },

    /**
     * GET 原始字节（弹幕 protobuf、图片、下载分片）。
     * @param {string} url - 地址。
     * @param {{ headers?: Record<string, string>, signal?: AbortSignal }} [getOptions] - 选项。
     * @returns {Promise<Uint8Array>} 字节。
     * @throws {BiliError} 网络/超时/HTTP 失败时。
     */
    async getBytes(url, getOptions = {}) {
      const response = await request(url, {
        headers: getOptions.headers,
        signal: getOptions.signal,
        retries: 0,
      });
      let buffer;
      try {
        buffer = await response.arrayBuffer();
      } catch (cause) {
        throw new BiliError(`读取 B 站响应失败（${url}）`, {
          code: CODES.NETWORK,
          hint: '连接在读取响应体时中断：稍后重试。',
          retryable: true,
          cause,
        });
      }
      return new Uint8Array(buffer);
    },

    /**
     * 打开一个流式响应（下载视频分片用）。
     * @param {string} url - 地址。
     * @param {{ headers?: Record<string, string>, signal?: AbortSignal }} [openOptions] - 选项。
     * @returns {Promise<{ status: number, headers: Headers, body: ReadableStream<Uint8Array> | null, contentLength?: number, url?: string }>} 响应。
     * @throws {BiliError} 网络/超时/非 2xx 时。
     */
    async open(url, openOptions = {}) {
      const response = await request(url, {
        headers: openOptions.headers,
        signal: openOptions.signal,
        retries: 0,
      });
      const headerValue = typeof response.headers?.get === 'function' ? response.headers.get('content-length') : null;
      const contentLength = headerValue === null || headerValue === undefined ? undefined : Number(headerValue);
      return {
        status: typeof response.status === 'number' ? response.status : 200,
        headers: response.headers,
        body: response.body ?? null,
        contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
        // 附加字段：b23.tv 短链跳转后从这里拿到最终地址（契约 §5 四个字段之外多给一个）。
        url: typeof response.url === 'string' ? response.url : '',
      };
    },

    /** 实际使用的 User-Agent。 */
    get userAgent() {
      return userAgent;
    },
  };
}
