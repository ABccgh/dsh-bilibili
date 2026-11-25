/**
 * 公开工具层（T2）测试。
 *
 * 覆盖：13 个工具的注册与参数 schema、每个工具的成功路径与 json 围栏契约、
 * 列表截断（「还有 N 条」）、图片附件（开关与静默降级）、错误路径（BiliError 与参数校验），
 * 以及工具层不得 import Host 层模块的静态约束。
 *
 * 全部离线：只有 `test/helpers.js` 的假 api / 假图片服务与内联 fixture，不联网、不写文件。
 *
 * @module test/tools-public
 */

import fs from 'node:fs';
import path from 'node:path';

import test from 'node:test';
import assert from 'node:assert/strict';

import { PLUGIN_VERSION } from '../lib/config.js';
import { BiliError, CODES, isBiliError } from '../lib/errors.js';
import { createCommunityTools } from '../lib/tools/community.js';
import { createHotwordTools, createHotwordsTools } from '../lib/tools/hotwords.js';
import { createMediaTools } from '../lib/tools/media.js';
import { createSearchTools } from '../lib/tools/search.js';
import { createStatusTools } from '../lib/tools/status.js';
import { createUserTools } from '../lib/tools/user.js';
import { createVideoTools } from '../lib/tools/video.js';
import {
  createFakeApi,
  createFakeLogger,
  executeTool,
  parseFence,
  repoRoot,
} from './helpers.js';

/** 13 个公开工具名（注册顺序）。 */
const TOOL_NAMES = [
  'bili_status',
  'bili_search',
  'bili_video',
  'bili_user',
  'bili_comments',
  'bili_danmaku',
  'bili_ranking',
  'bili_popular',
  'bili_bangumi',
  'bili_live',
  'bili_playurl',
  'bili_subtitle',
  'bili_hotwords',
];

/** 每个工具的参数名集合（契约 §10，排序后比较）。 */
const EXPECTED_PARAMETERS = {
  bili_status: [],
  bili_search: ['keyword', 'order', 'page', 'pageSize', 'type'],
  bili_video: ['includeParts', 'includeTags', 'page', 'target'],
  bili_user: ['includeVideos', 'limit', 'mid'],
  bili_comments: ['includeReplies', 'page', 'sort', 'target'],
  bili_danmaku: ['limit', 'page', 'target'],
  bili_ranking: ['area', 'limit'],
  bili_popular: ['kind', 'limit'],
  bili_bangumi: ['epId', 'seasonId'],
  bili_live: ['roomId'],
  bili_playurl: ['audioOnly', 'page', 'quality', 'target'],
  bili_subtitle: ['lang', 'page', 'target'],
  bili_hotwords: ['limit'],
};

/** 每个工具的必填参数（契约 §10，只有这些字段是 required）。 */
const EXPECTED_REQUIRED = {
  bili_search: ['keyword'],
  bili_video: ['target'],
  bili_user: ['mid'],
  bili_comments: ['target'],
  bili_danmaku: ['target'],
  bili_live: ['roomId'],
  bili_playurl: ['target'],
  bili_subtitle: ['target'],
};

/** 工具层 7 个文件。 */
const TOOL_FILES = ['status', 'search', 'video', 'user', 'community', 'media', 'hotwords']
  .map((module) => `lib/tools/${module}.js`);

/**
 * 造一个假图片附件器。
 * @param {{ throws?: boolean, blocks?: object[] }} [options] - 选项。
 * @returns {{ calls: object[], attachUrls: Function }} 假服务。
 */
function createFakeImages(options = {}) {
  /** @type {Array<{ urls: string[], options: any }>} */
  const calls = [];
  return {
    calls,
    async attachUrls(urls, attachOptions) {
      calls.push({ urls: Array.isArray(urls) ? [...urls] : [], options: attachOptions });
      if (options.throws === true) throw new Error('附件服务不可用');
      const blocks = Array.isArray(options.blocks)
        ? options.blocks
        : (Array.isArray(urls) ? urls.map((url, index) => ({
          type: 'image',
          attachment: {
            attachmentId: `att-${index + 1}`,
            mediaType: 'image/jpeg',
            bytes: 1024,
            width: 320,
            height: 180,
            name: `image-${index + 1}`,
            sourceUrl: url,
          },
        })) : []);
      return { blocks, attached: blocks.length };
    },
  };
}

/**
 * 造工具层的装配依赖。
 * @param {{ config?: Record<string, any>, api?: any, images?: any, ffmpeg?: any }} [overrides] - 覆盖项。
 * @returns {Record<string, any>} deps。
 */
function createDeps(overrides = {}) {
  const config = {
    maxListedItems: 25,
    attachImages: false,
    downloadDir: '',
    panelEnabled: true,
    publicRoute: true,
    ...(overrides.config ?? {}),
  };
  return {
    config,
    version: '0.1.0',
    api: overrides.api ?? createFakeApi(),
    images: Object.prototype.hasOwnProperty.call(overrides, 'images') ? overrides.images : createFakeImages(),
    ffmpeg: Object.prototype.hasOwnProperty.call(overrides, 'ffmpeg')
      ? overrides.ffmpeg
      : { detect: async () => ({ available: false }) },
    logger: createFakeLogger(),
  };
}

