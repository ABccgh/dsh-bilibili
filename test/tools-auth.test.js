/**
 * `lib/auth.js` + `lib/tools/{login,personal,download}.js` 的离线测试。
 *
 * 登录流程用假 api + 内存凭据 + 真实二维码编码器（生成的 PNG 落到 `%TEMP%`，测试后清理）；
 * 工具层断言三件事：工具名/参数 schema（必填项、枚举）、`execute` 返回的 `data` 形状严格
 * 符合契约 §10、`render` 的最后一个 ```json 围栏块可解析成 `{ ok: true, data }`。
 *
 * @module test/tools-auth.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAuth, userFromNav } from '../lib/auth.js';
import { BiliError, CODES } from '../lib/errors.js';
import { pngDimensions } from '../lib/png.js';
import { createDownloadTools } from '../lib/tools/download.js';
import { createLoginTools } from '../lib/tools/login.js';
import { createPersonalTools } from '../lib/tools/personal.js';
import {
  createFakeApi,
  createFakeLogger,
  createMemoryAttachments,
  createMemoryCredentials,
  executeTool,
  parseFence,
} from './helpers.js';

/** 登录二维码测试用的固定信息。 */
const LOGIN_URL = 'https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key=0123456789abcdef0123456789abcdef';
const COOKIE_STRING = 'SESSDATA=abc%2C123; bili_jct=0123456789abcdef; DedeUserID=42';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 二维码临时文件路径（与 lib/auth.js 的规则一致）。
 * @param {string} key - qrcodeKey。
 * @returns {string} 绝对路径。
 */
function qrFileFor(key) {
  return path.join(os.tmpdir(), `bili-login-${key}.png`);
}

/**
 * 让二维码副本落到临时目录（避免测试写用户真实的 Downloads），返回副本路径。
 * @param {import('node:test').TestContext} t - 测试上下文。
 * @returns {string} 持久化副本的绝对路径。
 */
function withQrDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-qr-dir-'));
  const previous = process.env.BILI_QR_DIR;
  process.env.BILI_QR_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.BILI_QR_DIR;
    else process.env.BILI_QR_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return path.join(directory, 'bilibili-login-qr.png');
}

/**
 * 造一个临时清理钩子：删掉这些 qrcodeKey 对应的二维码 PNG。
 * @param {import('node:test').TestContext} t - 测试上下文。
 * @param {string[]} keys - qrcodeKey 列表。
 */
function cleanupQrFiles(t, keys) {
  t.after(async () => {
    for (const key of keys) await fsp.rm(qrFileFor(key), { force: true });
  });
}

/**
 * 造 auth 依赖。
 * @param {{ loginStart?: Function, loginPoll?: Function, logout?: Function, nav?: Function,
 *   credentials?: object, config?: object }} [overrides] - 覆盖项。
 * @returns {{ auth: object, api: object, credentials: object }} 依赖。
 */
function makeAuth(overrides = {}) {
  const api = createFakeApi({
    loginStart: overrides.loginStart ?? (() => ({ qrcodeKey: 't3-key', url: LOGIN_URL, expiresInSec: 180 })),
    loginPoll: overrides.loginPoll ?? (() => ({ state: 'waiting', code: 86101, message: '未扫码' })),
    logout: overrides.logout ?? (() => ({ cleared: true })),
    nav: overrides.nav ?? (() => ({ loggedIn: false })),
  });
  const credentials = overrides.credentials === null
    ? undefined
    : (overrides.credentials ?? createMemoryCredentials());
  const auth = createAuth({
    api,
    credentials,
    config: { cookieEnv: 'BILI_COOKIE', ...overrides.config },
    logger: createFakeLogger(),
  });
  return { auth, api, credentials };
}

/**
 * 造工具层依赖。
 * @param {{ apiOverrides?: object, config?: object, images?: object, downloader?: object,
 *   credentialsValues?: object, directCredentials?: boolean }} [overrides] - 覆盖项。
 * @returns {{ deps: object, api: object, credentials: object, images: object, downloader: object }} 依赖。
 */
