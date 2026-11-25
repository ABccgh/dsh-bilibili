/**
 * `bili_status`：插件版本、登录态、Cookie/WBI/ffmpeg、下载目录与面板路由的总览。
 *
 * 这是使用其他工具前的第一步：先看清「有没有登录、能不能合并音视频、面板开没开」，
 * 再决定走公开接口还是提示用户扫码登录。
 *
 * @module @local/bilibili/tools/status
 */

import { PLUGIN_VERSION } from '../config.js';
import { resolveDownloadRoot } from '../paths.js';
import { defineTool, renderResult } from '../tool-kit.js';

/**
 * 面板取数路由前缀。
 *
 * 与 `lib/index.js` 的 `PANEL_ROUTE` 一致；这里不 import 插件入口，因为入口会连带
 * 加载 http/api/cookies 等整套 Host 依赖，工具模块不该有这种耦合。
 */
const PANEL_ROUTE = '/dsh-bilibili/api';

/**
 * 输出形状：`{ ok, data, text, blocks? }`。
 *
 * `text` 是 `execute` 拼好的中文正文（列表截断的「还有 N 条」只有在 execute 里才算得出来），
 * `render` 只负责把正文与末尾的 ```json 围栏块合并；围栏块是最后一个文本块。
 */
const STATUS_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', required: true, description: '成功恒为 true；失败时工具直接抛错' },
      data: { type: 'object', required: true, description: '结构化状态，同时写进文本末尾的 json 围栏' },
      text: { type: 'string', description: '给模型阅读的中文正文' },
      blocks: {
        type: 'array',
        description: '图片附件内容块（仅渲染用）',
        items: { type: 'object', properties: { type: { type: 'string', required: true } } },
      },
    },
  },
  /**
   * 渲染成内容块。
   * @param {Record<string, unknown>} _args - 工具参数（本工具无参数）。
   * @param {{ data?: Record<string, unknown>, text?: string, blocks?: object[] }} value - execute 的返回值。
   * @returns {object[]} 内容块数组（文本 + 可选图片）。
   */
  render(_args, value) {
    const data = value !== null && typeof value === 'object' && value.data !== null && typeof value.data === 'object'
      ? value.data
      : {};
    const text = typeof value?.text === 'string' ? value.text : '';
    const blocks = Array.isArray(value?.blocks) ? value.blocks : [];
    return renderResult(text, { ok: true, data }, blocks);
  },
};

/**
 * 把时间戳格式化成 `YYYY-MM-DD HH:mm`（本地时区）。
 * @param {unknown} value - 秒或毫秒时间戳。
 * @returns {string} 文本；无法解析时返回空串。
 */
function formatTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  const date = new Date(number < 1e12 ? number * 1000 : number);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 取插件版本：优先用装配层注入的 `deps.version`，否则回落到 `lib/config.js` 的常量。
 * @param {Record<string, any>} deps - 装配依赖。
 * @returns {string} 版本字符串。
 */
function versionOf(deps) {
  const injected = deps?.version;
  if (typeof injected === 'string' && injected.trim() !== '') return injected.trim();
  return PLUGIN_VERSION;
}

/**
 * 探测 ffmpeg：优先 `deps.ffmpeg.detect()`，探测失败再退化到 `api.status()` 自带的 ffmpeg 字段。
 * @param {Record<string, any>} deps - 装配依赖。
 * @param {Record<string, any> | undefined} status - `api.status()` 的结果。
 * @returns {Promise<Record<string, any>>} `{ available, version?, path? }` 形状。
 */
async function detectFfmpeg(deps, status) {
  const probe = deps?.ffmpeg;
  if (probe !== null && probe !== undefined && typeof probe.detect === 'function') {
    try {
      const detected = await probe.detect();
      if (detected !== null && typeof detected === 'object') return detected;
    } catch {
      // 探测失败不影响状态输出，往下走 api.status() 的字段或「不可用」。
    }
  }
  if (status?.ffmpeg !== null && status?.ffmpeg !== undefined && typeof status.ffmpeg === 'object') {
    return status.ffmpeg;
  }
  return { available: false };
}

/**
 * 把头像挂成图片附件；未启用、没有图片或失败时返回空数组（静默降级）。
 * @param {Record<string, any>} deps - 装配依赖。
 * @param {unknown[]} urls - 候选图片 URL。
 * @param {number} [max] - 最多挂几张。
 * @returns {Promise<object[]>} 图片内容块。
 */