/**
 * 按契约顺序拼出 13 个工具定义。
 * @param {Record<string, any>} deps - 装配依赖。
 * @returns {object[]} 工具定义数组。
 */
function createTools(deps) {
  return [
    ...createStatusTools(deps),
    ...createSearchTools(deps),
    ...createVideoTools(deps),
    ...createUserTools(deps),
    ...createCommunityTools(deps),
    ...createMediaTools(deps),
    ...createHotwordTools(deps),
  ];
}

/**
 * 取「工具名 → 定义」的映射。
 * @param {Record<string, any>} deps - 装配依赖。
 * @returns {Map<string, object>} 映射。
 */
function toolMap(deps) {
  return new Map(createTools(deps).map((definition) => [definition.name, definition]));
}

/**
 * 执行一个工具并返回 `{ value, blocks, text }`。
 * @param {Record<string, any>} deps - 装配依赖。
 * @param {string} name - 工具名。
 * @param {Record<string, unknown>} [args] - 参数。
 * @returns {Promise<{ value: any, blocks: object[], text: string }>} 结果。
 */
async function runTool(deps, name, args = {}) {
  const definition = toolMap(deps).get(name);
  assert.ok(definition !== undefined, `工具 ${name} 必须存在`);
  return executeTool(definition, args);
}

/**
 * 断言结果的 json 围栏可解析、内容与 `value.data` 一致、且围栏是最后一段。
 * @param {{ value: any, blocks: object[], text: string }} result - 工具结果。
 * @returns {void}
 */
function assertFence(result) {
  const stripped = result.text.trimEnd();
  assert.match(stripped, /```$/, '结尾必须是 json 围栏块');
  const lastFenceStart = stripped.lastIndexOf('```json');
  assert.ok(lastFenceStart > 0, '必须有 json 围栏块');
  assert.match(stripped.slice(lastFenceStart), /^```json\n[\s\S]*\n```$/, 'json 围栏块必须是最后一段');
  const parsed = parseFence(result.text);
  assert.ok(parsed !== null, 'json 围栏必须可解析');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data, JSON.parse(JSON.stringify(result.value.data)));
}

/**
 * 生成一条视频类 `Item`。
 * @param {Record<string, unknown>} [overrides] - 覆盖字段。
 * @returns {Record<string, unknown>} Item。
 */
function videoItem(overrides = {}) {
  return {
    type: 'video',
    bvid: 'BV1xx411c7mD',
    aid: 170001,
    title: '测试视频：明日方舟攻略',
    author: '测试UP',
    cover: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
    play: 123456,
    danmaku: 234,
    durationSec: 213,
    durationText: '03:33',
    pubdate: 1700000000,
    pubdateText: '2023-11-15',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    ...overrides,
  };
}

/** 视频详情（`Video`）。 */
const VIDEO_DETAIL = {
  bvid: 'BV1xx411c7mD',
  aid: 170001,
  title: '测试视频：明日方舟攻略',
  cover: 'https://i0.hdslb.com/bfs/archive/cover.jpg',
  durationSec: 213,
  durationText: '03:33',
  pubdate: 1700000000,
  pubdateText: '2023-11-15',
  desc: '  这是一段视频简介，含换行。\n第二行。',
  owner: { mid: 946974, name: '测试UP', face: 'https://i0.hdslb.com/bfs/face/p.jpg' },
  stat: { view: 123456, danmaku: 234, like: 1000, coin: 200, favorite: 300, share: 20, reply: 88 },
  pages: [{ cid: 170001, page: 1, part: 'P1 前言', durationSec: 213, durationText: '03:33' }],
  tags: [{ id: 1, name: '明日方舟', count: 100 }],
  url: 'https://www.bilibili.com/video/BV1xx411c7mD',
};

/** UP 主（`User`）。 */
const USER_DETAIL = {
  mid: 946974,
  name: '测试UP',
  face: 'https://i0.hdslb.com/bfs/face/p.jpg',
  fans: 1234567,
  level: 6,
  sign: '  签名：只做攻略\n不改名。',
  official: '认证：某机构',
  vip: { status: 1, label: '年度大会员' },
  archiveCount: 88,
  url: 'https://space.bilibili.com/946974',
};

/** 一条评论（`Comment`）。 */
const COMMENT = {
  rpid: 600001,
  mid: 12345,
  uname: '评论者甲',
  avatar: 'https://i0.hdslb.com/bfs/face/a.jpg',
  message: '  前排围观，这条评论有\n换行。',
  like: 12000,
  ctime: 1700000000,
  ctimeText: '2023-11-15 12:00',
  replyCount: 2,
  replies: [
    { rpid: 600002, uname: '回复者乙', message: '同意', like: 3, ctimeText: '2023-11-15 12:05' },
    { rpid: 600003, uname: '回复者丙', message: '补充一句', like: 1, ctimeText: '2023-11-15 12:06' },
  ],
};

/** 一条弹幕（`Danmaku`）。 */
const DANMAKU = { timeMs: 12000, mode: 1, color: 16777215, text: '  哈哈哈哈\n前排  ', ctime: 1700000000 };

