/**
 * Cookie 罐：B 站游客 Cookie 引导 + 用户 Cookie 拼装。
 *
 * B 站的公开接口对「完全没 Cookie」的请求更激进（412/风控），所以第一次真正的
 * 请求前先引导一组游客 Cookie：
 * 1. `GET https://www.bilibili.com/` 从 `Set-Cookie` 取 `buvid3`、`b_nut` 等；
 * 2. `GET https://api.bilibili.com/x/frontend/finger/spi` 取 `b_3`/`b_4`
 *    （分别对应 `buvid3`/`buvid4`）；
 * 3. 自己造 `_uuid`（UUID 大写）与 `b_lsid`（`8位十六进制_8位十六进制`）。
 *
 * 用户 Cookie（`SESSDATA=…; bili_jct=…`）每次调用都重新向凭据服务要，原样拼在
 * 游客 Cookie 后面；凭据服务缺失/读失败只告警，不影响公开接口。
 *
 * @module @local/bilibili/cookies
 */

import { randomBytes, randomUUID } from 'node:crypto';

/** 引导 Cookie 的入口页。 */
const HOME_URL = 'https://www.bilibili.com/';

/** 指纹接口：返回 `b_3`/`b_4`（buvid3/buvid4）。 */
const FINGER_URL = 'https://api.bilibili.com/x/frontend/finger/spi';

/** 游客 Cookie 缓存时长（12 小时）。 */
const GUIDE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * 塞一个键值进 Map（空值忽略，重复名后者覆盖）。
 * @param {Map<string, string>} target - 目标。
 * @param {string} name - Cookie 名。
 * @param {string} value - Cookie 值。
 * @returns {void}
 */
function putCookie(target, name, value) {
  const key = String(name).trim().replace(/^"(.*)"$/, '$1').trim();
  if (key === '') return;
  let text = String(value).trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  if (text === '') return;
  target.set(key, text);
}

/**
 * 从响应头里取全部 `Set-Cookie`。
 *
 * Node 18.17+/undici 提供 `headers.getSetCookie()`；没有时退回拆 `set-cookie`
 * 合并串（用「逗号 + 下一个 `name=`」切分，避开 expires 里的逗号）。
 * @param {any} headers - 响应头对象。
 * @returns {string[]} 原始 Set-Cookie 字符串。
 */
export function readSetCookies(headers) {
  if (headers === null || headers === undefined) return [];
  if (typeof headers.getSetCookie === 'function') {
    try {
      const list = headers.getSetCookie();
      if (Array.isArray(list)) return list.filter((item) => typeof item === 'string');
    } catch {
      // 退回下面按字符串拆。
    }
  }
  if (typeof headers.get === 'function') {
    const raw = headers.get('set-cookie');
    if (typeof raw === 'string' && raw !== '') {
      return raw.split(/,(?=\s*[^;,=\s]+=)/).map((part) => part.trim()).filter((part) => part !== '');
    }
  }
  return [];
}

/**
 * 把一组 Set-Cookie 解析成 name→value。
 * @param {string[]} setCookies - 原始 Set-Cookie 列表。
 * @returns {Map<string, string>} Cookie 表。
 */
export function parseSetCookies(setCookies) {
  /** @type {Map<string, string>} */
  const pairs = new Map();
  for (const raw of setCookies) {
    const first = String(raw).split(';')[0] ?? '';
    const index = first.indexOf('=');
    if (index <= 0) continue;
    putCookie(pairs, first.slice(0, index), first.slice(index + 1));
  }
  return pairs;
}

/**
 * 自造 `_uuid`（B 站要求大写 UUID 形式）。
 * @returns {string} UUID。
 */
export function createUuid() {
  return randomUUID().toUpperCase();
}

/**
 * 自造 `b_lsid`（`8 位十六进制_8 位十六进制`）。
 * @returns {string} b_lsid。
 */
export function createBiliLsId() {
  const hex = (size) => randomBytes(size).toString('hex').toUpperCase();
  return `${hex(4)}_${hex(4)}`;
}

/**
 * 把 Cookie 表序列化成请求头。
 * @param {Map<string, string>} pairs - Cookie 表。
 * @returns {string} `a=1; b=2`。
 */
