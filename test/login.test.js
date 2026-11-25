/**
 * 扫码登录的离线回归：Cookie 来源（Set-Cookie / 回跳 URL）、状态机与二维码持久化副本。
 *
 * 2026-11 真机发现：B 站扫码成功后 `data.url` 可能为空，Cookie 通过轮询响应的
 * `Set-Cookie` 下发；这里锁定这条路径，防止再次出现「登录成功但没 Cookie」。
 *
 * @module test/login.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBiliApi } from '../lib/api.js';
import { createLoginTools } from '../lib/tools/login.js';
import { createFakeHttp, executeTool } from './helpers.js';

/**
 * 造一个只用于登录轮询的 api（其余依赖都是空壳）。
 * @param {object} http - 假 HTTP。
 * @returns {object} BiliApi。
 */
function createApi(http) {
  return createBiliApi({
    http,
    cookies: { header: async () => '' },
    wbi: { sign: async () => '' },
    appApi: {},
    config: { maxListedItems: 5 },
    logger: { warn: () => {} },
  });
}

/**
 * 造一个带 `getSetCookie()` 的响应头替身。
 * @param {string[]} cookies - Set-Cookie 值。
 * @returns {object} Headers 替身。
 */
function headersWith(cookies) {
  return { getSetCookie: () => cookies };
}

test('loginPoll：Cookie 由 Set-Cookie 下发时也能拿到（新行为）', async () => {
  const http = createFakeHttp({});
  http.getJsonDetailed = async () => ({
    json: { code: 0, data: { code: 0, url: '', message: '' } },
    headers: headersWith([
      'SESSDATA=abc%2C123; Path=/; Domain=.bilibili.com; HttpOnly',
      'bili_jct=def456; Path=/',
      'DedeUserID=42; Path=/',
      'DedeUserID__ckMd5=xyz789; Path=/',
      'sid=s1; Path=/',
    ]),
    status: 200,
  });
  const result = await createApi(http).loginPoll('key');
  assert.equal(result.state, 'ok');
  assert.match(result.cookieString, /SESSDATA=abc%2C123/);
  assert.match(result.cookieString, /bili_jct=def456/);
  assert.match(result.cookieString, /DedeUserID=42/);
  assert.match(result.cookieString, /DedeUserID__ckMd5=xyz789/);
  assert.match(result.cookieString, /sid=s1/);
});

test('loginPoll：回退 URL 里的 Cookie 仍可用', async () => {
  const http = createFakeHttp({});
  http.getJsonDetailed = async () => ({
    json: {
      code: 0,
      data: {
        code: 0,
        url: 'https://passport.biligame.com/crossDomain?DedeUserID=7&SESSDATA=urlsess&bili_jct=urljct',
        message: '',
      },
    },
    headers: headersWith([]),
    status: 200,
  });
  const result = await createApi(http).loginPoll('key');
  assert.equal(result.state, 'ok');
  assert.match(result.cookieString, /DedeUserID=7/);
  assert.match(result.cookieString, /SESSDATA=urlsess/);
  assert.match(result.cookieString, /bili_jct=urljct/);
});

test('loginPoll：Set-Cookie 与 URL 合并，同名以 URL 为准', async () => {
  const http = createFakeHttp({});
  http.getJsonDetailed = async () => ({
    json: { code: 0, data: { code: 0, url: 'https://x/?SESSDATA=from-url&bili_jct=from-url-jct', message: '' } },
    headers: headersWith(['SESSDATA=from-header; Path=/', 'DedeUserID=9; Path=/']),
    status: 200,
  });
  const result = await createApi(http).loginPoll('key');
  assert.match(result.cookieString, /SESSDATA=from-url/);
  assert.match(result.cookieString, /bili_jct=from-url-jct/);
  assert.match(result.cookieString, /DedeUserID=9/);
});

test('loginPoll：86090 已扫码、86038 已失效、86101 等待', async () => {
  for (const [code, state] of [[86090, 'scanned'], [86038, 'expired'], [86101, 'waiting']]) {
    const http = createFakeHttp({});
    http.getJsonDetailed = async () => ({
      json: { code: 0, data: { code, url: '', message: 'x' } },
      headers: headersWith([]),
      status: 200,
    });
    const result = await createApi(http).loginPoll('key');
    assert.equal(result.state, state);
    assert.equal(result.code, code);
    assert.equal(result.cookieString, undefined);
  }
});

test('bili_login start：二维码 PNG 复制到下载目录，并在文本里给出路径', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-qr-'));
  const previous = process.env.BILI_QR_DIR;
  process.env.BILI_QR_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.BILI_QR_DIR;
    else process.env.BILI_QR_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const tempQr = path.join(directory, 'tmp-qr.png');
  fs.writeFileSync(tempQr, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const tools = createLoginTools({
    api: {},
    config: { attachImages: false },
    logger: { warn: () => {} },
    auth: {
      loginStart: async () => ({ qrcodeKey: 'k1', url: 'https://example.test/qr', expiresInSec: 180, qrFile: tempQr }),
      loginPoll: async () => ({ state: 'ok', code: 0, message: '' }),
      logout: async () => ({ cleared: true }),
      status: async () => ({ loggedIn: false }),
      removeQrFile: async () => {},
    },
  });
  const tool = tools.find((entry) => entry.name === 'bili_login');
  const { value, text } = await executeTool(tool, { action: 'start' });
  const saved = path.join(directory, 'bilibili-login-qr.png');
  assert.ok(fs.existsSync(saved), '应把二维码复制到下载目录');
  assert.equal(value.data.qr.file, saved);
  assert.match(text, /二维码图片已保存到/);
  assert.match(text, new RegExp(saved.replace(/\\/g, '\\\\')));
});
