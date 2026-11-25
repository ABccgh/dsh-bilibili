#!/usr/bin/env node
/**
 * 线上冒烟：逐个打真实 B 站接口，打印 PASS / SKIP / FAIL。
 *
 * 用法：
 *   node tools/live-check.mjs --public     # 只测公开接口（默认）
 *   node tools/live-check.mjs --auth       # 额外测需要登录的个人接口（无 Cookie 时 SKIP）
 *   node tools/live-check.mjs --download   # 额外下一次 360P 小文件到 %TEMP%，验完删除
 *   node tools/live-check.mjs --json out.json
 *
 * 说明：本脚本联网，**不属于** `test/*.test.js`（那些必须离线）。SKIP 不算失败；
 * 任何 FAIL 都会让退出码非 0。风控（-352/-412/-799）记为 SKIP 并给原因。
 *
 * @module @local/bilibili/tools/live-check
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAppApi } from '../lib/appapi.js';
import { createBiliApi } from '../lib/api.js';
import { DEFAULTS } from '../lib/config.js';
import { createCookieJar } from '../lib/cookies.js';
import { isBiliError } from '../lib/errors.js';
import { createFfmpegProbe } from '../lib/ffmpeg.js';
import { createHttpClient } from '../lib/http.js';
import { createImages } from '../lib/images.js';
import { createWbi } from '../lib/wbi.js';

/** 解析参数。 */
function parseArgs(argv) {
  const options = { public: true, auth: false, download: false, json: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--auth') options.auth = true;
    else if (arg === '--download') options.download = true;
    else if (arg === '--json') {
      options.json = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--public') options.public = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node tools/live-check.mjs [--public] [--auth] [--download] [--json <文件>]');
      process.exit(0);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const config = { ...DEFAULTS };
const logger = {
  warn: (message) => console.error(`  [warn] ${message}`),
  info: () => {},
};

/**
 * 组装真实的 api（不走插件 ctx）。
 * @returns {{ api: object, http: object, ffmpeg: object }} 依赖。
 */
function createApi() {
  const http = createHttpClient({ timeoutMs: config.requestTimeoutMs, logger });
  const cookieValue = process.env[config.cookieEnv];
  const cookies = createCookieJar({
    http,
    config,
    logger,
    resolveUserCookie: async () => (typeof cookieValue === 'string' && cookieValue.trim() !== '' ? cookieValue : undefined),
    describeUserCookie: async () => (cookieValue === undefined ? { configured: false } : { configured: true, source: 'env' }),
  });
  const wbi = createWbi({ http, config, logger });
  const appApi = createAppApi({ http });
  const ffmpeg = createFfmpegProbe({ config, logger });
  const api = createBiliApi({ http, cookies, wbi, appApi, ffmpeg, config, logger });
  return { api, http, ffmpeg };
}

/** @type {Array<{ name: string, status: 'PASS'|'SKIP'|'FAIL', detail: string, ms: number }>} */
const results = [];

/**
 * 跑一项检查。
 * @param {string} name - 检查名。
 * @param {() => Promise<{ status?: 'PASS'|'SKIP', detail: string }>} run - 检查体。
 * @returns {Promise<void>} 无。
 */
async function check(name, run) {
  const start = Date.now();
  try {
    const outcome = await run();
    const status = outcome.status ?? 'PASS';
    results.push({ name, status, detail: outcome.detail, ms: Date.now() - start });
    console.log(`${status === 'PASS' ? '✔' : '↷'} ${name} — ${outcome.detail}（${Date.now() - start} ms）`);
  } catch (error) {
    const risky = isBiliError(error) && /RISK|AUTH_REQUIRED|COOKIE_EXPIRED/.test(error.code);
    const status = risky ? 'SKIP' : 'FAIL';
    const detail = `${error.code ?? 'ERROR'}: ${error.message}${error.hint ? ` / ${error.hint}` : ''}`;
    results.push({ name, status, detail, ms: Date.now() - start });
    console.log(`${status === 'SKIP' ? '↷' : '✖'} ${name} — ${detail}（${Date.now() - start} ms）`);
  }
}

const { api, ffmpeg } = createApi();
const keyword = '明日方舟';
let sampleBvid = '';
let sampleAid = 0;
let sampleCid = 0;

console.log(`B 站线上冒烟（cookieEnv=${config.cookieEnv}，有 Cookie=${process.env[config.cookieEnv] ? '是' : '否'}）\n`);

await check('导航与登录态', async () => {
  const nav = await api.nav();
  return { detail: `loggedIn=${nav.loggedIn}${nav.uname ? ` uname=${nav.uname}` : ''}` };
});

await check('WBI 密钥', async () => {
  const query = await api.__wbiProbe?.();
  if (query !== undefined) return { detail: query };
  return { status: 'SKIP', detail: 'api 未暴露 wbi 探针' };
});

await check('搜索（App 签名）', async () => {
  const result = await api.search({ keyword, type: 'video', page: 1, pageSize: 5 });
  const first = result.items[0];
  if (first?.bvid) sampleBvid = first.bvid;
  if (first?.aid) sampleAid = first.aid;
  return { detail: `${result.items.length} 条${first ? `，首条=${first.title?.slice(0, 24)}` : ''}` };
});

await check('排行榜', async () => {
  const result = await api.ranking({ area: 'all', limit: 5 });
  const first = result.items[0];
  if (first?.bvid) sampleBvid = first.bvid;
  return { detail: `${result.items.length} 条${first ? `，首位=${first.title?.slice(0, 24)}` : ''}` };
});

await check('热门', async () => {
  const result = await api.popular({ kind: 'popular', limit: 5 });
  return { detail: `${result.items.length} 条` };
});

await check('热搜词', async () => {
  const result = await api.hotwords({ limit: 5 });
  return { detail: `${result.items.length} 条${result.items[0] ? `，首位=${result.items[0].keyword}` : ''}` };
});

await check('视频详情', async () => {
  if (sampleBvid === '') return { status: 'SKIP', detail: '没有可用样本 BV 号' };
  const result = await api.video({ target: sampleBvid });
  sampleAid = result.video.aid;
  sampleCid = result.parts?.[0]?.cid ?? 0;
  return { detail: `${result.video.title?.slice(0, 24)}，分P=${result.parts?.length ?? 0}，播放=${result.video.stat?.view}` };
});

await check('UP 主资料', async () => {
  const result = await api.user({ mid: 946974, includeVideos: true, limit: 3 });
  return { detail: `${result.user.name}，粉丝=${result.user.fans}，投稿=${result.videos?.length ?? 0}` };
});

await check('评论', async () => {
  if (sampleBvid === '') return { status: 'SKIP', detail: '没有可用样本' };
  const result = await api.comments({ target: sampleBvid, page: 1, sort: 'hot', includeReplies: false, limit: 5 });
  return { detail: `共 ${result.count} 条，取 ${result.items.length} 条` };
});

await check('弹幕', async () => {
  if (sampleCid === 0) return { status: 'SKIP', detail: '没有可用 cid' };
  const result = await api.danmaku({ target: sampleBvid, page: 1, limit: 10 });
  return { detail: `采样 ${result.sampled} 条，分布 ${result.distribution.length} 个分钟点` };
});

await check('番剧', async () => {
  const result = await api.bangumi({ seasonId: 28747 });
  return { detail: `${result.season.title}，评分=${result.season.rating}，剧集=${result.season.episodes.length}` };
});

await check('直播', async () => {
  const result = await api.live({ roomId: 3 });
  return { detail: `${result.room.title?.slice(0, 20)}，liveStatus=${result.room.liveStatus}，在线=${result.room.online}` };
});

await check('播放地址', async () => {
  if (sampleBvid === '') return { status: 'SKIP', detail: '没有可用样本' };
  const result = await api.playurl({ target: sampleBvid, page: 1, quality: '480' });
  return { detail: `quality=${result.quality}，video=${result.video.length} audio=${result.audio.length} durl=${result.durl.length}` };
});

await check('字幕', async () => {
  if (sampleBvid === '') return { status: 'SKIP', detail: '没有可用样本' };
  const result = await api.subtitle({ target: sampleBvid, page: 1 });
  if (result.languages.length === 0) return { status: 'SKIP', detail: '该稿件没有字幕（未登录或作者未提交）' };
  return { detail: `语言=${result.languages.map((entry) => entry.lan).join(',')}，行数=${result.lines.length}` };
});

await check('ffmpeg', async () => {
  const probe = await ffmpeg.detect();
  return {
    status: probe.available ? 'PASS' : 'SKIP',
    detail: probe.available ? `${probe.version} @ ${probe.path}` : `未安装：${probe.error ?? '未知'}`,
  };
});

if (options.auth) {
  await check('当前账号', async () => {
    const user = await api.nav();
    if (!user.loggedIn) return { status: 'SKIP', detail: '未配置 BILI_COOKIE' };
    return { detail: `${user.uname}（Lv${user.level}）` };
  });
  await check('观看历史', async () => {
    const result = await api.history({ limit: 5 });
    return { detail: `${result.items.length} 条` };
  });
  await check('收藏夹', async () => {
    const result = await api.favorites({ action: 'list' });
    return { detail: `${result.folders?.length ?? 0} 个收藏夹` };
  });
  await check('关注列表', async () => {
    const result = await api.follows({ page: 1, limit: 5 });
    return { detail: `${result.items.length} 个关注` };
  });
  await check('关注动态', async () => {
    const result = await api.dynamic({ page: 1, limit: 5 });
    return { detail: `${result.items.length} 条动态` };
  });
}

if (options.download) {
  await check('下载 360P', async () => {
    if (sampleBvid === '') return { status: 'SKIP', detail: '没有可用样本' };
    const { createDownloader } = await import('../lib/download.js');
    const downloader = createDownloader({ ctx: undefined, config: { ...config, maxListedItems: 5 }, api, http: createHttpClient({ timeoutMs: config.requestTimeoutMs, logger }), ffmpeg, logger });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-live-'));
    try {
      const result = await downloader.run({ target: sampleBvid, page: 1, quality: '360', dir: directory }, {});
      const stat = fs.statSync(result.file);
      return { detail: `${path.basename(result.file)} ${stat.size} B，merged=${result.merged}` };
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

const pass = results.filter((entry) => entry.status === 'PASS').length;
const skip = results.filter((entry) => entry.status === 'SKIP').length;
const fail = results.filter((entry) => entry.status === 'FAIL').length;
console.log(`\n合计 ${results.length} 项：PASS ${pass} / SKIP ${skip} / FAIL ${fail}`);

if (options.json !== '') {
  fs.writeFileSync(options.json, `${JSON.stringify({ at: new Date().toISOString(), results, pass, skip, fail }, null, 2)}\n`, 'utf8');
  console.log(`结果已写入 ${options.json}`);
}

process.exit(fail === 0 ? 0 : 1);
