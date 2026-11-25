/**
 * `lib/ffmpeg.js` 的离线测试。
 *
 * 只测「找不到 ffmpeg」的路径（本机没装也能跑）：失败结果缓存 60 秒后重试，
 * `force` 立即重试，`status()` 同步快照。真正的成功路径由 live-check 与真机下载验收覆盖。
 *
 * @module test/ffmpeg.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFfmpegProbe } from '../lib/ffmpeg.js';

/** 一个几乎不可能存在的可执行路径。 */
const MISSING = 'C:\\dsh-bilibili-test\\definitely-missing-ffmpeg.exe';

test('探测不到 ffmpeg 时返回 available=false 并带 error', async () => {
  const probe = createFfmpegProbe({ config: { ffmpegPath: MISSING } });
  const result = await probe.detect();
  assert.equal(result.available, false);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
  assert.equal(probe.status()?.available, false);
});

test('失败结果在 60 秒内复用，超过后重新探测', async () => {
  let clock = 1000;
  const probe = createFfmpegProbe({ config: { ffmpegPath: MISSING }, now: () => clock });
  const first = await probe.detect();
  assert.equal(first.available, false);

  clock += 1000;
  const cached = await probe.detect();
  assert.equal(cached, first, '60 秒内应复用同一个结果对象（不再 spawn）');

  clock += 60000;
  const retried = await probe.detect();
  assert.equal(retried.available, false);
  assert.notEqual(retried, first, '超过 60 秒应重新探测');
});

test('force 立即重新探测并清空缓存', async () => {
  let clock = 1000;
  const probe = createFfmpegProbe({ config: { ffmpegPath: MISSING }, now: () => clock });
  const first = await probe.detect();
  const forced = await probe.detect({ force: true });
  assert.notEqual(forced, first);
  assert.equal(forced.available, false);
  probe.invalidate();
  assert.equal(probe.status(), null);
});

test('并发 detect 只探测一次', async () => {
  const probe = createFfmpegProbe({ config: { ffmpegPath: MISSING } });
  const [a, b, c] = await Promise.all([probe.detect(), probe.detect(), probe.detect()]);
  assert.equal(a, b);
  assert.equal(b, c);
});
