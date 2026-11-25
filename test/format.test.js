/**
 * 纯格式化函数：BV/av 互转、时长/计数/时间、HTML 清洗、目标解析、弹幕 protobuf 解析。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BiliError, CODES } from '../lib/errors.js';
import {
  aidFromBv,
  bvFromAid,
  countText,
  deadlineFromUrl,
  durationText,
  findBvid,
  parseDanmakuSegments,
  parsePageNumber,
  pubdateText,
  resolveTargetInput,
  stripHtml,
} from '../lib/format.js';
import { readFixtureBytes } from './helpers.js';

/**
 * 写一个 protobuf varint。
 * @param {number} value - 非负整数。
 * @returns {number[]} 字节。
 */
function varint(value) {
  let rest = BigInt(value);
  /** @type {number[]} */
  const bytes = [];
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0n);
  return bytes;
}

/**
 * 写一个 wire type 0 的字段。
 * @param {number} field - 字段号。
 * @param {number} value - 值。
 * @returns {number[]} 字节。
 */
function varintField(field, value) {
  return [...varint(field * 8), ...varint(value)];
}

/**
 * 写一个 wire type 2 的字段。
 * @param {number} field - 字段号。
 * @param {Uint8Array | number[]} data - 载荷。
 * @returns {number[]} 字节。
 */
function bytesField(field, data) {
  const payload = [...data];
  return [...varint(field * 8 + 2), ...varint(payload.length), ...payload];
}

/**
 * 造一条 DanmakuElem 的字节。
 * @param {{ timeMs?: number, mode?: number, color?: number, content?: string, ctime?: number,
 *   extra?: number[] }} [options] - 字段。
 * @returns {number[]} 字节。
 */
function elem(options = {}) {
  /** @type {number[]} */
  const bytes = [];
  if (options.timeMs !== undefined) bytes.push(...varintField(2, options.timeMs));
  if (options.mode !== undefined) bytes.push(...varintField(3, options.mode));
  if (options.color !== undefined) bytes.push(...varintField(5, options.color));
  if (options.content !== undefined) bytes.push(...bytesField(7, new TextEncoder().encode(options.content)));
  if (options.ctime !== undefined) bytes.push(...varintField(8, options.ctime));
  if (options.extra !== undefined) bytes.push(...options.extra);
  return bytes;
}

/**
 * 包一层 `repeated DanmakuElem elems = 1`。
 * @param {number[][]} elems - 元素字节数组。
 * @returns {Uint8Array} 分段字节。
 */
function segment(elems) {
  /** @type {number[]} */
  const bytes = [];
  for (const item of elems) bytes.push(...bytesField(1, item));
  return Uint8Array.from(bytes);
}

test('bvFromAid / aidFromBv 已知向量', () => {
  assert.equal(bvFromAid(170001), 'BV17x411w7KC');
  assert.equal(bvFromAid(455017605), 'BV1Q541167Qg');
  assert.equal(bvFromAid(2), 'BV1xx411c7mD');
  assert.equal(bvFromAid('170001'), 'BV17x411w7KC');
  assert.equal(aidFromBv('BV17x411w7KC'), 170001);
  assert.equal(aidFromBv('BV1Q541167Qg'), 455017605);
  assert.equal(aidFromBv('BV1xx411c7mD'), 2);
});

test('BV/av 互转在所有小 aid 与随机大 aid 上可逆', () => {
  for (let aid = 0; aid <= 3000; aid += 1) {
    const bvid = bvFromAid(aid);
    assert.match(bvid, /^BV1[0-9A-Za-z]{9}$/);
    assert.equal(aidFromBv(bvid), aid);
  }
  // 确定性伪随机抽样（LCG），覆盖高位区间。
  let state = 123456789;
  for (let index = 0; index < 500; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const aid = state * 1024 + index;
    assert.equal(aidFromBv(bvFromAid(aid)), aid);
  }
});

test('BV 转换对非法输入抛 BILI_INVALID_ARGUMENT', () => {
  for (const bad of [-1, 1.5, Number.NaN, 2 ** 51, 'abc', undefined]) {
    assert.throws(
      () => bvFromAid(/** @type {any} */ (bad)),
      (error) => {
        assert.ok(error instanceof BiliError);
        assert.equal(error.code, CODES.INVALID_ARGUMENT);
        return true;
      },
    );
  }
  for (const bad of ['', 'BV1', 'av170001', 'BV1000000000', null]) {
    assert.throws(
      () => aidFromBv(/** @type {any} */ (bad)),
      (error) => {
        assert.ok(error instanceof BiliError);
        assert.equal(error.code, CODES.INVALID_ARGUMENT);
        return true;
      },
    );
  }
});

