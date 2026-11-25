/**
 * `bili_login` 工具：扫码登录的状态机入口。
 *
 * 参数只有两个（契约 §10 固定）：`action` = start|poll|logout|status（默认 status）、
 * `qrcodeKey`（poll 必填）。真正干活的是 `lib/auth.js`；这里负责工具层职责：
 * - `start` 把二维码 PNG 作为图片附件返回（`images.attachFile`），失败静默降级成文本链接；
 * - 用 WeakMap 把附件内容块挂到返回值上，`render` 时再取出来（`data` 形状保持契约干净）。
 *
 * @module @local/bilibili/tools/login
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAuth } from '../auth.js';
import { invalidArgument } from '../errors.js';
import { defineTool, renderResult } from '../tool-kit.js';

/** `action` 的合法值。 */
const LOGIN_ACTIONS = ['start', 'poll', 'logout', 'status'];

/**
 * 把二维码临时文件复制一份到下载目录，保证用户总能找到它。
 * @param {string | undefined} qrFile - `auth.loginStart` 返回的临时 PNG 路径。
 * @returns {string | undefined} 持久化路径；失败时 undefined。
 */
function persistQrCopy(qrFile) {
  if (typeof qrFile !== 'string' || qrFile === '') return undefined;
  try {
    const override = typeof process.env.BILI_QR_DIR === 'string' ? process.env.BILI_QR_DIR.trim() : '';
    const directory = override !== '' ? override : path.join(os.homedir(), 'Downloads', 'dsh-bilibili');
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, 'bilibili-login-qr.png');
    fs.copyFileSync(qrFile, target);
    return target;
  } catch {
    return undefined;
  }
}

/**
 * 从 `images.attachFile` 的返回值里取出内容块（兼容 `{ blocks }`、数组、单块三种形状）。
 * @param {unknown} result - 附件服务返回值。
 * @returns {object[]} 内容块。
 */
function pickImageBlocks(result) {
  if (Array.isArray(result)) return result.filter((block) => block !== null && typeof block === 'object');
  if (result !== null && typeof result === 'object') {
    if (Array.isArray(result.blocks)) return result.blocks.filter((block) => block !== null && typeof block === 'object');
    if (typeof result.type === 'string') return [result];
  }
  return [];
}

/**
 * 归一 `action` 参数。
 * @param {unknown} value - 原始值。
 * @returns {'start'|'poll'|'logout'|'status'} 动作。
 */
function normalizeAction(value) {
  if (value === undefined || value === null || value === '') return 'status';
  const action = String(value).trim().toLowerCase();
  if (!LOGIN_ACTIONS.includes(action)) {
    throw invalidArgument(`action 只能是 ${LOGIN_ACTIONS.join('、')}，收到 ${JSON.stringify(value)}。`);
  }
  return action;
}

/**
 * 把 poll 的状态翻成一句人话。
 * @param {string} state - 状态。
 * @returns {string} 文本。
 */
function stateText(state) {
  switch (state) {
    case 'waiting':
      return '二维码还没被扫描：请在手机上打开 B 站 App 扫码。';
    case 'scanned':
      return '已扫码：请在手机 App 上点「确认登录」。';
    case 'expired':
      return '二维码已过期：重新调用 bili_login action=start 生成新的二维码。';
    case 'ok':
      return '登录成功。';
    default:
      return `登录状态：${state}`;
  }
}

/**
 * `bili_login` 的渲染文本。
 * @param {Record<string, any>} args - 工具参数。
 * @param {{ data?: Record<string, any> }} value - 工具返回值。
 * @returns {string} 文本。
 */
function renderLoginText(args, value) {
  const data = value?.data ?? {};
  const action = normalizeAction(args?.action);
  if (action === 'start') {
    const lines = ['已生成 B 站扫码登录二维码。', `有效期约 ${data.expiresInSec ?? '?'} 秒。`];
    if (data.qr?.attached === true) {
      lines.push('二维码图片见附件。');
      if (typeof data.qr?.file === 'string') lines.push(`同一张图已保存到：${data.qr.file}`);
    } else if (typeof data.qr?.file === 'string') lines.push(`二维码图片已保存到：${data.qr.file}`);
    else lines.push(`二维码内容：${data.url ?? ''}`);
    lines.push(`扫完（并在手机上确认）后调用：bili_login action=poll qrcodeKey=${data.qrcodeKey ?? ''}`);
    return lines.join('\n');
  }
  if (action === 'poll') {
    const lines = [stateText(String(data.state ?? ''))];
    if (typeof data.message === 'string' && data.message.trim() !== '' && data.state !== 'ok') lines.push(`B 站提示：${data.message}`);
    if (data.state === 'ok') {
      const user = data.user;
      if (user !== undefined && user !== null) lines.push(`当前账号：${user.name ?? '未知'}${user.mid !== undefined ? `（UID ${user.mid}）` : ''}`);
      lines.push('Cookie 已写入凭据，之后可以直接用 bili_me / bili_history / bili_favorites 等工具。');
    }
    return lines.join('\n');
  }
  if (action === 'logout') {
    return data.cleared === false ? '没有可清除的登录凭据（可能本来就没登录）。' : '已清除本机保存的 B 站登录 Cookie。';
  }
  // status
  if (data.loggedIn !== true) return '当前未登录 B 站：调用 bili_login action=start 扫码，或把浏览器 Cookie 配置到 BILI_COOKIE。';
  const user = data.user ?? {};
  return `已登录：${user.name ?? '未知用户'}${user.mid !== undefined ? `（UID ${user.mid}，Lv${user.level ?? '?'}）` : ''}`;
}

