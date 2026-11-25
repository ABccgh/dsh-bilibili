/**
 * `bili_hotwords`：B 站热搜榜（关键词 + 展示名）。
 *
 * 数据经 `deps.api.hotwords` 拿；本模块只做参数校验、列表截断与中文排版。
 * 热搜条目只有小图标（`icon`），不是封面，所以不挂图片附件。
 *
 * @module @local/bilibili/tools/hotwords
 */

import { defineTool, renderResult } from '../tool-kit.js';

/** 输出形状：`{ ok, data, text, blocks? }`，`render` 把正文与末尾 json 围栏块合并。 */
const HOTWORDS_OUTPUT = {
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
 * 生成热搜的中文正文。
 * @param {Record<string, any>} data - 结构化结果。
 * @param {number} remaining - 被截断掉的条数。
 * @returns {string} 正文。
 */
function hotwordsText(data, remaining) {
  const items = Array.isArray(data.items) ? data.items : [];
  const lines = [`B 站热搜（显示 ${items.length} 条）：`];
  if (items.length === 0) {
    lines.push('没有取到热搜数据：可能被风控，稍后重试或先 bili_login start 登录。');
  }
  items.forEach((item, index) => {
    const keyword = typeof item?.keyword === 'string' && item.keyword !== '' ? item.keyword : '(空关键词)';
    const showName = typeof item?.showName === 'string' && item.showName !== '' && item.showName !== keyword
      ? ` — ${item.showName}`
      : '';
    lines.push(`${index + 1}. ${keyword}${showName}`);
  });
  if (remaining > 0) lines.push(`还有 ${remaining} 条未显示（调大 limit）。`);
  return lines.join('\n');
}

/**
 * 注册 `bili_hotwords`。
 * @param {Record<string, any>} deps - 装配依赖（`api`/`config`）。
 * @returns {object[]} 工具定义数组（1 个）。
 */
export function createHotwordTools(deps) {
  return [
    defineTool({
      name: 'bili_hotwords',
      description: '看 B 站热搜榜：按排名返回热搜关键词与展示名，可用来发现当前热点话题。',
      parameters: {
        limit: { type: 'integer', description: '最多返回几条（默认取配置 maxListedItems，且不超过它）' },
      },
      output: HOTWORDS_OUTPUT,
      async execute(args) {
        const max = maxListedItems(deps);
        const limit = clampLimit(args.limit, max);
        const result = await deps.api.hotwords({ limit });
        const items = Array.isArray(result?.items) ? result.items : [];
        const listed = items.slice(0, limit);
        /** @type {Record<string, any>} */
        const data = { items: listed };
        return { ok: true, data, text: hotwordsText(data, items.length - listed.length), blocks: [] };
      },
    }),
  ];
}

/**
 * `createHotwordsTools` 是 `createHotwordTools` 的别名。
 *
 * 聚合器 `lib/tools/index.js` 用的是单数形式（`createHotwordTools`），这里同时导出复数
 * 形式，便于按「模块 → createXxxTools」的统一命名约定引用。
 * @param {Record<string, any>} deps - 装配依赖（`api`/`config`）。
 * @returns {object[]} 工具定义数组（1 个）。
 */
export const createHotwordsTools = createHotwordTools;
