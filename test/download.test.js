/**
 * `lib/download.js` 的离线测试。
 *
 * 全部用替身：假 `api`（resolveTarget/playurl）、假 `http`（`open` 返回内存 ReadableStream）、
 * 假 ffmpeg（注入 `ffmpeg.detect` 与 `runFfmpeg`，不真的 spawn），只在 `%TEMP%` 下建临时
 * 下载目录并由 `t.after` 清理。覆盖：DASH 合并、durl 回退、无 ffmpeg 的 DASH 报错、
 * audioOnly、清晰度选流、content-length/体积上限、取消清理、目录越界、同名去重、覆盖。
 *
 * @module test/download.test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BiliError, CODES } from '../lib/errors.js';
import { createDownloader } from '../lib/download.js';
import { formatBytes } from '../lib/paths.js';
import { createFakeApi, createFakeHttp, createFakeLogger } from './helpers.js';

/** 测试用 BV 号。 */
const BVID = 'BV1xx411c7mD';

/** DASH 视频/音频流地址。 */
const VIDEO_1080_URL = 'https://cdn.test/v1080.m4s';
const VIDEO_720_URL = 'https://cdn.test/v720.m4s';
const AUDIO_URL = 'https://cdn.test/a192.m4s';
const DURL_URL = 'https://cdn.test/durl.mp4';

/**
 * 造一个内存字节流。
 * @param {Uint8Array} bytes - 字节。
 * @returns {ReadableStream} 流。
 */
function streamOf(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

/**
 * 造一个 `http.open` 路由处理器。
 * @param {{ bytes?: Uint8Array, contentLength?: number, status?: number, headers?: object }} options - 响应配置。
 * @returns {Function} 路由处理器。
 */
function openRoute(options = {}) {
  const bytes = options.bytes ?? new Uint8Array(0);
  return () => ({
    status: options.status ?? 200,
    headers: new Headers({ 'content-length': String(options.contentLength ?? bytes.length) }),
    body: streamOf(bytes),
    contentLength: options.contentLength ?? bytes.length,
  });
}

/**
 * 造一个「有 ffmpeg」或「无 ffmpeg」的探测/执行替身。
 * @param {boolean} available - 是否可用。
 * @returns {{ probe: object, runFfmpeg: Function, calls: object[] }} 替身。
 */
function createFakeFfmpeg(available = true) {
  /** @type {object[]} */
  const calls = [];
  const probe = {
    detect: async () => (available
      ? { available: true, path: 'ffmpeg', version: '6.1.1' }
      : { available: false, error: 'ffmpeg 不在 PATH 里' }),
  };
  const runFfmpeg = async (args, options) => {
    calls.push({ args: [...args], options });
    const output = args[args.length - 1];
    await fsp.writeFile(output, Buffer.alloc(1024, 0x42));
    return { code: 0, stdout: '', stderr: '' };
  };
  return { probe, runFfmpeg, calls };
}

/**
 * 造一个 DASH 播放信息。
 * @returns {object} playurl 返回值。
 */
function dashPlay() {
  return {
    media: { bvid: BVID, cid: 123, page: 1, durationSec: 123 },
    quality: '1080P',
    accept: [{ id: 80, label: '1080P' }, { id: 64, label: '720P' }],
    video: [
      { id: 80, label: '1080P', width: 1920, height: 1080, bytes: 4096, url: VIDEO_1080_URL },
      { id: 64, label: '720P', width: 1280, height: 720, bytes: 2048, url: VIDEO_720_URL },
    ],
    audio: [{ id: 30280, label: '192K', bytes: 1024, url: AUDIO_URL }],
    durl: [],
    expiresAt: Date.now() + 3600 * 1000,
  };
}

/**
 * 造一个只有 durl 的播放信息。
 * @param {number} [bytes] - 文件字节数。
 * @returns {object} playurl 返回值。
 */
function durlPlay(bytes = 5000) {
  return {
    media: { bvid: BVID, cid: 123, page: 1, durationSec: 60 },
    quality: '360P',
    accept: [{ id: 16, label: '360P' }],
    video: [],
    audio: [],
    durl: [{ order: 1, bytes, url: DURL_URL }],
    expiresAt: Date.now() + 3600 * 1000,
  };
}

/**
 * 造一个临时下载根目录，测试结束自动删除。
 * @param {import('node:test').TestContext} t - 测试上下文。
 * @returns {Promise<string>} 目录。
 */
async function makeDownloadRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-bil-dl-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  return root;
}

