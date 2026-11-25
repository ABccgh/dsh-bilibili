/**
 * 共享测试替身：假 ctx / 假 HTTP / 内存凭据 / 内存附件 / 假服务。
 *
 * 所有离线测试都必须通过这些替身，不联网、不写仓库外文件。
 *
 * @module test/helpers
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录。 */
export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** fixtures 目录。 */
export const fixturesDir = path.join(repoRoot, 'test', 'fixtures');

/**
 * 读一个文本 fixture。
 * @param {string} name - 文件名。
 * @returns {string} 文本。
 */
export function readFixture(name) {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

/**
 * 读一个 JSON fixture。
 * @param {string} name - 文件名。
 * @returns {any} 解析结果。
 */
export function readFixtureJson(name) {
  return JSON.parse(readFixture(name));
}

/**
 * 读一个二进制 fixture。
 * @param {string} name - 文件名。
 * @returns {Buffer} 字节。
 */
export function readFixtureBytes(name) {
  return fs.readFileSync(path.join(fixturesDir, name));
}

/**
 * 记录式日志器。
 * @returns {{ entries: Array<{ level: string, message: string }>, info: Function, warn: Function, error: Function }}
 *   日志器。
 */
export function createFakeLogger() {
  /** @type {Array<{ level: string, message: string }>} */
  const entries = [];
  const make = (level) => (message) => {
    entries.push({ level, message: String(message) });
  };
  return { entries, info: make('info'), warn: make('warn'), error: make('error') };
}

/**
 * 假 Cordis 上下文。
 * @param {{ logger?: object, credentials?: object, attachments?: object, webServer?: object,
 *   skills?: object, commands?: object, services?: Record<string, any> }} [options] - 可选服务。
 * @returns {{ ctx: any, tools: object[], services: Record<string, any>, logger: any }} 上下文与记录。
 */
export function createFakeCtx(options = {}) {
  /** @type {object[]} */
  const tools = [];
  const services = {
    credentials: options.credentials,
    attachments: options.attachments,
    webServer: options.webServer,
    skills: options.skills,
    commands: options.commands,
    ...options.services,
  };
  const logger = options.logger ?? createFakeLogger();
  /** @type {Array<() => void>} */
  const disposers = [];
  /** 等待服务出现才执行的 inject 回调。 */
  const pendingInjections = [];
  const ctx = {
    logger,
    tools: {
      /** 注册一个工具定义，返回注销函数。 */
      register(definition) {
        tools.push(definition);
        return () => {
          const index = tools.indexOf(definition);
          if (index >= 0) tools.splice(index, 1);
        };
      },
    },
    /** 立即执行回调并收集 disposer。 */
    effect(callback) {
      const disposer = callback();
      const cleanup = typeof disposer === 'function' ? disposer : () => {};
      disposers.push(cleanup);
      return cleanup;
    },
    /**
     * 取服务。
     * @param {string} name - 服务名。
     * @returns {any} 服务或 undefined。
     */
    get(name) {
      return services[name];
    },
    /**
     * Cordis 风格的服务注入：依赖齐了立刻执行，否则挂起等 `provide`。
     * @param {string[]} names - 依赖的服务名。
     * @param {Function} callback - 就绪回调。
     * @returns {Function} 注销函数。
     */
    inject(names, callback) {
      const entry = { names: [...names], callback };
      if (entry.names.every((name) => services[name] !== undefined)) {
        callback();
        return () => {};
      }
      pendingInjections.push(entry);
      return () => {
        const index = pendingInjections.indexOf(entry);
        if (index >= 0) pendingInjections.splice(index, 1);
      };
    },
  };

  /**
   * 让一个服务「出现」，并触发所有依赖已满足的 inject 回调。
   * @param {string} name - 服务名。
   * @param {any} value - 服务实例。
   * @returns {void}
   */
  function provide(name, value) {
    services[name] = value;
    for (const entry of [...pendingInjections]) {
      if (!entry.names.every((dependency) => services[dependency] !== undefined)) continue;
      const index = pendingInjections.indexOf(entry);
      if (index >= 0) pendingInjections.splice(index, 1);
      entry.callback();
    }
  }

  return { ctx, tools, services, logger, disposers, provide, pendingInjections };
}

/**
 * 假 HTTP 客户端：按 URL 片段匹配路由。
 *
 * `routes` 形如 `{ 'view?bvid=': (url, options) => ({ code: 0, data: {} }) }`，
 * 处理器可以返回对象（JSON/文本/字节）或抛错；`open` 必须返回
 * `{ status, headers, body, contentLength }` 形状。
 * @param {Record<string, any>} [routes] - 路由表。
 * @returns {object} 假客户端。
 */
export function createFakeHttp(routes = {}) {
  /** @type {Array<{ url: string, options: any, kind: string }>} */
  const calls = [];

  /**
   * 找匹配的路由。
   * @param {string} url - 请求 URL。
   * @returns {any} 处理器或 undefined。
   */
  function match(url) {
    for (const [fragment, handler] of Object.entries(routes)) {
      if (url.includes(fragment)) return handler;
    }
    return undefined;
  }

  /**
   * 执行一次假请求。
   * @param {string} url - URL。
   * @param {any} options - 请求选项。
   * @param {string} kind - 请求类型。
   * @returns {Promise<any>} 结果。
   */
  async function run(url, options, kind) {
    calls.push({ url, options, kind });
    const handler = match(url);
    if (handler === undefined) throw new Error(`假 HTTP 未配置的请求：${kind} ${url}`);
    if (typeof handler === 'function') return handler(url, options, kind);
    return handler;
  }

  return {
    calls,
    userAgent: 'dsh-bilibili-test/0.1.0',
    async getJson(url, options) {
      return run(url, options, 'json');
    },
    async getText(url, options) {
      return run(url, options, 'text');
    },
    async getBytes(url, options) {
      const value = await run(url, options, 'bytes');
      return value instanceof Uint8Array ? value : new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
    },
    async open(url, options) {
      return run(url, options, 'open');
    },
  };
}

/**
 * 内存凭据服务。
 * @param {Record<string, string>} [initial] - 初始 refs。
 * @returns {object} 凭据服务替身。
 */
export function createMemoryCredentials(initial = {}) {
  /** @type {Record<string, string>} */
  const values = { ...initial };
  return {
    values,
    async resolve(ref) {
      return values[ref] === undefined ? undefined : { value: values[ref] };
    },
    async describe(ref) {
      return values[ref] === undefined
        ? { configured: false }
        : { configured: true, source: 'test', writable: true, masked: `${values[ref].slice(0, 4)}…` };
    },
    async set(ref, value) {
      values[ref] = String(value);
    },
    async unset(ref) {
      delete values[ref];
    },
  };
}

/**
 * 内存附件服务：记录保存的图片，返回带尺寸的 ref。
 * @returns {object} 附件服务替身。
 */
export function createMemoryAttachments() {
  /** @type {Array<{ data: Uint8Array, mediaType: string, name?: string }>} */
  const saved = [];
  return {
    saved,
    async saveImage(input) {
      saved.push({ data: input.data, mediaType: input.mediaType, name: input.name });
      return {
        attachmentId: `att-${saved.length}`,
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 64,
        height: 64,
        name: input.name ?? `image-${saved.length}`,
      };
    },
    async saveImages(inputs) {
      const refs = [];
      for (const input of inputs) refs.push(await this.saveImage(input));
      return refs;
    },
  };
}

/**
 * 假 webserver：记录注册的路由。
 * @returns {object} 服务替身。
 */
export function createFakeWebServer() {
  /** @type {Array<{ kind: string, path: string, resource: Function }>} */
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
}

/**
 * 假技能服务。
 * @returns {object} 服务替身。
 */
export function createFakeSkills() {
  /** @type {object[]} */
  const skills = [];
  return {
    skills,
    register(definition) {
      skills.push(definition);
      return () => {
        const index = skills.indexOf(definition);
        if (index >= 0) skills.splice(index, 1);
      };
    },
  };
}

/**
 * 假命令服务。
 * @returns {object} 服务替身。
 */
export function createFakeCommands() {
  /** @type {object[]} */
  const commands = [];
  return {
    commands,
    register(definition) {
      commands.push(definition);
      return () => {
        const index = commands.indexOf(definition);
        if (index >= 0) commands.splice(index, 1);
      };
    },
  };
}

/**
 * 执行一个工具定义并返回渲染结果。
 * @param {object} definition - 工具定义。
 * @param {Record<string, unknown>} [args] - 参数。
 * @param {{ signal?: AbortSignal }} [exec] - 执行上下文。
 * @returns {Promise<{ value: any, blocks: object[], text: string }>} 结果。
 */
export async function executeTool(definition, args = {}, exec = {}) {
  const value = await definition.execute(args, { signal: exec.signal });
  const blocks = definition.output.render(args, value);
  const text = blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return { value, blocks, text };
}

/**
 * 取文本里最后一个 ```json 围栏块并解析。
 * @param {string} text - 文本。
 * @returns {any | null} 解析结果；没有围栏或解析失败返回 null。
 */
export function parseFence(text) {
  const pattern = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
  let match = null;
  let last = null;
  while ((match = pattern.exec(String(text ?? ''))) !== null) last = match[1];
  if (last === null) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

/**
 * 造一个最小可用的假 API：方法被调用时返回预置结果或抛错。
 * @param {Record<string, any>} [overrides] - 方法覆盖。
 * @returns {object} 假 API。
 */
export function createFakeApi(overrides = {}) {
  /** @type {Array<{ method: string, args: any }>} */
  const calls = [];
  const base = {};
  const methods = [
    'nav', 'status', 'resolveTarget', 'search', 'video', 'user', 'ranking', 'popular', 'hotwords',
    'comments', 'danmaku', 'bangumi', 'live', 'playurl', 'subtitle', 'loginStart', 'loginPoll',
    'logout', 'history', 'favorites', 'follows', 'dynamic',
  ];
  for (const method of methods) {
    base[method] = async (...args) => {
      calls.push({ method, args });
      if (typeof overrides[method] === 'function') return overrides[method](...args);
      if (overrides[method] !== undefined) return overrides[method];
      throw new Error(`假 API 未实现：${method}`);
    };
  }
  return { ...base, calls };
}
