/**
 * 扫码登录：二维码生成、轮询、Cookie 落凭据、退出。
 *
 * 职责划分：HTTP 与 B 站接口由 `lib/api.js` 负责（`loginStart`/`loginPoll`/`logout`/`nav`），
 * 这里只做「编排 + 本地副作用」：把登录 URL 渲染成 PNG 落到 `%TEMP%`、轮询到成功后把
 * `cookieString` 写进 `ctx.get('credentials')` 的 `config.cookieEnv` 引用里、退出时删除。
 *
 * 凭据服务是可选的（DSH 里 `credentials` 不一定挂载），所以每个需要它的出口都给出
 * 带 hint 的 `BiliError`，而不是静默失败。
 *
 * @module @local/bilibili/auth
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BiliError, CODES } from './errors.js';
import { renderQrPng } from './qr.js';

/** `api.loginPoll` 允许返回的状态。 */
const LOGIN_STATES = new Set(['waiting', 'scanned', 'expired', 'ok']);

/** 二维码临时文件名前缀（`%TEMP%/bili-login-<key>.png`）。 */
const QR_FILE_PREFIX = 'bili-login-';

/** 默认的二维码有效期（秒，API 没给时兜底）。 */
const DEFAULT_QR_EXPIRES_SEC = 180;

/**
 * 把任意错误转成一行文本（日志用）。
 * @param {unknown} error - 任意错误。
 * @returns {string} 文本。
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 取第一个是数字的值。
 * @param {...unknown} values - 候选值。
 * @returns {number | undefined} 数字或 undefined。
 */