function makeToolDeps(overrides = {}) {
  const logger = createFakeLogger();
  const credentials = createMemoryCredentials(overrides.credentialsValues ?? {});
  const attachments = createMemoryAttachments();
  const api = createFakeApi(overrides.apiOverrides ?? {});
  const config = { cookieEnv: 'BILI_COOKIE', maxListedItems: 3, attachImages: true, ...overrides.config };
  const images = overrides.images ?? {
    attachFile: async () => ({
      blocks: [{ type: 'image', mediaType: 'image/png', attachmentId: 'att-1', name: 'bili-login.png' }],
      attached: true,
    }),
  };
  const downloader = overrides.downloader ?? {
    run: async () => ({
      file: path.join(os.tmpdir(), 'fake-download.mp4'),
      bytes: 1024,
      sizeText: '1.0 KB',
      quality: '1080P',
      durationSec: 60,
      merged: true,
      audioOnly: false,
      elapsedMs: 1234,
    }),
  };
  /** @type {Record<string, any>} */
  const services = { credentials, attachments };
  const deps = {
    ctx: { get: (name) => services[name], logger },
    config,
    logger,
    api,
    images,
    downloader,
  };
  if (overrides.directCredentials !== false) deps.credentials = credentials;
  return { deps, api, credentials, images, downloader };
}

/**
 * 从工具文本结果里解析最后一个 ```json 围栏块。
 * @param {string} text - 工具文本。
 * @returns {any} 解析结果。
 */
function fenceOf(text) {
  const parsed = parseFence(text);
  assert.notEqual(parsed, null, '工具结果里必须有可解析的最后一个 ```json 围栏块');
  return parsed;
}

/**
 * 把值转成 JSON 往返后的形状（围栏块里的 data 会丢掉 undefined）。
 * @param {any} value - 任意值。
 * @returns {any} JSON 往返结果。
 */
function jsonRoundTrip(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// lib/auth.js
// ---------------------------------------------------------------------------

test('auth: userFromNav 把 nav 字段归一成契约 User 形状', () => {
  assert.deepEqual(userFromNav({
    loggedIn: true,
    mid: 42,
    uname: '测试UP',
    face: 'https://i0.hdslb.com/bfs/face/x.jpg',
    level: 6,
    follower: 1234,
    vip: { status: 1, label: '年度大会员' },
  }), {
    mid: 42,
    name: '测试UP',
    face: 'https://i0.hdslb.com/bfs/face/x.jpg',
    fans: 1234,
    level: 6,
    vip: { status: 1, label: '年度大会员' },
    url: 'https://space.bilibili.com/42',
  });
  // 嵌套 user 字段也能兜底
  const nested = userFromNav({ loggedIn: true, user: { mid: 7, name: '嵌套', face: 'f' } });
  assert.equal(nested.mid, 7);
  assert.equal(nested.name, '嵌套');
  assert.equal(nested.url, 'https://space.bilibili.com/7');
});

test('auth: loginStart 生成合法 PNG 到 %TEMP%，返回 key/url/有效期/路径', async (t) => {
  const key = 't3-start-1';
  cleanupQrFiles(t, [key]);
  const { auth } = makeAuth({
    loginStart: () => ({ qrcodeKey: key, url: LOGIN_URL, expiresInSec: 180 }),
  });
  const started = await auth.loginStart();
  assert.equal(started.qrcodeKey, key);
  assert.equal(started.url, LOGIN_URL);
  assert.equal(started.expiresInSec, 180);
  assert.equal(typeof started.qrFile, 'string');
  assert.ok(started.qrFile.startsWith(os.tmpdir()), `应落在 %TEMP%：${started.qrFile}`);
  assert.equal(started.qrFile, qrFileFor(key));
  assert.equal(fs.existsSync(started.qrFile), true);

  const bytes = await fsp.readFile(started.qrFile);
  assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE, '必须是 PNG');
  const dimensions = pngDimensions(bytes);
  assert.equal(dimensions.width, dimensions.height, '二维码是正方形');
  assert.ok(dimensions.width >= 100, `二维码尺寸过小：${dimensions.width}`);

  await auth.removeQrFile(started.qrFile);
  assert.equal(fs.existsSync(started.qrFile), false, 'removeQrFile 应删除临时文件');
});

test('auth: loginPoll 成功后把 Cookie 写进 config.cookieEnv，并删掉二维码文件', async (t) => {
  const key = 't3-poll-ok';
  cleanupQrFiles(t, [key]);
  const { auth, credentials } = makeAuth({
    loginStart: () => ({ qrcodeKey: key, url: LOGIN_URL, expiresInSec: 180 }),
    loginPoll: () => ({ state: 'ok', code: 0, message: '', cookieString: COOKIE_STRING, user: { mid: 42, uname: '扫码用户' } }),
  });
  const started = await auth.loginStart();
  assert.equal(fs.existsSync(started.qrFile), true);

  const polled = await auth.loginPoll(key);
  assert.equal(polled.state, 'ok');
  assert.equal(polled.saved, true);
  assert.deepEqual(polled.user, { mid: 42, uname: '扫码用户' });
  assert.equal(credentials.values.BILI_COOKIE, COOKIE_STRING, 'Cookie 应写入配置的凭据名');
  assert.equal(fs.existsSync(started.qrFile), false, '登录成功后二维码临时文件应删除');
});

