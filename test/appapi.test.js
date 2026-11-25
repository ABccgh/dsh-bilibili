/**
 * App 签名与 App 接口：签名 query、参数补齐、错误映射、返回原始 data。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { APP_KEYS, createAppApi, signAppQuery } from '../lib/appapi.js';
import { BiliError, CODES } from '../lib/errors.js';
import { createFakeHttp, readFixtureJson } from './helpers.js';

const ANDROID = APP_KEYS.android;
const IOS = APP_KEYS.ios;

test('APP_KEYS 的两个平台参数固定', () => {
  assert.deepEqual(ANDROID, {
    appkey: '1d8b6e7d45233436',
    appsec: '560c52ccd288fed045859ed18b8e951f',
    mobi_app: 'android',
    platform: 'android',
    build: '7420300',
  });
  assert.deepEqual(IOS, {
    appkey: '27eb53fc9058f8c3',
    appsec: 'c2ed53a74eeefe3cf99fbd01d8c9c375',
    mobi_app: 'iphone',
    platform: 'ios',
    build: '7420300',
  });
});

test('signAppQuery 按 key 排序 + 自动补 appkey/ts + 末尾 sign', () => {
  const query = signAppQuery({ keyword: '测试 视频', page: 1, page_size: 5 }, ANDROID, 1700000000);
  assert.equal(
    query,
    'appkey=1d8b6e7d45233436&keyword=%E6%B5%8B%E8%AF%95%20%E8%A7%86%E9%A2%91&page=1&page_size=5&ts=1700000000'
      + '&sign=f573776940c36602cbb0ffb1762339fe',
  );
});

test('signAppQuery：跳过 undefined/null、数字转字符串、保留调用方 appkey/ts', () => {
  const query = signAppQuery(
    { b: 2, a: 'x', skip: undefined, none: null, appkey: 'custom-appkey', ts: 123 },
    ANDROID,
    999,
  );
  assert.equal(query.split('&sign=')[0], 'a=x&appkey=custom-appkey&b=2&ts=123');
  assert.match(query, /&sign=[0-9a-f]{32}$/);
  assert.ok(!query.includes('skip='));
  assert.ok(!query.includes('none='));

  const iosQuery = signAppQuery({ vmid: 2 }, IOS, 1700000000);
  assert.match(iosQuery, /^appkey=27eb53fc9058f8c3&ts=1700000000&vmid=2&sign=[0-9a-f]{32}$/);
});

test('signAppQuery 对非法 appKey 抛 TypeError', () => {
  assert.throws(() => signAppQuery({}, /** @type {any} */ (null), 1), TypeError);
  assert.throws(() => signAppQuery({}, /** @type {any} */ ({ appkey: 'x' }), 1), TypeError);
});

test('createAppApi.search：Android 签名请求并原样返回 data', async () => {
  const fixture = readFixtureJson('t1-search-app.json');
  const http = createFakeHttp({ 'x/v2/search': fixture });
  const appApi = createAppApi({ http, now: () => 1700000000000 });

  const data = await appApi.search(
    { keyword: '原神', search_type: 'video', order: 'totalrank', page: 1, page_size: 5 },
    { cookie: 'SESSDATA=s' },
  );
  assert.deepEqual(data, fixture.data);
  assert.equal(data.item.length, 6);

  const call = http.calls[0];
  assert.ok(call.url.startsWith('https://app.bilibili.com/x/v2/search?'));
  assert.ok(call.url.includes('keyword=%E5%8E%9F%E7%A5%9E'));
  assert.ok(call.url.includes('search_type=video'));
  assert.ok(call.url.includes('order=totalrank'));
  assert.ok(call.url.includes('page=1'));
  assert.ok(call.url.includes('page_size=5'));
  assert.ok(call.url.includes(`appkey=${ANDROID.appkey}`));
  assert.ok(call.url.includes(`build=${ANDROID.build}`));
  assert.ok(call.url.includes('mobi_app=android'));
  assert.ok(call.url.includes('platform=android'));
  assert.ok(call.url.includes('ts=1700000000'));
  assert.match(call.url, /&sign=[0-9a-f]{32}$/);
  assert.equal(call.options.headers.cookie, 'SESSDATA=s');
});

test('createAppApi.search：app=ios 用 iOS key；无 cookie 时不带 cookie 头', async () => {
  const http = createFakeHttp({ 'x/v2/search': { code: 0, data: { ok: true } } });
  const appApi = createAppApi({ http, now: () => 1700000000000 });
  const data = await appApi.search({ keyword: 'x' }, { app: 'ios' });
  assert.deepEqual(data, { ok: true });
  const url = http.calls[0].url;
  assert.ok(url.includes(`appkey=${IOS.appkey}`));
  assert.ok(url.includes('mobi_app=iphone'));
  assert.ok(url.includes('platform=ios'));
  assert.equal(http.calls[0].options.headers.cookie, undefined);
});

test('createAppApi.search：不支持的 app 抛参数错误', async () => {
  const appApi = createAppApi({ http: createFakeHttp({}) });
  await assert.rejects(
    appApi.search({ keyword: 'x' }, { app: /** @type {any} */ ('windows') }),
    (error) => {
      assert.ok(error instanceof BiliError);
      assert.equal(error.code, CODES.INVALID_ARGUMENT);
      return true;
    },
  );
});

test('业务码映射：-352 → 风控，-101 → 需要登录，并带 apiCode', async () => {
  const risk = createAppApi({ http: createFakeHttp({ 'x/v2/search': { code: -352, message: '请求被拦截' } }) });
  await assert.rejects(risk.search({ keyword: 'x' }), (error) => {
    assert.ok(error instanceof BiliError);
    assert.equal(error.code, CODES.RISK);
    assert.equal(error.apiCode, -352);
    assert.match(error.message, /请求被拦截/);
    assert.match(error.hint, /风控/);
    return true;
  });

  const auth = createAppApi({ http: createFakeHttp({ 'x/v2/search': { code: -101, message: '账号未登录' } }) });
  await assert.rejects(auth.search({ keyword: 'x' }), (error) => {
    assert.equal(error.code, CODES.AUTH_REQUIRED);
    assert.equal(error.apiCode, -101);
    return true;
  });
});

test('createAppApi.spaceArchive：iOS 参数 + vmid/pn/ps', async () => {
  const fixture = readFixtureJson('t1-space-archive.json');
  const http = createFakeHttp({ 'x/v2/space/archive': fixture });
  const appApi = createAppApi({ http, now: () => 1700000000000 });

  const data = await appApi.spaceArchive({ vmid: 2, pn: 1, ps: 5 });
  assert.deepEqual(data, fixture.data);
  assert.equal(data.count, 43);

  const url = http.calls[0].url;
  assert.ok(url.startsWith('https://app.bilibili.com/x/v2/space/archive?'));
  assert.ok(url.includes('vmid=2'));
  assert.ok(url.includes('pn=1'));
  assert.ok(url.includes('ps=5'));
  assert.ok(url.includes(`appkey=${IOS.appkey}`));
  assert.ok(url.includes('mobi_app=iphone'));
});

test('createAppApi.spaceArchive：-3 业务码带 apiCode（供 API 层重试判定）', async () => {
  const appApi = createAppApi({ http: createFakeHttp({ 'x/v2/space/archive': { code: -3, message: '参数错误' } }) });
  await assert.rejects(appApi.spaceArchive({ vmid: 2, pn: 1, ps: 5 }), (error) => {
    assert.ok(error instanceof BiliError);
    assert.equal(error.apiCode, -3);
    return true;
  });
});