export function serializeCookies(pairs) {
  return [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * 造 Cookie 罐。
 * @param {{ http: { open: Function, getJson: Function }, config?: Record<string, any>,
 *   logger?: { warn?: Function }, resolveUserCookie?: () => Promise<string | undefined>,
 *   describeUserCookie?: () => Promise<any>, now?: () => number }} [options] - 依赖。
 * @returns {{
 *   header: () => Promise<string>,
 *   refresh: () => Promise<void>,
 *   userCookie: () => Promise<string | undefined>,
 *   invalidate: () => void,
 *   status: () => Promise<{ configured: boolean, source?: string, names: string[] }>,
 *   name: 'cookies'
 * }} Cookie 罐。
 */
export function createCookieJar(options = {}) {
  const http = options.http;
  const logger = options.logger;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const resolveUserCookie = typeof options.resolveUserCookie === 'function' ? options.resolveUserCookie : undefined;
  const describeUserCookie = typeof options.describeUserCookie === 'function' ? options.describeUserCookie : undefined;
  const ttlMs = GUIDE_TTL_MS;

  /** @type {Map<string, string>} 游客 Cookie。 */
  let guide = new Map();
  /** 上次引导完成的时间。 */
  let fetchedAt = 0;
  /** @type {Promise<Map<string, string>> | null} */
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
   * 请求首页 + 指纹接口，组装游客 Cookie。
   * @returns {Promise<Map<string, string>>} Cookie 表。
   */
  async function fetchGuide() {
    /** @type {Map<string, string>} */
    const pairs = new Map();

    const home = await http.open(HOME_URL, {});
    // 首页 HTML 我们不关心，取消掉流避免占连接。
    try {
      await home.body?.cancel?.();
    } catch {
      // 忽略。
    }
    for (const [name, value] of parseSetCookies(readSetCookies(home.headers))) {
      putCookie(pairs, name, value);
    }

    const finger = await http.getJson(FINGER_URL);
    const data = finger?.data;
    if (data !== null && typeof data === 'object') {
      if (typeof data.b_3 === 'string' && data.b_3 !== '') putCookie(pairs, 'buvid3', data.b_3);
      if (typeof data.b_4 === 'string' && data.b_4 !== '') putCookie(pairs, 'buvid4', data.b_4);
    }

    // 自造的两个：网页端由 JS 生成，接口不返回。
    if (!pairs.has('_uuid')) pairs.set('_uuid', createUuid());
    if (!pairs.has('b_lsid')) pairs.set('b_lsid', createBiliLsId());
    return pairs;
  }

  /**
   * 确保游客 Cookie 可用（并发去重）。
   * @param {boolean} force - 是否强制重新引导。
   * @returns {Promise<Map<string, string>>} Cookie 表。
   */
  async function ensureGuide(force) {
    if (!force && guide.size > 0 && now() - fetchedAt < ttlMs) return guide;
    if (pending === null) {
      pending = fetchGuide()
        .then((pairs) => {
          guide = pairs;
          fetchedAt = now();
          return guide;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  }

  return {
    name: 'cookies',

    /**
     * 拼出完整 Cookie 请求头（游客 Cookie + 用户 Cookie）。
     *
     * 游客 Cookie 引导失败时降级为「只有用户 Cookie」并告警，公开接口仍可尝试。
     * @returns {Promise<string>} Cookie 头（可能为空字符串）。
     */
    async header() {
      /** @type {string} */
      let guideHeader = '';
      try {
        guideHeader = serializeCookies(await ensureGuide(false));
      } catch (error) {
        warn(`[bilibili] 引导游客 Cookie 失败，将只用用户 Cookie：${error instanceof Error ? error.message : String(error)}`);
      }
      const user = await this.userCookie();
      if (user === undefined) return guideHeader;
      return guideHeader === '' ? user : `${guideHeader}; ${user}`;
    },

    /**
     * 丢弃缓存并重新引导（失败会抛错，`header()` 则只会降级）。
     * @returns {Promise<void>} 无。
     */
    async refresh() {
      guide = new Map();
      fetchedAt = 0;
      pending = null;
      await ensureGuide(true);
    },

    /**
     * 直接问凭据服务要用户 Cookie。
     * @returns {Promise<string | undefined>} Cookie 字符串；未配置/读失败返回 undefined。
     */
    async userCookie() {
      if (resolveUserCookie === undefined) return undefined;
      try {
        const value = await resolveUserCookie();
        if (typeof value !== 'string') return undefined;
        const trimmed = value.trim().replace(/^;\s*|\s*;$/g, '');
        return trimmed === '' ? undefined : trimmed;
      } catch (error) {
        warn(`[bilibili] 读取用户 Cookie 失败：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },

    /** 丢弃缓存；下次 `header()` 重新引导。 */
    invalidate() {
      guide = new Map();
      fetchedAt = 0;
      pending = null;
    },

    /**
     * Cookie 状态（`bili_status` 用）。
     * @returns {Promise<{ configured: boolean, source?: string, names: string[] }>} 状态。
     */
    async status() {
      const user = await this.userCookie();
      // 尽量把游客 Cookie 也引导出来，这样 `names` 能完整反映实际 Cookie 头；
      // 引导失败不影响状态查询本身。
      try {
        await ensureGuide(false);
      } catch {
        // 忽略。
      }
      /** @type {Set<string>} */
      const names = new Set(guide.keys());
      if (user !== undefined) {
        for (const piece of user.split(';')) {
          const name = (piece.split('=')[0] ?? '').trim();
          if (name !== '') names.add(name);
        }
      }
      /** @type {{ configured: boolean, source?: string, names: string[] }} */
      const result = { configured: user !== undefined, names: [...names] };
      if (describeUserCookie !== undefined) {
        try {
          const described = await describeUserCookie();
          if (described !== null && typeof described === 'object') {
            if (result.configured !== true && described.configured === true) result.configured = true;
            if (typeof described.source === 'string' && described.source !== '') result.source = described.source;
          }
        } catch (error) {
          warn(`[bilibili] 读取 Cookie 来源失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return result;
    },
  };
}