/**
 * 列目录下的所有文件（递归，相对路径）。
 * @param {string} root - 目录。
 * @returns {Promise<string[]>} 文件列表。
 */
async function listFiles(root) {
  /** @type {string[]} */
  const result = [];
  /**
   * 递归遍历。
   * @param {string} directory - 当前目录。
   */
  const walk = async (directory) => {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else result.push(path.relative(root, fullPath));
    }
  };
  await walk(root);
  return result.sort();
}

/**
 * 拼一个下载器（默认带假 ffmpeg）。
 * @param {{ root: string, api: object, http: object, ffmpeg: object, runFfmpeg?: Function,
 *   maxDownloadMb?: number }} options - 依赖。
 * @returns {object} 下载器。
 */
function makeDownloader(options) {
  return createDownloader({
    ctx: {},
    config: { downloadDir: options.root, maxDownloadMb: options.maxDownloadMb ?? 8, ffmpegPath: '' },
    api: options.api,
    http: options.http,
    ffmpeg: options.ffmpeg,
    logger: createFakeLogger(),
    ...(options.runFfmpeg === undefined ? {} : { runFfmpeg: options.runFfmpeg }),
  });
}

test('download: 有 ffmpeg 时下 DASH video+audio 到临时 .m4s，再用 ffmpeg -c copy 合并', async (t) => {
  const root = await makeDownloadRoot(t);
  const videoBytes = new Uint8Array(4096).fill(0x56);
  const audioBytes = new Uint8Array(1024).fill(0x41);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '测试视频', durationSec: 123 }),
    playurl: () => dashPlay(),
  });
  const http = createFakeHttp({
    'v1080.m4s': openRoute({ bytes: videoBytes }),
    'v720.m4s': openRoute({ bytes: new Uint8Array(2048).fill(0x37) }),
    'a192.m4s': openRoute({ bytes: audioBytes }),
  });
  const fakeFfmpeg = createFakeFfmpeg(true);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  const result = await downloader.run({ target: BVID, quality: '1080' }, {});

  assert.equal(result.merged, true, 'DASH 路径应标记 merged');
  assert.equal(result.audioOnly, false);
  assert.equal(result.quality, '1080P');
  assert.equal(result.durationSec, 123);
  assert.equal(result.bytes, 1024, '合并后的字节数应来自最终文件');
  assert.equal(result.sizeText, formatBytes(1024));
  assert.equal(typeof result.elapsedMs, 'number');
  assert.ok(result.elapsedMs >= 0);
  assert.ok(result.file.endsWith('.mp4'), `输出应为 mp4：${result.file}`);
  const stat = await fsp.stat(result.file);
  assert.equal(stat.size, 1024);

  // 选的是 1080P 流，没下 720P
  const urls = http.calls.map((call) => call.url);
  assert.ok(urls.includes(VIDEO_1080_URL), '应下载 1080P 视频流');
  assert.equal(urls.includes(VIDEO_720_URL), false, '不应下载 720P 视频流');
  assert.ok(urls.includes(AUDIO_URL), '应下载音频流');

  // 断言 ffmpeg 命令行形状
  assert.equal(fakeFfmpeg.calls.length, 1);
  const ffmpegCall = fakeFfmpeg.calls[0];
  assert.equal(ffmpegCall.args[0], '-y');
  assert.deepEqual(ffmpegCall.args.slice(-5, -1), ['-c', 'copy', '-movflags', '+faststart']);
  assert.ok(ffmpegCall.args.includes('-i'));
  assert.equal(ffmpegCall.args.filter((arg) => arg === '-i').length, 2, '应有视频/音频两个输入');
  assert.ok(ffmpegCall.args.some((arg) => arg.endsWith('video.m4s')), '视频应下到临时 video.m4s');
  assert.ok(ffmpegCall.args.some((arg) => arg.endsWith('audio.m4s')), '音频应下到临时 audio.m4s');
  const output = ffmpegCall.args[ffmpegCall.args.length - 1];
  assert.ok(output.endsWith('.part.mp4'), `ffmpeg 应先写 .part.mp4：${output}`);
  assert.equal(ffmpegCall.options.command, 'ffmpeg');
  assert.ok(ffmpegCall.options.cwd.includes('dsh-bilibili-'), '工作目录应是临时目录');

  // 不留 .part
  const files = await listFiles(root);
  assert.equal(files.some((file) => file.endsWith('.part')), false);
});

