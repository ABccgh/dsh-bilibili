/**
 * API 层：分P页码传递、分P越界校验、status 注入 ffmpeg、logout 清理凭据。
 *
 * 全部用假 http / 假 cookies / 假 wbi / 假 ffmpeg，离线运行。
 * （本文件原本不在 T1 的测试清单里，是 Lead 在集成反馈里点名补的回归测试。）
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createBiliApi } from '../lib/api.js';
import { BiliError, CODES } from '../lib/errors.js';
import { createFakeHttp, createFakeLogger } from './helpers.js';

/** 三集测试视频的 view 响应。 */
const VIEW = {
  bvid: 'BV1Q541167Qg',
  aid: 455017605,
  cid: 101,
  title: '三集测试视频',
  pic: '//i0.hdslb.com/bfs/archive/cover.jpg',
  duration: 600,
  pubdate: 1700000000,
  desc: '<b>简介</b>&amp;说明',
  owner: { mid: 7, name: 'UP主', face: '//i0.hdslb.com/bfs/face/face.jpg' },
  stat: { view: 1, danmaku: 2, like: 3, coin: 4, favorite: 5, share: 6, reply: 7 },
  pages: [
    { cid: 101, page: 1, part: 'P1', duration: 100 },
    { cid: 202, page: 2, part: 'P2', duration: 200 },
    { cid: 303, page: 3, part: 'P3', duration: 300 },
  ],
};

/** playurl 的 DASH 响应。 */
const PLAYURL = {
  code: 0,
  data: {
    quality: 64,
    accept_quality: [80, 64],
    accept_description: ['高清 1080P', '高清 720P'],
    dash: {
      video: [
        {
          id: 64,
          baseUrl: 'https://x.example.com/video-64.m4s?deadline=1800000000',
          backupUrl: ['https://y.example.com/video-64.m4s'],
          bandwidth: 1000000,
          codecs: 'avc1.64001F',
          width: 1280,
          height: 720,
        },
        {
          id: 64,
          baseUrl: 'https://x.example.com/video-64-hevc.m4s',
          bandwidth: 800000,
          codecs: 'hev1.1.6.L120.90',
          width: 1280,
          height: 720,
        },
      ],
      audio: [
        { id: 30216, baseUrl: 'https://x.example.com/audio-30216.m4s', bandwidth: 64000, codecs: 'mp4a.40.2' },
        { id: 30280, baseUrl: 'https://x.example.com/audio-30280.m4s', bandwidth: 129664, codecs: 'mp4a.40.2' },
      ],
    },
  },
};

/**
 * 造一个只用来断言 URL 的假 wbi。
 * @returns {{ sign: (params: Record<string, unknown>) => Promise<string> }} 假签名器。
 */
function makeFakeWbi() {
  return {
    async sign(params) {
      return Object.entries(params)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');
    },
    async status() {
      return { cached: true, fetchedAt: 123 };
    },
  };
}

/**
 * 造假的 Cookie 罐。
 * @param {{ invalidate?: Function }} [options] - 选项。
 * @returns {object} 假罐。
 */
function makeFakeCookies(options = {}) {
  return {
    async header() {
      return '';
    },
    async status() {
      return { configured: false, names: [] };
    },
    invalidate: options.invalidate ?? (() => {}),
    name: 'cookies',
  };
}

/**
 * 造一个可用的 API 客户端（假 http）。
 * @param {{ routes?: Record<string, any>, ffmpeg?: object, credentials?: object,
 *   cookies?: object, http?: object }} [options] - 选项。
 * @returns {{ api: any, http: any, logger: any }} 客户端与假依赖。
 */
function makeApi(options = {}) {
  const logger = createFakeLogger();
  const http = options.http ?? createFakeHttp({
    'x/web-interface/view': { code: 0, data: VIEW },
    'x/tag/archive/tags': {
      code: 0,
      data: [
        { tag_id: 1, tag_name: '测试<em>标签</em>', count: { use: 5 } },
        { tag_id: 2, tag_name: '第二' },
      ],
    },
    'x/player/wbi/playurl': PLAYURL,
    'x/player/wbi/v2': { code: 0, data: { subtitle: { subtitles: [] } } },
    'x/v2/dm/web/seg.so': new Uint8Array(0),
    'x/web-interface/nav': { code: -101, data: { isLogin: false } },
    ...options.routes,
  });
  const api = createBiliApi({
    http,
    cookies: options.cookies ?? makeFakeCookies(),
    wbi: makeFakeWbi(),
    appApi: { async search() { return { item: [] }; }, async spaceArchive() { return {}; } },
    ffmpeg: options.ffmpeg,
    config: { maxListedItems: 5, cookieEnv: 'BILI_COOKIE' },
    logger,
    credentials: options.credentials,
    now: () => 1700000000000,
  });
  return { api, http, logger };
}