test('auth: loginPoll 等待/已扫码/过期状态不写 Cookie，过期时删二维码', async (t) => {
  const waitingKey = 't3-poll-waiting';
  cleanupQrFiles(t, [waitingKey]);
  const waiting = makeAuth({
    loginStart: () => ({ qrcodeKey: waitingKey, url: LOGIN_URL, expiresInSec: 180 }),
    loginPoll: () => ({ state: 'waiting', code: 86101, message: '未扫码' }),
  });
  const waitingStarted = await waiting.auth.loginStart();
  const waitingPolled = await waiting.auth.loginPoll(waitingKey);
  assert.equal(waitingPolled.state, 'waiting');
  assert.equal(waitingPolled.saved, false);
  assert.equal(waiting.credentials.values.BILI_COOKIE, undefined);
  assert.equal(fs.existsSync(waitingStarted.qrFile), true, '等待中二维码文件应保留');

  const expiredKey = 't3-poll-expired';
  const expired = makeAuth({
    loginStart: () => ({ qrcodeKey: expiredKey, url: LOGIN_URL }),
    loginPoll: () => ({ state: 'expired', code: 86038, message: '二维码已失效' }),
  });
  const expiredStarted = await expired.auth.loginStart();
  const expiredPolled = await expired.auth.loginPoll(expiredKey);
  assert.equal(expiredPolled.state, 'expired');
  assert.equal(expiredPolled.saved, false);
  assert.equal(expired.credentials.values.BILI_COOKIE, undefined);
  assert.equal(fs.existsSync(expiredStarted.qrFile), false, '过期后应删除二维码文件');
});

test('auth: 登录成功但没有凭据服务时抛 BILI_AUTH_REQUIRED', async (t) => {
  const key = 't3-no-credentials';
  cleanupQrFiles(t, [key]);
  const { auth } = makeAuth({
    credentials: null,
    loginStart: () => ({ qrcodeKey: key, url: LOGIN_URL }),
    loginPoll: () => ({ state: 'ok', code: 0, message: '', cookieString: COOKIE_STRING }),
  });
  const started = await auth.loginStart();
  await assert.rejects(
    () => auth.loginPoll(key),
    (error) => error instanceof BiliError && error.code === CODES.AUTH_REQUIRED && /凭据/.test(error.message),
  );
  assert.equal(fs.existsSync(started.qrFile), false, '即使保存失败，二维码也不该留在 %TEMP%');
});

test('auth: loginPoll 缺 key / 状态非法 / 成功但没 Cookie 都给出清晰错误', async () => {
  const missingKey = makeAuth();
  await assert.rejects(
    () => missingKey.auth.loginPoll(''),
    (error) => error instanceof BiliError && error.code === CODES.INVALID_ARGUMENT,
  );

  const badState = makeAuth({ loginPoll: () => ({ state: 'weird', code: 1, message: '' }) });
  await assert.rejects(
    () => badState.auth.loginPoll('k'),
    (error) => error instanceof BiliError && error.code === CODES.API,
  );

  const noCookie = makeAuth({ loginPoll: () => ({ state: 'ok', code: 0, message: '', cookieString: '' }) });
  await assert.rejects(
    () => noCookie.auth.loginPoll('k'),
    (error) => error instanceof BiliError && error.code === CODES.API && /Cookie/.test(error.message),
  );
});

test('auth: loginStart 对不完整响应抛 BILI_API，凭据缺失只告警不阻塞', async () => {
  const broken = makeAuth({ loginStart: () => ({}) });
  await assert.rejects(
    () => broken.auth.loginStart(),
    (error) => error instanceof BiliError && error.code === CODES.API,
  );

  const key = 't3-warn-no-cred';
  const { auth, credentials } = makeAuth({ credentials: null, loginStart: () => ({ qrcodeKey: key, url: LOGIN_URL }) });
  const started = await auth.loginStart({ write: false });
  assert.equal(started.qrFile, undefined, 'write=false 时不落盘');
  assert.equal(started.qrcodeKey, key);
  assert.equal(credentials, undefined);
});