test('download: 无 ffmpeg 时退回 durl 单文件 MP4', async (t) => {
  const root = await makeDownloadRoot(t);
  const durlBytes = new Uint8Array(5000).fill(0x44);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: 'durl 视频', durationSec: 60 }),
    playurl: () => durlPlay(durlBytes.length),
  });
  const http = createFakeHttp({ 'durl.mp4': openRoute({ bytes: durlBytes }) });
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  const result = await downloader.run({ target: BVID }, {});

  assert.equal(result.merged, false, 'durl 路径不是合并');
  assert.equal(result.audioOnly, false);
  assert.ok(result.file.endsWith('.mp4'));
  assert.equal(result.bytes, durlBytes.length);
  assert.equal(result.sizeText, formatBytes(durlBytes.length));
  assert.equal(fakeFfmpeg.calls.length, 0, '无 ffmpeg 时不能调用 ffmpeg');
  const content = await fsp.readFile(result.file);
  assert.deepEqual([...content], [...durlBytes]);
});

test('download: 无 ffmpeg 且只有 DASH 流时报 BILI_FFMPEG_MISSING', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '只有 DASH' }),
    playurl: () => ({ ...dashPlay(), durl: [] }),
  });
  const http = createFakeHttp({});
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  await assert.rejects(
    () => downloader.run({ target: BVID }, {}),
    (error) => error instanceof BiliError && error.code === CODES.FFMPEG_MISSING && /ffmpeg/.test(error.message),
  );
  assert.deepEqual(await listFiles(root), [], '失败不应留下文件');
});

test('download: 无 ffmpeg 且首包只有 DASH 时，带 durlOnly 再请求一次并下整段 MP4', async (t) => {
  const root = await makeDownloadRoot(t);
  const durlBytes = new Uint8Array(4096).fill(0x5a);
  let durlOnlySeen = false;
  let calls = 0;
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: 'DASH 优先', durationSec: 90 }),
    playurl: (args) => {
      calls += 1;
      if (args?.durlOnly === true) {
        durlOnlySeen = true;
        return durlPlay(durlBytes.length);
      }
      return { ...dashPlay(), durl: [] };
    },
  });
  const http = createFakeHttp({ 'durl.mp4': openRoute({ bytes: durlBytes }) });
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  const result = await downloader.run({ target: BVID, quality: '360' }, {});

  assert.equal(durlOnlySeen, true, '无 ffmpeg 时应带 durlOnly 重新请求播放地址');
  assert.equal(calls, 2, '首包 DASH + 第二次 durlOnly 共两次 playurl');
  assert.equal(result.merged, false);
  assert.equal(result.bytes, durlBytes.length);
  assert.equal(fakeFfmpeg.calls.length, 0, '无 ffmpeg 时不能调用 ffmpeg');
  assert.deepEqual([...await fsp.readFile(result.file)], [...durlBytes]);
});

test('download: 无 ffmpeg 且 durlOnly 也拿不到整段 MP4 时报 BILI_FFMPEG_MISSING', async (t) => {
  const root = await makeDownloadRoot(t);
  let calls = 0;
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '只有 DASH' }),
    playurl: () => {
      calls += 1;
      return { ...dashPlay(), durl: [] };
    },
  });
  const http = createFakeHttp({});
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  await assert.rejects(
    () => downloader.run({ target: BVID }, {}),
    (error) => error instanceof BiliError && error.code === CODES.FFMPEG_MISSING && /ffmpeg/.test(error.message),
  );
  assert.equal(calls, 2, '应尝试 durlOnly 兜底后才失败');
  assert.deepEqual(await listFiles(root), [], '失败不应留下文件');
});

