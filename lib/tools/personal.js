/**
 * 个人数据工具：`bili_me`、`bili_history`、`bili_favorites`、`bili_follows`、`bili_dynamic`。
 *
 * 这些接口都需要登录态（或至少需要 Cookie），未登录时 `lib/api.js` 会抛
 * `BILI_AUTH_REQUIRED`；本地再补一层「nav 说没登录就提前给提示」，省一次失败的请求。
 * 返回的 `data` 形状严格按契约 §10，列表按 `config.maxListedItems` 截断。
 *
 * @module @local/bilibili/tools/personal
 */

import { userFromNav } from '../auth.js';
import { authRequired, invalidArgument } from '../errors.js';
import { defineTool, renderResult } from '../tool-kit.js';

/**
 * 取一个合法的列表条数。
 * @param {unknown} value - 用户传入的 limit。
 * @param {Record<string, any>} config - 生效配置。
 * @returns {number} 截断后的条数。
 */
function normalizeLimit(value, config) {
  const max = Number.isInteger(config?.maxListedItems) && config.maxListedItems > 0 ? config.maxListedItems : 25;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return max;
  return Math.min(Math.trunc(parsed), max);
}

/**
 * 取一个合法的页码。
 * @param {unknown} value - 用户传入的 page。
 * @param {number} [fallback] - 缺省页码。
 * @returns {number} 页码。
 */
function normalizePage(value, fallback = 1) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw invalidArgument(`page 必须是 ≥1 的整数，收到 ${JSON.stringify(value)}。`);
  return parsed;
}

/**
 * 把数组安全地截断。
 * @param {unknown} value - 可能是数组的值。
 * @param {number} limit - 条数。
 * @returns {any[]} 截断后的数组。
 */
function takeItems(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, Math.max(0, limit));
}

/**
 * 用「标题/名字 + 作者」渲染一条列表项。
 * @param {Record<string, any>} item - 列表项。
 * @param {number} index - 序号（从 1 起）。
 * @returns {string} 文本行。
 */
function itemLine(item, index) {
  const title = typeof item?.title === 'string' ? item.title : (typeof item?.name === 'string' ? item.name : '(无标题)');
  const author = typeof item?.author === 'string' && item.author !== '' ? ` — ${item.author}` : '';
  const extra = typeof item?.fans === 'number' ? `（${item.fans} 粉丝）` : (typeof item?.count === 'number' ? `（${item.count} 个视频）` : '');
  return `${index}. ${title}${author}${extra}`;
}

/**
 * 造个人数据工具。
 * @param {{ api: object, config?: Record<string, any>, logger?: object }} deps - 插件依赖。
 * @returns {object[]} 5 个工具定义。
 */