test('auth: logout 调 api.logout 并删除凭据；没有凭据服务时抛 BILI_AUTH_REQUIRED', async () => {
  const { auth, api, credentials } = makeAuth();
  await credentials.set('BILI_COOKIE', COOKIE_STRING);
  const result = await auth.logout();
  assert.deepEqual(result, { cleared: true });
  assert.equal(credentials.values.BILI_COOKIE, undefined);
  assert.ok(api.calls.some((call) => call.method === 'logout'), '应调用 api.logout');

  const withoutCredentials = createAuth({
    api: createFakeApi({ logout: () => ({ cleared: true }), nav: () => ({ loggedIn: false }) }),
    credentials: undefined,
    config: { cookieEnv: 'BILI_COOKIE' },
    logger: createFakeLogger(),
  });
  await assert.rejects(
    () => withoutCredentials.logout(),
    (error) => error instanceof BiliError && error.code === CODES.AUTH_REQUIRED,
  );
});

test('auth: status 返回登录态与凭据描述', async () => {
  const offline = makeAuth({ nav: () => ({ loggedIn: false }) });
  const offlineStatus = await offline.auth.status();
  assert.equal(offlineStatus.loggedIn, false);
  assert.equal(offlineStatus.user, undefined);
  assert.equal(offlineStatus.credential.available, true);

  const online = makeAuth({
    nav: () => ({ loggedIn: true, mid: 42, uname: '在线用户', level: 6, follower: 10 }),
  });
  const onlineStatus = await online.auth.status();
  assert.equal(onlineStatus.loggedIn, true);
  assert.equal(onlineStatus.user.name, '在线用户');
  assert.equal(onlineStatus.user.mid, 42);
});

// ---------------------------------------------------------------------------
// bili_login
// ---------------------------------------------------------------------------

test('bili_login: 只有一个工具，参数为 action(enum) + qrcodeKey，未强制任何必填', () => {
  const { deps } = makeToolDeps();
  const tools = createLoginTools(deps);
  assert.equal(tools.length, 1);
  const definition = tools[0];
  assert.equal(definition.name, 'bili_login');
  assert.equal(definition.parameters.type, 'object');
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ['action', 'qrcodeKey']);
  assert.deepEqual(definition.parameters.properties.action.enum, ['start', 'poll', 'logout', 'status']);
  assert.equal(definition.parameters.required, undefined, '动作默认 status，因此没有必填参数');
  assert.equal(typeof definition.output.render, 'function');
});

test('bili_login action=start：返回契约 data + 二维码图片附件，并删掉 %TEMP% 文件', async (t) => {
  const key = 't3-tool-start';
  cleanupQrFiles(t, [key]);
  const saved = withQrDir(t);
  let attachedPath = '';
  const { deps } = makeToolDeps({
    apiOverrides: { loginStart: () => ({ qrcodeKey: key, url: LOGIN_URL, expiresInSec: 180 }) },
    images: {
      attachFile: async (filePath) => {
        attachedPath = filePath;
        assert.equal(fs.existsSync(filePath), true, 'attachFile 时临时文件应存在');
        return { blocks: [{ type: 'image', mediaType: 'image/png', attachmentId: 'att-1' }], attached: true };
      },
    },
  });
  const [definition] = createLoginTools(deps);
  const { value, blocks, text } = await executeTool(definition, { action: 'start' });

  assert.equal(value.ok, true);
  assert.deepEqual(Object.keys(value.data).sort(), ['expiresInSec', 'qr', 'qrcodeKey', 'url']);
  assert.equal(value.data.qrcodeKey, key);
  assert.equal(value.data.url, LOGIN_URL);
  assert.equal(value.data.expiresInSec, 180);
  assert.deepEqual(value.data.qr, { attached: true, file: saved });
  assert.equal(attachedPath, qrFileFor(key));
  assert.equal(fs.existsSync(attachedPath), false, '挂完附件后应删除临时文件');
  assert.equal(fs.existsSync(saved), true, '应保留下载目录里的二维码副本');
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[1].type, 'image', '图片块应追加在文本之后');
  assert.ok(text.includes('bili_login action=poll'), '文本应提示下一步 poll');
  assert.deepEqual(fenceOf(text), { ok: true, data: jsonRoundTrip(value.data) });
});

