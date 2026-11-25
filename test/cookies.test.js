/**
 * Cookie 罐：游客 Cookie 引导、用户 Cookie 拼装、12 小时缓存、失败降级与状态。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBiliLsId,
  createCookieJar,
  createUuid,
  parseSetCookies,
  readSetCookies,
  serializeCookies,
} from '../lib/cookies.js';
import { createFakeHttp, createFakeLogger } from './helpers.js';

/**
 * 造一个「带 Set-Cookie」的响应头替身。
 * @param {string[]} setCookies - Set-Cookie 列表。
 * @returns {{ getSetCookie: () => string[], get: (name: string) => string | null }} 头。
 */
function headersWithSetCookies(setCookies) {
  return {
    getSetCookie: () => [...setCookies],
    get: (name) => (name.toLowerCase() === 'set-cookie' ? setCookies.join(', ') : null),
  };
}

/**
 * 造一个只有合并 `set-cookie` 字符串的响应头（模拟旧 Node）。
 * @param {string} combined - 合并后的 Set-Cookie。
 * @returns {{ get: (name: string) => string | null }} 头。
 */
function headersWithCombined(combined) {
  return {
    get: (name) => (name.toLowerCase() === 'set-cookie' ? combined : null),
  };
}

/**
 * 造假的 open 响应。
 * @param {object} headers - 响应头。
 * @returns {object} 响应。
 */
function openResponse(headers) {
  return { status: 200, headers, body: null, contentLength: undefined, url: 'https://www.bilibili.com/' };
}

/**
 * 造一罐 Cookie。
 * @param {{ http?: object, now?: () => number, resolveUserCookie?: Function,
 *   describeUserCookie?: Function, logger?: object }} [options] - 选项。
 * @returns {object} Cookie 罐。
 */
function makeJar(options = {}) {
  return createCookieJar({
    http: options.http,
    config: { cookieEnv: 'BILI_COOKIE' },
    logger: options.logger ?? createFakeLogger(),
    resolveUserCookie: options.resolveUserCookie,
    describeUserCookie: options.describeUserCookie,
    now: options.now,
  });
}

test('readSetCookies：优先 getSetCookie，其次拆合并串', () => {
  const split = readSetCookies(headersWithSetCookies(['a=1; Path=/', 'b=2; Path=/']));
  assert.deepEqual(split, ['a=1; Path=/', 'b=2; Path=/']);

  const combined = readSetCookies(headersWithCombined('a=1; Path=/, b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT'));
  assert.deepEqual(combined, ['a=1; Path=/', 'b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT']);

  assert.deepEqual(readSetCookies(null), []);
  assert.deepEqual(readSetCookies({}), []);
});

test('parseSetCookies / serializeCookies', () => {
  const pairs = parseSetCookies([
    'buvid3=AAA; Path=/; HttpOnly',
    'b_nut=123; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
    '"quoted"="x y"; Path=/',
    'empty=; Path=/',
    'novalue',
  ]);
  assert.equal(pairs.get('buvid3'), 'AAA');
  assert.equal(pairs.get('b_nut'), '123');
  assert.equal(pairs.get('quoted'), 'x y');
  assert.equal(pairs.has('empty'), false);
  assert.equal(pairs.has('novalue'), false);
  assert.equal(serializeCookies(pairs), 'buvid3=AAA; b_nut=123; quoted=x y');
});