export function createPersonalTools(deps = {}) {
  const { api, config = {} } = deps;

  /**
   * 确认 API 存在。
   * @param {string} method - 方法名。
   */
  const requireApi = (method) => {
    if (api === undefined || api === null || typeof api[method] !== 'function') {
      throw new Error(`插件装配异常：api.${method} 不可用。`);
    }
  };

  const meTool = defineTool({
    name: 'bili_me',
    description: '查看当前登录的 B 站账号资料（昵称、UID、等级、粉丝数、头像）。需要先扫码登录或配置 BILI_COOKIE。',
    parameters: {},
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const user = value?.data?.user ?? {};
        const lines = [
          `已登录：${user.name ?? '未知用户'}`,
          `UID：${user.mid ?? '?'}，等级：Lv${user.level ?? '?'}${typeof user.fans === 'number' ? `，粉丝：${user.fans}` : ''}`,
        ];
        if (typeof user.url === 'string') lines.push(`主页：${user.url}`);
        return renderResult(lines.join('\n'), value);
      },
    },
    async execute() {
      requireApi('nav');
      const nav = await api.nav();
      if (nav === undefined || nav === null || nav.loggedIn !== true) {
        throw authRequired('bili_me 需要登录态');
      }
      return { ok: true, data: { user: userFromNav(nav) } };
    },
  });

  const historyTool = defineTool({
    name: 'bili_history',
    description: '查看当前账号的 B 站观看历史（最近看过的视频、进度）。需要登录。',
    parameters: {
      limit: { type: 'integer', description: '要返回多少条（受 maxListedItems 限制，默认取配置值）。' },
      cursor: { type: 'integer', description: '翻页游标：上一次返回的 cursor；首次不传。' },
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const data = value?.data ?? {};
        const items = Array.isArray(data.items) ? data.items : [];
        const lines = [`观看历史：${items.length} 条（hasMore=${data.hasMore === true}）`];
        items.forEach((item, index) => lines.push(itemLine(item, index + 1)));
        return renderResult(lines.join('\n'), value);
      },
    },
    async execute(args) {
      requireApi('history');
      const limit = normalizeLimit(args.limit, config);
      const result = await api.history({ limit, cursor: args.cursor });
      return {
        ok: true,
        data: {
          items: takeItems(result?.items, limit),
          cursor: result?.cursor ?? null,
          hasMore: result?.hasMore === true,
        },
      };
    },
  });

  const favoritesTool = defineTool({
    name: 'bili_favorites',
    description: 'B 站收藏夹：action=list 列出自己的收藏夹，action=items 列出某个收藏夹里的视频。需要登录。',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'items'],
        description: 'list 列出收藏夹（默认），items 列出某个收藏夹的视频（需要 mediaId）。',
      },
      mediaId: { type: 'integer', description: '收藏夹 ID：action=items 时必填，来自 action=list 的 folders[].id。' },
      page: { type: 'integer', description: 'action=items 的页码，默认 1。' },
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const data = value?.data ?? {};
        if (Array.isArray(data.folders)) {
          const lines = [`收藏夹：${data.folders.length} 个`];
          data.folders.forEach((folder, index) => lines.push(itemLine(folder, index + 1)));
          return renderResult(lines.join('\n'), value);
        }
        const items = Array.isArray(data.items) ? data.items : [];
        const lines = [`收藏夹内容：${items.length} 条（第 ${data.page ?? 1} 页，hasMore=${data.hasMore === true}）`];
        items.forEach((item, index) => lines.push(itemLine(item, index + 1)));
        return renderResult(lines.join('\n'), value);
      },
    },
    async execute(args) {
      requireApi('favorites');
      const action = args.action === undefined || args.action === null || args.action === '' ? 'list' : String(args.action);
      const limit = normalizeLimit(args.limit, config);
      if (action === 'items') {
        if (!Number.isInteger(args.mediaId) || args.mediaId < 1) {
          throw invalidArgument('action=items 需要 mediaId（收藏夹 ID），先用 action=list 拿到 folders[].id。');
        }
        const page = normalizePage(args.page);
        const result = await api.favorites({ action: 'items', mediaId: args.mediaId, page, limit });
        return {
          ok: true,
          data: {
            items: takeItems(result?.items, limit),
            page: Number.isInteger(result?.page) ? result.page : page,
            hasMore: result?.hasMore === true,
          },
        };
      }
      if (action !== 'list') throw invalidArgument(`action 只能是 list 或 items，收到 ${JSON.stringify(args.action)}。`);
      const result = await api.favorites({ action: 'list', limit });
      return { ok: true, data: { folders: takeItems(result?.folders, limit) } };
    },
  });

  const followsTool = defineTool({
    name: 'bili_follows',
    description: '查看关注列表（默认自己，可用 vmid 看别人）。需要登录才能看自己的关注。',
    parameters: {
      vmid: { type: 'integer', description: '要查看的 UID；不传表示自己（需要登录）。' },
      page: { type: 'integer', description: '页码，默认 1。' },
      limit: { type: 'integer', description: '每页条数（受 maxListedItems 限制）。' },
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const data = value?.data ?? {};
        const items = Array.isArray(data.items) ? data.items : [];
        const lines = [`关注列表：${items.length} 人（第 ${data.page ?? 1} 页，hasMore=${data.hasMore === true}）`];
        items.forEach((item, index) => lines.push(itemLine(item, index + 1)));
        return renderResult(lines.join('\n'), value);
      },
    },
    async execute(args) {
      requireApi('follows');
      const limit = normalizeLimit(args.limit, config);
      const page = normalizePage(args.page);
      if (args.vmid !== undefined && args.vmid !== null && (!Number.isInteger(args.vmid) || args.vmid < 1)) {
        throw invalidArgument(`vmid 必须是正整数，收到 ${JSON.stringify(args.vmid)}。`);
      }
      const result = await api.follows({ vmid: args.vmid, page, limit });
      return {
        ok: true,
        data: {
          items: takeItems(result?.items, limit),
          page: Number.isInteger(result?.page) ? result.page : page,
          hasMore: result?.hasMore === true,
        },
      };
    },
  });

  const dynamicTool = defineTool({
    name: 'bili_dynamic',
    description: '查看关注的人发的动态（时间线）。需要登录。',
    parameters: {
      page: { type: 'integer', description: '页码，默认 1。' },
      limit: { type: 'integer', description: '每页条数（受 maxListedItems 限制）。' },
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const data = value?.data ?? {};
        const items = Array.isArray(data.items) ? data.items : [];
        const lines = [`动态：${items.length} 条（hasMore=${data.hasMore === true}）`];
        items.forEach((item, index) => {
          const author = typeof item?.author?.name === 'string' ? item.author.name : '';
          const text = typeof item?.text === 'string' ? item.text.replace(/\s+/g, ' ').slice(0, 80) : '';
          lines.push(`${index + 1}. ${author === '' ? '' : `[${author}] `}${text}`);
        });
        return renderResult(lines.join('\n'), value);
      },
    },
    async execute(args) {
      requireApi('dynamic');
      const limit = normalizeLimit(args.limit, config);
      const page = normalizePage(args.page);
      const result = await api.dynamic({ page, limit });
      return {
        ok: true,
        data: {
          items: takeItems(result?.items, limit),
          offset: result?.offset ?? 0,
          hasMore: result?.hasMore === true,
        },
      };
    },
  });

  return [meTool, historyTool, favoritesTool, followsTool, dynamicTool];
}