/** 番剧（`Bangumi`）。 */
const BANGUMI = {
  seasonId: 33378,
  title: '测试番剧',
  cover: 'https://i0.hdslb.com/bfs/bangumi/cover.jpg',
  evaluate: 12345,
  rating: 9.2,
  totalEpisodes: 12,
  episodes: [
    { epId: 1001, title: '第 1 话', bvid: 'BV1ep0001', cover: 'https://i0.hdslb.com/bfs/ep/1.jpg', durationSec: 1440 },
    { epId: 1002, title: '第 2 话', bvid: 'BV1ep0002', durationSec: 1440 },
  ],
  url: 'https://www.bilibili.com/bangumi/play/ss33378',
};

/** 直播间（`Room`）。 */
const ROOM = {
  roomId: 22625025,
  shortId: 1234,
  title: '测试直播间',
  cover: 'https://i0.hdslb.com/bfs/live/cover.jpg',
  liveStatus: 1,
  online: 12345,
  attention: 6789,
  url: 'https://live.bilibili.com/22625025',
};

/** 主播（`User`）。 */
const ANCHOR = {
  mid: 999,
  name: '主播甲',
  face: 'https://i0.hdslb.com/bfs/face/anchor.jpg',
  fans: 100,
  level: 6,
  url: 'https://space.bilibili.com/999',
};

/** 播放地址结果。 */
const PLAYURL = {
  media: { bvid: 'BV1xx411c7mD', cid: 170001, page: 1, durationSec: 213 },
  quality: 80,
  accept: [{ id: 80, label: '1080P 高清' }, { id: 64, label: '720P 高清' }],
  video: [{
    id: 80,
    label: '1080P 高清',
    codec: 'avc1.640032',
    width: 1920,
    height: 1080,
    bytes: 12345678,
    url: 'https://upos-sz-mirrorcos.bilivideo.com/video.m4s?sign=1',
    backupUrls: ['https://cn-hbxy-cu-01.bilivideo.com/video.m4s?sign=2'],
  }],
  audio: [{
    id: 30280,
    label: '192K',
    codec: 'mp4a.40.2',
    bytes: 3456789,
    url: 'https://upos-sz-mirrorcos.bilivideo.com/audio.m4s?sign=3',
  }],
  durl: [],
  expiresAt: 1900000000,
};

/** 字幕结果。 */
const SUBTITLE = {
  languages: [{ lan: 'zh-CN', lanDoc: '中文（中国）', url: 'https://i0.hdslb.com/bfs/subtitle/x.json' }],
  lang: 'zh-CN',
  lines: [
    { fromSec: 1.2, toSec: 4.5, text: '这是第一句字幕' },
    { fromSec: 4.5, toSec: 8, text: '这是第二句字幕' },
  ],
};

/** 热搜条目。 */
const HOTWORD = { keyword: '测试热搜', showName: '测试热搜词', icon: 'https://i0.hdslb.com/bfs/hot.png' };

/**
 * 每个工具的成功用例：假 api 返回值、调用参数、额外 deps 与断言。
 * @type {Record<string, { args?: Record<string, unknown>, api: Record<string, any>,
 *   deps?: Record<string, any>, check: (result: any) => void }>}
 */