/**
 * 取最后一次匹配片段的请求。
 * @param {any} http - 假 http。
 * @param {string} fragment - URL 片段。
 * @returns {{ url: string, options: any, kind: string } | undefined} 调用记录。
 */
function lastCall(http, fragment) {
  return [...http.calls].reverse().find((call) => call.url.includes(fragment));
}

test('video：分P 全量返回，不按 page 过滤', async () => {
  const { api } = makeApi();
  const result = await api.video({ target: 'BV1Q541167Qg', page: 2 });
  assert.equal(result.parts.length, 3);
  assert.deepEqual(result.parts.map((part) => part.cid), [101, 202, 303]);
  assert.deepEqual(result.parts.map((part) => part.durationText), ['1:40', '3:20', '5:00']);
  assert.equal(result.video.pages.length, 3);
  assert.equal(result.video.title, '三集测试视频');
  assert.equal(result.video.desc, '简介&说明');
  assert.deepEqual(result.tags, [
    { id: 1, name: '测试标签', count: 5 },
    { id: 2, name: '第二' },
  ]);
  assert.equal(result.video.url, 'https://www.bilibili.com/video/BV1Q541167Qg');
  assert.equal(result.video.owner.name, 'UP主');
  assert.equal(result.video.cover, 'https://i0.hdslb.com/bfs/archive/cover.jpg');
});

test('video：page 越界抛 BILI_INVALID_ARGUMENT', async () => {
  const { api } = makeApi();
  await assert.rejects(api.video({ target: 'BV1Q541167Qg', page: 4 }), (error) => {
    assert.ok(error instanceof BiliError);
    assert.equal(error.code, CODES.INVALID_ARGUMENT);
    assert.match(error.message, /分P数量/);
    return true;
  });
  // 合法页码不报错；不传 page 也不报错。
  await api.video({ target: 'BV1Q541167Qg', page: 3 });
  await api.video({ target: 'BV1Q541167Qg' });
});

test('resolveTarget 用 URL 里的 p 参数（identity.page），且保持契约形状', async () => {
  const { api } = makeApi();
  const single = await api.resolveTarget('BV1Q541167Qg');
  assert.deepEqual(single, {
    bvid: 'BV1Q541167Qg',
    aid: 455017605,
    page: 1,
    cid: 101,
    title: '三集测试视频',
    durationSec: 100,
  });
  const paged = await api.resolveTarget('https://www.bilibili.com/video/BV1Q541167Qg/?p=3');
  assert.equal(paged.page, 3);
  assert.equal(paged.cid, 303);
  assert.equal(paged.durationSec, 300);
});

test('danmaku：args.page 覆盖 identity.page，并落成 oid', async () => {
  const { api, http } = makeApi();
  const page2 = await api.danmaku({ target: 'BV1Q541167Qg', page: 2, limit: 5 });
  assert.equal(lastCall(http, 'seg.so').url.includes('oid=202'), true);
  assert.equal(page2.count, 2);
  assert.equal(page2.sampled, 0);

  await api.danmaku({ target: 'BV1Q541167Qg', page: 3 });
  assert.equal(lastCall(http, 'seg.so').url.includes('oid=303'), true);

  // 不传 args.page 时用 URL 的 ?p=2。
  await api.danmaku({ target: 'https://www.bilibili.com/video/BV1Q541167Qg/?p=2' });
  assert.equal(lastCall(http, 'seg.so').url.includes('oid=202'), true);

  const call = lastCall(http, 'seg.so');
  assert.equal(call.options.headers['accept-encoding'], 'identity');
  assert.equal(call.options.headers.referer, 'https://www.bilibili.com/BV1Q541167Qg'.replace('/BV', '/video/BV'));
});