test('download: audioOnly + ffmpeg 只输入音频并输出 .m4a（merged=false）', async (t) => {
  const root = await makeDownloadRoot(t);
  const audioBytes = new Uint8Array(2048).fill(0x41);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '音频下载', durationSec: 30 }),
    playurl: () => ({ ...dashPlay(), video: [] }),
  });
  const http = createFakeHttp({ 'a192.m4s': openRoute({ bytes: audioBytes }) });
  const fakeFfmpeg = createFakeFfmpeg(true);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  const result = await downloader.run({ target: BVID, audioOnly: true }, {});

  assert.equal(result.audioOnly, true);
  assert.equal(result.merged, false, '纯音频不是音视频合并');
  assert.ok(result.file.endsWith('.m4a'), `音频输出应为 .m4a：${result.file}`);
  const ffmpegCall = fakeFfmpeg.calls[0];
  assert.equal(ffmpegCall.args.filter((arg) => arg === '-i').length, 1, 'audioOnly 只有一个输入');
  assert.ok(ffmpegCall.args[ffmpegCall.args.length - 1].endsWith('.part.m4a'));
});

test('download: audioOnly 且无 ffmpeg 时保存 DASH 原始音频分片 .m4s', async (t) => {
  const root = await makeDownloadRoot(t);
  const audioBytes = new Uint8Array(777).fill(0x41);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '裸音频', durationSec: 30 }),
    playurl: () => ({ ...dashPlay(), video: [], durl: [] }),
  });
  const http = createFakeHttp({ 'a192.m4s': openRoute({ bytes: audioBytes }) });
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  const result = await downloader.run({ target: BVID, audioOnly: true }, {});

  assert.equal(result.audioOnly, true);
  assert.equal(result.merged, false);
  assert.ok(result.file.endsWith('.m4s'), `无 ffmpeg 的音频应保持 .m4s：${result.file}`);
  assert.equal(result.bytes, audioBytes.length);
});

test('download: quality=720 选择 720P 视频流', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '选流测试' }),
    playurl: () => dashPlay(),
  });
  const http = createFakeHttp({
    'v1080.m4s': openRoute({ bytes: new Uint8Array(16) }),
    'v720.m4s': openRoute({ bytes: new Uint8Array(16) }),
    'a192.m4s': openRoute({ bytes: new Uint8Array(16) }),
  });
  const fakeFfmpeg = createFakeFfmpeg(true);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  await downloader.run({ target: BVID, quality: '720' }, {});
  const urls = http.calls.map((call) => call.url);
  assert.ok(urls.includes(VIDEO_720_URL));
  assert.equal(urls.includes(VIDEO_1080_URL), false);
});

test('download: content-length 超过 maxDownloadMb 时提前失败且不留文件', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '超限' }),
    playurl: () => durlPlay(0),
  });
  const http = createFakeHttp({
    'durl.mp4': openRoute({ bytes: new Uint8Array(8), contentLength: 2 * 1024 * 1024 }),
  });
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, maxDownloadMb: 1, runFfmpeg: fakeFfmpeg.runFfmpeg });

  await assert.rejects(
    () => downloader.run({ target: BVID }, {}),
    (error) => error instanceof BiliError && error.code === CODES.DOWNLOAD && /上限/.test(error.message),
  );
  assert.deepEqual(await listFiles(root), [], '超限失败不应留下文件');
});

test('download: content-length 与实际字节数不符时报下载不完整并清理 .part', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '不完整' }),
    playurl: () => durlPlay(0),
  });
  const http = createFakeHttp({
    'durl.mp4': openRoute({ bytes: new Uint8Array(10), contentLength: 100 }),
  });
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  await assert.rejects(
    () => downloader.run({ target: BVID }, {}),
    (error) => error instanceof BiliError && error.code === CODES.DOWNLOAD && /不完整/.test(error.message),
  );
  assert.deepEqual(await listFiles(root), [], '.part 应被清理');
});

test('download: exec.signal 已取消时立即失败', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '取消' }),
    playurl: () => durlPlay(0),
  });
  const http = createFakeHttp({ 'durl.mp4': openRoute({ bytes: new Uint8Array(8) }) });
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => downloader.run({ target: BVID }, { signal: controller.signal }),
    (error) => error instanceof BiliError && error.code === CODES.DOWNLOAD && /取消/.test(error.message),
  );
  assert.equal(http.calls.length, 0, '取消后不应发起请求');
  assert.deepEqual(await listFiles(root), []);
});