const SUCCESS_CASES = {
  bili_status: {
    api: {
      status: {
        loggedIn: true,
        user: { mid: 123, uname: '甲', face: 'https://i0.hdslb.com/bfs/face/a.jpg', level: 6 },
        cookie: { configured: true, source: 'credentials' },
        wbi: { cached: true, fetchedAt: 1700000000000 },
      },
    },
    deps: { ffmpeg: { detect: async () => ({ available: true, version: '6.1' }) } },
    check(result) {
      const { data } = result.value;
      assert.equal(data.version, '0.1.0');
      assert.equal(data.loggedIn, true);
      assert.equal(data.user.mid, 123);
      assert.deepEqual(data.cookie, { configured: true, source: 'credentials' });
      assert.equal(data.ffmpeg.version, '6.1');
      assert.deepEqual(data.panel, { enabled: true, route: '/dsh-bilibili/api' });
      assert.ok(data.download.dir.endsWith('dsh-bilibili'));
      assert.match(result.text, /B 站集成状态（v0\.1\.0）/);
      assert.match(result.text, /已登录/);
      assert.match(result.text, /Cookie：已配置（来源 credentials）/);
      assert.match(result.text, /WBI：已缓存/);
      assert.match(result.text, /ffmpeg：可用（6\.1）/);
      assert.match(result.text, /侧栏面板：已启用/);
    },
  },
  bili_search: {
    args: { keyword: '明日方舟', type: 'video', order: 'click', pageSize: 2 },
    api: {
      search: {
        keyword: '明日方舟',
        type: 'video',
        page: 1,
        pageSize: 2,
        hasMore: true,
        total: 99,
        source: 'app',
        items: [videoItem(), videoItem({ bvid: 'BV2xx411c7mD', cover: 'https://i0.hdslb.com/bfs/archive/c2.jpg' })],
      },
    },
    check(result) {
      const { data } = result.value;
      assert.equal(data.keyword, '明日方舟');
      assert.equal(data.type, 'video');
      assert.equal(data.page, 1);
      assert.equal(data.hasMore, true);
      assert.deepEqual(data.items.map((item) => item.bvid), ['BV1xx411c7mD', 'BV2xx411c7mD']);
      assert.equal('total' in data, false, '不返回契约外字段 total');
      assert.equal('source' in data, false, '不返回契约外字段 source');
      assert.match(result.text, /在 B 站搜索「明日方舟」（视频 · 第 1 页 · 显示 2 条）/);
      assert.match(result.text, /12\.3万播放/);
      assert.match(result.text, /还有下一页：page=2/);
    },
  },
  bili_video: {
    args: { target: 'BV1xx411c7mD' },
    api: {
      video: {
        video: VIDEO_DETAIL,
        parts: [{ cid: 170001, page: 1, part: 'P1 前言', durationSec: 213, durationText: '03:33' }],
        tags: [{ id: 1, name: '明日方舟', count: 100 }, { id: 2, name: '攻略' }],
      },
    },
    check(result) {
      const { data } = result.value;
      assert.equal(data.video.bvid, 'BV1xx411c7mD');
      assert.equal(data.parts.length, 1);
      assert.equal(data.tags.length, 2);
      assert.match(result.text, /测试视频：明日方舟攻略/);
      assert.match(result.text, /UP 主：测试UP（UID 946974）/);
      assert.match(result.text, /播放 12\.3万 · 弹幕 234/);
      assert.match(result.text, /分P（显示 1 个）/);
      assert.match(result.text, /P1 P1 前言（03:33）/);
      assert.match(result.text, /标签：明日方舟、攻略/);
    },
  },
  bili_user: {
    args: { mid: 946974 },
    api: {
      user: {
        user: USER_DETAIL,
        videos: [videoItem(), videoItem({ bvid: 'BV2xx411c7mD', title: '第二个投稿' })],
      },
    },
    check(result) {
      const { data } = result.value;
      assert.equal(data.user.mid, 946974);
      assert.equal(data.videos.length, 2);
      assert.match(result.text, /测试UP（UID 946974）/);
      assert.match(result.text, /Lv6 · 123\.5万粉丝 · 投稿 88/);
      assert.match(result.text, /签名：签名：只做攻略 不改名。/);
      assert.match(result.text, /最近投稿（显示 2 条）/);
      assert.match(result.text, /2\. 第二个投稿/);
    },
  },
  bili_comments: {
    args: { target: 'BV1xx411c7mD' },
    api: {
      comments: { count: 12345, page: 1, hasMore: true, items: [COMMENT, { ...COMMENT, rpid: 600010, replies: [] }] },
    },
    check(result) {
      const { data } = result.value;
      assert.equal(data.count, 12345);
      assert.equal(data.page, 1);
      assert.equal(data.hasMore, true);
      assert.equal(data.items.length, 2);
      assert.match(result.text, /视频评论：共 1\.2万 条，第 1 页（热门），显示 2 条/);
      assert.match(result.text, /评论者甲（赞 1\.2万，回复 2，2023-11-15 12:00）/);
      assert.match(result.text, /↳ 回复者乙：同意/);
      assert.match(result.text, /还有下一页：page=2/);
    },
  },
  bili_danmaku: {
    args: { target: 'BV1xx411c7mD' },
    api: {
      danmaku: {
        count: 500,
        sampled: 100,
        distribution: [{ minute: 3, count: 88 }, { minute: 7, count: 120 }],
        items: [DANMAKU, { ...DANMAKU, timeMs: 65000, mode: 5, text: '顶部弹幕' }],
      },
    },
    check(result) {
      const { data } = result.value;
      assert.equal(data.count, 500);
      assert.equal(data.sampled, 100);
      assert.equal(data.distribution.length, 2);
      assert.equal(data.items.length, 2);
      assert.match(result.text, /弹幕：共 500 条，采样 100 条，显示 2 条/);
      assert.match(result.text, /密度最高的时间段：第 7 分钟 120 条、第 3 分钟 88 条/);
      assert.match(result.text, /1\. 00:12 哈哈哈哈 前排/);
      assert.match(result.text, /2\. 01:05（顶部） 顶部弹幕/);
    },
  },
  bili_ranking: {
    api: { ranking: { area: 'all', name: '全站', items: [videoItem(), videoItem({ bvid: 'BV9', title: '第二名' })] } },
    check(result) {
      const { data } = result.value;
      assert.equal(data.area, 'all');
      assert.equal(data.name, '全站');
      assert.equal(data.items.length, 2);
      assert.match(result.text, /全站排行榜（显示 2 条）/);
      assert.match(result.text, /1\. 【视频】测试视频：明日方舟攻略/);
      assert.match(result.text, /2\. 【视频】第二名/);
    },
  },
  bili_popular: {
    api: { popular: { kind: 'popular', items: [videoItem()] } },
    check(result) {
      const { data } = result.value;
      assert.equal(data.kind, 'popular');
      assert.equal(data.items.length, 1);
      assert.match(result.text, /B 站综合热门（显示 1 条）/);
    },
  },
  bili_bangumi: {
    args: { seasonId: 33378 },
    api: { bangumi: { season: BANGUMI } },
    check(result) {
      const { data } = result.value;
      assert.equal(data.season.seasonId, 33378);
      assert.equal(data.season.episodes.length, 2);
      assert.match(result.text, /测试番剧（seasonId 33378）/);
      assert.match(result.text, /评分 9\.2 · 共 12 集 · 评价 1\.2万 人/);
      assert.match(result.text, /EP1 第 1 话（24:00） · BV1ep0001/);
    },
  },
  bili_live: {
    args: { roomId: 22625025 },
    api: { live: { room: ROOM, anchor: ANCHOR } },
    check(result) {
      const { data } = result.value;
      assert.equal(data.room.roomId, 22625025);
      assert.equal(data.anchor.mid, 999);
      assert.match(result.text, /测试直播间（房间号 22625025 · 短号 1234）/);
      assert.match(result.text, /主播：主播甲（UID 999）/);
      assert.match(result.text, /状态：直播中 · 人气 1\.2万 · 关注 6789/);
    },
  },
  bili_playurl: {
    args: { target: 'BV1xx411c7mD' },
    api: { playurl: PLAYURL },
    check(result) {
      const { data } = result.value;
      assert.equal(data.media.bvid, 'BV1xx411c7mD');
      assert.equal(data.video.length, 1);
      assert.equal(data.audio.length, 1);
      assert.equal(data.quality, 80);
      assert.match(result.text, /播放地址：BV1xx411c7mD · cid 170001/);
      assert.match(result.text, /取到的清晰度：80/);
      assert.match(result.text, /可选清晰度：1080P 高清、720P 高清/);
      assert.match(result.text, /视频流（1 条）/);
      assert.match(result.text, /1080P 高清 · avc1\.640032 · 1920×1080 · 11\.8 MB · 备用 1 条/);
      assert.match(result.text, /音频流（1 条）/);
      assert.match(result.text, /地址过期时间：/);
    },
  },
  bili_subtitle: {
    args: { target: 'BV1xx411c7mD' },
    api: { subtitle: SUBTITLE },
    check(result) {
      const { data } = result.value;
      assert.equal(data.languages.length, 1);
      assert.equal(data.lang, 'zh-CN');
      assert.equal(data.lines.length, 2);
      assert.match(result.text, /可用字幕语言：中文（中国）（zh-CN）/);
      assert.match(result.text, /\[00:01 → 00:04\] 这是第一句字幕/);
    },
  },
  bili_hotwords: {
    args: { limit: 2 },
    api: { hotwords: { items: [HOTWORD, { keyword: '第二条热搜' }, { keyword: '第三条热搜' }] } },
    check(result) {
      const { data } = result.value;
      assert.equal(data.items.length, 2);
      assert.match(result.text, /B 站热搜（显示 2 条）/);
      assert.match(result.text, /1\. 测试热搜 — 测试热搜词/);
      assert.match(result.text, /还有 1 条未显示/);
    },
  },
};

