/**
 * `@local/bilibili` 的 Cordis 插件入口。
 *
 * 注册 20 个 `bili_*` 工具、`bilibili` 技能、3 个 `/bili-*` 用户命令，以及面板取数
 * 路由 `/dsh-bilibili/api`。装配顺序与 dsh-3dsmax / dsh-steam 一致：
 * 配置归一化 → 依赖（http/cookies/wbi/app/ api/images/downloader）→ 工具 → 可选能力。
 *
 * 注意两件事：
 * 1. **不 import 任何 `@deepseek-ai/*`**。插件是 `link:` 安装的 profile bundle，
 *    代码在 DSH 安装作用域之外，这类 import 会以 `ERR_MODULE_NOT_FOUND` 让插件加载失败。
 * 2. **`apply` 不返回值**。Cordis 会把返回值当 effect 收集，返回数组会让插件激活失败。
 *
 * @module @local/bilibili
 */

import { fileURLToPath } from 'node:url';

import { createAppApi } from './appapi.js';
import { createBiliApi } from './api.js';
import { normalizeConfigWithWarnings, PLUGIN_VERSION } from './config.js';
import { createCookieJar } from './cookies.js';
import { createDownloader } from './download.js';
import { createFfmpegProbe } from './ffmpeg.js';
import { createHttpClient } from './http.js';
import { createImages } from './images.js';
import { createQr } from './qr.js';
import { createPanelResource } from './route.js';
import { createSkillDefinition } from './skill.js';
import { createToolDefinitions } from './tools/index.js';
import { createWbi } from './wbi.js';

/** 插件名（日志与 Loader 行里的标识）。 */
export const name = 'bilibili';

/** 硬依赖：工具注册表。 */
export const inject = ['tools'];

/** 面板取数路由前缀。 */
export const PANEL_ROUTE = '/dsh-bilibili/api';

/** 包目录（`lib/` 的上一级）。 */
const packageDir = fileURLToPath(new URL('..', import.meta.url));

/**
 * 取可选服务；没有该服务时返回 undefined 而不是抛错。
 * @param {any} ctx - Cordis 上下文。
 * @param {string} service - 服务名。
 * @returns {any} 服务或 undefined。
 */
function optionalService(ctx, service) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(service);
  } catch {
    // 服务未挂载时 Cordis 可能抛错，按不可用处理。
  }
  return undefined;
}

/**
 * 直接调用一个已注册的工具定义，拿到它的文本结果（命令与工具共用实现）。
 * @param {object[]} definitions - 工具定义。
 * @param {string} toolName - 工具名。
 * @param {Record<string, unknown>} args - 参数。
 * @param {AbortSignal | undefined} signal - 取消信号。
 * @returns {Promise<string>} 文本结果。
 */