function pickNumber(...values) {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * 取第一个非空字符串。
 * @param {...unknown} values - 候选值。
 * @returns {string | undefined} 字符串或 undefined。
 */
function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * 把 `api.nav()` 的原始字段归一成契约里的 `User` 形状。
 *
 * nav 返回的是 `{ loggedIn, mid, uname, face, level, vip, follower, … }`，契约要求的是
 * `{ mid, name, face?, fans?, level?, … }`；`fans` 取 nav 的 `follower`（粉丝数）。
 * @param {Record<string, any>} nav - `api.nav()` 的返回值。
 * @returns {Record<string, unknown>} 契约 `User` 形状。
 */
export function userFromNav(nav) {
  const source = nav !== null && typeof nav === 'object' ? nav : {};
  const nested = source.user !== null && typeof source.user === 'object' ? source.user : {};
  const mid = pickNumber(source.mid, nested.mid);
  const name = pickString(source.uname, nested.name, nested.uname) ?? (mid === undefined ? '未知用户' : `UID ${mid}`);
  const face = pickString(source.face, nested.face);
  const level = pickNumber(source.level, nested.level);
  const fans = pickNumber(source.follower, source.fans, nested.fans);
  const sign = pickString(source.sign, nested.sign);
  const official = source.official ?? nested.official;
  const vip = source.vip ?? nested.vip;

  /** @type {Record<string, unknown>} */
  const user = { mid, name };
  if (face !== undefined) user.face = face;
  if (fans !== undefined) user.fans = fans;
  if (level !== undefined) user.level = level;
  if (sign !== undefined) user.sign = sign;
  if (official !== undefined && official !== null) user.official = official;
  if (vip !== undefined && vip !== null) user.vip = vip;
  if (mid !== undefined) user.url = `https://space.bilibili.com/${mid}`;
  return user;
}

/**
 * 造一个登录服务。
 * @param {{ api: object, credentials?: object, config?: Record<string, any>,
 *   logger?: { info?: Function, warn?: Function } }} options - 依赖。
 *   `api` 必须实现 `loginStart/loginPoll/logout/nav`（见契约 §9）；
 *   `credentials` 是 DSH 的凭据服务（可选，形状 `{ resolve, set, unset, describe }`）。
 * @returns {{ loginStart: Function, loginPoll: Function, logout: Function, status: Function,
 *   removeQrFile: Function, cleanupQrFiles: Function, cookieEnv: string }} 登录服务。
 */
export function createAuth(options = {}) {
  const { api, credentials, config = {}, logger } = options;
  if (api === undefined || api === null || typeof api.loginStart !== 'function' || typeof api.loginPoll !== 'function') {
    throw new TypeError('createAuth 需要 api（含 loginStart/loginPoll）。');
  }

  const cookieEnv = typeof config.cookieEnv === 'string' && config.cookieEnv.trim() !== ''
    ? config.cookieEnv.trim()
    : 'BILI_COOKIE';

  /** @type {Map<string, string>} 还没消费掉的二维码临时文件（qrcodeKey → 绝对路径）。 */
  const pendingQrFiles = new Map();

  /**
   * 记一条告警；日志失败不影响登录流程。
   * @param {string} message - 消息。
   */
  const logWarn = (message) => {
    try {
      logger?.warn?.(`[bilibili] ${message}`);
    } catch {
      // 忽略日志失败。
    }
  };

  /**
   * 记一条信息日志。
   * @param {string} message - 消息。
   */
  const logInfo = (message) => {
    try {
      logger?.info?.(`[bilibili] ${message}`);
    } catch {
      // 忽略日志失败。
    }
  };

  /**
   * 凭据服务是否挂载。
   * @returns {boolean} 是否可用。
   */
  const hasCredentialService = () => credentials !== undefined && credentials !== null;

  /**
   * 凭据服务是否可以写入。
   * @returns {boolean} 是否可写。
   */
  const canWriteCredentials = () => hasCredentialService() && typeof credentials.set === 'function';

  /**
   * 清洗 qrcodeKey 以便安全拼进文件名。
   * @param {string} key - 原始 key。
   * @returns {string} 只含 `[A-Za-z0-9_-]` 的片段。
   */
  const sanitizeKey = (key) => {
    const cleaned = String(key ?? '').replace(/[^A-Za-z0-9_-]/g, '');
    return cleaned === '' ? 'unknown' : cleaned.slice(0, 64);
  };

  /**
   * 把登录 URL 渲染成 PNG 写到 `%TEMP%`。
   * @param {string} qrcodeKey - 二维码 key（用于文件名）。
   * @param {string} url - 登录 URL。
   * @returns {Promise<string>} 绝对路径。
   */
  const writeQrFile = async (qrcodeKey, url) => {
    const filePath = path.join(os.tmpdir(), `${QR_FILE_PREFIX}${sanitizeKey(qrcodeKey)}.png`);
    await fsp.writeFile(filePath, renderQrPng(url, { scale: 6, margin: 4 }));
    return filePath;
  };

  /**
   * 删除一个二维码临时文件（幂等），同时清掉 pending 记录。
   * @param {string} filePath - 文件路径。
   * @returns {Promise<void>} 无。
   */
  const removeQrFile = async (filePath) => {
    if (typeof filePath !== 'string' || filePath === '') return;
    for (const [key, value] of pendingQrFiles) {
      if (value === filePath) pendingQrFiles.delete(key);
    }
    try {
      await fsp.rm(filePath, { force: true });
    } catch (error) {
      logWarn(`删除二维码临时文件失败（${filePath}）：${errorMessage(error)}`);
    }
  };

  /**
   * 清空所有待处理的二维码临时文件。
   * @returns {Promise<number>} 删除的文件数。
   */
  const cleanupQrFiles = async () => {
    const files = [...pendingQrFiles.values()];
    for (const file of files) await removeQrFile(file);
    pendingQrFiles.clear();
    return files.length;
  };

  /**
   * 生成登录二维码。
   * @param {{ write?: boolean }} [options] - `write=false` 时不落盘（`attachImages=false` 用）。
   * @returns {Promise<{ qrcodeKey: string, url: string, expiresInSec: number, qrFile?: string }>}
   *   二维码 key、URL、有效期与临时 PNG 路径；落盘失败时 `qrFile` 为 undefined。
   */
  const loginStart = async (options_ = {}) => {
    const started = await api.loginStart();
    if (started === null || typeof started !== 'object' || typeof started.qrcodeKey !== 'string' || started.qrcodeKey === '') {
      throw new BiliError('登录接口没有返回二维码 key。', {
        code: CODES.API,
        hint: '稍后重试；持续失败说明 B 站登录接口返回结构有变。',
      });
    }
    const url = typeof started.url === 'string' ? started.url : '';
    if (url === '') {
      throw new BiliError('登录接口没有返回二维码内容。', {
        code: CODES.API,
        hint: '稍后重试；持续失败说明 B 站登录接口返回结构有变。',
      });
    }

    let qrFile;
    if (options_.write !== false) {
      try {
        qrFile = await writeQrFile(started.qrcodeKey, url);
        pendingQrFiles.set(started.qrcodeKey, qrFile);
      } catch (error) {
        logWarn(`二维码 PNG 落盘失败（仍会返回登录链接）：${errorMessage(error)}`);
        qrFile = undefined;
      }
    }
    if (!canWriteCredentials()) {
      logWarn(`没有可写入的凭据服务：扫码成功也无法保存 Cookie（凭据名 ${cookieEnv}）。`);
    }

    const rawExpires = Number(started.expiresInSec);
    const expiresInSec = Number.isFinite(rawExpires) && rawExpires > 0 ? Math.trunc(rawExpires) : DEFAULT_QR_EXPIRES_SEC;
    /** @type {{ qrcodeKey: string, url: string, expiresInSec: number, qrFile?: string }} */
    const result = { qrcodeKey: started.qrcodeKey, url, expiresInSec };
    if (qrFile !== undefined) result.qrFile = qrFile;
    return result;
  };

  /**
   * 轮询二维码状态；成功时把 Cookie 写进凭据服务。
   * @param {string} qrcodeKey - `loginStart` 返回的 key。
   * @returns {Promise<{ state: string, code: number, message: string, user?: object, saved: boolean }>}
   *   状态、B 站返回码/消息、用户信息（成功时）与「Cookie 是否已保存」。
   * @throws {BiliError} 缺少 key、状态非法、登录成功但无法保存 Cookie 时。
   */
  const loginPoll = async (qrcodeKey) => {
    const key = typeof qrcodeKey === 'string' ? qrcodeKey.trim() : '';
    if (key === '') {
      throw new BiliError('缺少二维码 key：action=poll 需要传 qrcodeKey。', {
        code: CODES.INVALID_ARGUMENT,
        hint: '把 bili_login action=start 返回的 qrcodeKey 原样传给 poll。',
      });
    }

    const polled = await api.loginPoll(key);
    const state = typeof polled?.state === 'string' ? polled.state : '';
    if (!LOGIN_STATES.has(state)) {
      throw new BiliError(`无法识别的登录状态：${state === '' ? '(空)' : state}。`, {
        code: CODES.API,
        hint: '稍后重试；持续失败说明 B 站登录接口返回结构有变。',
      });
    }
    const message = typeof polled.message === 'string' ? polled.message : '';
    const rawCode = Number(polled?.code);
    const code = Number.isFinite(rawCode) ? rawCode : 0;

    // 二维码一旦被消费（成功或过期）就删掉临时 PNG，避免 %TEMP% 越积越多。
    if (state === 'ok' || state === 'expired') {
      const stale = pendingQrFiles.get(key);
      if (stale !== undefined) await removeQrFile(stale);
    }

    if (state === 'ok') {
      const cookieString = typeof polled.cookieString === 'string' ? polled.cookieString.trim() : '';
      if (cookieString === '') {
        throw new BiliError('登录成功但 B 站没有返回 Cookie。', {
          code: CODES.API,
          hint: '重新 bili_login action=start 再扫一次；持续失败说明登录接口返回结构有变。',
        });
      }
      if (!canWriteCredentials()) {
        throw new BiliError('扫码登录成功，但当前环境没有可写入的凭据服务，Cookie 无法保存。', {
          code: CODES.AUTH_REQUIRED,
          hint: `请在 DSH 中启用 credentials 服务（插件会写入凭据 ${cookieEnv}），或手动把 Cookie 配置到该凭据/环境变量。`,
        });
      }
      try {
        await credentials.set(cookieEnv, cookieString);
      } catch (cause) {
        throw new BiliError(`Cookie 写入凭据 ${cookieEnv} 失败。`, {
          code: CODES.AUTH_REQUIRED,
          hint: '检查凭据服务是否只读、磁盘是否可写；也可以手动配置 Cookie 后重试。',
          cause,
        });
      }
      logInfo(`扫码登录成功，Cookie 已写入凭据 ${cookieEnv}。`);
    }

    /** @type {{ state: string, code: number, message: string, user?: object, saved: boolean }} */
    const result = { state, code, message, saved: state === 'ok' };
    if (polled.user !== undefined && polled.user !== null) result.user = polled.user;
    return result;
  };

  /**
   * 退出登录：清 Cookie 凭据与临时二维码文件。
   * @returns {Promise<{ cleared: boolean }>} 是否已清除。
   * @throws {BiliError} 没有凭据服务或删除失败时。
   */
  const logout = async () => {
    const clearedResult = typeof api.logout === 'function' ? await api.logout() : { cleared: true };
    await cleanupQrFiles();
    if (!hasCredentialService() || typeof credentials.unset !== 'function') {
      throw new BiliError('当前环境没有可用的凭据服务，无法清除已保存的登录 Cookie。', {
        code: CODES.AUTH_REQUIRED,
        hint: `在 DSH 中启用 credentials 服务后重试，或手动删除凭据 ${cookieEnv} 的值。`,
      });
    }
    try {
      await credentials.unset(cookieEnv);
    } catch (cause) {
      throw new BiliError(`清除凭据 ${cookieEnv} 失败。`, {
        code: CODES.AUTH_REQUIRED,
        hint: '检查凭据服务是否只读，或手动删除该凭据。',
        cause,
      });
    }
    logInfo(`已清除凭据 ${cookieEnv} 保存的登录 Cookie。`);
    return { cleared: clearedResult?.cleared !== false };
  };

  /**
   * 查询凭据服务的描述（「Cookie 从哪一层读到的」）。
   * @returns {Promise<object>} 描述对象；没有凭据服务时 `{ available: false }`。
   */
  const describeCredential = async () => {
    if (!hasCredentialService() || typeof credentials.describe !== 'function') return { available: false };
    try {
      const described = await credentials.describe(cookieEnv);
      return { available: true, ...(described !== null && typeof described === 'object' ? described : {}) };
    } catch (error) {
      logWarn(`读取凭据 ${cookieEnv} 的描述失败：${errorMessage(error)}`);
      return { available: true, error: errorMessage(error) };
    }
  };

  /**
   * 查登录状态（不含 Cookie 内容）。
   * @returns {Promise<{ loggedIn: boolean, user?: object, credential: object }>} 状态。
   */
  const status = async () => {
    const nav = await api.nav();
    const loggedIn = nav?.loggedIn === true;
    /** @type {{ loggedIn: boolean, user?: object, credential: object }} */
    const result = { loggedIn, credential: await describeCredential() };
    if (loggedIn) result.user = userFromNav(nav);
    return result;
  };

  return { loginStart, loginPoll, logout, status, removeQrFile, cleanupQrFiles, cookieEnv };
}