test('公开工具层注册 13 个工具，名字唯一且都带 bili_ 前缀', () => {
  const definitions = createTools(createDeps());
  assert.equal(definitions.length, 13);
  assert.deepEqual(definitions.map((definition) => definition.name), TOOL_NAMES);
  assert.equal(new Set(definitions.map((definition) => definition.name)).size, 13);
  for (const definition of definitions) {
    assert.match(definition.name, /^bili_[a-z]+$/);
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 10, `${definition.name} 的描述太短`);
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.parameters.additionalProperties, false);
    assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(definition.output.schema.type, 'object');
  }
  // 单数与复数导出指向同一模块。
  assert.equal(createHotwordsTools, createHotwordTools);
});

test('每个工具的参数名与 required 严格按契约 §10', () => {
  const definitions = toolMap(createDeps());
  for (const name of TOOL_NAMES) {
    const definition = definitions.get(name);
    const actual = Object.keys(definition.parameters.properties ?? {}).sort();
    assert.deepEqual(actual, EXPECTED_PARAMETERS[name], `${name} 的参数集合不符`);
    const expectedRequired = EXPECTED_REQUIRED[name];
    if (expectedRequired === undefined) {
      assert.equal(definition.parameters.required, undefined, `${name} 不应有必填参数`);
    } else {
      assert.deepEqual(definition.parameters.required, expectedRequired, `${name} 的 required 不符`);
    }
  }

  // 枚举与默认值逐项对齐契约。
  assert.deepEqual(definitions.get('bili_search').parameters.properties.type.enum, ['video', 'user', 'bangumi', 'live', 'article']);
  assert.equal(definitions.get('bili_search').parameters.properties.type.default, 'video');
  assert.deepEqual(definitions.get('bili_search').parameters.properties.order.enum, ['totalrank', 'click', 'pubdate', 'dm', 'stow']);
  assert.deepEqual(definitions.get('bili_comments').parameters.properties.sort.enum, ['hot', 'time']);
  assert.deepEqual(definitions.get('bili_popular').parameters.properties.kind.enum, ['popular', 'weekly']);
  assert.deepEqual(definitions.get('bili_playurl').parameters.properties.quality.enum, ['best', '1080', '720', '480', '360']);
  assert.equal(definitions.get('bili_video').parameters.properties.includeParts.default, true);
  assert.equal(definitions.get('bili_video').parameters.properties.includeTags.default, true);
  assert.equal(definitions.get('bili_user').parameters.properties.includeVideos.default, true);
  assert.equal(definitions.get('bili_comments').parameters.properties.includeReplies.default, true);
  assert.equal(definitions.get('bili_playurl').parameters.properties.audioOnly.default, false);
  const areas = definitions.get('bili_ranking').parameters.properties.area.enum;
  assert.equal(areas.length, 20);
  assert.ok(areas.includes('all'));
  assert.ok(areas.includes('documentary'));
});