test('bili_login action=start：attachImages=false 时不挂附件，但仍落盘二维码副本', async (t) => {
  const key = 't3-tool-start-noattach';
  cleanupQrFiles(t, [key]);
  const saved = withQrDir(t);
  let attachCalls = 0;
  const { deps } = makeToolDeps({
    config: { attachImages: false },
    apiOverrides: { loginStart: () => ({ qrcodeKey: key, url: LOGIN_URL, expiresInSec: 180 }) },
    images: {
      attachFile: async () => {
        attachCalls += 1;
        return { blocks: [], attached: false };
      },
    },
  });
  const [definition] = createLoginTools(deps);
  const { value, blocks, text } = await executeTool(definition, { action: 'start' });

  assert.deepEqual(value.data.qr, { attached: false, file: saved });
  assert.equal(attachCalls, 0, 'attachImages=false 时不该调用附件服务');
  assert.equal(fs.existsSync(qrFileFor(key)), false, '临时 PNG 在持久化副本后应删除');
  assert.equal(fs.existsSync(saved), true, '二维码副本应存在');
  assert.equal(blocks.filter((block) => block.type === 'image').length, 0);
  assert.ok(text.includes('已保存到'), '文本应给出落盘路径');
  assert.ok(text.includes(saved));
});

test('bili_login action=start：附件失败时降级为落盘副本并给出路径', async (t) => {
  const key = 't3-tool-start-fallback';
  cleanupQrFiles(t, [key]);
  const saved = withQrDir(t);
  const { deps } = makeToolDeps({
    apiOverrides: { loginStart: () => ({ qrcodeKey: key, url: LOGIN_URL, expiresInSec: 180 }) },
    images: {
      attachFile: async () => {
        throw new Error('attachments 服务未挂载');
      },
    },
  });
  const [definition] = createLoginTools(deps);
  const { value, blocks, text } = await executeTool(definition, { action: 'start' });

  assert.equal(value.data.qr.attached, false);
  assert.equal(value.data.qr.file, saved);
  assert.equal(fs.existsSync(value.data.qr.file), true, '降级时应保留 PNG 供手动打开');
  assert.equal(blocks.filter((block) => block.type === 'image').length, 0);
  assert.ok(text.includes(saved));
});

test('bili_login action=poll：成功后 data 形状正确、Cookie 写入凭据', async (t) => {
  const key = 't3-tool-poll';
  cleanupQrFiles(t, [key]);
  const { deps, credentials } = makeToolDeps({
    apiOverrides: {
      loginStart: () => ({ qrcodeKey: key, url: LOGIN_URL, expiresInSec: 180 }),
      loginPoll: () => ({ state: 'ok', code: 0, message: '', cookieString: COOKIE_STRING, user: { mid: 42, uname: '扫码用户', face: 'f' } }),
    },
  });
  const [definition] = createLoginTools(deps);
  // start 一下，让 auth 有二维码可清理
  await executeTool(definition, { action: 'start' });
  const { value, text } = await executeTool(definition, { action: 'poll', qrcodeKey: key });

  assert.deepEqual(Object.keys(value.data).sort(), ['code', 'message', 'state', 'user']);
  assert.equal(value.data.state, 'ok');
  assert.equal(value.data.code, 0);
  assert.equal(value.data.user.uname, '扫码用户');
  assert.equal(credentials.values.BILI_COOKIE, COOKIE_STRING);
  assert.ok(text.includes('登录成功'));
  assert.deepEqual(fenceOf(text), { ok: true, data: jsonRoundTrip(value.data) });
});

test('bili_login action=poll：缺 qrcodeKey 抛 BILI_INVALID_ARGUMENT；非法 action 被 schema 拒绝', async () => {
  const { deps } = makeToolDeps();
  const [definition] = createLoginTools(deps);
  await assert.rejects(
    () => definition.execute({ action: 'poll' }, {}),
    (error) => error instanceof BiliError && error.code === CODES.INVALID_ARGUMENT,
  );
  await assert.rejects(
    () => definition.execute({ action: 'bogus' }, {}),
    /只能是/,
  );
  await assert.rejects(
    () => definition.execute({ action: 'status', unknown: 1 }, {}),
    /不认识的参数/,
  );
});

test('bili_login action=logout / status（默认动作）', async () => {
  const { deps, credentials } = makeToolDeps({
    credentialsValues: { BILI_COOKIE: COOKIE_STRING },
    apiOverrides: {
      nav: () => ({ loggedIn: false }),
      logout: () => ({ cleared: true }),
    },
  });
  const [definition] = createLoginTools(deps);

  const logout = await executeTool(definition, { action: 'logout' });
  assert.deepEqual(logout.value.data, { cleared: true });
  assert.equal(credentials.values.BILI_COOKIE, undefined);

  const status = await executeTool(definition, {});
  assert.deepEqual(status.value.data, { loggedIn: false });
  assert.ok(status.text.includes('未登录'));
  assert.deepEqual(fenceOf(status.text), { ok: true, data: { loggedIn: false } });

  const loggedIn = await executeTool(definition, { action: 'status' });
  assert.deepEqual(loggedIn.value.data, { loggedIn: false });
});