test('playurl：args.page 决定 cid，DASH 流归一（视频按清晰度、音频按 id 排序）', async () => {
  const { api, http } = makeApi();
  const result = await api.playurl({ target: 'BV1Q541167Qg', page: 2, quality: '720', audioOnly: false });
  const call = lastCall(http, 'playurl');
  assert.ok(call.url.includes('cid=202'));
  assert.ok(call.url.includes('qn=64'));
  assert.ok(call.url.includes('fnval=4048'));
  assert.ok(call.url.includes('bvid=BV1Q541167Qg'));

  assert.deepEqual(result.media, { bvid: 'BV1Q541167Qg', cid: 202, page: 2, durationSec: 200 });
  assert.deepEqual(result.quality, { id: 64, label: '高清 720P' });
  assert.deepEqual(result.accept, [
    { id: 80, label: '高清 1080P' },
    { id: 64, label: '高清 720P' },
  ]);
  // 同清晰度去重（保留 avc）、音频按 id 从高到低（30280 最优）。
  assert.deepEqual(result.video.map((stream) => [stream.id, stream.codec]), [['64', 'avc1.64001F']]);
  assert.deepEqual(result.audio.map((stream) => stream.id), ['30280', '30216']);
  assert.equal(result.video[0].width, 1280);
  assert.equal(result.video[0].height, 720);
  assert.deepEqual(result.video[0].backupUrls, ['https://y.example.com/video-64.m4s']);
  assert.equal(result.expiresAt, 1800000000);
  assert.equal(result.durl.length, 0);

  // 不传 args.page：URL 里的 ?p=3。
  await api.playurl({ target: 'https://www.bilibili.com/video/BV1Q541167Qg/?p=3', quality: 'best' });
  assert.ok(lastCall(http, 'playurl').url.includes('cid=303'));
});

test('subtitle：args.page 决定 cid', async () => {
  const { api, http } = makeApi();
  const result = await api.subtitle({ target: 'BV1Q541167Qg', page: 3 });
  assert.ok(lastCall(http, 'player/wbi/v2').url.includes('cid=303'));
  assert.deepEqual(result, { languages: [], lines: [] });

  await api.subtitle({ target: 'BV1Q541167Qg' });
  assert.ok(lastCall(http, 'player/wbi/v2').url.includes('cid=101'));
});

test('status：注入的 ffmpeg.detect 结果会出现在返回里', async () => {
  const ffmpeg = {
    async detect() {
      return { available: true, path: 'C:\\ffmpeg.exe', version: 'ffmpeg version 7.0' };
    },
  };
  const { api } = makeApi({ ffmpeg });
  const status = await api.status();
  assert.equal(status.loggedIn, false);
  assert.deepEqual(status.cookie, { configured: false });
  assert.deepEqual(status.wbi, { cached: true, fetchedAt: 123 });
  assert.deepEqual(status.ffmpeg, { available: true, path: 'C:\\ffmpeg.exe', version: 'ffmpeg version 7.0' });
});

test('status：没有 ffmpeg 时不带 ffmpeg 字段；detect 抛错时归一成 available:false', async () => {
  const noFfmpeg = makeApi();
  assert.equal('ffmpeg' in (await noFfmpeg.api.status()), false);

  const broken = makeApi({
    ffmpeg: {
      async detect() {
        throw new Error('探测失败');
      },
    },
  });
  const status = await broken.api.status();
  assert.equal(status.ffmpeg.available, false);
  assert.equal(status.ffmpeg.error, '探测失败');
});

test('logout：清凭据并让 Cookie 罐失效', async () => {
  /** @type {Array<[string, string]>} */
  const calls = [];
  let invalidated = 0;
  const { api } = makeApi({
    credentials: {
      async unset(ref) {
        calls.push(['unset', ref]);
      },
    },
    cookies: makeFakeCookies({
      invalidate() {
        invalidated += 1;
      },
    }),
  });
  assert.deepEqual(await api.logout(), { cleared: true });
  assert.deepEqual(calls, [['unset', 'BILI_COOKIE']]);
  assert.equal(invalidated, 1);

  const noCredentials = makeApi();
  assert.deepEqual(await noCredentials.api.logout(), { cleared: true });
});