for (const [name, testCase] of Object.entries(SUCCESS_CASES)) {
  test(`成功路径与 json 围栏：${name}`, async () => {
    const api = createFakeApi(testCase.api);
    const deps = createDeps({ api, ...(testCase.deps ?? {}) });
    const result = await runTool(deps, name, testCase.args ?? {});
    assert.equal(result.value.ok, true);
    assert.equal(typeof result.value.data, 'object');
    testCase.check(result);
    assertFence(result);
  });
}

test('bili_video：includeParts/includeTags=false 时返回空列表且正文不提分P/标签', async () => {
  const api = createFakeApi({ video: { video: VIDEO_DETAIL, parts: [{ cid: 1, page: 1, part: 'P1' }], tags: [{ id: 1, name: 't' }] } });
  const deps = createDeps({ api });
  const result = await runTool(deps, 'bili_video', { target: 'BV1xx411c7mD', includeParts: false, includeTags: false });
  assert.deepEqual(result.value.data.parts, []);
  assert.deepEqual(result.value.data.tags, []);
  assert.doesNotMatch(result.text, /分P/);
  assert.doesNotMatch(result.text, /标签/);
});

test('bili_user：includeVideos=false 时不请求投稿并返回空列表', async () => {
  const api = createFakeApi({ user: { user: USER_DETAIL, videos: [videoItem()] } });
  const deps = createDeps({ api });
  const result = await runTool(deps, 'bili_user', { mid: 946974, includeVideos: false });
  assert.deepEqual(result.value.data.videos, []);
  assert.equal(api.calls[0].args[0].includeVideos, false);
  assert.doesNotMatch(result.text, /最近投稿/);
});

test('列表截断：pageSize/limit 不超过 maxListedItems，正文标「还有 N 条」', async () => {
  const fiveItems = Array.from({ length: 5 }, (_, index) => videoItem({ bvid: `BV${index}`, title: `第 ${index} 个` }));
  const api = createFakeApi({
    search: { keyword: 'k', type: 'video', page: 1, hasMore: false, items: fiveItems },
    ranking: { area: 'all', name: '全站', items: fiveItems },
    hotwords: { items: fiveItems.map((item, index) => ({ keyword: `热搜${index}` })) },
    comments: { count: 5, page: 1, hasMore: false, items: fiveItems.map((item, index) => ({ ...COMMENT, rpid: index })) },
    danmaku: { count: 5, sampled: 5, distribution: [], items: fiveItems.map(() => DANMAKU) },
    user: { user: USER_DETAIL, videos: fiveItems },
    video: { video: VIDEO_DETAIL, parts: fiveItems.map((item, index) => ({ cid: index, page: index + 1, part: `P${index + 1}` })), tags: fiveItems.map((item, index) => ({ id: index, name: `标签${index}` })) },
    bangumi: { season: { ...BANGUMI, episodes: fiveItems.map((item, index) => ({ epId: index, title: `第 ${index} 话`, durationSec: 60 })) } },
  });
  const deps = createDeps({ api, config: { maxListedItems: 3, attachImages: false } });

  const search = await runTool(deps, 'bili_search', { keyword: 'k' });
  assert.equal(search.value.data.items.length, 3);
  assert.match(search.text, /还有 2 条未显示/);
  assert.equal(api.calls.find((call) => call.method === 'search').args[0].pageSize, 3);

  const clamped = await runTool(deps, 'bili_search', { keyword: 'k', pageSize: 100 });
  assert.equal(clamped.value.data.items.length, 3);
  assert.equal(api.calls.filter((call) => call.method === 'search').at(-1).args[0].pageSize, 3);

  const ranking = await runTool(deps, 'bili_ranking', { limit: 2 });
  assert.equal(ranking.value.data.items.length, 2);
  assert.match(ranking.text, /还有 3 条未显示/);

  const hotwords = await runTool(deps, 'bili_hotwords', { limit: 2 });
  assert.equal(hotwords.value.data.items.length, 2);
  assert.match(hotwords.text, /还有 3 条未显示/);

  const comments = await runTool(deps, 'bili_comments', { target: 'BV1' });
  assert.equal(comments.value.data.items.length, 3);
  assert.match(comments.text, /还有 2 条未显示/);

  const danmaku = await runTool(deps, 'bili_danmaku', { target: 'BV1', limit: 1 });
  assert.equal(danmaku.value.data.items.length, 1);
  assert.match(danmaku.text, /还有 4 条未显示/);

  const user = await runTool(deps, 'bili_user', { mid: 946974 });
  assert.equal(user.value.data.videos.length, 3);
  assert.match(user.text, /还有 2 条投稿未显示/);

  const video = await runTool(deps, 'bili_video', { target: 'BV1' });
  assert.equal(video.value.data.parts.length, 3);
  assert.equal(video.value.data.tags.length, 3);
  assert.match(video.text, /还有 2 个未显示/);

  const bangumi = await runTool(deps, 'bili_bangumi', { seasonId: 1 });
  assert.equal(bangumi.value.data.season.episodes.length, 3);
  assert.match(bangumi.text, /还有 2 集未显示/);
});

