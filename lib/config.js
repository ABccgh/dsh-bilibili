/**
 * 插件配置：字段、默认值与归一化。
 *
 * 与 dsh-steam / dsh-3dsmax 一致：**不导出 Schemastery `Config`**。loader 在没有
 * `Config` 时原样透传配置对象，校验与默认值全部由 `normalizeConfigWithWarnings` 负责。
 * 一个写错的字段不应该让插件装不上，但也不该悄悄回退——每个被拒的值都生成一条告警，
 * 由 `apply` 记进日志。
 *
 * @module @local/bilibili/config
 */

/** 插件版本（与 package.json 保持一致，测试会校验）。 */
export const PLUGIN_VERSION = '0.1.1';

/** 配置默认值。 */
export const DEFAULTS = {
  /** Cookie 的凭据名（credentials ref / 环境变量名，默认 BILI_COOKIE）。 */
  cookieEnv: 'BILI_COOKIE',
  /** 单次 HTTP 超时（毫秒）。 */
  requestTimeoutMs: 15000,
  /** 列表类工具一次默认返回多少条。 */
  maxListedItems: 25,
  /** 是否把封面/头像/二维码作为图片附件随结果返回。 */
  attachImages: true,
  /** 下载根目录；空字符串表示 `%USERPROFILE%\Downloads\dsh-bilibili`。 */
  downloadDir: '',
  /** ffmpeg 可执行文件路径；空字符串表示自动探测 PATH。 */
  ffmpegPath: '',
  /** 单个下载任务的体积上限（MiB）。 */
  maxDownloadMb: 2048,
  /** 是否注册侧栏按钮与浮层面板。 */
  panelEnabled: true,
  /** 是否注册面板取数路由（只暴露公开数据）。 */
  publicRoute: true,
  /** 面板路由与工具响应的内存缓存时长（毫秒）。 */
  cacheTtlMs: 60000,
  /** WBI 密钥缓存时长（毫秒）。 */
  wbiCacheTtlMs: 3600000,
};

/**
 * 把 loader 传来的配置收进合法范围，并收集每个被拒字段的告警。
 * @param {Record<string, unknown>} [raw] - loader 校验后的配置。
 * @returns {{ config: typeof DEFAULTS, warnings: string[] }} 生效配置与告警。
 */
export function normalizeConfigWithWarnings(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  /** @type {string[]} */
  const warnings = [];

  /**
   * 记一条「字段被拒，已回退」的告警；缺省（undefined）不算被拒。
   * @param {string} field - 字段名。
   * @param {unknown} value - 被拒的值。
   * @param {unknown} fallback - 回退值。
   */
  const reject = (field, value, fallback) => {
    warnings.push(`配置项 ${field} 的值 ${JSON.stringify(value)} 无效，已回退到默认值 ${JSON.stringify(fallback)}。`);
  };

  /**
   * 允许空字符串的文本字段。
   * @param {string} field - 字段名。
   * @param {string} fallback - 默认值。
   * @param {{ allowEmpty?: boolean }} [options] - 选项。
   * @returns {string} 生效值。
   */
  const text = (field, fallback, options = {}) => {
    const value = source[field];
    if (value === undefined) return fallback;
    if (typeof value !== 'string') {
      reject(field, value, fallback);
      return fallback;
    }
    const trimmed = value.trim();
    if (trimmed === '' && options.allowEmpty !== true) {
      reject(field, value, fallback);
      return fallback;
    }
    return options.allowEmpty === true ? trimmed : trimmed;
  };

  /**
   * 正整数（毫秒、条数、MiB）。
   * @param {string} field - 字段名。
   * @param {number} fallback - 默认值。
   * @param {{ min?: number, max?: number }} [bounds] - 上下限。
   * @returns {number} 生效值。
   */
  const positive = (field, fallback, bounds = {}) => {
    const value = source[field];
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      reject(field, value, fallback);
      return fallback;
    }
    const truncated = Math.trunc(value);
    if (bounds.min !== undefined && truncated < bounds.min) {
      reject(field, value, fallback);
      return fallback;
    }
    if (bounds.max !== undefined && truncated > bounds.max) {
      reject(field, value, fallback);
      return fallback;
    }
    return truncated;
  };

  /**
   * 布尔字段。
   * @param {string} field - 字段名。
   * @param {boolean} fallback - 默认值。
   * @returns {boolean} 生效值。
   */
  const boolean = (field, fallback) => {
    const value = source[field];
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    reject(field, value, fallback);
    return fallback;
  };

  /** @type {typeof DEFAULTS} */
  const config = {
    cookieEnv: text('cookieEnv', DEFAULTS.cookieEnv),
    requestTimeoutMs: positive('requestTimeoutMs', DEFAULTS.requestTimeoutMs, { min: 1000, max: 120000 }),
    maxListedItems: positive('maxListedItems', DEFAULTS.maxListedItems, { min: 1, max: 200 }),
    attachImages: boolean('attachImages', DEFAULTS.attachImages),
    downloadDir: text('downloadDir', DEFAULTS.downloadDir, { allowEmpty: true }),
    ffmpegPath: text('ffmpegPath', DEFAULTS.ffmpegPath, { allowEmpty: true }),
    maxDownloadMb: positive('maxDownloadMb', DEFAULTS.maxDownloadMb, { min: 1, max: 51200 }),
    panelEnabled: boolean('panelEnabled', DEFAULTS.panelEnabled),
    publicRoute: boolean('publicRoute', DEFAULTS.publicRoute),
    cacheTtlMs: positive('cacheTtlMs', DEFAULTS.cacheTtlMs, { min: 1000, max: 3600000 }),
    wbiCacheTtlMs: positive('wbiCacheTtlMs', DEFAULTS.wbiCacheTtlMs, { min: 60000, max: 86400000 }),
  };

  // 凭据名必须是合法的标识符式字符串，避免把用户引导到错误的 ref 上。
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(config.cookieEnv)) {
    warnings.push(`配置项 cookieEnv 的值 ${JSON.stringify(config.cookieEnv)} 不是合法的凭据名，已回退到 ${JSON.stringify(DEFAULTS.cookieEnv)}。`);
    config.cookieEnv = DEFAULTS.cookieEnv;
  }

  return { config, warnings };
}

/**
 * 只要生效值。
 * @param {Record<string, unknown>} [raw] - loader 校验后的配置。
 * @returns {typeof DEFAULTS} 生效配置。
 */
export function normalizeConfig(raw = {}) {
  return normalizeConfigWithWarnings(raw).config;
}