test('download: 写入过程中取消会抛「下载已取消」并清理 .part', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '中途取消' }),
    playurl: () => durlPlay(0),
  });
  const controller = new AbortController();
  let pulls = 0;
  const body = new ReadableStream({
    pull(streamController) {
      pulls += 1;
      if (pulls === 1) {
        streamController.enqueue(new Uint8Array(4));
      } else {
        controller.abort();
        streamController.error(new Error('test abort'));
      }
    },
  });
  const http = createFakeHttp({
    'durl.mp4': () => ({ status: 200, headers: new Headers({ 'content-length': '100' }), body, contentLength: 100 }),
  });
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  await assert.rejects(
    () => downloader.run({ target: BVID }, { signal: controller.signal }),
    (error) => error instanceof BiliError && error.code === CODES.DOWNLOAD && /取消/.test(error.message),
  );
  assert.deepEqual(await listFiles(root), [], '取消后必须清掉 .part');
});

test('download: dir 越界（.. 或根目录外绝对路径）被拒绝', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '越界' }),
    playurl: () => durlPlay(0),
  });
  const http = createFakeHttp({ 'durl.mp4': openRoute({ bytes: new Uint8Array(8) }) });
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  for (const dir of ['../outside', '..\\..\\outside', path.dirname(root)]) {
    await assert.rejects(
      () => downloader.run({ target: BVID, dir }, {}),
      (error) => error instanceof BiliError && error.code === CODES.INVALID_ARGUMENT,
      `dir=${JSON.stringify(dir)} 应被拒绝`,
    );
  }
});

test('download: 允许下载根目录内的子目录', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '子目录' }),
    playurl: () => durlPlay(4),
  });
  const http = createFakeHttp({ 'durl.mp4': openRoute({ bytes: new Uint8Array(4) }) });
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  const result = await downloader.run({ target: BVID, dir: 'anime/2026' }, {});
  assert.equal(path.dirname(result.file), path.join(root, 'anime', '2026'));
  assert.ok((await fsp.stat(result.file)).isFile());
});

test('download: 同名文件不覆盖，自动加 (2) 后缀；overwrite=true 时复用同名', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '同名: 视频?' }),
    playurl: () => durlPlay(4),
  });
  const http = createFakeHttp({ 'durl.mp4': openRoute({ bytes: new Uint8Array(4) }) });
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  const first = await downloader.run({ target: BVID }, {});
  const second = await downloader.run({ target: BVID }, {});
  assert.notEqual(first.file, second.file);
  assert.ok(second.file.endsWith(' (2).mp4'), `第二次应加 (2)：${second.file}`);
  assert.ok((await fsp.stat(first.file)).isFile());
  assert.ok((await fsp.stat(second.file)).isFile());
  // 文件名里的非法字符已被清洗
  assert.equal(path.basename(first.file).includes(':'), false);
  assert.equal(path.basename(first.file).includes('?'), false);

  const overwritten = await downloader.run({ target: BVID, overwrite: true }, {});
  assert.equal(overwritten.file, first.file, 'overwrite=true 应复用同名路径');
});

test('download: api.playurl 的 quality 是 { id, label } 对象时返回 label', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '清晰度对象' }),
    playurl: () => ({ ...durlPlay(4), quality: { id: 64, label: '720P' } }),
  });
  const http = createFakeHttp({ 'durl.mp4': openRoute({ bytes: new Uint8Array(4) }) });
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  const result = await downloader.run({ target: BVID, quality: '720' }, {});
  assert.equal(result.quality, '720P');
});

test('download: page>1 时用 bvid 重建带 ?p= 的 target 传给 playurl', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '分P视频' }),
    playurl: () => durlPlay(4),
  });
  const http = createFakeHttp({ 'durl.mp4': openRoute({ bytes: new Uint8Array(4) }) });
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  const result = await downloader.run({ target: BVID, page: 2 }, {});
  const playCall = api.calls.find((call) => call.method === 'playurl');
  assert.equal(playCall.args[0].target, `https://www.bilibili.com/video/${BVID}?p=2`);
  assert.equal(playCall.args[0].page, 2);
  assert.ok(path.basename(result.file).includes('P2'), `文件名应带 P2：${result.file}`);
});