test('durationText 格式', () => {
  assert.equal(durationText(0), '0:00');
  assert.equal(durationText(5), '0:05');
  assert.equal(durationText(65), '1:05');
  assert.equal(durationText(605), '10:05');
  assert.equal(durationText(3600), '1:00:00');
  assert.equal(durationText(3661), '1:01:01');
  assert.equal(durationText(86399), '23:59:59');
  assert.equal(durationText(249.9), '4:09');
  assert.equal(durationText(-1), '');
  assert.equal(durationText(Number.NaN), '');
  assert.equal(durationText(undefined), '');
});

test('countText 中文计数', () => {
  assert.equal(countText(0), '0');
  assert.equal(countText(999), '999');
  assert.equal(countText(9999), '9999');
  assert.equal(countText(10000), '1万');
  assert.equal(countText(12345), '1.2万');
  assert.equal(countText(100000), '10万');
  assert.equal(countText(99999999), '1亿');
  assert.equal(countText(123456789), '1.2亿');
  assert.equal(countText(-5), '');
  assert.equal(countText(undefined), '');
});

test('pubdateText 固定按北京时间（UTC+8）', () => {
  assert.equal(pubdateText(1704067200), '2024-01-01 08:00');
  assert.equal(pubdateText(1704067200000), '2024-01-01 08:00');
  assert.equal(pubdateText(1584949634), '2020-03-23 15:47');
  assert.equal(pubdateText(0), '');
  assert.equal(pubdateText(-1), '');
  assert.equal(pubdateText(undefined), '');
});

test('stripHtml 去标签、解实体、压空白', () => {
  assert.equal(stripHtml('<em class="keyword">原神</em>攻略'), '原神攻略');
  assert.equal(stripHtml('第一行<br>第二行<br/>第三行'), '第一行\n第二行\n第三行');
  assert.equal(stripHtml('<p>段落一</p><p>段落二</p>'), '段落一\n段落二');
  assert.equal(stripHtml('A &amp; B &lt;C&gt; &quot;D&quot; &#39;E&#39; &#x27;F&#x27;'), "A & B <C> \"D\" 'E' 'F'");
  assert.equal(stripHtml('a&nbsp;&nbsp;b'), 'a b');
  assert.equal(stripHtml('unknown &custom; entity'), 'unknown &custom; entity');
  assert.equal(stripHtml('多  个   空格\n\n\n\n空行'), '多 个 空格\n\n空行');
  assert.equal(stripHtml(''), '');
  assert.equal(stripHtml(null), '');
  assert.equal(stripHtml(123), '');
});

test('resolveTargetInput 解析 BV / av / 链接 / 播放器 / 短链', () => {
  assert.deepEqual(resolveTargetInput('BV17x411w7KC'), { page: 1, bvid: 'BV17x411w7KC', aid: 170001 });
  assert.deepEqual(resolveTargetInput('bv17x411w7KC'), { page: 1, bvid: 'BV17x411w7KC', aid: 170001 });
  assert.deepEqual(resolveTargetInput(' av170001 '), { page: 1, aid: 170001, bvid: 'BV17x411w7KC' });
  assert.deepEqual(resolveTargetInput('170001'), { page: 1, aid: 170001, bvid: 'BV17x411w7KC' });

  const share = resolveTargetInput('https://www.bilibili.com/video/BV17x411w7KC/?p=2&spm_id_from=333.999');
  assert.deepEqual(share, { page: 2, bvid: 'BV17x411w7KC', aid: 170001 });

  const mobile = resolveTargetInput('https://m.bilibili.com/video/av170001?p=3');
  assert.deepEqual(mobile, { page: 3, aid: 170001, bvid: 'BV17x411w7KC' });

  const player = resolveTargetInput('https://player.bilibili.com/player.html?bvid=BV17x411w7KC&page=4');
  assert.deepEqual(player, { page: 4, bvid: 'BV17x411w7KC', aid: 170001 });

  const playerAid = resolveTargetInput('player.bilibili.com/player.html?aid=170001&page=2');
  assert.deepEqual(playerAid, { page: 2, aid: 170001, bvid: 'BV17x411w7KC' });

  assert.deepEqual(resolveTargetInput('https://b23.tv/abc123'), { page: 1, shortUrl: 'https://b23.tv/abc123' });
  assert.deepEqual(resolveTargetInput('b23.tv/abc123'), { page: 1, shortUrl: 'https://b23.tv/abc123' });
  assert.deepEqual(resolveTargetInput('https://b23.tv/BV17x411w7KC'), { page: 1, bvid: 'BV17x411w7KC', aid: 170001 });

  // BV 号里混进 base58 字典外的字符（如 0）时解不出 aid，但保留 bvid。
  assert.deepEqual(resolveTargetInput('BV1000000000'), { page: 1, bvid: 'BV1000000000' });
});

