/**
 * 统一错误类型：所有工具失败都抛 `BiliError`，消息里带可执行的 hint。
 *
 * 工具注册表会把 throw 变成 `isError` 结果；卡片与模型都能读到错误文本，
 * 所以这里同时提供 `toErrorText` 把 `code`/`hint` 拼成稳定的两行格式。
 *
 * @module @local/bilibili/errors
 */

/** 稳定错误码（测试与客户端依赖这些字符串）。 */
export const CODES = {
  NETWORK: 'BILI_NETWORK',
  TIMEOUT: 'BILI_TIMEOUT',
  HTTP: 'BILI_HTTP',
  API: 'BILI_API',
  RISK: 'BILI_RISK_CONTROL',
  AUTH_REQUIRED: 'BILI_AUTH_REQUIRED',
  COOKIE_EXPIRED: 'BILI_COOKIE_EXPIRED',
  NOT_FOUND: 'BILI_NOT_FOUND',
  INVALID_ARGUMENT: 'BILI_INVALID_ARGUMENT',
  DOWNLOAD: 'BILI_DOWNLOAD',
  FFMPEG_MISSING: 'BILI_FFMPEG_MISSING',
  INTERNAL: 'BILI_INTERNAL',
};

/** B 站业务错误码的默认解释与建议。 */
const API_CODE_HINTS = {
  '-101': { code: CODES.AUTH_REQUIRED, hint: '这个接口需要登录：先用 bili_login start 扫码，或配置 BILI_COOKIE。' },
  '-352': { code: CODES.RISK, hint: '触发 B 站风控：稍等 1 分钟后重试；仍失败就先 bili_login start 登录再试。' },
  '-412': { code: CODES.RISK, hint: '请求被 B 站拦截：关闭代理/VPN，稍等重试；持续失败说明本机 IP 被临时限制。' },
  '-799': { code: CODES.RISK, hint: '请求过于频繁：等 10–30 秒再重试，不要连续刷。' },
  '-404': { code: CODES.NOT_FOUND, hint: '目标不存在、已删除或地区/版权限制。' },
  '-403': { code: CODES.RISK, hint: '接口拒绝访问：可能需要登录态或已过期，重新登录后再试。' },
  '-10403': { code: CODES.RISK, hint: '风控升级：先在浏览器打开一次 B 站再回来重试。' },
  '-87008': { code: CODES.API, hint: '该清晰度需要大会员或账号权限。' },
};

/**
 * 插件统一错误。
 */
export class BiliError extends Error {
  /**
   * @param {string} message - 面向用户的消息（不含 hint）。
   * @param {{ code?: string, hint?: string, retryable?: boolean, cause?: unknown, status?: number }} [options] - 选项。
   */
  constructor(message, options = {}) {
    super(String(message), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BiliError';
    this.code = typeof options.code === 'string' && options.code !== '' ? options.code : CODES.API;
    this.hint = typeof options.hint === 'string' ? options.hint : '';
    this.retryable = options.retryable === true;
    if (typeof options.status === 'number') this.status = options.status;
  }
}

/**
 * 判断一个值是否是 `BiliError`。
 * @param {unknown} value - 任意值。
 * @returns {boolean} 是否。
 */
export function isBiliError(value) {
  return value instanceof BiliError;
}

/**
 * 把错误渲染成稳定的两行文本（第一行消息，第二行提示）。
 * @param {unknown} error - 任意错误。
 * @returns {string} 文本。
 */
export function toErrorText(error) {
  if (error instanceof BiliError) {
    const first = `[${error.code}] ${error.message}`;
    return error.hint === '' ? first : `${first}\n提示：${error.hint}`;
  }
  if (error instanceof Error) return `[${CODES.INTERNAL}] ${error.message}`;
  return `[${CODES.INTERNAL}] ${String(error)}`;
}

/**
 * 把 B 站业务码转成 `BiliError`。
 * @param {number} code - `data` 里的 code。
 * @param {string} [message] - B 站返回的 message。
 * @param {{ context?: string, retryable?: boolean }} [options] - 额外上下文。
 * @returns {BiliError} 错误。
 */
export function fromApiCode(code, message = '', options = {}) {
  const mapped = API_CODE_HINTS[String(code)];
  const context = options.context === undefined ? '' : `${options.context}：`;
  return new BiliError(`${context}${message !== '' ? message : 'B 站接口返回错误'}（code ${code}）`, {
    code: mapped?.code ?? CODES.API,
    hint: mapped?.hint ?? 'B 站接口可能已调整；先 bili_status 看状态，再稍后重试。',
    retryable: options.retryable === true || String(code) === '-799',
  });
}

/**
 * 造一个参数错误。
 * @param {string} message - 消息。
 * @returns {BiliError} 错误。
 */
export function invalidArgument(message) {
  return new BiliError(message, { code: CODES.INVALID_ARGUMENT, hint: '检查参数名与取值；可用值见工具描述。' });
}

/**
 * 造一个「需要登录」错误。
 * @param {string} [detail] - 额外说明。
 * @returns {BiliError} 错误。
 */
export function authRequired(detail = '') {
  const suffix = detail === '' ? '' : `（${detail}）`;
  return new BiliError(`这个操作需要登录 B 站${suffix}。`, {
    code: CODES.AUTH_REQUIRED,
    hint: '调用 bili_login action=start 生成二维码扫码，或把浏览器 Cookie 配置到凭据 BILI_COOKIE。',
  });
}