test('download: 参数校验（缺 target / 非法 quality / 非法 page）', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '参数' }),
    playurl: () => durlPlay(0),
  });
  const http = createFakeHttp({ 'durl.mp4': openRoute({ bytes: new Uint8Array(0) }) });
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  await assert.rejects(
    () => downloader.run({}, {}),
    (error) => error instanceof BiliError && error.code === CODES.INVALID_ARGUMENT,
  );
  await assert.rejects(
    () => downloader.run({ target: BVID, quality: '4k' }, {}),
    (error) => error instanceof BiliError && error.code === CODES.INVALID_ARGUMENT,
  );
  await assert.rejects(
    () => downloader.run({ target: BVID, page: 0 }, {}),
    (error) => error instanceof BiliError && error.code === CODES.INVALID_ARGUMENT,
  );
  assert.equal(api.calls.filter((call) => call.method === 'playurl').length, 0, '参数非法时不应请求 playurl');
});

test('download: 返回结构只含契约 §10 规定的字段', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '结构', durationSec: 9 }),
    playurl: () => durlPlay(4),
  });
  const http = createFakeHttp({ 'durl.mp4': openRoute({ bytes: new Uint8Array(4) }) });
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  const result = await downloader.run({ target: BVID }, {});
  assert.deepEqual(Object.keys(result).sort(), [
    'audioOnly', 'bytes', 'durationSec', 'elapsedMs', 'file', 'merged', 'quality', 'sizeText',
  ]);
});

test('download: ffmpeg 合并失败时报 DOWNLOAD 并清理临时输出', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: 'ffmpeg 失败' }),
    playurl: () => dashPlay(),
  });
  const http = createFakeHttp({
    'v1080.m4s': openRoute({ bytes: new Uint8Array(32) }),
    'a192.m4s': openRoute({ bytes: new Uint8Array(32) }),
  });
  const fakeFfmpeg = createFakeFfmpeg(true);
  const failingFfmpeg = async () => {
    throw new Error('spawn ffmpeg ENOENT');
  };
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: failingFfmpeg });

  await assert.rejects(
    () => downloader.run({ target: BVID }, {}),
    (error) => error instanceof BiliError && error.code === CODES.DOWNLOAD && /ffmpeg 合并失败/.test(error.message),
  );
  assert.deepEqual(await listFiles(root), [], '失败后不应留下 .part.mp4');
});

test('download: ffmpeg 探测抛错时按无 ffmpeg 处理并回退 durl', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '探测异常' }),
    playurl: () => durlPlay(4),
  });
  const http = createFakeHttp({ 'durl.mp4': openRoute({ bytes: new Uint8Array(4) }) });
  const brokenProbe = {
    detect: async () => {
      throw new Error('probe broken');
    },
  };
  const downloader = makeDownloader({ root, api, http, ffmpeg: brokenProbe, runFfmpeg: createFakeFfmpeg(true).runFfmpeg });

  const result = await downloader.run({ target: BVID }, {});
  assert.equal(result.merged, false);
  assert.ok(result.file.endsWith('.mp4'));
});

test('download: http.open 返回非 2xx 时报 DOWNLOAD', async (t) => {
  const root = await makeDownloadRoot(t);
  const api = createFakeApi({
    resolveTarget: () => ({ bvid: BVID, aid: 1, page: 1, title: '403' }),
    playurl: () => durlPlay(4),
  });
  const http = createFakeHttp({ 'durl.mp4': openRoute({ bytes: new Uint8Array(4), status: 403 }) });
  const fakeFfmpeg = createFakeFfmpeg(false);
  const downloader = makeDownloader({ root, api, http, ffmpeg: fakeFfmpeg.probe, runFfmpeg: fakeFfmpeg.runFfmpeg });

  await assert.rejects(
    () => downloader.run({ target: BVID }, {}),
    (error) => error instanceof BiliError && error.code === CODES.DOWNLOAD && /HTTP 403/.test(error.message),
  );
});