test('图片附件：attachImages=true 时挂封面，围栏仍是最后一段', async () => {
  const images = createFakeImages();
  const api = createFakeApi({
    search: { keyword: 'k', type: 'video', page: 1, hasMore: false, items: [videoItem(), videoItem({ bvid: 'BV2', cover: 'https://i0.hdslb.com/bfs/archive/c2.jpg' })] },
  });
  const deps = createDeps({ api, images, config: { attachImages: true } });
  const result = await runTool(deps, 'bili_search', { keyword: 'k' });
  assert.equal(images.calls.length, 1);
  assert.deepEqual(images.calls[0].urls, [
    'https://i0.hdslb.com/bfs/archive/cover.jpg',
    'https://i0.hdslb.com/bfs/archive/c2.jpg',
  ]);
  assert.equal(result.value.blocks.length, 2);
  assert.equal(result.blocks.filter((block) => block.type === 'image').length, 2);
  assertFence(result);
});

test('图片附件：attachImages=false 时不调用附件服务', async () => {
  const images = createFakeImages();
  const api = createFakeApi({ video: { video: VIDEO_DETAIL, parts: [], tags: [] } });
  const deps = createDeps({ api, images, config: { attachImages: false } });
  const result = await runTool(deps, 'bili_video', { target: 'BV1' });
  assert.equal(images.calls.length, 0);
  assert.deepEqual(result.value.blocks, []);
  assert.equal(result.blocks.filter((block) => block.type === 'image').length, 0);
  assertFence(result);
});

test('图片附件：attachUrls 抛错或未挂载时静默降级', async () => {
  const throwing = await runTool(
    createDeps({
      api: createFakeApi({ live: { room: ROOM, anchor: ANCHOR } }),
      images: createFakeImages({ throws: true }),
      config: { attachImages: true },
    }),
    'bili_live',
    { roomId: 22625025 },
  );
  assert.equal(throwing.value.ok, true);
  assert.deepEqual(throwing.value.blocks, []);
  assertFence(throwing);

  const missing = await runTool(
    createDeps({ api: createFakeApi({ live: { room: ROOM, anchor: ANCHOR } }), images: undefined, config: { attachImages: true } }),
    'bili_live',
    { roomId: 22625025 },
  );
  assert.equal(missing.value.ok, true);
  assert.deepEqual(missing.value.blocks, []);
  assertFence(missing);
});

test('错误路径：api 抛出的 BiliError 原样冒泡（含 code/hint）', async () => {
  const api = createFakeApi({
    search: () => {
      throw new BiliError('搜索接口触发风控', { code: CODES.RISK, hint: '稍等 1 分钟再试' });
    },
    video: () => {
      throw new BiliError('视频不存在', { code: CODES.NOT_FOUND });
    },
    live: () => {
      throw new BiliError('直播间不存在', { code: CODES.NOT_FOUND });
    },
  });
  const deps = createDeps({ api });
  for (const [name, args, code] of [
    ['bili_search', { keyword: '明日方舟' }, CODES.RISK],
    ['bili_video', { target: 'BV1xx411c7mD' }, CODES.NOT_FOUND],
    ['bili_live', { roomId: 1 }, CODES.NOT_FOUND],
  ]) {
    await assert.rejects(
      () => runTool(deps, name, args),
      (error) => {
        assert.ok(isBiliError(error), `${name} 应抛 BiliError`);
        assert.equal(error.code, code);
        return true;
      },
    );
  }
});

test('错误路径：空参数与语义非法参数抛 BiliError(BILI_INVALID_ARGUMENT)', async () => {
  const deps = createDeps();
  const cases = [
    ['bili_search', { keyword: '   ' }],
    ['bili_video', { target: '  ' }],
    ['bili_comments', { target: '' }],
    ['bili_danmaku', { target: '' }],
    ['bili_playurl', { target: '' }],
    ['bili_subtitle', { target: '' }],
    ['bili_bangumi', {}],
    ['bili_bangumi', { seasonId: 0 }],
    ['bili_bangumi', { epId: -1 }],
    ['bili_user', { mid: 0 }],
    ['bili_live', { roomId: -2 }],
  ];
  for (const [name, args] of cases) {
    await assert.rejects(
      () => runTool(deps, name, args),
      (error) => {
        assert.ok(isBiliError(error), `${name} 应抛 BiliError`);
        assert.equal(error.code, CODES.INVALID_ARGUMENT, `${name} 的错误码应为参数错误`);
        return true;
      },
    );
  }
});

test('错误路径：schema 层拦截缺参、枚举越界与未知参数', async () => {
  const deps = createDeps();
  await assert.rejects(() => runTool(deps, 'bili_live', {}), /缺少必填参数 roomId/);
  await assert.rejects(() => runTool(deps, 'bili_search', {}), /缺少必填参数 keyword/);
  await assert.rejects(() => runTool(deps, 'bili_search', { keyword: 'x', type: 'podcast' }), /只能是/);
  await assert.rejects(() => runTool(deps, 'bili_playurl', { target: 'BV1', quality: '4k' }), /只能是/);
  await assert.rejects(() => runTool(deps, 'bili_comments', { target: 'BV1', sort: 'newest' }), /只能是/);
  await assert.rejects(() => runTool(deps, 'bili_status', { nope: 1 }), /不认识的参数/);
  await assert.rejects(() => runTool(deps, 'bili_user', { mid: 'abc' }), /必须是整数/);
});

