/**
 * `bili_ranking` / `bili_popular` / `bili_bangumi` / `bili_live` / `bili_playurl` / `bili_subtitle`：
 * 媒体与榜单类工具（排行榜、热门、番剧、直播、播放地址、字幕）。
 *
 * 数据全部经 `deps.api` 拿；本模块只做参数校验、列表截断与中文排版。
 *
 * @module @local/bilibili/tools/media
 */

import { invalidArgument } from '../errors.js';
import { formatBytes } from '../paths.js';
import { defineTool, renderResult } from '../tool-kit.js';

/** 一次随结果最多挂几张图。 */
const MAX_IMAGES = 4;

/** 排行榜分区显示名。 */
const AREA_LABELS = {
  all: '全站',
  douga: '动画',
  game: '游戏',
  kichiku: '鬼畜',
  music: '音乐',
  dance: '舞蹈',
  cinephile: '影视',
  ent: '娱乐',
  knowledge: '知识',
  tech: '科技',
  food: '美食',
  animal: '动物圈',
  fashion: '时尚',
  information: '资讯',
  auto: '汽车',
  sports: '运动',
  movie: '电影',
  teleplay: '电视剧',
  variety: '综艺',
  documentary: '纪录片',
};

/** 热门类型显示名。 */
const POPULAR_LABELS = { popular: '综合热门', weekly: '每周必看' };

/** 直播间状态显示名。 */
const LIVE_LABELS = { 0: '未开播', 1: '直播中', 2: '轮播中' };

/** 字幕正文最多预览多少行（数据里仍保留完整字幕）。 */
const SUBTITLE_PREVIEW = 20;

/** 简介/标题类文本在正文里的截断长度。 */
const TEXT_LIMIT = 200;

/** 输出形状：`{ ok, data, text, blocks? }`，`render` 把正文与末尾 json 围栏块合并。 */
const MEDIA_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', required: true, description: '成功恒为 true；失败时工具直接抛错' },
      data: { type: 'object', required: true, description: '结构化结果，同时写进文本末尾的 json 围栏' },
      text: { type: 'string', description: '给模型阅读的中文正文' },
      blocks: {
        type: 'array',
        description: '图片附件内容块（仅渲染用）',
        items: { type: 'object', properties: { type: { type: 'string', required: true } } },
      },
    },
  },
  /**
   * 渲染成内容块。
   * @param {Record<string, unknown>} _args - 工具参数。
   * @param {{ data?: Record<string, any>, text?: string, blocks?: object[] }} value - execute 的返回值。
   * @returns {object[]} 内容块数组。
   */
  render(_args, value) {
    const data = value !== null && typeof value === 'object' && value.data !== null && typeof value.data === 'object'
      ? value.data
      : {};
    const text = typeof value?.text === 'string' ? value.text : '';
    const blocks = Array.isArray(value?.blocks) ? value.blocks : [];
    return renderResult(text, { ok: true, data }, blocks);
  },
};

/** 排行榜/热门条目列表里的视频字幕标签。 */
const VIDEO_KIND_LABEL = '视频';

/**
 * 取配置里的单次列表上限（缺省 25）。
 * @param {Record<string, any>} deps - 装配依赖。
 * @returns {number} 上限。
 */
function maxListedItems(deps) {
  const value = Number(deps?.config?.maxListedItems);
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 25;
}

/**
 * 把用户请求的页大小夹到 `[1, maxListedItems]`。
 * @param {unknown} requested - `args.limit`。
 * @param {number} max - 配置上限。
 * @returns {number} 实际条数。
 */
function clampLimit(requested, max) {
  const value = Number(requested);
  const wanted = Number.isFinite(value) && value >= 1 ? Math.trunc(value) : max;
  return Math.min(wanted, max);
}

/**
 * 把页码归一成正整数，缺省第 1 页。
 * @param {unknown} value - `args.page`。
 * @returns {number} 页码。
 */
function pageOf(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.trunc(number) : 1;
}

/**
 * 把数字格式化成中文计数（万/亿）。
 * @param {unknown} value - 数字。
 * @returns {string} 文本；无法解析时返回空串。
 */
