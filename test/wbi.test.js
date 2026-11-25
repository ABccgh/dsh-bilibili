/**
 * WBI 签名：置换表、mixinKey、query 生成、密钥缓存与降级。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BiliError, CODES } from '../lib/errors.js';
import {
  MIXIN_KEY_ENC_TAB,
  createWbi,
  md5,
  mixinKeyFrom,
  signQuery,
  wbiKeyFromUrl,
} from '../lib/wbi.js';
import { createFakeHttp, createFakeLogger, readFixtureJson } from './helpers.js';

/** 真实 nav 响应里的一对 WBI key（fixture 同值）。 */
const IMG_URL = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
const SUB_URL = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png';
const IMG_KEY = '7cd084941338484aae1ad9425b84077c';
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45';

/** 官方文档示例算出的 mixinKey（与真实接口一致，实测可用）。 */
const MIXIN_KEY = 'ea1db124af3c7062474693fa704f4ff8';

test('MIXIN_KEY_ENC_TAB 是 64 项的 0..63 置换', () => {
  assert.equal(MIXIN_KEY_ENC_TAB.length, 64);
  const sorted = [...MIXIN_KEY_ENC_TAB].sort((a, b) => a - b);
  assert.deepEqual(sorted, Array.from({ length: 64 }, (_, index) => index));
  assert.deepEqual(MIXIN_KEY_ENC_TAB.slice(0, 8), [46, 47, 18, 2, 53, 8, 23, 32]);
});

test('wbiKeyFromUrl 取文件名去扩展名', () => {
  assert.equal(wbiKeyFromUrl(IMG_URL), IMG_KEY);
  assert.equal(wbiKeyFromUrl(SUB_URL), SUB_KEY);
  assert.equal(wbiKeyFromUrl('https://i0.hdslb.com/bfs/wbi/abc.png?x=1'), 'abc');
  assert.equal(wbiKeyFromUrl(''), '');
  assert.equal(wbiKeyFromUrl(undefined), '');
});

test('mixinKeyFrom 按置换表算出 32 位 mixinKey（真实样例）', () => {
  assert.equal(mixinKeyFrom(IMG_KEY, SUB_KEY), MIXIN_KEY);
  assert.equal(mixinKeyFrom(IMG_KEY, SUB_KEY).length, 32);
});

test('mixinKeyFrom 遇到长度不足抛 BILI_API', () => {
  assert.throws(
    () => mixinKeyFrom('short', 'key'),
    (error) => {
      assert.ok(error instanceof BiliError);
      assert.equal(error.code, CODES.API);
      assert.match(error.hint, /WBI/);
      return true;
    },
  );
});

test('signQuery 逐值对齐官方示例', () => {
  // 官方文档的示例参数与结果，实测 search/playurl 接口可用。
  const query = signQuery({ foo: '114', bar: '514', zab: '1919810' }, MIXIN_KEY, 1702204169);
  assert.equal(
    query,
    'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4',
  );
});

test('signQuery：排序、去字符、编码、跳过空值、覆盖 wts', () => {
  const query = signQuery(
    { keyword: "a!b'c(d)e*f 测试&x", page: 1, empty: '', skip: undefined, nothing: null, wts: 1 },
    MIXIN_KEY,
    1700000000,
  );
  const mainQuery = 'empty=&keyword=abcdef%20%E6%B5%8B%E8%AF%95%26x&page=1&wts=1700000000';
  assert.equal(query, `${mainQuery}&w_rid=${md5(mainQuery + MIXIN_KEY)}`);
  assert.ok(!query.includes('skip='));
  assert.ok(!query.includes('nothing='));
  assert.equal(query.split('&wts=')[1].split('&')[0], '1700000000');
});

test('signQuery：布尔/数字转字符串，key 也按字典序', () => {
  const query = signQuery({ zebra: true, alpha: 0, middle: false }, MIXIN_KEY, 1600000000);
  assert.match(query, /^alpha=0&middle=false&wts=1600000000&zebra=true&w_rid=[0-9a-f]{32}$/);
});