test('bili_login action=status：已登录时带上 user', async () => {
  const { deps } = makeToolDeps({
    apiOverrides: { nav: () => ({ loggedIn: true, mid: 42, uname: '在线', level: 6 }) },
  });
  const [definition] = createLoginTools(deps);
  const { value } = await executeTool(definition, { action: 'status' });
  assert.equal(value.data.loggedIn, true);
  assert.equal(value.data.user.name, '在线');
  assert.equal(value.data.user.url, 'https://space.bilibili.com/42');
});

// ---------------------------------------------------------------------------
// 个人数据工具
// ---------------------------------------------------------------------------

/**
 * 造一个「已登录 nav」。
 * @returns {object} nav 响应。
 */
function loggedInNav() {
  return { loggedIn: true, mid: 42, uname: '测试UP', face: 'face.jpg', level: 6, follower: 1234 };
}

test('bili_me / bili_history / bili_favorites / bili_follows / bili_dynamic：工具名与参数 schema', () => {
  const { deps } = makeToolDeps();
  const tools = createPersonalTools(deps);
  assert.deepEqual(tools.map((tool) => tool.name), ['bili_me', 'bili_history', 'bili_favorites', 'bili_follows', 'bili_dynamic']);

  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(byName.bili_me.parameters.properties), []);
  assert.deepEqual(Object.keys(byName.bili_history.parameters.properties).sort(), ['cursor', 'limit']);
  assert.deepEqual(Object.keys(byName.bili_favorites.parameters.properties).sort(), ['action', 'mediaId', 'page']);
  assert.deepEqual(byName.bili_favorites.parameters.properties.action.enum, ['list', 'items']);
  assert.deepEqual(Object.keys(byName.bili_follows.parameters.properties).sort(), ['limit', 'page', 'vmid']);
  assert.deepEqual(Object.keys(byName.bili_dynamic.parameters.properties).sort(), ['limit', 'page']);
  // 这 5 个工具的参数都是可选的（契约 §10 没有标 *）
  for (const tool of tools) assert.equal(tool.parameters.required, undefined, `${tool.name} 不应有必填参数`);
});

test('bili_me：已登录返回契约 User 形状；未登录抛 BILI_AUTH_REQUIRED', async () => {
  const online = makeToolDeps({ apiOverrides: { nav: () => loggedInNav() } });
  const [me] = [createPersonalTools(online.deps)[0]];
  const { value, text } = await executeTool(me, {});
  assert.deepEqual(Object.keys(value.data), ['user']);
  assert.equal(value.data.user.mid, 42);
  assert.equal(value.data.user.name, '测试UP');
  assert.equal(value.data.user.fans, 1234);
  assert.equal(value.data.user.level, 6);
  assert.equal(value.data.user.url, 'https://space.bilibili.com/42');
  assert.ok(text.includes('测试UP'));
  assert.deepEqual(fenceOf(text), { ok: true, data: jsonRoundTrip(value.data) });

  const offline = makeToolDeps({ apiOverrides: { nav: () => ({ loggedIn: false }) } });
  const [meOffline] = createPersonalTools(offline.deps);
  await assert.rejects(
    () => meOffline.execute({}, {}),
    (error) => error instanceof BiliError && error.code === CODES.AUTH_REQUIRED,
  );
});

test('bili_history：按 maxListedItems 截断，返回 { items, cursor, hasMore }', async () => {
  const many = Array.from({ length: 5 }, (_, index) => ({
    title: `视频${index + 1}`,
    author: 'UP',
    progressSec: index * 10,
    durationSec: 100,
    viewedAtText: '昨天',
    url: `https://www.bilibili.com/video/BV${index}`,
  }));
  const { deps, api } = makeToolDeps({
    apiOverrides: { history: () => ({ items: many, cursor: 12345, hasMore: true }) },
  });
  const history = createPersonalTools(deps).find((tool) => tool.name === 'bili_history');
  const { value, text } = await executeTool(history, {});
  assert.equal(value.data.items.length, 3, '应截断到 maxListedItems');
  assert.equal(value.data.cursor, 12345);
  assert.equal(value.data.hasMore, true);
  const call = api.calls.find((entry) => entry.method === 'history');
  assert.deepEqual(call.args[0], { limit: 3, cursor: undefined });
  assert.ok(text.includes('观看历史'));

  const limited = await executeTool(history, { limit: 2, cursor: 12345 });
  assert.equal(limited.value.data.items.length, 2);
  const secondCall = api.calls.filter((entry) => entry.method === 'history')[1];
  assert.deepEqual(secondCall.args[0], { limit: 2, cursor: 12345 });
});

