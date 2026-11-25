/**
 * WBI 签名（B 站 Web 端接口的 `w_rid` 参数）。
 *
 * 算法（2023 年起）：
 * 1. 从 `x/web-interface/nav` 的 `data.wbi_img.img_url/sub_url` 取文件名（去扩展名）
 *    得到 `imgKey` / `subKey`；
 * 2. `imgKey + subKey`（64 字符）按固定 64 项置换表重排，取前 32 位即 `mixinKey`；
 * 3. 全部参数按 key 排序，值去掉 `!'()*` 后 `encodeURIComponent`，拼成 query，
 *    末尾追加 `wts`（秒级时间戳），`w_rid = md5(query + mixinKey)`。
 *
 * 两个纯函数（`mixinKeyFrom` / `signQuery`）单独导出，测试逐值断言；网络与缓存
 * 都在 `createWbi` 里。
 *
 * @module @local/bilibili/wbi
 */

import { createHash } from 'node:crypto';

import { BiliError, CODES } from './errors.js';

/** 64 项置换表（B 站前端固定顺序，不得改动）。 */
export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/** WBI 密钥来源接口（未登录也会返回密钥，只是 code 为 -101）。 */
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';

/** 密钥默认缓存时长（毫秒）。 */
const DEFAULT_TTL_MS = 3600000;

/** 需要从签名值里剔除的字符（B 站前端固定过滤）。 */
const CHR_FILTER = /[!'()*]/g;

/**
 * 算 md5（小写十六进制）。
 * @param {string} text - 输入。
 * @returns {string} 32 位小写十六进制。
 */
export function md5(text) {
  return createHash('md5').update(String(text), 'utf8').digest('hex');
}

/**
 * 按 64 项置换表算 `mixinKey`。
 * @param {string} imgKey - `img_url` 的文件名（不含扩展名）。
 * @param {string} subKey - `sub_url` 的文件名（不含扩展名）。
 * @returns {string} 32 位 mixinKey。
 * @throws {BiliError} 两个 key 拼起来不足 64 字符时（接口改版/取错字段）。
 */
export function mixinKeyFrom(imgKey, subKey) {
  const raw = `${typeof imgKey === 'string' ? imgKey : ''}${typeof subKey === 'string' ? subKey : ''}`;
  if (raw.length < 64) {
    throw new BiliError(`WBI 密钥长度不足（${raw.length} < 64），无法生成签名。`, {
      code: CODES.API,
      hint: 'B 站 WBI 密钥接口可能已改版：重启插件，或稍后重试。',
    });
  }
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index]).join('').slice(0, 32);
}

/**
 * 生成带 WBI 签名的 query 串。
 *
 * 纯函数：同样的 params/mixinKey/wts 永远得到同样的串。`params` 里的
 * `undefined`/`null` 会被跳过；数字/布尔会转成字符串；值先剔除 `!'()*` 再
 * `encodeURIComponent`；`wts` 参与排序与签名，`w_rid` 追加在最后。
 * @param {Record<string, unknown>} params - 业务参数（不含 `wts`，传了也会被覆盖）。
 * @param {string} mixinKey - `mixinKeyFrom` 的结果。
 * @param {number} wts - 秒级时间戳。
 * @returns {string} 形如 `a=1&wts=…&w_rid=…` 的 query（不带 `?`）。
 * @throws {BiliError} mixinKey 为空时。
 */
export function signQuery(params, mixinKey, wts) {
  const key = typeof mixinKey === 'string' ? mixinKey : '';
  if (key === '') {
    throw new BiliError('WBI 签名缺少 mixinKey。', {
      code: CODES.API,
      hint: '先调用一次需要 WBI 的接口让密钥缓存建立，或稍后重试。',
    });
  }
  const timestamp = Number.isFinite(Number(wts)) ? Math.trunc(Number(wts)) : Math.floor(Date.now() / 1000);
  /** @type {Record<string, string>} */
  const payload = {};
  if (params !== null && typeof params === 'object') {
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'function' || typeof value === 'symbol') continue;
      payload[name] = String(value).replace(CHR_FILTER, '');
    }
  }
  payload.wts = String(timestamp);
  const query = Object.keys(payload)
    .sort()
    .map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(payload[name])}`)
    .join('&');
  return `${query}&w_rid=${md5(query + key)}`;
}

/**
 * 从 `wbi_img` 的 URL 里取 key（文件名去掉扩展名）。
 * @param {unknown} url - 形如 `https://i0.hdslb.com/bfs/wbi/7cd0….png`。
 * @returns {string} key；取不到时返回空字符串。
 */