test('signQuery 缺 mixinKey 抛 BILI_API', () => {
  assert.throws(
    () => signQuery({ a: 1 }, '', 1),
    (error) => {
      assert.equal(error.code, CODES.API);
      return true;
    },
  );
});

test('createWbi：拉 nav 取密钥、缓存、过期、invalid/forceRefresh', async () => {
  const logger = createFakeLogger();
  let clock = 1000000;
  const http = createFakeHttp({
    'x/web-interface/nav': readFixtureJson('t1-nav-wbi.json'),
  });
  const wbi = createWbi({ http, config: { wbiCacheTtlMs: 3600000 }, logger, now: () => clock });

  assert.deepEqual(await wbi.status(), { cached: false });
  const first = await wbi.sign({ a: 1, b: 'x y' });
  assert.match(first, /^a=1&b=x%20y&wts=1000&w_rid=[0-9a-f]{32}$/);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url.includes('x/web-interface/nav'), true);

  const status = await wbi.status();
  assert.equal(status.cached, true);
  assert.equal(status.fetchedAt, clock);
  assert.equal(status.imgKey, IMG_KEY);

  // 缓存期内再签不发请求（wts 用当前注入时间）。
  const second = await wbi.sign({ a: 1, b: 'x y' });
  assert.equal(http.calls.length, 1);
  assert.match(second, /wts=1000&/);

  // 过期后重新拉取。
  clock += 3600001;
  await wbi.sign({ a: 2 });
  assert.equal(http.calls.length, 2);

  // invalidate 后立刻重新拉取。
  wbi.invalidate();
  assert.equal((await wbi.status()).cached, false);
  await wbi.sign({ a: 3 });
  assert.equal(http.calls.length, 3);

  // forceRefresh 强制刷新。
  await wbi.sign({ a: 4 }, { forceRefresh: true });
  assert.equal(http.calls.length, 4);
});

test('createWbi：并发 sign 只拉一次 nav', async () => {
  const http = createFakeHttp({
    'x/web-interface/nav': readFixtureJson('t1-nav-wbi.json'),
  });
  const wbi = createWbi({ http, now: () => 2000000 });
  const results = await Promise.all([wbi.sign({ a: 1 }), wbi.sign({ a: 2 }), wbi.sign({ a: 3 })]);
  assert.equal(http.calls.length, 1);
  for (const query of results) assert.match(query, /w_rid=[0-9a-f]{32}$/);
});

test('createWbi：nav 失败抛错；有旧缓存时降级继续用旧密钥', async () => {
  /** @type {boolean} */
  let failing = false;
  let clock = 3000000;
  const http = createFakeHttp({
    'x/web-interface/nav': () => {
      if (failing) throw new Error('网络断了');
      return readFixtureJson('t1-nav-wbi.json');
    },
  });
  const logger = createFakeLogger();
  const wbi = createWbi({ http, config: { wbiCacheTtlMs: 60000 }, logger, now: () => clock });

  await assert.rejects(
    (async () => {
      failing = true;
      await wbi.sign({ a: 1 });
    })(),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /网络断了/);
      return true;
    },
  );

  failing = false;
  const okQuery = await wbi.sign({ a: 1 });
  assert.match(okQuery, /w_rid=/);

  // 缓存过期 + nav 失败：用旧密钥并告警。
  failing = true;
  clock += 120000;
  const staleQuery = await wbi.sign({ a: 2 });
  assert.match(staleQuery, /w_rid=[0-9a-f]{32}$/);
  assert.ok(logger.entries.some((entry) => entry.level === 'warn' && /WBI 密钥/.test(entry.message)));
});

test('createWbi：nav 没有 wbi_img 时抛可读错误', async () => {
  const http = createFakeHttp({ 'x/web-interface/nav': { code: -101, data: { isLogin: false } } });
  const wbi = createWbi({ http, now: () => 4000000 });
  await assert.rejects(wbi.sign({ a: 1 }), (error) => {
    assert.ok(error instanceof BiliError);
    assert.equal(error.code, CODES.API);
    assert.match(error.message, /wbi_img/);
    return true;
  });
});