test('bili_favorites：list 返回 { folders }，items 需要 mediaId', async () => {
  const folders = Array.from({ length: 4 }, (_, index) => ({ id: index + 1, title: `收藏夹${index + 1}`, count: index * 2 }));
  const items = Array.from({ length: 4 }, (_, index) => ({ type: 'video', title: `收藏${index}`, url: 'u' }));
  const { deps, api } = makeToolDeps({
    apiOverrides: {
      favorites: (options) => (options.action === 'list'
        ? { folders }
        : { items, page: options.page, hasMore: true }),
    },
  });
  const favorites = createPersonalTools(deps).find((tool) => tool.name === 'bili_favorites');

  const list = await executeTool(favorites, {});
  assert.deepEqual(Object.keys(list.value.data), ['folders']);
  assert.equal(list.value.data.folders.length, 3);
  const listCall = api.calls.find((entry) => entry.method === 'favorites');
  assert.deepEqual(listCall.args[0], { action: 'list', limit: 3 });

  await assert.rejects(
    () => favorites.execute({ action: 'items' }, {}),
    (error) => error instanceof BiliError && error.code === CODES.INVALID_ARGUMENT,
  );

  const pages = await executeTool(favorites, { action: 'items', mediaId: 7, page: 2 });
  assert.deepEqual(Object.keys(pages.value.data).sort(), ['hasMore', 'items', 'page']);
  assert.equal(pages.value.data.items.length, 3);
  assert.equal(pages.value.data.page, 2);
  const itemsCall = api.calls.filter((entry) => entry.method === 'favorites')[1];
  assert.deepEqual(itemsCall.args[0], { action: 'items', mediaId: 7, page: 2, limit: 3 });
});

test('bili_follows / bili_dynamic：返回形状与翻页参数', async () => {
  const users = Array.from({ length: 5 }, (_, index) => ({ mid: index + 1, name: `UP${index + 1}`, fans: 100 * index }));
  const dynamics = Array.from({ length: 5 }, (_, index) => ({
    id: `dyn-${index}`,
    type: 'video',
    pubTimeText: '1 小时前',
    text: `动态正文 ${index}`,
    author: { mid: 42, name: 'UP主' },
    url: 'u',
  }));
  const { deps, api } = makeToolDeps({
    apiOverrides: {
      follows: () => ({ items: users, page: 2, hasMore: true }),
      dynamic: () => ({ items: dynamics, offset: 999, hasMore: true }),
    },
  });
  const tools = createPersonalTools(deps);
  const follows = tools.find((tool) => tool.name === 'bili_follows');
  const dynamic = tools.find((tool) => tool.name === 'bili_dynamic');

  const followsResult = await executeTool(follows, { vmid: 42, page: 2 });
  assert.deepEqual(Object.keys(followsResult.value.data).sort(), ['hasMore', 'items', 'page']);
  assert.equal(followsResult.value.data.items.length, 3);
  assert.equal(followsResult.value.data.page, 2);
  const followsCall = api.calls.find((entry) => entry.method === 'follows');
  assert.deepEqual(followsCall.args[0], { vmid: 42, page: 2, limit: 3 });

  const dynamicResult = await executeTool(dynamic, { page: 1 });
  assert.deepEqual(Object.keys(dynamicResult.value.data).sort(), ['hasMore', 'items', 'offset']);
  assert.equal(dynamicResult.value.data.items.length, 3);
  assert.equal(dynamicResult.value.data.offset, 999);
  assert.ok(dynamicResult.text.includes('UP主'));

  // vmid 非法
  await assert.rejects(
    () => follows.execute({ vmid: 0 }, {}),
    (error) => error instanceof BiliError && error.code === CODES.INVALID_ARGUMENT,
  );
});

// ---------------------------------------------------------------------------
// bili_download
// ---------------------------------------------------------------------------

test('bili_download：timeoutMs=1800000、isConcurrencySafe=false、target 必填', () => {
  const { deps } = makeToolDeps();
  const tools = createDownloadTools(deps);
  assert.equal(tools.length, 1);
  const definition = tools[0];
  assert.equal(definition.name, 'bili_download');
  assert.equal(definition.timeoutMs, 1800000);
  assert.equal(typeof definition.isConcurrencySafe, 'function');
  assert.equal(definition.isConcurrencySafe(), false);
  assert.deepEqual(definition.parameters.required, ['target']);
  assert.deepEqual(definition.parameters.properties.quality.enum, ['best', '1080', '720', '480', '360']);
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), [
    'audioOnly', 'dir', 'overwrite', 'page', 'quality', 'target',
  ]);
});