export function wbiKeyFromUrl(url) {
  if (typeof url !== 'string') return '';
  const last = url.split('/').pop() ?? '';
  const name = last.split('?')[0];
  return name.replace(/\.[A-Za-z0-9]+$/, '');
}

/**
 * 造 WBI 签名器（带密钥缓存）。
 * @param {{ http: { getJson: Function }, config?: { wbiCacheTtlMs?: number },
 *   logger?: { warn?: Function }, now?: () => number }} options - 依赖。
 * @returns {{
 *   sign: (params: Record<string, unknown>, options?: { forceRefresh?: boolean }) => Promise<string>,
 *   invalidate: () => void,
 *   status: () => Promise<{ cached: boolean, fetchedAt?: number, imgKey?: string }>
 * }} 签名器。
 */
export function createWbi(options = {}) {
  const http = options.http;
  const logger = options.logger;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const rawTtl = Number(options.config?.wbiCacheTtlMs);
  const ttlMs = Number.isFinite(rawTtl) && rawTtl > 0 ? Math.trunc(rawTtl) : DEFAULT_TTL_MS;

  /** @type {{ imgKey: string, subKey: string, mixinKey: string, fetchedAt: number } | null} */
  let cache = null;
  /** @type {Promise<typeof cache> | null} */
  let pending = null;

  /**
   * 记一条告警。
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
   * 拉取并解析 WBI 密钥。
   * @returns {Promise<{ imgKey: string, subKey: string, mixinKey: string, fetchedAt: number }>} 密钥。
   */
  async function fetchKeys() {
    const body = await http.getJson(NAV_URL);
    const wbiImg = body?.data?.wbi_img;
    if (wbiImg === null || typeof wbiImg !== 'object') {
      throw new BiliError('B 站 nav 接口没有返回 WBI 密钥（data.wbi_img 缺失）。', {
        code: CODES.API,
        hint: '接口可能被风控或已改版：稍后重试，或先在浏览器打开一次 B 站。',
      });
    }
    const imgKey = wbiKeyFromUrl(wbiImg.img_url);
    const subKey = wbiKeyFromUrl(wbiImg.sub_url);
    if (imgKey === '' || subKey === '') {
      throw new BiliError('B 站 WBI 密钥 URL 格式异常。', {
        code: CODES.API,
        hint: '接口可能已改版：重启插件或稍后重试。',
      });
    }
    const mixinKey = mixinKeyFrom(imgKey, subKey);
    cache = { imgKey, subKey, mixinKey, fetchedAt: now() };
    return cache;
  }

  /**
   * 确保有可用密钥（并发去重；失败时若还有旧缓存则降级用旧的）。
   * @param {boolean} force - 是否强制刷新。
   * @returns {Promise<{ imgKey: string, subKey: string, mixinKey: string, fetchedAt: number }>} 密钥。
   */
  async function ensure(force) {
    if (!force && cache !== null && now() - cache.fetchedAt < ttlMs) return cache;
    if (pending === null) {
      pending = fetchKeys()
        .catch((error) => {
          if (cache !== null) {
            warn(`[bilibili] 刷新 WBI 密钥失败，继续用旧密钥（${now() - cache.fetchedAt}ms 前取的）：${error instanceof Error ? error.message : String(error)}`);
            return cache;
          }
          throw error;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  }

  return {
    /**
     * 给参数签名。
     * @param {Record<string, unknown>} params - 业务参数。
     * @param {{ forceRefresh?: boolean }} [signOptions] - 选项。
     * @returns {Promise<string>} 带 `wts`/`w_rid` 的 query。
     */
    async sign(params, signOptions = {}) {
      const keys = await ensure(signOptions.forceRefresh === true);
      return signQuery(params, keys.mixinKey, Math.floor(now() / 1000));
    },

    /** 丢弃当前密钥缓存（下次 `sign` 重新拉取）。 */
    invalidate() {
      cache = null;
    },

    /**
     * 密钥缓存状态。
     * @returns {Promise<{ cached: boolean, fetchedAt?: number, imgKey?: string }>} 状态。
     */
    async status() {
      if (cache === null) return { cached: false };
      return {
        cached: now() - cache.fetchedAt < ttlMs,
        fetchedAt: cache.fetchedAt,
        imgKey: cache.imgKey,
      };
    },
  };
}