test('_uuid 与 b_lsid 格式', () => {
  assert.match(createUuid(), /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  assert.match(createBiliLsId(), /^[0-9A-F]{8}_[0-9A-F]{8}$/);
  assert.notEqual(createUuid(), createUuid());
});

test('header 引导游客 Cookie 并拼接用户 Cookie（用户在后）', async () => {
  const http = createFakeHttp({
    'www.bilibili.com/': openResponse(headersWithSetCookies(['buvid3=home-buvid3; Path=/', 'b_nut=1700000000; Path=/'])),
    'frontend/finger/spi': { code: 0, data: { b_3: 'spi-buvid3', b_4: 'spi-buvid4' } },
  });
  let resolveCount = 0;
  const jar = makeJar({
    http,
    resolveUserCookie: async () => {
      resolveCount += 1;
      return 'SESSDATA=sess; bili_jct=jct';
    },
  });

  const header = await jar.header();
  assert.match(header, /buvid3=spi-buvid3/);
  assert.match(header, /buvid4=spi-buvid4/);
  assert.match(header, /b_nut=1700000000/);
  assert.match(header, /_uuid=[0-9A-F-]{36}/);
  assert.match(header, /b_lsid=[0-9A-F]{8}_[0-9A-F]{8}/);
  assert.match(header, /SESSDATA=sess; bili_jct=jct$/);
  assert.ok(header.indexOf('buvid3=') < header.indexOf('SESSDATA='), '用户 Cookie 应拼在游客 Cookie 后面');
  assert.equal(resolveCount, 1);
  assert.equal(http.calls.length, 2);
  assert.equal(http.calls[0].kind, 'open');
  assert.equal(http.calls[1].kind, 'json');

  // 12 小时内不重新引导，但每次 header() 都会重新解析用户 Cookie（支持热加载）。
  await jar.header();
  assert.equal(http.calls.length, 2);
  assert.equal(resolveCount, 2);
});

test('没有任何解析器时也能引导游客 Cookie；TTL 过期后重新引导', async () => {
  let clock = 1000000;
  const http = createFakeHttp({
    'www.bilibili.com/': openResponse(headersWithSetCookies(['buvid3=v; Path=/', 'b_nut=1; Path=/'])),
    'frontend/finger/spi': { code: 0, data: { b_3: 'v', b_4: 'w' } },
  });
  const jar = makeJar({ http, now: () => clock });
  const header = await jar.header();
  assert.ok(header.startsWith('buvid3=v; '));
  assert.equal(http.calls.length, 2);

  clock += 12 * 60 * 60 * 1000 - 1;
  await jar.header();
  assert.equal(http.calls.length, 2, '未过期不应重新请求');

  clock += 2;
  await jar.header();
  assert.equal(http.calls.length, 4, '过期后应重新引导');
});

test('refresh() 丢弃缓存并重新引导；失败时抛错但 header() 降级', async () => {
  let failing = false;
  const http = createFakeHttp({
    'www.bilibili.com/': () => {
      if (failing) throw new Error('首页挂了');
      return openResponse(headersWithSetCookies(['buvid3=v; Path=/']));
    },
    'frontend/finger/spi': { code: 0, data: { b_3: 'v', b_4: 'w' } },
  });
  const logger = createFakeLogger();
  const jar = makeJar({ http, logger, resolveUserCookie: async () => 'SESSDATA=sess' });

  await jar.header();
  assert.equal(http.calls.length, 2);
  await jar.refresh();
  assert.equal(http.calls.length, 4);

  // 引导失败：refresh 抛错；header 只用用户 Cookie 并告警。
  failing = true;
  jar.invalidate();
  await assert.rejects(jar.refresh(), /首页挂了/);
  const degraded = await jar.header();
  assert.equal(degraded, 'SESSDATA=sess');
  assert.ok(logger.entries.some((entry) => entry.level === 'warn' && /游客 Cookie/.test(entry.message)));
});

test('invalidate() 让下一次 header() 重新引导', async () => {
  const http = createFakeHttp({
    'www.bilibili.com/': openResponse(headersWithSetCookies(['buvid3=v; Path=/'])),
    'frontend/finger/spi': { code: 0, data: { b_3: 'v', b_4: 'w' } },
  });
  const jar = makeJar({ http });
  await jar.header();
  assert.equal(http.calls.length, 2);
  jar.invalidate();
  await jar.header();
  assert.equal(http.calls.length, 4);
});

test('userCookie()：未配置/读失败返回 undefined 并告警', async () => {
  const noResolver = makeJar({ http: createFakeHttp({}) });
  assert.equal(await noResolver.userCookie(), undefined);

  const logger = createFakeLogger();
  const failing = makeJar({
    http: createFakeHttp({}),
    logger,
    resolveUserCookie: async () => {
      throw new Error('凭据服务坏了');
    },
  });
  assert.equal(await failing.userCookie(), undefined);
  assert.ok(logger.entries.some((entry) => entry.level === 'warn' && /用户 Cookie/.test(entry.message)));

  const blank = makeJar({ http: createFakeHttp({}), resolveUserCookie: async () => '   ' });
  assert.equal(await blank.userCookie(), undefined);
});

test('status()：configured/source/names', async () => {
  const http = createFakeHttp({
    'www.bilibili.com/': openResponse(headersWithSetCookies(['buvid3=v; Path=/', 'b_nut=1; Path=/'])),
    'frontend/finger/spi': { code: 0, data: { b_3: 'v', b_4: 'w' } },
  });
  const jar = makeJar({ http });
  const status = await jar.status();
  assert.equal(status.configured, false);
  assert.ok(status.names.includes('buvid3'));
  assert.ok(status.names.includes('buvid4'));
  assert.ok(status.names.includes('_uuid'));
  assert.ok(status.names.includes('b_lsid'));

  const withUser = makeJar({
    http,
    resolveUserCookie: async () => 'SESSDATA=sess; bili_jct=jct',
    describeUserCookie: async () => ({ configured: true, source: 'credentials' }),
  });
  const second = await withUser.status();
  assert.equal(second.configured, true);
  assert.equal(second.source, 'credentials');
  assert.ok(second.names.includes('SESSDATA'));
  assert.ok(second.names.includes('bili_jct'));
});
