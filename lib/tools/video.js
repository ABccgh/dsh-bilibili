/**
 * `bili_video`：视频详情（标题、UP 主、统计、简介、分 P、标签）。
 *
 * 数据全部经 `deps.api.video` 拿；本模块只做参数校验、列表截断与中文排版。
 *
 * @module @local/bilibili/tools/video
 */

import { invalidArgument } from '../errors.js';
import { defineTool, renderResult } from '../tool-kit.js';

/** 一次随结果最多挂几张图（封面）。 */
const MAX_IMAGES = 2;

/** 简介在正文里的截断长度。 */
const DESC_LIMIT = 300;

/** 输出形状：`{ ok, data, text, blocks? }`，`render` 把正文与末尾 json 围栏块合并。 */
const VIDEO_OUTPUT = {
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
 * 把页码归一成正整数，缺省第 1 页。
 * @param {unknown} value - `args.page`。
 * @returns {number} 页码。
 */
function pageOf(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.trunc(number) : 1;
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
 * 压掉换行并把文本截到指定长度。
 * @param {unknown} value - 原始文本。
 * @param {number} max - 最大长度。
 * @returns {string} 单行文本。
 */
function clampText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 把封面挂成图片附件；未启用、没有图或失败时返回空数组（静默降级）。
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
 * 生成视频详情的中文正文。
 * @param {Record<string, any>} data - 结构化结果。
 * @param {number} remainingParts - 被截断掉的分 P 数。
 * @param {number} remainingTags - 被截断掉的标签数。
 * @returns {string} 正文。
 */
function videoText(data, remainingParts, remainingTags) {
  const video = data.video !== null && typeof data.video === 'object' ? data.video : {};
  const owner = video.owner !== null && typeof video.owner === 'object' ? video.owner : {};
  const stat = video.stat !== null && typeof video.stat === 'object' ? video.stat : {};
  const lines = [];

  const ids = [];
  if (typeof video.bvid === 'string' && video.bvid !== '') ids.push(video.bvid);
  if (video.aid !== undefined && video.aid !== null) ids.push(`av${video.aid}`);
  lines.push(`${typeof video.title === 'string' && video.title !== '' ? video.title : '(无标题)'}${ids.length > 0 ? `（${ids.join(' · ')}）` : ''}`);

  const ownerName = typeof owner.name === 'string' && owner.name !== '' ? owner.name : '';
  const ownerMid = owner.mid !== undefined && owner.mid !== null ? `UID ${owner.mid}` : '';
  const ownerText = ownerName !== ''
    ? `${ownerName}${ownerMid === '' ? '' : `（${ownerMid}）`}`
    : ownerMid;
  if (ownerText !== '') lines.push(`UP 主：${ownerText}`);

  const meta = [];
  const duration = typeof video.durationText === 'string' && video.durationText !== ''
    ? video.durationText
    : formatDurationText(video.durationSec);
  if (duration !== '') meta.push(`时长 ${duration}`);
  const published = typeof video.pubdateText === 'string' && video.pubdateText !== ''
    ? video.pubdateText
    : formatDate(video.pubdate);
  if (published !== '') meta.push(`发布 ${published}`);
  if (meta.length > 0) lines.push(meta.join(' · '));

  const stats = [];
  const statLabels = [
    ['view', '播放'], ['danmaku', '弹幕'], ['like', '点赞'], ['coin', '投币'],
    ['favorite', '收藏'], ['share', '转发'], ['reply', '评论'],
  ];
  for (const [key, label] of statLabels) {
    if (stat[key] !== undefined && stat[key] !== null) stats.push(`${label} ${formatCount(stat[key])}`);
  }
  if (stats.length > 0) lines.push(stats.join(' · '));

  if (typeof video.desc === 'string' && video.desc.trim() !== '') lines.push(`简介：${clampText(video.desc, DESC_LIMIT)}`);
  if (typeof video.url === 'string' && video.url !== '') lines.push(`链接：${video.url}`);

  const parts = Array.isArray(data.parts) ? data.parts : [];
  if (parts.length > 0) {
    lines.push(`分P（显示 ${parts.length} 个${remainingParts > 0 ? `，还有 ${remainingParts} 个未显示` : ''}）：`);
    parts.forEach((part, index) => {
      const label = typeof part?.part === 'string' && part.part !== '' ? part.part : `第 ${part?.page ?? index + 1} P`;
      const partDuration = typeof part?.durationText === 'string' && part.durationText !== ''
        ? part.durationText
        : formatDurationText(part?.durationSec);
      lines.push(`  P${part?.page ?? index + 1} ${label}${partDuration === '' ? '' : `（${partDuration}）`}`);
    });
  }

  const tags = Array.isArray(data.tags) ? data.tags : [];
  if (tags.length > 0) {
    const names = tags.map((tag) => (typeof tag?.name === 'string' && tag.name !== '' ? tag.name : '')).filter((name) => name !== '');
    if (names.length > 0) {
      lines.push(`标签：${names.join('、')}${remainingTags > 0 ? `（还有 ${remainingTags} 个未显示）` : ''}`);
    }
  }

  return lines.join('\n');
}

/**
 * 注册 `bili_video`。
 * @param {Record<string, any>} deps - 装配依赖（`api`/`config`/`images`）。
 * @returns {object[]} 工具定义数组（1 个）。
 */
export function createVideoTools(deps) {
  return [
    defineTool({
      name: 'bili_video',
      description: '查看一个 B 站视频的详情：标题、UP 主、时长、发布时间、播放/弹幕/点赞等统计、简介、分 P 列表与标签。'
        + 'target 支持 BV 号、av 号、完整链接或 b23.tv 短链。',
      parameters: {
        target: { type: 'string', description: '视频标识：BV 号、av 号、B 站链接或 b23.tv 短链', required: true },
        page: { type: 'integer', description: '分 P 页码（从 1 开始，默认 1）', default: 1 },
        includeParts: { type: 'boolean', description: '是否返回分 P 列表（默认 true）', default: true },
        includeTags: { type: 'boolean', description: '是否返回标签列表（默认 true）', default: true },
      },
      output: VIDEO_OUTPUT,
      async execute(args) {
        const target = typeof args.target === 'string' ? args.target.trim() : '';
        if (target === '') throw invalidArgument('target 不能为空：请给出 BV 号、av 号或 B 站链接。');
        const max = maxListedItems(deps);
        const result = await deps.api.video({ target, page: pageOf(args.page) });
        const rawParts = Array.isArray(result?.parts) ? result.parts : [];
        const rawTags = Array.isArray(result?.tags) ? result.tags : [];
        const parts = args.includeParts === false ? [] : rawParts.slice(0, max);
        const tags = args.includeTags === false ? [] : rawTags.slice(0, max);
        /** @type {Record<string, any>} */
        const data = {
          video: result?.video !== null && typeof result?.video === 'object' ? result.video : {},
          parts,
          tags,
        };
        const remainingParts = args.includeParts === false ? 0 : Math.max(0, rawParts.length - parts.length);
        const remainingTags = args.includeTags === false ? 0 : Math.max(0, rawTags.length - tags.length);
        const blocks = await attachCovers(deps, [data.video.cover]);
        return { ok: true, data, text: videoText(data, remainingParts, remainingTags), blocks };
      },
    }),
  ];
}
