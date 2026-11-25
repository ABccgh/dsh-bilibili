/**
 * `lib/ffmpeg.js` 的离线测试。
 *
 * 用注入的 `probeImpl` 替身覆盖失败缓存、60 秒重试、force、并发与「配置路径失败后回退 PATH」；
 * 最后一条用真实 PATH 探测，本机没装 ffmpeg 时自动跳过。
 *
 * @module test/ffmpeg.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFfmpegProbe } from '../lib/ffmpeg.js';

/** 一个几乎不可能存在的可执行路径。 */
const MISSING = 'C:\\dsh-bilibili-test\\definitely-missing-ffmpeg.exe';

/**
 * 造一个可计数的探测替身。
 * @param {Array<{ available: boolean, path?: string, version?: string, error?: string }>} results - 依次返回的结果。
 * @returns {{ calls: string[], probeImpl: Function }} 替身。
 */
function stubProbe(results) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    probeImpl: async (command) => {
      calls.push(command);
      const result = results[Math.min(calls.length - 1, results.length - 1)];
      return { ...result };
    },
  };
}

test('探测不到 ffmpeg 时返回 available=false 并带 error', async () => {
  const stub = stubProbe([{ available: false, error: 'ENOENT' }]);
  const probe = createFfmpegProbe({ config: { ffmpegPath: MISSING }, probeImpl: stub.probeImpl });
  const result = await probe.detect();
  assert.equal(result.available, false);
  assert.equal(result.error, 'ENOENT');
  assert.equal(stub.calls.length, 2, '配置路径失败后会再探测一次 PATH');
  assert.deepEqual(stub.calls, [MISSING, 'ffmpeg']);
  assert.equal(probe.status()?.available, false);
});

test('失败结果在 60 秒内复用，超过后重新探测', async () => {
  let clock = 1000;
  const stub = stubProbe([{ available: false, error: 'ENOENT' }]);
  const probe = createFfmpegProbe({ config: { ffmpegPath: '' }, probeImpl: stub.probeImpl, now: () => clock });
  const first = await probe.detect();
  assert.equal(first.available, false);
  assert.equal(stub.calls.length, 1);

  clock += 1000;
  const cached = await probe.detect();
  assert.equal(cached, first, '60 秒内应复用同一个结果对象（不再 spawn）');
  assert.equal(stub.calls.length, 1);

  clock += 60000;
  const retried = await probe.detect();
  assert.equal(retried.available, false);
  assert.notEqual(retried, first, '超过 60 秒应重新探测');
  assert.equal(stub.calls.length, 2);
});

test('force 立即重新探测并清空缓存', async () => {
  const stub = stubProbe([{ available: false, error: 'ENOENT' }]);
  const probe = createFfmpegProbe({ config: { ffmpegPath: '' }, probeImpl: stub.probeImpl });
  const first = await probe.detect();
  const forced = await probe.detect({ force: true });
  assert.notEqual(forced, first);
  assert.equal(stub.calls.length, 2);
  probe.invalidate();
  assert.equal(probe.status(), null);
});

test('并发 detect 只探测一次', async () => {
  const stub = stubProbe([{ available: false, error: 'ENOENT' }]);
  const probe = createFfmpegProbe({ config: { ffmpegPath: '' }, probeImpl: stub.probeImpl });
  const [a, b, c] = await Promise.all([probe.detect(), probe.detect(), probe.detect()]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(stub.calls.length, 1);
});

test('配置路径失败后回退 PATH，成功时清掉 error', async () => {
  const stub = stubProbe([
    { available: false, error: 'spawn 失败' },
    { available: true, path: 'ffmpeg', version: '9.1' },
  ]);
  const probe = createFfmpegProbe({ config: { ffmpegPath: MISSING }, probeImpl: stub.probeImpl });
  const result = await probe.detect();
  assert.equal(result.available, true);
  assert.equal(result.version, '9.1');
  assert.equal(result.error, undefined);
});

test('真实 PATH 探测（无 ffmpeg 的机器跳过）', async (t) => {
  const probe = createFfmpegProbe({ config: { ffmpegPath: '' } });
  const result = await probe.detect();
  if (result.available !== true) {
    t.skip(`本机没有 ffmpeg（${result.error ?? '未知原因'}）`);
    return;
  }
  assert.equal(typeof result.version, 'string');
  assert.ok(result.version.length > 0);
  assert.equal(typeof result.path, 'string');
});