test('resolveTargetInput 对非法目标抛 BILI_INVALID_ARGUMENT', () => {
  for (const bad of ['', '   ', 'hello', 'https://example.com/video/BV17x411w7KC', 'https://b23.tv/', 'https://space.bilibili.com/2']) {
    assert.throws(
      () => resolveTargetInput(bad),
      (error) => {
        assert.ok(error instanceof BiliError);
        assert.equal(error.code, CODES.INVALID_ARGUMENT);
        return true;
      },
    );
  }
  assert.throws(() => resolveTargetInput(undefined), BiliError);
  assert.throws(() => resolveTargetInput(42), BiliError);
});

test('parsePageNumber / findBvid / deadlineFromUrl', () => {
  assert.equal(parsePageNumber('3'), 3);
  assert.equal(parsePageNumber('0'), 1);
  assert.equal(parsePageNumber('-2'), 1);
  assert.equal(parsePageNumber('abc'), 1);
  assert.equal(parsePageNumber(null), 1);
  assert.equal(findBvid('看这个 https://www.bilibili.com/video/BV1Q541167Qg/?share=1'), 'BV1Q541167Qg');
  assert.equal(findBvid('没有BV号'), undefined);
  assert.equal(deadlineFromUrl('https://x.example.com/a.m4s?deadline=1795576599&x=1'), 1795576599);
  assert.equal(deadlineFromUrl('https://x.example.com/a.m4s?x=1'), undefined);
});

test('parseDanmakuSegments 解析合成 protobuf（含未知字段与多字节 varint）', () => {
  const bytes = segment([
    elem({
      timeMs: 1234,
      mode: 1,
      color: 0xffffff,
      content: '你好，世界',
      ctime: 1584951615,
      // 未知字段：field 12 wire2 字符串、field 13 wire0 varint、field 14 wire5 固定 4 字节。
      extra: [
        ...bytesField(12, new TextEncoder().encode('ignored')),
        ...varintField(13, 999999),
        ...[12 * 8 + 5, 1, 2, 3, 4],
      ],
    }),
    elem({
      timeMs: 65000,
      mode: 5,
      color: 0x00ff00,
      content: 'top',
      ctime: 1700000000,
    }),
  ]);
  const items = parseDanmakuSegments(bytes);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { timeMs: 1234, mode: 1, color: 0xffffff, text: '你好，世界', ctime: 1584951615 });
  assert.deepEqual(items[1], { timeMs: 65000, mode: 5, color: 0x00ff00, text: 'top', ctime: 1700000000 });
});

test('parseDanmakuSegments 对空/JSON/截断字节不抛错', () => {
  assert.deepEqual(parseDanmakuSegments(new Uint8Array(0)), []);
  assert.deepEqual(parseDanmakuSegments(new TextEncoder().encode('{"code":-101,"message":"账号未登录"}')), []);

  const bytes = segment([
    elem({ timeMs: 1, content: 'a' }),
    elem({ timeMs: 2, content: 'b' }),
    elem({ timeMs: 3, content: 'c' }),
  ]);
  // 逐字节截断都不能抛错，且只返回完整元素。
  for (let cut = 0; cut <= bytes.length; cut += 1) {
    const items = parseDanmakuSegments(bytes.subarray(0, cut));
    assert.ok(Array.isArray(items));
    assert.ok(items.length <= 3);
    for (const item of items) {
      assert.equal(typeof item.timeMs, 'number');
      assert.equal(typeof item.text, 'string');
    }
  }
});

test('parseDanmakuSegments 解析真实弹幕分段 fixture', () => {
  const bytes = readFixtureBytes('t1-danmaku-seg.bin');
  assert.ok(bytes.length > 0 && bytes.length <= 64 * 1024);
  const items = parseDanmakuSegments(bytes);
  assert.ok(items.length > 10);
  assert.deepEqual(items[0], {
    timeMs: 71847,
    mode: 1,
    color: 16777215,
    text: '泪目，时代的过客',
    ctime: 1584951615,
  });
  for (const item of items) {
    assert.ok(Number.isFinite(item.timeMs) && item.timeMs >= 0);
    assert.ok(Number.isFinite(item.mode) && item.mode >= 1);
    assert.ok(Number.isFinite(item.color) && item.color >= 0);
    assert.ok(typeof item.text === 'string');
    assert.ok(Number.isFinite(item.ctime) && item.ctime > 0);
  }
  // 接受 ArrayBuffer / Buffer 视图。
  assert.equal(parseDanmakuSegments(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).length, items.length);
});
