/**
 * `bili_user`：UP 主资料与最近投稿。
 *
 * 数据全部经 `deps.api.user` 拿（资料走 card 接口、投稿走 App 投稿接口）；
 * 本模块只做参数校验、列表截断与中文排版。
 *
 * @module @local/bilibili/tools/user
 */

import { invalidArgument } from '../errors.js';
import { defineTool, renderResult } from '../tool-kit.js';

/** 一次随结果最多挂几张图（头像 + 投稿封面）。 */
const MAX_IMAGES = 4;

/** 签名在正文里的截断长度。 */
const SIGN_LIMIT = 160;

/** 输出形状：`{ ok, data, text, blocks? }`，`render` 把正文与末尾 json 围栏块合并。 */
const USER_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', required: true, description: '成功恒为 true；失败时工具直接抛错' },
      data: { type: 'object', required: true, description: '结构化结果，同时写进文本末尾的 json 围栏' },
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
   * @param {Record<string, unknown>} _args - 工具参数。
   * @param {{ data?: Record<string, unknown>, text?: string, blocks?: object[] }} value - execute 的返回值。
   * @returns {object[]} 内容块数组。
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
 * 取配置里的单次列表上限（缺省 25）。
 * @param {Record<string, any>} deps - 装配依赖。
 * @returns {number} 上限。
 */
function maxListedItems(deps) {
  const value = Number(deps?.config?.maxListedItems);
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 25;
}

/**
 * 把用户请求的页大小夹到 `[1, maxListedItems]`。
 * @param {unknown} requested - `args.limit`。
 * @param {number} max - 配置上限。
 * @returns {number} 实际条数。
 */
function clampLimit(requested, max) {
  const value = Number(requested);
  const wanted = Number.isFinite(value) && value >= 1 ? Math.trunc(value) : max;
  return Math.min(wanted, max);
}

/**
 * 把数字格式化成中文计数（万/亿）。
 * @param {unknown} value - 数字。
 * @returns {string} 文本；无法解析时返回空串。
 */