test('bili_status：deps.version 缺失回落到 PLUGIN_VERSION，ffmpeg 探测失败按不可用处理', async () => {
  const api = createFakeApi({
    status: {
      loggedIn: false,
      cookie: { configured: false },
      wbi: { cached: false },
      ffmpeg: { available: true, version: '7.0' },
    },
  });
  const deps = createDeps({ api, ffmpeg: undefined });
  delete deps.version;
  const result = await runTool(deps, 'bili_status');
  assert.equal(result.value.data.version, PLUGIN_VERSION);
  assert.equal(result.value.data.ffmpeg.version, '7.0', '没有 deps.ffmpeg 时用 api.status() 的 ffmpeg');
  assert.equal(result.value.data.panel.enabled, true);
  assert.match(result.text, /未登录/);
  assert.match(result.text, /Cookie：未配置/);
  assert.match(result.text, /WBI：未缓存/);

  const throwing = createDeps({
    api: createFakeApi({ status: { loggedIn: false, cookie: {}, wbi: {} } }),
    ffmpeg: { detect: async () => { throw new Error('探测失败'); } },
  });
  const fallback = await runTool(throwing, 'bili_status');
  assert.deepEqual(fallback.value.data.ffmpeg, { available: false });
  assert.match(fallback.text, /ffmpeg：不可用/);
});

test('bili_status：panelEnabled=false 时正文说明未启用', async () => {
  const api = createFakeApi({ status: { loggedIn: false, cookie: {}, wbi: {} } });
  const deps = createDeps({ api, config: { panelEnabled: false } });
  const result = await runTool(deps, 'bili_status');
  assert.deepEqual(result.value.data.panel, { enabled: false, route: '/dsh-bilibili/api' });
  assert.match(result.text, /侧栏面板：未启用/);
});

test('bili_subtitle：没有语言列表时正文提示未登录，不算错误', async () => {
  const api = createFakeApi({ subtitle: { languages: [], lines: [] } });
  const deps = createDeps({ api });
  const result = await runTool(deps, 'bili_subtitle', { target: 'BV1xx411c7mD' });
  assert.equal(result.value.ok, true);
  assert.deepEqual(result.value.data.languages, []);
  assert.deepEqual(result.value.data.lines, []);
  assert.match(result.text, /可用字幕语言：没有/);
  assert.match(result.text, /未登录/);
  assertFence(result);
});

test('bili_subtitle：正文只预览前 20 行，完整字幕保留在 data.lines', async () => {
  const lines = Array.from({ length: 25 }, (_, index) => ({ fromSec: index, toSec: index + 1, text: `第 ${index} 句` }));
  const api = createFakeApi({ subtitle: { languages: SUBTITLE.languages, lang: 'zh-CN', lines } });
  const deps = createDeps({ api });
  const result = await runTool(deps, 'bili_subtitle', { target: 'BV1xx411c7mD' });
  assert.equal(result.value.data.lines.length, 25);
  assert.match(result.text, /还有 5 行未显示/);
  const prose = result.text.slice(0, result.text.lastIndexOf('```json'));
  assert.match(prose, /第 19 句/);
  assert.doesNotMatch(prose, /第 20 句/);
  assertFence(result);
});

test('bili_playurl：audioOnly=true 透传，缺地址时正文给出降级说明', async () => {
  const api = createFakeApi({ playurl: { ...PLAYURL, video: [], audio: PLAYURL.audio, durl: [] } });
  const deps = createDeps({ api });
  const result = await runTool(deps, 'bili_playurl', { target: 'BV1xx411c7mD', quality: '720', audioOnly: true });
  const call = api.calls.find((entry) => entry.method === 'playurl');
  assert.deepEqual(call.args[0], { target: 'BV1xx411c7mD', page: 1, quality: '720', audioOnly: true });
  assert.equal(result.value.data.video.length, 0);
  assert.match(result.text, /音频流（1 条）/);

  const emptyApi = createFakeApi({ playurl: { media: {}, quality: 0, accept: [], video: [], audio: [], durl: [] } });
  const empty = await runTool(createDeps({ api: emptyApi }), 'bili_playurl', { target: 'BV1' });
  assert.match(empty.text, /没有取到可用地址/);
});

test('工具层文件不 import Host 层模块，也不返回 { ok: false }', () => {
  for (const relative of TOOL_FILES) {
    const source = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    for (const forbidden of ["'../api.js'", "'../http.js'", "'../format.js'", '@deepseek-ai/']) {
      assert.equal(source.includes(forbidden), false, `${relative} 不应出现 ${forbidden}`);
    }
    assert.equal(/ok:\s*false/.test(source), false, `${relative} 不应返回 { ok: false }`);
    assert.match(source, /export function create[A-Za-z]*Tools\(deps\)/, `${relative} 必须导出 createXxxTools(deps)`);
    assert.ok(source.includes("from '../tool-kit.js'"), `${relative} 必须从 ../tool-kit.js 导入`);
    assert.ok(source.includes('defineTool'), `${relative} 必须使用 defineTool`);
    assert.ok(source.includes('renderResult'), `${relative} 必须使用 renderResult`);
  }
});