export async function invokeToolText(definitions, toolName, args, signal) {
  const definition = definitions.find((entry) => entry.name === toolName);
  if (definition === undefined) throw new Error(`工具 ${toolName} 未注册`);
  const value = await definition.execute(args, { signal });
  const blocks = definition.output.render(args, value);
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * 注册 3 个用户命令：`/bili-status`、`/bili-search`、`/bili-download`。
 * @param {any} commands - `ctx.commands` 服务。
 * @param {object[]} definitions - 工具定义。
 * @param {Record<string, string>} failures - 命令名 → 失败前缀（仅测试用，可省略）。
 * @returns {Array<() => void>} disposer 列表。
 */
export function registerCommands(commands, definitions, failures = {}) {
  /** @type {Array<() => void>} */
  const disposers = [];

  /**
   * 把一次工具调用包成命令结果。
   * @param {string} toolName - 工具名。
   * @param {Record<string, unknown>} args - 参数。
   * @param {any} invocation - 命令调用信息（含 signal）。
   * @returns {Promise<{ kind: string, text: string }>} 命令结果。
   */
  const run = async (toolName, args, invocation) => {
    try {
      const text = await invokeToolText(definitions, toolName, args, invocation.signal);
      return { kind: 'success', text };
    } catch (error) {
      const prefix = failures[toolName] ?? toolName;
      return { kind: 'error', text: `${prefix} 失败：${error instanceof Error ? error.message : String(error)}` };
    }
  };

  disposers.push(commands.register({
    name: 'bili-status',
    description: '查看 B 站登录态、Cookie、ffmpeg 与面板路由状态（与 bili_status 工具同源）',
    handler: async (invocation) => run('bili_status', {}, invocation),
  }));

  disposers.push(commands.register({
    name: 'bili-search',
    description: '在 B 站搜索视频（与 bili_search 工具同源）',
    input: { hint: '<关键词>' },
    handler: async (invocation) => {
      const keyword = String(invocation.rawInput ?? '').trim();
      if (keyword === '') return { kind: 'error', text: '用法：/bili-search <关键词>' };
      return run('bili_search', { keyword }, invocation);
    },
  }));

  disposers.push(commands.register({
    name: 'bili-download',
    description: '下载一个 B 站视频/音频（与 bili_download 工具同源）',
    input: { hint: '<BV号或链接> [audio]' },
    handler: async (invocation) => {
      const parts = String(invocation.rawInput ?? '').trim().split(/\s+/).filter((part) => part !== '');
      const target = parts[0] ?? '';
      if (target === '') return { kind: 'error', text: '用法：/bili-download <BV号或链接> [audio]' };
      const audioOnly = parts.includes('audio');
      return run('bili_download', { target, audioOnly }, invocation);
    },
  }));

  return disposers;
}

/**
 * 装配插件。
 * @param {any} ctx - Cordis 上下文（硬依赖 `tools`）。
 * @param {Record<string, unknown>} config - loader 校验后的配置。
 * @returns {Promise<void>} 无。**不要返回任何值**。
 */
export async function apply(ctx, config) {
  const { config: effective, warnings } = normalizeConfigWithWarnings(config);

  /** 记一行日志；日志不可用不该影响插件本身。 */
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`[bilibili] ${message}`);
    } catch {
      // 日志失败无所谓。
    }
  };

  for (const warning of warnings) log('warn', warning);

  const effect = typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : (callback) => callback();
  const credentials = optionalService(ctx, 'credentials');
  const ref = effective.cookieEnv;

  /**
   * 每次调用重新解析 Cookie：凭据服务的约定就是「不要跨操作缓存」，改
   * `.credentials.yaml` 的 `refs:` 后（热加载）下一次调用立刻可见。
   * @returns {Promise<string | undefined>} Cookie 字符串或 undefined。
   */
  const resolveUserCookie = async () => {
    if (credentials === undefined) return undefined;
    try {
      const resolved = await credentials.resolve(ref);
      return resolved?.value;
    } catch (cause) {
      log('warn', `读取凭据 ${ref} 失败：${cause instanceof Error ? cause.message : String(cause)}`);
      return undefined;
    }
  };

  /**
   * 凭据来源描述，供 `bili_status` 回答「这个 Cookie 从哪一层读到的」。
   * @returns {Promise<object | undefined>} `describe` 结果或 undefined。
   */
  const describeUserCookie = async () => {
    if (credentials === undefined || typeof credentials.describe !== 'function') return undefined;
    try {
      return await credentials.describe(ref);
    } catch (cause) {
      log('warn', `读取凭据 ${ref} 的来源失败：${cause instanceof Error ? cause.message : String(cause)}`);
      return undefined;
    }
  };

  const http = createHttpClient({ timeoutMs: effective.requestTimeoutMs, logger: { warn: (m) => log('warn', m) } });
  const cookies = createCookieJar({ http, config: effective, logger: { warn: (m) => log('warn', m) }, resolveUserCookie, describeUserCookie });
  const wbi = createWbi({ http, config: effective, logger: { warn: (m) => log('warn', m) } });
  const appApi = createAppApi({ http });
  const ffmpeg = createFfmpegProbe({ config: effective, logger: { warn: (m) => log('warn', m) } });
  const api = createBiliApi({
    http,
    cookies,
    wbi,
    appApi,
    ffmpeg,
    config: effective,
    logger: { warn: (m) => log('warn', m) },
  });
  const images = createImages({ ctx, config: effective, logger: { warn: (m) => log('warn', m) }, http });
  const qr = createQr();
  const downloader = createDownloader({
    ctx,
    config: effective,
    api,
    http,
    ffmpeg,
    logger: { warn: (m) => log('warn', m), info: (m) => log('info', m) },
  });

  const deps = {
    ctx,
    config: effective,
    logger: { warn: (m) => log('warn', m), info: (m) => log('info', m) },
    http,
    cookies,
    wbi,
    appApi,
    ffmpeg,
    api,
    images,
    qr,
    downloader,
    version: PLUGIN_VERSION,
  };

  const definitions = createToolDefinitions(deps);
  for (const definition of definitions) effect(() => ctx.tools.register(definition));
  effect(() => () => {
    // 卸载时清掉内存缓存/定时器（如果实现有）。
    try {
      cookies.invalidate?.();
      wbi.invalidate?.();
    } catch {
      // 忽略。
    }
  });

  // 技能：把 skills/bilibili 注册成运行期技能（resourceBase 指向目录）。
  const skills = optionalService(ctx, 'skills');
  if (skills !== undefined && typeof skills.register === 'function') {
    const skill = createSkillDefinition({ packageDir });
    if (skill !== undefined) effect(() => skills.register(skill));
  }

  // 用户命令：与工具同源，供输入框直接触发。
  const commands = optionalService(ctx, 'commands');
  let commandCount = 0;
  if (commands !== undefined && typeof commands.register === 'function') {
    const disposers = registerCommands(commands, definitions);
    commandCount = disposers.length;
    for (const disposer of disposers) effect(() => disposer);
  }

  // 面板取数：只读公开数据，未鉴权但严格 allow-list；个人数据只走工具。
  //
  // webServer 是可选服务：全新启动时插件可能先于 webServer 挂载，直接 `ctx.get('webServer')`
  // 会拿到 undefined 并且永远不注册路由（表现为面板取数 404）。所以先试一次，失败后
  // 用 `ctx.inject(['webServer'])` 等服务出现再补注册。
  let routeRegistered = false;

  /**
   * 注册面板路由（幂等）。
   * @param {any} web - webServer 服务。
   * @returns {boolean} 是否已注册。
   */
  const registerPanelRoute = (web) => {
    if (routeRegistered) return true;
    if (web === undefined || web === null || typeof web.register !== 'function') return false;
    const resource = createPanelResource({
      api,
      config: effective,
      logger: { warn: (m) => log('warn', m) },
      ffmpeg,
      version: PLUGIN_VERSION,
    });
    effect(() => web.register({ kind: 'prefix', path: PANEL_ROUTE, resource }));
    routeRegistered = true;
    log('info', `面板路由已注册：${PANEL_ROUTE}`);
    return true;
  };

  if (effective.publicRoute && !registerPanelRoute(optionalService(ctx, 'webServer'))) {
    try {
      effect(() => ctx.inject(['webServer'], () => {
        registerPanelRoute(optionalService(ctx, 'webServer'));
      }));
    } catch {
      // 上下文不支持 inject（测试替身）时保持未注册。
    }
  }

  log(
    'info',
    `就绪（v${PLUGIN_VERSION}）：${definitions.length} 个工具、${commandCount} 个命令`
      + `${routeRegistered ? `、面板路由 ${PANEL_ROUTE}` : '（面板路由等待 webServer）'}；`
      + `cookieEnv=${effective.cookieEnv}，downloadDir=${effective.downloadDir || '(默认)'}。`,
  );
}

/** 供测试用：暴露包目录与装配辅助。 */
export { packageDir, optionalService };
