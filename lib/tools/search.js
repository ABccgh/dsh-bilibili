/**
 * `bili_search`：在 B 站搜索视频、UP 主、番剧、直播与专栏。
 *
 * 数据全部经 `deps.api.search`（App 搜索接口）拿；本模块只做参数校验、列表截断与中文排版。
 *
 * @module @local/bilibili/tools/search
 */

import { invalidArgument } from '../errors.js';
import { defineTool, renderResult } from '../tool-kit.js';

/** 搜索结果类型的显示名。 */
const TYPE_LABELS = { video: '视频', user: 'UP主', bangumi: '番剧', live: '直播', article: '专栏' };

/** 条目类型的显示名（api 归一后的 `Item.type`）。 */
const KIND_LABELS = { video: '视频', user: 'UP主', bangumi: '番剧', live: '直播', article: '专栏' };

/** 一次随结果最多挂几张封面图（避免把上下文塞满）。 */
const MAX_IMAGES = 4;

/** 输出形状：`{ ok, data, text, blocks? }`，`render` 把正文与末尾 json 围栏块合并。 */
const SEARCH_OUTPUT = {
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
 * @param {unknown} requested - `args.pageSize`。
 * @param {number} max - 配置上限。
 * @returns {number} 实际条数。
 */
function clampLimit(requested, max) {
  const value = Number(requested);
  const wanted = Number.isFinite(value) && value >= 1 ? Math.trunc(value) : max;
  return Math.min(wanted, max);
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
 * 渲染一条搜索结果。
 * @param {number} index - 序号（从 1 开始）。
 * @param {Record<string, any>} item - 归一化 `Item`。
 * @returns {string} 一行文本。
 */
function itemLine(index, item) {
  const title = typeof item?.title === 'string' && item.title !== '' ? item.title : '(无标题)';
  const facts = [];
  if (typeof item?.author === 'string' && item.author !== '') facts.push(item.author);
  if (item?.play !== undefined && item.play !== null) facts.push(`${formatCount(item.play)}播放`);
  if (item?.danmaku !== undefined && item.danmaku !== null && Number(item.danmaku) > 0) {
    facts.push(`${formatCount(item.danmaku)}弹幕`);
  }
  if (item?.fans !== undefined && item.fans !== null) facts.push(`${formatCount(item.fans)}粉丝`);
  if (item?.level !== undefined && item.level !== null) facts.push(`Lv${item.level}`);
  const duration = typeof item?.durationText === 'string' && item.durationText !== ''
    ? item.durationText
    : formatDurationText(item?.durationSec);
  if (duration !== '') facts.push(duration);
  const published = typeof item?.pubdateText === 'string' && item.pubdateText !== ''
    ? item.pubdateText
    : formatDate(item?.pubdate);
  if (published !== '') facts.push(published);
  const kind = KIND_LABELS[item?.type] ?? (typeof item?.type === 'string' && item.type !== '' ? item.type : '条目');
  return `${index}. 【${kind}】${title}${facts.length > 0 ? ` — ${facts.join(' · ')}` : ''}`;
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
 * 生成搜索结果的中文正文。
 * @param {Record<string, any>} data - 结构化结果。
 * @param {number} remaining - 被截断掉的条数。
 * @returns {string} 正文。
 */
function searchText(data, remaining) {
  const typeLabel = TYPE_LABELS[data.type] ?? '视频';
  const items = Array.isArray(data.items) ? data.items : [];
  const lines = [`在 B 站搜索「${data.keyword}」（${typeLabel} · 第 ${data.page} 页 · 显示 ${items.length} 条）：`];
  if (items.length === 0) {
    lines.push('没有找到结果：换个关键词，或把 type 改成 video / user / bangumi / live / article 再试。');
  }
  items.forEach((item, index) => {
    lines.push(itemLine(index + 1, item));
    if (typeof item?.url === 'string' && item.url !== '') lines.push(`   ${item.url}`);
  });
  if (remaining > 0) lines.push(`还有 ${remaining} 条未显示（调大 pageSize 或翻页）。`);
  if (data.hasMore === true) lines.push(`还有下一页：page=${data.page + 1}。`);
  return lines.join('\n');
}

/**
 * 注册 `bili_search`。
 * @param {Record<string, any>} deps - 装配依赖（`api`/`config`/`images`）。
 * @returns {object[]} 工具定义数组（1 个）。
 */
export function createSearchTools(deps) {
  return [
    defineTool({
      name: 'bili_search',
      description: '在 B 站搜索内容并返回归一化列表（标题、作者、播放/弹幕、时长、发布时间、链接）。'
        + 'type 可选 video（默认）/user/bangumi/live/article；order 可选 totalrank（默认）/click/pubdate/dm/stow。',
      parameters: {
        keyword: { type: 'string', description: '搜索关键词', required: true },
        type: {
          type: 'string',
          description: '搜索类型：video 视频（默认）、user UP 主、bangumi 番剧、live 直播、article 专栏',
          enum: ['video', 'user', 'bangumi', 'live', 'article'],
          default: 'video',
        },
        order: {
          type: 'string',
          description: '排序：totalrank 综合（默认）、click 播放、pubdate 最新、dm 弹幕、stow 收藏',
          enum: ['totalrank', 'click', 'pubdate', 'dm', 'stow'],
        },
        page: { type: 'integer', description: '页码（从 1 开始，默认 1）', default: 1 },
        pageSize: { type: 'integer', description: '本页返回条数（默认取配置 maxListedItems，且不超过它）' },
      },
      output: SEARCH_OUTPUT,
      async execute(args) {
        const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : '';
        if (keyword === '') throw invalidArgument('keyword 不能为空：请给出要搜索的关键词。');
        const max = maxListedItems(deps);
        const limit = clampLimit(args.pageSize, max);
        const page = pageOf(args.page);
        const type = typeof args.type === 'string' && args.type !== '' ? args.type : 'video';
        /** @type {Record<string, any>} */
        const params = { keyword, type, page, pageSize: limit };
        if (args.order !== undefined) params.order = args.order;
        const result = await deps.api.search(params);
        const items = Array.isArray(result?.items) ? result.items : [];
        const listed = items.slice(0, limit);
        /** @type {Record<string, any>} */
        const data = {
          keyword: typeof result?.keyword === 'string' && result.keyword !== '' ? result.keyword : keyword,
          type: typeof result?.type === 'string' && result.type !== '' ? result.type : type,
          page: Number.isFinite(Number(result?.page)) ? Math.trunc(Number(result.page)) : page,
          hasMore: result?.hasMore === true,
          items: listed,
        };
        const blocks = await attachCovers(deps, listed.map((item) => item?.cover));
        return { ok: true, data, text: searchText(data, items.length - listed.length), blocks };
      },
    }),
  ];
}
