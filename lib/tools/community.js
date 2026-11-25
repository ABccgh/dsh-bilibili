/**
 * `bili_comments` / `bili_danmaku`：评论与弹幕（社区内容）。
 *
 * 数据全部经 `deps.api.comments` / `deps.api.danmaku` 拿；本模块只做参数校验、
 * 列表截断与中文排版。弹幕的 protobuf 解析在 Host 层的 `lib/format.js` 里，工具层不碰字节。
 *
 * @module @local/bilibili/tools/community
 */

import { invalidArgument } from '../errors.js';
import { defineTool, renderResult } from '../tool-kit.js';

/** 评论一次随结果最多挂几张头像。 */
const MAX_IMAGES = 3;

/** 正文里每条评论最多显示多少字。 */
const COMMENT_LIMIT = 200;

/** 正文里每条评论最多显示几条楼中楼。 */
const REPLY_LIMIT = 3;

/** 排序方式显示名。 */
const SORT_LABELS = { hot: '热门', time: '最新' };

/** 弹幕模式显示名（4 底部、5 顶部，其余滚动）。 */
const MODE_LABELS = { 4: '底部', 5: '顶部' };

/**
 * 造一个输出形状：`{ ok, data, text, blocks? }`，`render` 把正文与末尾 json 围栏块合并。
 * @returns {{ schema: object, render: Function }} 输出描述。
 */