function formatCount(value) {
  if (value === undefined || value === null || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  if (number < 10000) return String(Math.trunc(number));
  const trimZero = (text) => (text.endsWith('.0') ? text.slice(0, -2) : text);
  if (number < 100000000) return `${trimZero((number / 10000).toFixed(1))}万`;
  return `${trimZero((number / 100000000).toFixed(1))}亿`;
}

/**
 * 把秒数格式化成 `mm:ss` 或 `h:mm:ss`。
 * @param {unknown} seconds - 秒数。
 * @returns {string} 文本；无法解析时返回空串。
 */
function formatDurationText(seconds) {
  const number = Number(seconds);
  if (!Number.isFinite(number) || number < 0) return '';
  const total = Math.trunc(number);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${rest}`;
  return `${String(minutes).padStart(2, '0')}:${rest}`;
}

/**
 * 把时间戳格式化成 `YYYY-MM-DD`（本地时区）。
 * @param {unknown} value - 秒或毫秒时间戳。
 * @returns {string} 文本；无法解析时返回空串。
 */
function formatDate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  const date = new Date(number < 1e12 ? number * 1000 : number);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 把签名压成单行并截断。
 * @param {unknown} value - 原始签名。
 * @returns {string} 单行文本。
 */
function clampSign(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= SIGN_LIMIT ? text : `${text.slice(0, SIGN_LIMIT)}…`;
}

/**
 * 把头像与投稿封面挂成图片附件；未启用、没有图或失败时返回空数组（静默降级）。
 * @param {Record<string, any>} deps - 装配依赖。
 * @param {unknown[]} urls - 候选图片 URL。
 * @returns {Promise<object[]>} 图片内容块。
 */
async function attachCovers(deps, urls) {
  if (deps?.config?.attachImages !== true) return [];
  const images = deps?.images;
  if (images === null || images === undefined || typeof images.attachUrls !== 'function') return [];
  const list = urls.filter((url) => typeof url === 'string' && url.trim() !== '');
  if (list.length === 0) return [];
  try {
    const attached = await images.attachUrls(list.slice(0, MAX_IMAGES), { max: MAX_IMAGES });
    return Array.isArray(attached?.blocks) ? attached.blocks : [];
  } catch {
    return [];
  }
}

/**
 * 生成 UP 主资料与投稿列表的中文正文。
 * @param {Record<string, any>} data - 结构化结果。
 * @param {number} remaining - 被截断掉的投稿数。
 * @param {boolean} includeVideos - 本次是否请求了投稿列表。
 * @returns {string} 正文。
 */
function userText(data, remaining, includeVideos) {
  const user = data.user !== null && typeof data.user === 'object' ? data.user : {};
  const lines = [];
  const name = typeof user.name === 'string' && user.name !== '' ? user.name : '(未知用户)';
  const uid = user.mid !== undefined && user.mid !== null ? `UID ${user.mid}` : 'UID 未知';
  lines.push(`${name}（${uid}）`);

  const facts = [];
  if (user.level !== undefined && user.level !== null) facts.push(`Lv${user.level}`);
  if (user.fans !== undefined && user.fans !== null) facts.push(`${formatCount(user.fans)}粉丝`);
  if (user.archiveCount !== undefined && user.archiveCount !== null) facts.push(`投稿 ${formatCount(user.archiveCount)}`);
  if (typeof user.vip === 'object' && user.vip !== null && user.vip.label !== undefined) facts.push(`会员：${user.vip.label}`);
  if (typeof user.official === 'string' && user.official !== '') facts.push(`认证：${user.official}`);
  if (facts.length > 0) lines.push(facts.join(' · '));

  if (typeof user.sign === 'string' && user.sign.trim() !== '') lines.push(`签名：${clampSign(user.sign)}`);
  if (typeof user.url === 'string' && user.url !== '') lines.push(`主页：${user.url}`);

  const videos = Array.isArray(data.videos) ? data.videos : [];
  if (includeVideos === true && videos.length > 0) {
    lines.push(`最近投稿（显示 ${videos.length} 条）：`);
    videos.forEach((item, index) => {
      const title = typeof item?.title === 'string' && item.title !== '' ? item.title : '(无标题)';
      const detail = [];
      if (item?.bvid !== undefined && item.bvid !== null) detail.push(item.bvid);
      if (item?.play !== undefined && item.play !== null) detail.push(`${formatCount(item.play)}播放`);
      if (item?.danmaku !== undefined && item.danmaku !== null && Number(item.danmaku) > 0) {
        detail.push(`${formatCount(item.danmaku)}弹幕`);
      }
      const duration = typeof item?.durationText === 'string' && item.durationText !== ''
        ? item.durationText
        : formatDurationText(item?.durationSec);
      if (duration !== '') detail.push(duration);
      const published = typeof item?.pubdateText === 'string' && item.pubdateText !== ''
        ? item.pubdateText
        : formatDate(item?.pubdate);
      if (published !== '') detail.push(published);
      lines.push(`${index + 1}. ${title}${detail.length > 0 ? ` — ${detail.join(' · ')}` : ''}`);
    });
  } else if (includeVideos === true) {
    lines.push('最近投稿：没有取到（可能未登录、被风控，或该 UP 主没有公开投稿）。');
  }
  if (remaining > 0) lines.push(`还有 ${remaining} 条投稿未显示（调大 limit）。`);
  return lines.join('\n');
}

/**
 * 注册 `bili_user`。
 * @param {Record<string, any>} deps - 装配依赖（`api`/`config`/`images`）。
 * @returns {object[]} 工具定义数组（1 个）。
 */
export function createUserTools(deps) {
  return [
    defineTool({
      name: 'bili_user',
      description: '查看一个 B 站 UP 主的资料（昵称、等级、粉丝、签名、认证、投稿数）与最近投稿列表。mid 是数字 UID（不是昵称）。',
      parameters: {
        mid: { type: 'integer', description: 'UP 主的数字 UID（space.bilibili.com/<mid> 里的那个）', required: true },
        includeVideos: { type: 'boolean', description: '是否返回最近投稿（默认 true）', default: true },
        limit: { type: 'integer', description: '投稿最多返回几条（默认取配置 maxListedItems，且不超过它）' },
      },
      output: USER_OUTPUT,
      async execute(args) {
        const mid = Number(args.mid);
        if (!Number.isInteger(mid) || mid <= 0) throw invalidArgument('mid 必须是正整数 UID。');
        const max = maxListedItems(deps);
        const limit = clampLimit(args.limit, max);
        const includeVideos = args.includeVideos !== false;
        const result = await deps.api.user({ mid, includeVideos, limit });
        const rawVideos = includeVideos && Array.isArray(result?.videos) ? result.videos : [];
        const videos = rawVideos.slice(0, limit);
        /** @type {Record<string, any>} */
        const data = {
          user: result?.user !== null && typeof result?.user === 'object' ? result.user : {},
          videos,
        };
        const blocks = await attachCovers(deps, [
          data.user.face,
          ...videos.map((item) => item?.cover),
        ]);
        return { ok: true, data, text: userText(data, rawVideos.length - videos.length, includeVideos), blocks };
      },
    }),
  ];
}