async function attachImages(deps, urls, max = 1) {
  if (deps?.config?.attachImages !== true) return [];
  const images = deps?.images;
  if (images === null || images === undefined || typeof images.attachUrls !== 'function') return [];
  const list = urls.filter((url) => typeof url === 'string' && url.trim() !== '');
  if (list.length === 0) return [];
  try {
    const attached = await images.attachUrls(list.slice(0, max), { max });
    return Array.isArray(attached?.blocks) ? attached.blocks : [];
  } catch {
    return [];
  }
}

/**
 * 生成状态的中文正文。
 * @param {Record<string, any>} data - 结构化状态。
 * @returns {string} 正文。
 */
function statusText(data) {
  const lines = [`B 站集成状态（v${data.version}）`];

  const user = data.user !== null && typeof data.user === 'object' ? data.user : {};
  if (data.loggedIn === true) {
    const bits = [];
    if (typeof user.uname === 'string' && user.uname !== '') bits.push(user.uname);
    if (user.mid !== undefined && user.mid !== null) bits.push(`UID ${user.mid}`);
    if (user.level !== undefined && user.level !== null) bits.push(`Lv${user.level}`);
    lines.push(`登录：已登录${bits.length > 0 ? `（${bits.join('，')}）` : ''}`);
  } else {
    lines.push('登录：未登录（公开数据可用；观看历史/收藏/关注/动态需要登录，用 bili_login start 扫码）');
  }

  const cookie = data.cookie !== null && typeof data.cookie === 'object' ? data.cookie : {};
  const source = typeof cookie.source === 'string' && cookie.source !== '' ? `（来源 ${cookie.source}）` : '';
  lines.push(`Cookie：${cookie.configured === true ? `已配置${source}` : '未配置（游客态可访问公开接口，部分接口会返回 BILI_AUTH_REQUIRED）'}`);

  const wbi = data.wbi !== null && typeof data.wbi === 'object' ? data.wbi : {};
  const fetchedAt = formatTime(wbi.fetchedAt);
  lines.push(`WBI：${wbi.cached === true ? `已缓存${fetchedAt === '' ? '' : `（获取于 ${fetchedAt}）`}` : '未缓存（首次调用时自动获取）'}`);

  const ffmpeg = data.ffmpeg !== null && typeof data.ffmpeg === 'object' ? data.ffmpeg : {};
  const ffmpegVersion = typeof ffmpeg.version === 'string' && ffmpeg.version !== '' ? `（${ffmpeg.version}）` : '';
  lines.push(`ffmpeg：${ffmpeg.available === true
    ? `可用${ffmpegVersion}`
    : '不可用（DASH 音视频合并需要 ffmpeg：配置 ffmpegPath，或把 ffmpeg 放进 PATH）'}`);

  const dir = typeof data.download?.dir === 'string' ? data.download.dir : '';
  lines.push(`下载目录：${dir === '' ? '（未知）' : dir}`);

  const panel = data.panel !== null && typeof data.panel === 'object' ? data.panel : {};
  lines.push(`侧栏面板：${panel.enabled === true
    ? `已启用（取数路由 ${panel.route ?? PANEL_ROUTE}）`
    : '未启用（panelEnabled=false）'}`);

  return lines.join('\n');
}

/**
 * 注册 `bili_status`。
 * @param {Record<string, any>} deps - 装配依赖（`api`/`config`/`images`/`ffmpeg`/`version`）。
 * @returns {object[]} 工具定义数组（1 个）。
 */
export function createStatusTools(deps) {
  return [
    defineTool({
      name: 'bili_status',
      description: '查看 B 站集成状态：登录态与用户、Cookie 来源、WBI 密钥缓存、ffmpeg 可用性、下载目录、侧栏面板路由。'
        + '涉及登录态、个人数据或下载前先调用它，不要猜登录态。',
      parameters: {},
      output: STATUS_OUTPUT,
      async execute() {
        const status = await deps.api.status();
        const ffmpeg = await detectFfmpeg(deps, status);
        /** @type {Record<string, any>} */
        const data = {
          version: versionOf(deps),
          loggedIn: status?.loggedIn === true,
          cookie: status?.cookie !== null && typeof status?.cookie === 'object' ? status.cookie : { configured: false },
          wbi: status?.wbi !== null && typeof status?.wbi === 'object' ? status.wbi : { cached: false },
          ffmpeg,
          download: { dir: resolveDownloadRoot(deps.config?.downloadDir) },
          panel: { enabled: deps.config?.panelEnabled === true, route: PANEL_ROUTE },
        };
        if (status?.user !== null && status?.user !== undefined && typeof status.user === 'object') data.user = status.user;
        const blocks = await attachImages(deps, [status?.user?.face], 1);
        return { ok: true, data, text: statusText(data), blocks };
      },
    }),
  ];
}