/**
 * 造 `bili_login` 工具。
 * @param {{ api: object, config?: Record<string, any>, logger?: object, ctx?: any,
 *   images?: object, credentials?: object, auth?: object }} deps - 插件依赖。
 * @returns {object[]} 只含 `bili_login` 的工具定义数组。
 */
export function createLoginTools(deps = {}) {
  const { api, config = {}, logger, ctx } = deps;
  const credentials = deps.credentials ?? (typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined);
  const auth = deps.auth ?? createAuth({ api, credentials, config, logger });

  /** @type {WeakMap<object, object[]>} 返回值 → 附加图片块。 */
  const extraBlocks = new WeakMap();

  /**
   * 尝试把二维码 PNG 挂成附件。
   * @param {string | undefined} qrFile - 二维码临时文件。
   * @returns {Promise<{ blocks: object[], attached: boolean }>} 结果。
   */
  const attachQr = async (qrFile) => {
    if (config.attachImages === false) return { blocks: [], attached: false };
    if (typeof qrFile !== 'string' || qrFile === '') return { blocks: [], attached: false };
    const images = deps.images;
    if (images === undefined || images === null || typeof images.attachFile !== 'function') return { blocks: [], attached: false };
    try {
      const blocks = pickImageBlocks(await images.attachFile(qrFile));
      return { blocks, attached: blocks.length > 0 };
    } catch (error) {
      // 图片只是锦上添花，失败静默降级成文本链接。
      try {
        logger?.warn?.(`[bilibili] 二维码附件生成失败：${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // 忽略日志失败。
      }
      return { blocks: [], attached: false };
    }
  };

  /**
   * 处理 `action=start`。
   * @returns {Promise<object>} 工具返回值。
   */
  const startLogin = async () => {
    const attachEnabled = config.attachImages !== false;
    // 二维码始终生成：attachImages 只决定「挂不挂附件」，不影响落盘副本与登录本身。
    const started = await auth.loginStart({ write: true });
    const savedPath = persistQrCopy(started.qrFile);
    /** @type {{ attached: boolean, file?: string }} */
    const qr = { attached: false };
    let blocks = [];
    if (attachEnabled) {
      const attached = await attachQr(started.qrFile);
      blocks = attached.blocks;
      if (attached.attached) qr.attached = true;
    }
    const filePath = typeof savedPath === 'string' ? savedPath : (qr.attached ? undefined : started.qrFile);
    if (typeof filePath === 'string') qr.file = filePath;
    // 临时文件在「已持久化副本」或「已挂附件」后就没用了，统一清掉。
    if (typeof savedPath === 'string' || qr.attached) {
      await auth.removeQrFile(started.qrFile);
    }
    const data = {
      qrcodeKey: started.qrcodeKey,
      url: started.url,
      expiresInSec: started.expiresInSec,
      qr,
    };
    const value = { ok: true, data };
    if (blocks.length > 0) extraBlocks.set(value, blocks);
    return value;
  };

  /**
   * 处理 `action=poll`。
   * @param {unknown} qrcodeKey - 二维码 key。
   * @returns {Promise<object>} 工具返回值。
   */
  const pollLogin = async (qrcodeKey) => {
    if (typeof qrcodeKey !== 'string' || qrcodeKey.trim() === '') {
      throw invalidArgument('action=poll 需要 qrcodeKey：把 bili_login action=start 返回的 key 原样传入。');
    }
    const polled = await auth.loginPoll(qrcodeKey);
    /** @type {Record<string, unknown>} */
    const data = { state: polled.state, code: polled.code, message: polled.message };
    if (polled.state === 'ok' && polled.user !== undefined && polled.user !== null) data.user = polled.user;
    return { ok: true, data };
  };

  const definition = defineTool({
    name: 'bili_login',
    description:
      'B 站扫码登录：action=start 生成登录二维码（PNG 附件），action=poll 用 qrcodeKey 轮询结果（成功后 Cookie 自动写入凭据），'
      + 'action=logout 清除本机 Cookie，action=status 查看当前登录状态。',
    parameters: {
      action: {
        type: 'string',
        enum: LOGIN_ACTIONS,
        description: '要执行的动作：start 生成二维码、poll 轮询、logout 退出、status 查状态（默认 status）。',
      },
      qrcodeKey: {
        type: 'string',
        description: 'action=poll 必填：bili_login action=start 返回的二维码 key。',
      },
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return renderResult(renderLoginText(args, value), value, extraBlocks.get(value) ?? []);
      },
    },
    async execute(args) {
      const action = normalizeAction(args.action);
      if (action === 'start') return startLogin();
      if (action === 'poll') return pollLogin(args.qrcodeKey);
      if (action === 'logout') {
        const result = await auth.logout();
        return { ok: true, data: { cleared: result.cleared } };
      }
      const status = await auth.status();
      /** @type {Record<string, unknown>} */
      const data = { loggedIn: status.loggedIn === true };
      if (status.loggedIn === true) data.user = status.user ?? {};
      return { ok: true, data };
    },
  });

  return [definition];
}