function publicOutput() {
  return {
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
     * @param {{ data?: Record<string, any>, text?: string, blocks?: object[] }} value - execute 的返回值。
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
}

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
 * 把评论/弹幕文本压成单行并截断。
 * @param {unknown} value - 原始文本。
 * @param {number} max - 最大长度。
 * @returns {string} 单行文本。
 */
function clampText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 把头像挂成图片附件；未启用、没有图或失败时返回空数组（静默降级）。
 * @param {Record<string, any>} deps - 装配依赖。
 * @param {unknown[]} urls - 候选图片 URL。
 * @returns {Promise<object[]>} 图片内容块。
 */
async function attachAvatars(deps, urls) {
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
 * 生成评论列表的中文正文。
 * @param {Record<string, any>} data - 结构化结果。
 * @param {number} remaining - 被截断掉的条数。
 * @param {string} sort - 排序方式（hot/time），用于正文标题。
 * @returns {string} 正文。
 */
function commentsText(data, remaining, sort) {
  const items = Array.isArray(data.items) ? data.items : [];
  const count = data.count !== undefined && data.count !== null ? formatCount(data.count) : '未知';
  const sortLabel = SORT_LABELS[sort] ?? SORT_LABELS.hot;
  const lines = [`视频评论：共 ${count} 条，第 ${data.page} 页（${sortLabel}），显示 ${items.length} 条：`];
  if (items.length === 0) {
    lines.push('这一页没有评论：可能有审核延迟、被风控，或视频尚未开放评论区。');
  }
  items.forEach((item, index) => {
    const uname = typeof item?.uname === 'string' && item.uname !== '' ? item.uname : '(匿名用户)';
    const meta = [];
    if (item?.like !== undefined && item.like !== null) meta.push(`赞 ${formatCount(item.like)}`);
    if (item?.replyCount !== undefined && item.replyCount !== null && Number(item.replyCount) > 0) {
      meta.push(`回复 ${formatCount(item.replyCount)}`);
    }
    const ctime = typeof item?.ctimeText === 'string' && item.ctimeText !== '' ? item.ctimeText : formatTime(item?.ctime);
    if (ctime !== '') meta.push(ctime);
    lines.push(`${index + 1}. ${uname}${meta.length > 0 ? `（${meta.join('，')}）` : ''}`);
    lines.push(`   ${clampText(item?.message, COMMENT_LIMIT)}`);
    const replies = Array.isArray(item?.replies) ? item.replies : [];
    for (const reply of replies.slice(0, REPLY_LIMIT)) {
      const replyName = typeof reply?.uname === 'string' && reply.uname !== '' ? reply.uname : '(匿名用户)';
      lines.push(`   ↳ ${replyName}：${clampText(reply?.message, COMMENT_LIMIT)}`);
    }
    if (replies.length > REPLY_LIMIT) lines.push(`   ↳ 还有 ${replies.length - REPLY_LIMIT} 条回复未显示`);
  });
  if (remaining > 0) lines.push(`还有 ${remaining} 条未显示（翻页用 page=${data.page + 1}）。`);
  if (data.hasMore === true) lines.push(`还有下一页：page=${data.page + 1}。`);
  return lines.join('\n');
}

/**
 * 生成弹幕的中文正文。
 * @param {Record<string, any>} data - 结构化结果。
 * @param {number} remaining - 被截断掉的条数。
 * @returns {string} 正文。
 */
function danmakuText(data, remaining) {
  const items = Array.isArray(data.items) ? data.items : [];
  const count = data.count !== undefined && data.count !== null ? formatCount(data.count) : '未知';
  const sampled = data.sampled !== undefined && data.sampled !== null ? formatCount(data.sampled) : '未知';
  const lines = [`弹幕：共 ${count} 条，采样 ${sampled} 条，显示 ${items.length} 条：`];

  const distribution = Array.isArray(data.distribution) ? data.distribution : [];
  if (distribution.length > 0) {
    const top = [...distribution]
      .filter((entry) => Number(entry?.count) > 0)
      .sort((left, right) => Number(right.count) - Number(left.count))
      .slice(0, 5)
      .map((entry) => `第 ${entry.minute} 分钟 ${formatCount(entry.count)} 条`);
    if (top.length > 0) lines.push(`密度最高的时间段：${top.join('、')}。`);
  }

  if (items.length === 0) {
    lines.push('这一页没有弹幕：可能被风控、视频无弹幕，或页码超出范围。');
  }
  items.forEach((item, index) => {
    const seconds = Number(item?.timeMs) >= 0 ? Number(item.timeMs) / 1000 : undefined;
    const at = formatDurationText(seconds);
    const mode = MODE_LABELS[item?.mode];
    const prefix = `${at === '' ? '??:??' : at}${mode === undefined ? '' : `（${mode}）`}`;
    lines.push(`${index + 1}. ${prefix} ${clampText(item?.text, COMMENT_LIMIT)}`);
  });
  if (remaining > 0) lines.push(`还有 ${remaining} 条未显示（调大 limit）。`);
  return lines.join('\n');
}

/**
 * 注册 `bili_comments` 与 `bili_danmaku`。
 * @param {Record<string, any>} deps - 装配依赖（`api`/`config`/`images`）。
 * @returns {object[]} 工具定义数组（2 个）。
 */
export function createCommunityTools(deps) {
  return [
    defineTool({
      name: 'bili_comments',
      description: '看一个视频的评论：总数、分页、按热门/最新排序，含点赞数、回复数与楼中楼摘要。target 支持 BV 号/av 号/链接。',
      parameters: {
        target: { type: 'string', description: '视频标识：BV 号、av 号、B 站链接或 b23.tv 短链', required: true },
        page: { type: 'integer', description: '页码（从 1 开始，默认 1）', default: 1 },
        sort: {
          type: 'string',
          description: '排序：hot 热门（默认）、time 最新',
          enum: ['hot', 'time'],
          default: 'hot',
        },
        includeReplies: { type: 'boolean', description: '是否包含楼中楼回复（默认 true）', default: true },
      },
      output: publicOutput(),
      async execute(args) {
        const target = typeof args.target === 'string' ? args.target.trim() : '';
        if (target === '') throw invalidArgument('target 不能为空：请给出 BV 号、av 号或 B 站链接。');
        const max = maxListedItems(deps);
        const page = pageOf(args.page);
        const sort = args.sort === 'time' ? 'time' : 'hot';
        const result = await deps.api.comments({
          target,
          page,
          sort,
          includeReplies: args.includeReplies !== false,
          limit: max,
        });
        const items = Array.isArray(result?.items) ? result.items : [];
        const listed = items.slice(0, max);
        /** @type {Record<string, any>} */
        const data = {
          count: Number.isFinite(Number(result?.count)) ? Math.trunc(Number(result.count)) : 0,
          page: Number.isFinite(Number(result?.page)) ? Math.trunc(Number(result.page)) : page,
          hasMore: result?.hasMore === true,
          items: listed,
        };
        const blocks = await attachAvatars(deps, listed.map((item) => item?.avatar));
        return { ok: true, data, text: commentsText(data, items.length - listed.length, sort), blocks };
      },
    }),
    defineTool({
      name: 'bili_danmaku',
      description: '看一个视频的弹幕：总条数、采样数、按分钟的热度分布与前若干条弹幕内容（含出现时间与顶部/底部模式）。target 支持 BV 号/av 号/链接。',
      parameters: {
        target: { type: 'string', description: '视频标识：BV 号、av 号、B 站链接或 b23.tv 短链', required: true },
        page: { type: 'integer', description: '分 P 页码（从 1 开始，默认 1）', default: 1 },
        limit: { type: 'integer', description: '最多返回几条弹幕（默认取配置 maxListedItems，且不超过它）' },
      },
      output: publicOutput(),
      async execute(args) {
        const target = typeof args.target === 'string' ? args.target.trim() : '';
        if (target === '') throw invalidArgument('target 不能为空：请给出 BV 号、av 号或 B 站链接。');
        const max = maxListedItems(deps);
        const limit = clampLimit(args.limit, max);
        const page = pageOf(args.page);
        const result = await deps.api.danmaku({ target, page, limit });
        const items = Array.isArray(result?.items) ? result.items : [];
        const listed = items.slice(0, limit);
        /** @type {Record<string, any>} */
        const data = {
          count: Number.isFinite(Number(result?.count)) ? Math.trunc(Number(result.count)) : 0,
          sampled: Number.isFinite(Number(result?.sampled)) ? Math.trunc(Number(result.sampled)) : 0,
          distribution: Array.isArray(result?.distribution) ? result.distribution : [],
          items: listed,
        };
        return { ok: true, data, text: danmakuText(data, items.length - listed.length), blocks: [] };
      },
    }),
  ];
}
