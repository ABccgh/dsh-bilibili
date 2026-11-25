/**
 * 面板取数路由：`/dsh-bilibili/api`。
 *
 * 侧栏「B 站」面板需要浏览热搜、搜索与视频详情，但浏览器不能直接请求 B 站
 * （CORS + 风控 + Cookie 都在 Host 侧）。这里注册一个**只读公开**的同源路由：
 * 只走 `api.js` 的公开方法，绝不返回 Cookie/个人数据；图片走严格 allow-list 的代理，
 * 避免 hdslb 防盗链与页面 CSP 的差异。
 *
 * 路由本身没有鉴权（Host 的 `webServer` 不做全站鉴权），所以这里的暴露面必须自己控制：
 * - 只接受 GET/HEAD（由 webServer 保证）；
 * - 只暴露 status/hot/search/video/image 五个路径；
 * - 所有参数做长度与格式校验；
 * - 图片只允许 https + `*.hdslb.com/bfs/*`，上限 5 MiB。
 *
 * @module @local/bilibili/route
 */

import { BiliError, CODES, isBiliError } from './errors.js';
import { resolveDownloadRoot } from './paths.js';

/** 路由前缀（与 `lib/index.js` 的 `PANEL_ROUTE` 一致）。 */
export const PANEL_ROUTE_PREFIX = '/dsh-bilibili/api';

/** 图片代理允许的主机后缀。 */
const IMAGE_HOST_SUFFIX = '.hdslb.com';

/** 图片代理的体积上限（5 MiB）。 */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** 搜索类型白名单。 */
const SEARCH_TYPES = new Set(['video', 'user', 'bangumi', 'live', 'article']);

/** BV 号格式。 */
const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;

/**
 * 造 JSON 响应。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} payload - JSON 负载。
 * @param {boolean} [headOnly] - 只返回头部（HEAD 请求）。
 * @returns {Response} 响应。
 */
function jsonResponse(status, payload, headOnly = false) {
  const body = JSON.stringify(payload);
  return new Response(headOnly ? null : body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-length': String(Buffer.byteLength(body, 'utf8')),
    },
  });
}

/**
 * 把错误渲染成面板能读的响应。
 * @param {unknown} error - 任意错误。
 * @param {boolean} headOnly - 是否 HEAD。
 * @returns {Response} 响应。
 */
function errorResponse(error, headOnly) {
  if (isBiliError(error)) {
    const status = error.code === CODES.INVALID_ARGUMENT ? 400 : 502;
    return jsonResponse(status, { ok: false, error: { code: error.code, message: error.message, hint: error.hint } }, headOnly);
  }
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse(502, { ok: false, error: { code: CODES.INTERNAL, message, hint: '' } }, headOnly);
}

/**
 * 解析整数查询参数。
 * @param {URLSearchParams} params - 查询串。
 * @param {string} name - 参数名。
 * @param {number} fallback - 默认值。
 * @param {{ min?: number, max?: number }} [bounds] - 上下限。
 * @returns {number} 结果。
 */
function intParam(params, name, fallback, bounds = {}) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new BiliError(`参数 ${name} 必须是整数。`, { code: CODES.INVALID_ARGUMENT });
  const min = bounds.min ?? 1;
  const max = bounds.max ?? Number.MAX_SAFE_INTEGER;
  if (parsed < min || parsed > max) {
    throw new BiliError(`参数 ${name} 必须在 ${min}–${max} 之间。`, { code: CODES.INVALID_ARGUMENT });
  }
  return parsed;
}

/**
 * 校验并归一图片地址。
 * @param {string} raw - `u` 参数（可能已被 encode）。
 * @returns {URL} 合法 URL。
 * @throws {BiliError} 非法时。
 */
function imageUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BiliError('图片地址不是合法 URL。', { code: CODES.INVALID_ARGUMENT });
  }
  if (parsed.protocol !== 'https:') {
    throw new BiliError('图片地址必须是 https。', { code: CODES.INVALID_ARGUMENT });
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith(IMAGE_HOST_SUFFIX) && host !== 'hdslb.com') {
    throw new BiliError(`图片主机不在允许列表：${host}`, { code: CODES.INVALID_ARGUMENT });
  }
  if (!parsed.pathname.startsWith('/bfs/')) {
    throw new BiliError('只允许 /bfs/ 路径下的图片。', { code: CODES.INVALID_ARGUMENT });
  }
  return parsed;
}

/**
 * 造面板路由的 `WebResource`。
 * @param {{ api: object, config: object, logger?: object, ffmpeg?: object, version: string,
 *   now?: () => number, fetchImpl?: typeof fetch }} options - 依赖。
 * @returns {(request: Request) => Promise<Response>} 资源函数。
 */
