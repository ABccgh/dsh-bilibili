/**
 * App 端接口：签名（`appkey`/`ts`/`sign`）与两个必须走 App 域名的端点。
 *
 * 为什么绕到 `app.bilibili.com`：App 的搜索与 UP 主投稿列表不校验 WBI、
 * 风控也明显宽松于 Web 端，是当前最稳的取数入口（Web 搜索在不少网络环境直接 -412）。
 *
 * @module @local/bilibili/appapi
 */

import { createHash } from 'node:crypto';

import { fromApiCode, invalidArgument } from './errors.js';

/** 两个平台固定的 appkey/appsec 与设备参数。 */
export const APP_KEYS = {
  android: {
    appkey: '1d8b6e7d45233436',
    appsec: '560c52ccd288fed045859ed18b8e951f',
    mobi_app: 'android',
    platform: 'android',
    build: '7420300',
  },
  ios: {
    appkey: '27eb53fc9058f8c3',
    appsec: 'c2ed53a74eeefe3cf99fbd01d8c9c375',
    mobi_app: 'iphone',
    platform: 'ios',
    build: '7420300',
  },
};

/** App 搜索接口。 */
const SEARCH_URL = 'https://app.bilibili.com/x/v2/search';

/** App UP 主投稿列表接口（iOS 参数最宽松）。 */
const SPACE_ARCHIVE_URL = 'https://app.bilibili.com/x/v2/space/archive';

/**
 * 生成 App 签名 query。
 *
 * 纯函数：参数按 key 排序，`key=encodeURIComponent(value)`，自动补
 * `appkey` 与 `ts`（已有则以调用方为准），最后追加
 * `sign=md5(query + appsec)`。
 * @param {Record<string, unknown>} params - 业务参数。
 * @param {{ appkey: string, appsec: string }} appKey - `APP_KEYS` 里的一项。
 * @param {number} ts - 秒级时间戳。
 * @returns {string} 完整 query（不带 `?`）。
 * @throws {TypeError} appKey 缺少 appkey/appsec 时。
 */
export function signAppQuery(params, appKey, ts) {
  if (appKey === null || typeof appKey !== 'object'
    || typeof appKey.appkey !== 'string' || typeof appKey.appsec !== 'string') {
    throw new TypeError('signAppQuery 需要 { appkey, appsec } 形式的 appKey');
  }
  const timestamp = Number.isFinite(Number(ts)) ? Math.trunc(Number(ts)) : Math.floor(Date.now() / 1000);
  /** @type {Record<string, string>} */
  const payload = {};
  if (params !== null && typeof params === 'object') {
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'function' || typeof value === 'symbol') continue;
      payload[name] = String(value);
    }
  }
  if (payload.appkey === undefined) payload.appkey = appKey.appkey;
  if (payload.ts === undefined) payload.ts = String(timestamp);
  const query = Object.keys(payload)
    .sort()
    .map((name) => `${name}=${encodeURIComponent(payload[name])}`)
    .join('&');
  // App 签名用的是 query 原串 + appsec 的 md5。
  const sign = md5Hex(`${query}${appKey.appsec}`);
  return `${query}&sign=${sign}`;
}

/**
 * 算 md5（小写十六进制）。
 * @param {string} text - 输入。
 * @returns {string} 32 位小写十六进制。
 */
function md5Hex(text) {
  return createHash('md5').update(String(text), 'utf8').digest('hex');
}

/**
 * 把 App 接口返回里的一层包装（`{code,message,data}`）拆开。
 * @param {any} body - 接口响应。
 * @param {string} context - 出错时的上下文（如「App 搜索」）。
 * @returns {any} `data`。
 * @throws {import('./errors.js').BiliError} `code !== 0` 时。
 */
function unwrap(body, context) {
  const code = Number(body?.code);
  if (Number.isFinite(code) && code !== 0) {
    const error = fromApiCode(code, typeof body?.message === 'string' ? body.message : '', { context });
    // 附加原始业务码：API 层据此决定「-3 时退 -799 重试一次」。
    /** @type {any} */ (error).apiCode = code;
    throw error;
  }
  if (body === null || typeof body !== 'object' || body.data === undefined) {
    return undefined;
  }
  return body.data;
}

/**
 * 造 App 接口客户端。
 * @param {{ http: { getJson: Function }, now?: () => number }} options - 依赖。
 * @returns {{
 *   search: (params: Record<string, unknown>, options?: { app?: 'android' | 'ios', cookie?: string }) => Promise<any>,
 *   spaceArchive: (params: Record<string, unknown>, options?: { cookie?: string }) => Promise<any>
 * }} 客户端（两个方法都直接返回 `data`）。
 */
export function createAppApi(options = {}) {
  const http = options.http;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  /**
   * 发一次已签名的 App 请求。
   * @param {string} url - 接口地址。
   * @param {Record<string, unknown>} params - 业务参数。
   * @param {{ appkey: string, appsec: string, mobi_app: string, platform: string, build: string }} appKey - 平台参数。
   * @param {string | undefined} cookie - 可选 Cookie 头。
   * @param {string} context - 错误上下文。
   * @returns {Promise<any>} `data`。
   */
  async function request(url, params, appKey, cookie, context) {
    const query = signAppQuery(
      {
        ...params,
        appkey: appKey.appkey,
        build: appKey.build,
        mobi_app: appKey.mobi_app,
        platform: appKey.platform,
      },
      appKey,
      Math.floor(now() / 1000),
    );
    /** @type {Record<string, string>} */
    const headers = {};
    if (typeof cookie === 'string' && cookie.trim() !== '') headers.cookie = cookie.trim();
    const body = await http.getJson(`${url}?${query}`, { headers });
    return unwrap(body, context);
  }

  return {
    /**
     * App 搜索。
     * @param {Record<string, unknown>} params - `keyword`、`search_type`、`order`、`page`、`page_size` 等。
     * @param {{ app?: 'android' | 'ios', cookie?: string }} [searchOptions] - 平台与 Cookie。
     * @returns {Promise<any>} 接口的 `data`（`data.item` 是分组数组）。
     */
    async search(params, searchOptions = {}) {
      const app = searchOptions.app ?? 'android';
      const appKey = APP_KEYS[app];
      if (appKey === undefined) throw invalidArgument(`不支持的 App 平台：${String(app)}（可选 android/ios）。`);
      return request(SEARCH_URL, params, appKey, searchOptions.cookie, 'App 搜索');
    },

    /**
     * UP 主投稿列表（iOS 参数，不需要 WBI）。
     * @param {{ vmid: number | string, pn?: number | string, ps?: number | string }} params - 参数。
     * @param {{ cookie?: string }} [archiveOptions] - 可选 Cookie。
     * @returns {Promise<any>} 接口的 `data`。
     */
    async spaceArchive(params, archiveOptions = {}) {
      return request(SPACE_ARCHIVE_URL, params, APP_KEYS.ios, archiveOptions.cookie, 'Up 主投稿');
    },
  };
}