function formatCount(value) {
  if (value === undefined || value === null || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  if (number < 10000) return String(Math.trunc(number));
  const trimZero = (text) => (text.endsWith('.0') ? text.slice(0, -2) : text);
  if (number < 100000000) return `${trimZero((number / 10000).toFixed(1))}万`;
  return `${trimZero((number / 100000000).toFixed(1))}亿`;
}

/**
 * 把秒数格式化成 `mm:ss` 或 `h:mm:ss`。
 * @param {unknown} seconds - 秒数。
 * @returns {string} 文本；无法解析时返回空串。
 */
function formatDurationText(seconds) {
  const number = Number(seconds);
  if (!Number.isFinite(number) || number < 0) return '';
  const total = Math.trunc(number);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${rest}`;
  return `${String(minutes).padStart(2, '0')}:${rest}`;
}

/**
 * 把时间戳格式化成 `YYYY-MM-DD HH:mm`（本地时区）。
 * @param {unknown} value - 秒或毫秒时间戳。
 * @returns {string} 文本；无法解析时返回空串。
 */
function formatTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  const date = new Date(number < 1e12 ? number * 1000 : number);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 把日期格式化成 `YYYY-MM-DD`（本地时区）。
 * @param {unknown} value - 秒或毫秒时间戳。
 * @returns {string} 文本；无法解析时返回空串。
 */
function formatDate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  const date = new Date(number < 1e12 ? number * 1000 : number);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 把文本压成单行并截断。
 * @param {unknown} value - 原始文本。
 * @param {number} max - 最大长度。
 * @returns {string} 单行文本。
 */
function clampText(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 把清晰度字段渲染成文本（可能是数字 id、也可能是 `{ id, label }`）。
 * @param {unknown} value - `quality`。
 * @returns {string} 文本。
 */
function qualityText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const label = value.label ?? value.id;
    return label === undefined || label === null ? '' : String(label);
  }
  return String(value);
}

/**
 * 把封面挂成图片附件；未启用、没有图或失败时返回空数组（静默降级）。
 * @param {Record<string, any>} deps - 装配依赖。
 * @param {unknown[]} urls - 候选图片 URL。
 * @returns {Promise<object[]>} 图片内容块。
 */
async function attachCovers(deps, urls) {
  if (deps?.config?.attachImages !== true) return [];
  const images = deps?.images;
  if (images === null || images === undefined || typeof images.attachUrls !== 'function') return [];
  const list = urls.filter((url) => typeof url === 'string' && url.trim() !== '');
  if (list.length === 0) return [];
  try {
    const attached = await images.attachUrls(list.slice(0, MAX_IMAGES), { max: MAX_IMAGES });
    return Array.isArray(attached?.blocks) ? attached.blocks : [];
  } catch {
    return [];
  }
}

/**
 * 渲染一条榜单条目。
 * @param {number} index - 名次（从 1 开始）。
 * @param {Record<string, any>} item - 归一化 `Item`。
 * @returns {string} 一行文本。
 */
function rankedItemLine(index, item) {
  const title = typeof item?.title === 'string' && item.title !== '' ? item.title : '(无标题)';
  const facts = [];
  if (typeof item?.author === 'string' && item.author !== '') facts.push(item.author);
  if (item?.play !== undefined && item.play !== null) facts.push(`${formatCount(item.play)}播放`);
  if (item?.danmaku !== undefined && item.danmaku !== null && Number(item.danmaku) > 0) {
    facts.push(`${formatCount(item.danmaku)}弹幕`);
  }
  const duration = typeof item?.durationText === 'string' && item.durationText !== ''
    ? item.durationText
    : formatDurationText(item?.durationSec);
  if (duration !== '') facts.push(duration);
  const published = typeof item?.pubdateText === 'string' && item.pubdateText !== ''
    ? item.pubdateText
    : formatDate(item?.pubdate);
  if (published !== '') facts.push(published);
  if (typeof item?.bvid === 'string' && item.bvid !== '') facts.push(item.bvid);
  return `${index}. 【${VIDEO_KIND_LABEL}】${title}${facts.length > 0 ? ` — ${facts.join(' · ')}` : ''}`;
}

/**
 * 生成排行榜正文。
 * @param {Record<string, any>} data - 结构化结果。
 * @param {number} remaining - 被截断掉的条数。
 * @returns {string} 正文。
 */
function rankingText(data, remaining) {
  const items = Array.isArray(data.items) ? data.items : [];
  const lines = [`${data.name ?? AREA_LABELS[data.area] ?? '全站'}排行榜（显示 ${items.length} 条）：`];
  if (items.length === 0) lines.push('没有取到榜单数据：可能被风控，稍后重试或先 bili_login start 登录。');
  items.forEach((item, index) => {
    lines.push(rankedItemLine(index + 1, item));
    if (typeof item?.url === 'string' && item.url !== '') lines.push(`   ${item.url}`);
  });
  if (remaining > 0) lines.push(`还有 ${remaining} 条未显示（调大 limit）。`);
  return lines.join('\n');
}

/**
 * 生成热门正文。
 * @param {Record<string, any>} data - 结构化结果。
 * @param {number} remaining - 被截断掉的条数。
 * @returns {string} 正文。
 */
function popularText(data, remaining) {
  const items = Array.isArray(data.items) ? data.items : [];
  const label = POPULAR_LABELS[data.kind] ?? '热门';
  const lines = [`B 站${label}（显示 ${items.length} 条）：`];
  if (items.length === 0) lines.push('没有取到热门数据：可能被风控，稍后重试或先 bili_login start 登录。');
  items.forEach((item, index) => {
    lines.push(rankedItemLine(index + 1, item));
    if (typeof item?.url === 'string' && item.url !== '') lines.push(`   ${item.url}`);
  });
  if (remaining > 0) lines.push(`还有 ${remaining} 条未显示（调大 limit）。`);
  return lines.join('\n');
}

/**
 * 生成番剧正文。
 * @param {Record<string, any>} data - 结构化结果。
 * @param {number} remaining - 被截断掉的集数。
 * @returns {string} 正文。
 */
function bangumiText(data, remaining) {
  const season = data.season !== null && typeof data.season === 'object' ? data.season : {};
  const lines = [];
  const title = typeof season.title === 'string' && season.title !== '' ? season.title : '(无标题)';
  lines.push(`${title}${season.seasonId !== undefined && season.seasonId !== null ? `（seasonId ${season.seasonId}）` : ''}`);

  const meta = [];
  if (season.rating !== undefined && season.rating !== null) meta.push(`评分 ${season.rating}`);
  if (season.totalEpisodes !== undefined && season.totalEpisodes !== null) meta.push(`共 ${season.totalEpisodes} 集`);
  if (Number.isFinite(Number(season.evaluate)) && Number(season.evaluate) > 0) {
    meta.push(`评价 ${formatCount(season.evaluate)} 人`);
  }
  if (meta.length > 0) lines.push(meta.join(' · '));
  if (typeof season.url === 'string' && season.url !== '') lines.push(`链接：${season.url}`);

  const episodes = Array.isArray(season.episodes) ? season.episodes : [];
  if (episodes.length > 0) {
    lines.push(`剧集（显示 ${episodes.length} 集${remaining > 0 ? `，还有 ${remaining} 集未显示` : ''}）：`);
    episodes.forEach((episode, index) => {
      const epTitle = typeof episode?.title === 'string' && episode.title !== '' ? episode.title : `第 ${index + 1} 集`;
      const duration = formatDurationText(episode?.durationSec);
      const bvid = typeof episode?.bvid === 'string' && episode.bvid !== '' ? ` · ${episode.bvid}` : '';
      lines.push(`  EP${index + 1} ${epTitle}${duration === '' ? '' : `（${duration}）`}${bvid}`);
    });
  } else {
    lines.push('剧集：没有取到（可能版权限制或该番剧尚未开播）。');
  }
  return lines.join('\n');
}

/**
 * 生成直播间正文。
 * @param {Record<string, any>} data - 结构化结果。
 * @returns {string} 正文。
 */
function liveText(data) {
  const room = data.room !== null && typeof data.room === 'object' ? data.room : {};
  const anchor = data.anchor !== null && typeof data.anchor === 'object' ? data.anchor : {};
  const lines = [];
  const title = typeof room.title === 'string' && room.title !== '' ? room.title : '(无标题直播间)';
  const ids = [];
  if (room.roomId !== undefined && room.roomId !== null) ids.push(`房间号 ${room.roomId}`);
  if (room.shortId !== undefined && room.shortId !== null) ids.push(`短号 ${room.shortId}`);
  lines.push(`${title}${ids.length > 0 ? `（${ids.join(' · ')}）` : ''}`);

  const anchorName = typeof anchor.name === 'string' && anchor.name !== '' ? anchor.name : '';
  const anchorMid = anchor.mid !== undefined && anchor.mid !== null ? `UID ${anchor.mid}` : '';
  const anchorText = anchorName !== '' ? `${anchorName}${anchorMid === '' ? '' : `（${anchorMid}）`}` : anchorMid;
  if (anchorText !== '') lines.push(`主播：${anchorText}`);

  const status = LIVE_LABELS[room.liveStatus] ?? '未知';
  const stats = [`状态：${status}`];
  if (room.online !== undefined && room.online !== null) stats.push(`人气 ${formatCount(room.online)}`);
  if (room.attention !== undefined && room.attention !== null) stats.push(`关注 ${formatCount(room.attention)}`);
  lines.push(stats.join(' · '));
  if (typeof room.url === 'string' && room.url !== '') lines.push(`链接：${room.url}`);
  return lines.join('\n');
}

/**
 * 生成播放地址正文。
 * @param {Record<string, any>} data - 结构化结果。
 * @returns {string} 正文。
 */
function playurlText(data) {
  const media = data.media !== null && typeof data.media === 'object' ? data.media : {};
  const lines = [];
  const ids = [];
  if (typeof media.bvid === 'string' && media.bvid !== '') ids.push(media.bvid);
  if (media.cid !== undefined && media.cid !== null) ids.push(`cid ${media.cid}`);
  if (media.page !== undefined && media.page !== null) ids.push(`第 ${media.page} P`);
  const duration = formatDurationText(media.durationSec);
  if (duration !== '') ids.push(`时长 ${duration}`);
  lines.push(`播放地址${ids.length > 0 ? `：${ids.join(' · ')}` : ''}`);

  const quality = qualityText(data.quality);
  if (quality !== '') lines.push(`取到的清晰度：${quality}`);
  const accept = Array.isArray(data.accept) ? data.accept : [];
  if (accept.length > 0) {
    const labels = accept
      .map((entry) => {
        const label = entry?.label ?? entry?.id;
        return label === undefined || label === null ? '' : String(label);
      })
      .filter((label) => label !== '');
    if (labels.length > 0) lines.push(`可选清晰度：${labels.join('、')}`);
  }

  const video = Array.isArray(data.video) ? data.video : [];
  if (video.length > 0) {
    lines.push(`视频流（${video.length} 条）：`);
    for (const stream of video) {
      const facts = [];
      if (stream?.label !== undefined) facts.push(String(stream.label));
      else if (stream?.id !== undefined) facts.push(`id ${stream.id}`);
      if (stream?.codec !== undefined) facts.push(String(stream.codec));
      if (stream?.width !== undefined && stream?.height !== undefined) facts.push(`${stream.width}×${stream.height}`);
      if (stream?.bytes !== undefined) facts.push(formatBytes(stream.bytes));
      if (Array.isArray(stream?.backupUrls) && stream.backupUrls.length > 0) facts.push(`备用 ${stream.backupUrls.length} 条`);
      lines.push(`  - ${facts.join(' · ')}`);
    }
  }

  const audio = Array.isArray(data.audio) ? data.audio : [];
  if (audio.length > 0) {
    lines.push(`音频流（${audio.length} 条）：`);
    for (const stream of audio) {
      const facts = [];
      if (stream?.label !== undefined) facts.push(String(stream.label));
      else if (stream?.id !== undefined) facts.push(`id ${stream.id}`);
      if (stream?.codec !== undefined) facts.push(String(stream.codec));
      if (stream?.bytes !== undefined) facts.push(formatBytes(stream.bytes));
      lines.push(`  - ${facts.join(' · ')}`);
    }
  }

  const durl = Array.isArray(data.durl) ? data.durl : [];
  if (durl.length > 0) {
    const total = durl.reduce((sum, part) => sum + (Number(part?.bytes) || 0), 0);
    lines.push(`分段直链（durl，${durl.length} 段，共 ${formatBytes(total)}）：`);
    for (const part of durl.slice(0, 5)) {
      lines.push(`  - 第 ${part?.order ?? '?'} 段${part?.bytes === undefined ? '' : `：${formatBytes(part.bytes)}`}`);
    }
    if (durl.length > 5) lines.push(`  - 还有 ${durl.length - 5} 段未显示`);
  }

  const expires = formatTime(data.expiresAt);
  if (expires !== '') lines.push(`地址过期时间：${expires}`);
  if (video.length === 0 && audio.length === 0 && durl.length === 0) {
    lines.push('没有取到可用地址：可能需要登录、需要大会员，或被地区/版权限制。');
  }
  lines.push('说明：完整地址（含签名参数）在下方 json 的 url 字段；过期后重新调用本工具，或直接用 bili_download 下载。');
  return lines.join('\n');
}

/**
 * 生成字幕正文。
 * @param {Record<string, any>} data - 结构化结果。
 * @param {number} preview - 正文里预览多少行。
 * @param {number} remaining - 正文预览之外还有多少行。
 * @returns {string} 正文。
 */
function subtitleText(data, preview, remaining) {
  const languages = Array.isArray(data.languages) ? data.languages : [];
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const names = languages
    .map((entry) => {
      const doc = typeof entry?.lanDoc === 'string' && entry.lanDoc !== '' ? entry.lanDoc : '';
      const lan = typeof entry?.lan === 'string' && entry.lan !== '' ? entry.lan : '';
      if (doc !== '' && lan !== '') return `${doc}（${lan}）`;
      return doc !== '' ? doc : lan;
    })
    .filter((name) => name !== '');
  const output = [`可用字幕语言：${names.length > 0 ? names.join('、') : '没有'}（共 ${lines.length} 行字幕）`];
  if (names.length === 0) {
    output.push('说明：未登录时通常拿不到字幕，空语言列表是正常现象；先 bili_login start 扫码登录再试。');
    return output.join('\n');
  }
  const current = typeof data.lang === 'string' && data.lang !== '' ? data.lang : '(未指定)';
  output.push(`当前语言：${current}，预览前 ${preview} 行：`);
  const shown = lines.slice(0, preview);
  for (const line of shown) {
    const from = formatDurationText(line?.fromSec);
    const to = formatDurationText(line?.toSec);
    const span = from === '' ? '' : `[${from}${to === '' ? '' : ` → ${to}`}] `;
    output.push(`  ${span}${clampText(line?.text, TEXT_LIMIT)}`);
  }
  if (remaining > 0) output.push(`  还有 ${remaining} 行未显示（完整字幕在下方 json 的 lines 字段）。`);
  return output.join('\n');
}

/**
 * 注册 `bili_ranking`。
 * @param {Record<string, any>} deps - 装配依赖（`api`/`config`/`images`）。
 * @returns {object[]} 工具定义数组（1 个）。
 */
function createRankingTools(deps) {
  return [
    defineTool({
      name: 'bili_ranking',
      description: '看 B 站排行榜：area 选分区（all 全站、douga 动画、game 游戏、music 音乐、movie 电影等），返回名次、标题、UP 主、播放/弹幕、时长与链接。',
      parameters: {
        area: {
          type: 'string',
          description: '分区：all 全站（默认）、douga、game、kichiku、music、dance、cinephile、ent、knowledge、tech、food、animal、fashion、information、auto、sports、movie、teleplay、variety、documentary',
          enum: Object.keys(AREA_LABELS),
          default: 'all',
        },
        limit: { type: 'integer', description: '最多返回几条（默认取配置 maxListedItems，且不超过它）' },
      },
      output: MEDIA_OUTPUT,
      async execute(args) {
        const max = maxListedItems(deps);
        const limit = clampLimit(args.limit, max);
        const area = typeof args.area === 'string' && args.area !== '' ? args.area : 'all';
        const result = await deps.api.ranking({ area, type: 'all', limit });
        const items = Array.isArray(result?.items) ? result.items : [];
        const listed = items.slice(0, limit);
        /** @type {Record<string, any>} */
        const data = {
          area: typeof result?.area === 'string' && result.area !== '' ? result.area : area,
          name: typeof result?.name === 'string' && result.name !== ''
            ? result.name
            : (AREA_LABELS[area] ?? AREA_LABELS.all),
          items: listed,
        };
        const blocks = await attachCovers(deps, listed.map((item) => item?.cover));
        return { ok: true, data, text: rankingText(data, items.length - listed.length), blocks };
      },
    }),
  ];
}

/**
 * 注册 `bili_popular`。
 * @param {Record<string, any>} deps - 装配依赖（`api`/`config`/`images`）。
 * @returns {object[]} 工具定义数组（1 个）。
 */
function createPopularTools(deps) {
  return [
    defineTool({
      name: 'bili_popular',
      description: '看 B 站热门视频：kind 选 popular 综合热门（默认）或 weekly 每周必看，返回标题、UP 主、播放/弹幕、时长与链接。',
      parameters: {
        kind: {
          type: 'string',
          description: '热门类型：popular 综合热门（默认）、weekly 每周必看',
          enum: ['popular', 'weekly'],
          default: 'popular',
        },
        limit: { type: 'integer', description: '最多返回几条（默认取配置 maxListedItems，且不超过它）' },
      },
      output: MEDIA_OUTPUT,
      async execute(args) {
        const max = maxListedItems(deps);
        const limit = clampLimit(args.limit, max);
        const kind = args.kind === 'weekly' ? 'weekly' : 'popular';
        const result = await deps.api.popular({ kind, limit });
        const items = Array.isArray(result?.items) ? result.items : [];
        const listed = items.slice(0, limit);
        /** @type {Record<string, any>} */
        const data = {
          kind: typeof result?.kind === 'string' && result.kind !== '' ? result.kind : kind,
          items: listed,
        };
        const blocks = await attachCovers(deps, listed.map((item) => item?.cover));
        return { ok: true, data, text: popularText(data, items.length - listed.length), blocks };
      },
    }),
  ];
}

/**
 * 注册 `bili_bangumi`。
 * @param {Record<string, any>} deps - 装配依赖（`api`/`config`/`images`）。
 * @returns {object[]} 工具定义数组（1 个）。
 */
function createBangumiTools(deps) {
  return [
    defineTool({
      name: 'bili_bangumi',
      description: '看一部番剧/影视的详情：标题、评分、总集数、剧集列表（标题、时长、BV 号）与链接。seasonId 与 epId 至少给一个（epId 用于从某一集反查季）。',
      parameters: {
        seasonId: { type: 'integer', description: '番剧 season_id（ss 号里的数字）' },
        epId: { type: 'integer', description: '剧集 ep_id（ep 号里的数字）' },
      },
      output: MEDIA_OUTPUT,
      async execute(args) {
        const seasonId = args.seasonId === undefined ? undefined : Number(args.seasonId);
        const epId = args.epId === undefined ? undefined : Number(args.epId);
        if (seasonId === undefined && epId === undefined) {
          throw invalidArgument('需要 seasonId 或 epId 至少一个：从番剧页取 ss 号/seasonId，或从单集页取 ep 号/epId。');
        }
        /** @type {Record<string, any>} */
        const params = {};
        if (seasonId !== undefined) {
          if (!Number.isInteger(seasonId) || seasonId <= 0) throw invalidArgument('seasonId 必须是正整数。');
          params.seasonId = seasonId;
        }
        if (epId !== undefined) {
          if (!Number.isInteger(epId) || epId <= 0) throw invalidArgument('epId 必须是正整数。');
          params.epId = epId;
        }
        const max = maxListedItems(deps);
        const result = await deps.api.bangumi(params);
        const season = result?.season !== null && typeof result?.season === 'object' ? result.season : {};
        const episodes = Array.isArray(season.episodes) ? season.episodes : [];
        const listed = episodes.slice(0, max);
        /** @type {Record<string, any>} */
        const data = { season: { ...season, episodes: listed } };
        const blocks = await attachCovers(deps, [data.season.cover, ...listed.map((episode) => episode?.cover)]);
        return { ok: true, data, text: bangumiText(data, episodes.length - listed.length), blocks };
      },
    }),
  ];
}

/**
 * 注册 `bili_live`。
 * @param {Record<string, any>} deps - 装配依赖（`api`/`config`/`images`）。
 * @returns {object[]} 工具定义数组（1 个）。
 */
function createLiveTools(deps) {
  return [
    defineTool({
      name: 'bili_live',
      description: '看一个 B 站直播间：标题、主播、开播状态、人气、关注数与链接。roomId 是数字房间号（短号也行）。',
      parameters: {
        roomId: { type: 'integer', description: '直播间房间号（数字）', required: true },
      },
      output: MEDIA_OUTPUT,
      async execute(args) {
        const roomId = Number(args.roomId);
        if (!Number.isInteger(roomId) || roomId <= 0) throw invalidArgument('roomId 必须是正整数房间号。');
        const result = await deps.api.live({ roomId });
        /** @type {Record<string, any>} */
        const data = {
          room: result?.room !== null && typeof result?.room === 'object' ? result.room : {},
          anchor: result?.anchor !== null && typeof result?.anchor === 'object' ? result.anchor : undefined,
        };
        const blocks = await attachCovers(deps, [data.room.cover, data.anchor?.face]);
        return { ok: true, data, text: liveText(data), blocks };
      },
    }),
  ];
}

/**
 * 注册 `bili_playurl`。
 * @param {Record<string, any>} deps - 装配依赖（`api`/`config`）。
 * @returns {object[]} 工具定义数组（1 个）。
 */
function createPlayurlTools(deps) {
  return [
    defineTool({
      name: 'bili_playurl',
      description: '取一个视频的播放地址（DASH 视频/音频流与分段直链）：默认 best 清晰度，可指定 1080/720/480/360，audioOnly 只取音频。'
        + '返回的地址带签名会过期，过期后重新调用；只想下载文件请用 bili_download。',
      parameters: {
        target: { type: 'string', description: '视频标识：BV 号、av 号、B 站链接或 b23.tv 短链', required: true },
        page: { type: 'integer', description: '分 P 页码（从 1 开始，默认 1）', default: 1 },
        quality: {
          type: 'string',
          description: '清晰度：best 最好（默认）、1080、720、480、360',
          enum: ['best', '1080', '720', '480', '360'],
          default: 'best',
        },
        audioOnly: { type: 'boolean', description: '只取音频流（默认 false）', default: false },
      },
      output: MEDIA_OUTPUT,
      async execute(args) {
        const target = typeof args.target === 'string' ? args.target.trim() : '';
        if (target === '') throw invalidArgument('target 不能为空：请给出 BV 号、av 号或 B 站链接。');
        const quality = typeof args.quality === 'string' && args.quality !== '' ? args.quality : 'best';
        const result = await deps.api.playurl({
          target,
          page: pageOf(args.page),
          quality,
          audioOnly: args.audioOnly === true,
        });
        /** @type {Record<string, any>} */
        const data = {
          media: result?.media !== null && typeof result?.media === 'object' ? result.media : {},
          quality: result?.quality,
          accept: Array.isArray(result?.accept) ? result.accept : [],
          video: Array.isArray(result?.video) ? result.video : [],
          audio: Array.isArray(result?.audio) ? result.audio : [],
          durl: Array.isArray(result?.durl) ? result.durl : [],
          expiresAt: result?.expiresAt,
        };
        return { ok: true, data, text: playurlText(data), blocks: [] };
      },
    }),
  ];
}

/**
 * 注册 `bili_subtitle`。
 * @param {Record<string, any>} deps - 装配依赖（`api`/`config`）。
 * @returns {object[]} 工具定义数组（1 个）。
 */
function createSubtitleTools(deps) {
  return [
    defineTool({
      name: 'bili_subtitle',
      description: '取一个视频的字幕：可用语言列表、当前语言与逐行字幕（起止秒 + 文本）。未登录时通常为空列表，属正常现象。',
      parameters: {
        target: { type: 'string', description: '视频标识：BV 号、av 号、B 站链接或 b23.tv 短链', required: true },
        page: { type: 'integer', description: '分 P 页码（从 1 开始，默认 1）', default: 1 },
        lang: { type: 'string', description: '字幕语言代码（如 zh-CN、ai-zh），缺省取接口返回的第一种' },
      },
      output: MEDIA_OUTPUT,
      async execute(args) {
        const target = typeof args.target === 'string' ? args.target.trim() : '';
        if (target === '') throw invalidArgument('target 不能为空：请给出 BV 号、av 号或 B 站链接。');
        const params = { target, page: pageOf(args.page) };
        if (typeof args.lang === 'string' && args.lang.trim() !== '') params.lang = args.lang.trim();
        const result = await deps.api.subtitle(params);
        const rawLines = Array.isArray(result?.lines) ? result.lines : [];
        /** @type {Record<string, any>} */
        const data = {
          languages: Array.isArray(result?.languages) ? result.languages : [],
          lang: result?.lang,
          lines: rawLines,
        };
        const preview = Math.min(SUBTITLE_PREVIEW, rawLines.length);
        return {
          ok: true,
          data,
          text: subtitleText(data, preview, rawLines.length - preview),
          blocks: [],
        };
      },
    }),
  ];
}

/**
 * 注册 6 个媒体/榜单类工具。
 * @param {Record<string, any>} deps - 装配依赖（`api`/`config`/`images`）。
 * @returns {object[]} 工具定义数组（6 个）。
 */
export function createMediaTools(deps) {
  return [
    ...createRankingTools(deps),
    ...createPopularTools(deps),
    ...createBangumiTools(deps),
    ...createLiveTools(deps),
    ...createPlayurlTools(deps),
    ...createSubtitleTools(deps),
  ];
}