export function createPanelResource(options) {
  const { api, config, logger, ffmpeg, version } = options;
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttl = typeof config?.cacheTtlMs === 'number' ? config.cacheTtlMs : 60000;

  /** @type {Map<string, { at: number, promise: Promise<any> }>} */
  const cache = new Map();
  /** @type {Map<string, { at: number, body: Uint8Array, type: string }>} */
  const imageCache = new Map();

  /**
   * 带 TTL 的缓存执行器（并发请求共享同一次 Promise）。
   * @param {string} key - 缓存键。
   * @param {() => Promise<any>} producer - 生产者。
   * @returns {Promise<any>} 结果。
   */
  function cached(key, producer) {
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at < ttl) return hit.promise;
    const entry = { at: now(), promise: Promise.resolve().then(producer) };
    cache.set(key, entry);
    entry.promise.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    return entry.promise;
  }

  /**
   * 处理 `/image`。
   * @param {URL} url - 请求 URL。
   * @param {boolean} headOnly - 是否 HEAD。
   * @returns {Promise<Response>} 响应。
   */
  async function handleImage(url, headOnly) {
    const raw = url.searchParams.get('u');
    if (raw === null || raw.trim() === '') {
      throw new BiliError('缺少图片地址参数 u。', { code: CODES.INVALID_ARGUMENT });
    }
    const target = imageUrl(raw);
    const key = target.toString();
    const hit = imageCache.get(key);
    if (hit !== undefined && now() - hit.at < 3600000) {
      return new Response(headOnly ? null : hit.body, {
        status: 200,
        headers: {
          'content-type': hit.type,
          'content-length': String(hit.body.length),
          'cache-control': 'public, max-age=3600',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    const upstream = await fetchImpl(target.toString(), {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        referer: 'https://www.bilibili.com/',
      },
    });
    if (!upstream.ok) {
      throw new BiliError(`图片下载失败（HTTP ${upstream.status}）。`, { code: CODES.HTTP });
    }
    const declared = upstream.headers.get('content-length');
    if (declared !== null && Number(declared) > IMAGE_MAX_BYTES) {
      throw new BiliError('图片超过 5 MiB 上限。', { code: CODES.INVALID_ARGUMENT });
    }
    const buffer = new Uint8Array(await upstream.arrayBuffer());
    if (buffer.length > IMAGE_MAX_BYTES) {
      throw new BiliError('图片超过 5 MiB 上限。', { code: CODES.INVALID_ARGUMENT });
    }
    const type = upstream.headers.get('content-type') ?? 'image/jpeg';
    if (!type.startsWith('image/')) {
      throw new BiliError(`上游返回的不是图片（${type}）。`, { code: CODES.API });
    }
    imageCache.set(key, { at: now(), body: buffer, type });
    if (imageCache.size > 200) {
      // 简单容量控制：删最早的一半。
      const keys = [...imageCache.keys()].slice(0, 100);
      for (const stale of keys) imageCache.delete(stale);
    }
    return new Response(headOnly ? null : buffer, {
      status: 200,
      headers: {
        'content-type': type,
        'content-length': String(buffer.byteLength),
        'cache-control': 'public, max-age=3600',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  /**
   * 路由资源函数。
   * @param {Request} request - Fetch Request。
   * @returns {Promise<Response>} 响应。
   */
  return async function resource(request) {
    const headOnly = request.method === 'HEAD';
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return jsonResponse(400, { ok: false, error: { code: CODES.INVALID_ARGUMENT, message: 'URL 无法解析', hint: '' } }, headOnly);
    }
    const path = url.pathname.startsWith(PANEL_ROUTE_PREFIX)
      ? url.pathname.slice(PANEL_ROUTE_PREFIX.length) || '/'
      : url.pathname;

    try {
      if (path === '/image') return await handleImage(url, headOnly);

      if (path === '/status') {
        const data = await cached('status', async () => {
          const status = await api.status();
          const probe = ffmpeg === undefined ? undefined : await ffmpeg.detect();
          return {
            version,
            loggedIn: status.loggedIn === true,
            uname: status.user?.uname,
            level: status.user?.level,
            ffmpeg: probe === undefined
              ? { available: false }
              : { available: probe.available === true, version: probe.version },
            downloadDir: resolveDownloadRoot(config?.downloadDir ?? ''),
          };
        });
        return jsonResponse(200, { ok: true, data }, headOnly);
      }

      if (path === '/hot') {
        const limit = intParam(url.searchParams, 'limit', Math.min(20, config?.maxListedItems ?? 20), { min: 1, max: 50 });
        const data = await cached(`hot:${limit}`, async () => {
          const result = await api.hotwords({ limit });
          return { items: (result.items ?? []).slice(0, limit) };
        });
        return jsonResponse(200, { ok: true, data }, headOnly);
      }

      if (path === '/search') {
        const keyword = (url.searchParams.get('keyword') ?? '').trim();
        if (keyword === '') throw new BiliError('缺少 keyword 参数。', { code: CODES.INVALID_ARGUMENT });
        if (keyword.length > 100) throw new BiliError('keyword 不能超过 100 个字符。', { code: CODES.INVALID_ARGUMENT });
        const type = url.searchParams.get('type') ?? 'video';
        if (!SEARCH_TYPES.has(type)) {
          throw new BiliError(`type 只能是 ${[...SEARCH_TYPES].join('、')}。`, { code: CODES.INVALID_ARGUMENT });
        }
        const page = intParam(url.searchParams, 'page', 1, { min: 1, max: 50 });
        const pageSize = Math.min(20, config?.maxListedItems ?? 20);
        const data = await cached(`search:${type}:${page}:${keyword}`, async () => {
          const result = await api.search({ keyword, type, page, pageSize });
          return { keyword, type, page, hasMore: result.hasMore === true, items: result.items ?? [] };
        });
        return jsonResponse(200, { ok: true, data }, headOnly);
      }

      if (path === '/video') {
        const bvid = (url.searchParams.get('bvid') ?? '').trim();
        if (!BVID_PATTERN.test(bvid)) {
          throw new BiliError('bvid 必须是 BV 号（如 BV1GJ411x7h7）。', { code: CODES.INVALID_ARGUMENT });
        }
        const data = await cached(`video:${bvid}`, async () => {
          const result = await api.video({ target: bvid });
          return { video: result.video, parts: result.parts ?? [] };
        });
        return jsonResponse(200, { ok: true, data }, headOnly);
      }

      return jsonResponse(404, { ok: false, error: { code: CODES.NOT_FOUND, message: `未知路径 ${path}`, hint: '可用：/status /hot /search /video /image' } }, headOnly);
    } catch (error) {
      try {
        logger?.warn?.(`[bilibili] 面板路由失败：${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // 忽略。
      }
      return errorResponse(error, headOnly);
    }
  };
}