test('bili_download：调用 downloader.run 并返回契约 §10 的 data 形状', async () => {
  /** @type {object[]} */
  const runCalls = [];
  const expected = {
    file: path.join(os.tmpdir(), 'downloaded.mp4'),
    bytes: 2048,
    sizeText: '2.0 KB',
    quality: '1080P',
    durationSec: 90,
    merged: true,
    audioOnly: false,
    elapsedMs: 2500,
  };
  const { deps } = makeToolDeps({
    downloader: {
      run: async (args, exec) => {
        runCalls.push({ args, exec });
        return expected;
      },
    },
  });
  const [definition] = createDownloadTools(deps);
  const signal = new AbortController().signal;
  const { value, text } = await executeTool(
    definition,
    { target: 'BV1xx411c7mD', page: 2, quality: '720', audioOnly: true, dir: 'anime', overwrite: true },
    { signal },
  );

  assert.deepEqual(value, { ok: true, data: expected });
  assert.deepEqual(Object.keys(value.data).sort(), [
    'audioOnly', 'bytes', 'durationSec', 'elapsedMs', 'file', 'merged', 'quality', 'sizeText',
  ]);
  assert.equal(runCalls.length, 1);
  assert.deepEqual(runCalls[0].args, {
    target: 'BV1xx411c7mD',
    page: 2,
    quality: '720',
    audioOnly: true,
    dir: 'anime',
    overwrite: true,
  });
  assert.equal(runCalls[0].exec.signal, signal, 'exec.signal 必须透传给下载器');
  assert.ok(text.includes('downloaded.mp4'));
  assert.ok(text.includes('2.0 KB'));
  assert.deepEqual(fenceOf(text), { ok: true, data: expected });
});

test('bili_download：参数校验与下载器缺失', async () => {
  const { deps } = makeToolDeps();
  const [definition] = createDownloadTools(deps);
  await assert.rejects(
    () => definition.execute({}, {}),
    /缺少必填参数 target/,
  );
  await assert.rejects(
    () => definition.execute({ target: 'BV1', quality: '4k' }, {}),
    /只能是/,
  );
  await assert.rejects(
    () => definition.execute({ target: 'BV1', audioOnly: 'yes' }, {}),
    /布尔值/,
  );

  const broken = createDownloadTools({ deps: undefined, downloader: undefined, config: {} });
  await assert.rejects(
    () => broken[0].execute({ target: 'BV1' }, {}),
    (error) => error instanceof BiliError && error.code === CODES.INTERNAL,
  );
});

test('bili_download：正文区分 ffmpeg 合并 / 音频转封装 / durl 回退三种情况', async () => {
  const base = {
    bytes: 100,
    sizeText: '100 B',
    quality: '1080P',
    durationSec: 5,
    elapsedMs: 10,
  };
  /**
   * 用指定结果渲染一次正文。
   * @param {object} result - downloader.run 的返回值。
   * @returns {Promise<string>} 正文文本。
   */
  const renderWith = async (result) => {
    const { deps } = makeToolDeps({ downloader: { run: async () => result } });
    const [definition] = createDownloadTools(deps);
    const { text } = await executeTool(definition, { target: 'BV1xx411c7mD' });
    return text;
  };

  const merged = await renderWith({ ...base, file: 'C:\\Downloads\\a.mp4', merged: true, audioOnly: false });
  assert.ok(merged.includes('ffmpeg 无损合并'));

  const m4a = await renderWith({ ...base, file: 'C:\\Downloads\\a.m4a', merged: false, audioOnly: true });
  assert.ok(m4a.includes('转封装为 .m4a'));

  const rawAudio = await renderWith({ ...base, file: 'C:\\Downloads\\a.m4s', merged: false, audioOnly: true });
  assert.ok(rawAudio.includes('DASH 原始分片'));

  const durl = await renderWith({ ...base, file: 'C:\\Downloads\\a.mp4', merged: false, audioOnly: false });
  assert.ok(durl.includes('durl'));
});

test('三组工具一起注册时共 7 个工具且名字唯一（契约 §10 的 T3 部分）', () => {
  const { deps } = makeToolDeps();
  const definitions = [
    ...createLoginTools(deps),
    ...createPersonalTools(deps),
    ...createDownloadTools(deps),
  ];
  const names = definitions.map((definition) => definition.name).sort();
  assert.deepEqual(names, [
    'bili_download',
    'bili_dynamic',
    'bili_favorites',
    'bili_follows',
    'bili_history',
    'bili_login',
    'bili_me',
  ]);
  assert.equal(new Set(names).size, names.length);
});
