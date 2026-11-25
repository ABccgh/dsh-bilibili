/**
 * B 站 API 层：**所有端点的唯一入口**。
 *
 * 设计原则：
 * 1. 每个方法只做「取数 + 归一化」，网络走 `lib/http.js`、签名走 `lib/wbi.js` /
 *    `lib/appapi.js`、Cookie 走 `lib/cookies.js`；T2/T3/T4 只消费这里返回的形状，
 *    不自己拼 URL（契约 §9）。
 * 2. 归一化后的字段名严格按契约 §9，不得改名；可选字段在没数据时直接省略。
 * 3. 业务码 `code !== 0` 统一转 `BiliError`：`-101` → `BILI_AUTH_REQUIRED`，
 *    风控码给「稍等/登录」提示，`-404` → `BILI_NOT_FOUND`。
 * 4. 只读接口允许降级：搜索 App→Web、投稿列表失败返回空数组 + 告警、
 *    每周必看失败退普通热门；鉴权接口失败必须抛错（让工具层提示登录）。
 *
 * 端点现实与契约的已知差异（2026-11 实测）：
 * - 搜索：Web WBI `x/web-interface/wbi/search/type` 才是「按类型 + 可翻页」的稳定入口
 *   （video 的 numResults=1000/numPages=200 正常），所以**搜索以 Web 为主**、App 混合流
 *   为降级；App `x/v2/search` 现在返回平铺混合流（每页约 20 条，`goto` 混杂），且 `page`
 *   参数实测不可靠（第 2/3 页与第 1 页大量重复），契约里「分组数组的数组」已过时。
 * - 番剧 `pgc/view/web/season` 的正确路径是 `api.bilibili.com/pgc/...`（无 `/x/`），
 *   响应在 `result` 字段里。
 * - 排行榜 `information`/`variety` 两个分区当前返回 `-400`，只能给可读错误与建议。
 * - 直播 `getInfoByRoom` 实测返回 1000003，主播信息改用 `live_user/v1/UserInfo/get_anchor_in_room`。
 *
 * @module @local/bilibili/api
 */

import {
  BiliError,
  CODES,
  authRequired,
  fromApiCode,
  invalidArgument,
} from './errors.js';
import {
  aidFromBv,
  bvFromAid,
  deadlineFromUrl,
  durationText,
  findBvid,
  parseDanmakuSegments,
  pubdateText,
  resolveTargetInput,
  stripHtml,
} from './format.js';

/** Web 接口主机。 */
const API = 'https://api.bilibili.com';

/** 直播接口主机。 */
const LIVE_API = 'https://api.live.bilibili.com';

/** 通行证接口主机。 */
const PASSPORT = 'https://passport.bilibili.com';

/** App 搜索每页条数（服务端固定约 20 条，page_size 参数会被忽略）。 */
const APP_SEARCH_PAGE_SIZE = 20;

/** App 搜索「这一页基本是满的」阈值：服务端实际返回 19–20 条，低于 15 视为见底。 */
const APP_SEARCH_FULL_PAGE = 15;

/** 一次搜索最多翻几页 App 混合流（实测该端点 page 参数不可靠，只取一页）。 */
const APP_SEARCH_MAX_FETCHES = 1;

/** 默认列表条数（与配置默认值一致，作为 config 缺省时的兜底）。 */
const DEFAULT_MAX_ITEMS = 25;

/** 一次弹幕请求最多取多少条（契约限制在工具层，这里再兜一层）。 */
const DANMAKU_SEGMENT = 1;

/** 搜索类型 → B 站 `search_type` 取值。 */
const SEARCH_TYPES = {
  video: 'video',
  user: 'bili_user',
  bangumi: 'media_bangumi',
  live: 'live',
  article: 'article',
};

/** 每种搜索类型对应的 App `goto`（混合流里筛出目标类型）。 */
const TYPE_GOTOS = {
  video: new Set(['av', 'video']),
  user: new Set(['author_new', 'bili_user']),
  bangumi: new Set(['bangumi', 'media_bangumi']),
  live: new Set(['live']),
  article: new Set(['article', 'article_new']),
};

/** 允许的排序方式。 */
const SEARCH_ORDERS = new Set(['totalrank', 'click', 'pubdate', 'dm', 'stow']);

/** 排行榜分区：工具参数名 → 分区 id 与中文名。 */
const RANKING_AREAS = {
  all: { rid: 0, name: '全站' },
  douga: { rid: 1, name: '动画' },
  game: { rid: 4, name: '游戏' },
  kichiku: { rid: 119, name: '鬼畜' },
  music: { rid: 3, name: '音乐' },
  dance: { rid: 129, name: '舞蹈' },
  cinephile: { rid: 181, name: '影视' },
  ent: { rid: 5, name: '娱乐' },
  knowledge: { rid: 36, name: '知识' },
  tech: { rid: 188, name: '科技' },
  food: { rid: 211, name: '美食' },
  animal: { rid: 217, name: '动物圈' },
  fashion: { rid: 155, name: '时尚' },
  information: { rid: 202, name: '资讯' },
  auto: { rid: 223, name: '汽车' },
  sports: { rid: 234, name: '运动' },
  movie: { rid: 23, name: '电影' },
  teleplay: { rid: 11, name: '电视剧' },
  variety: { rid: 71, name: '综艺' },
  documentary: { rid: 177, name: '纪录片' },
};

/** 清晰度参数 → `qn`。 */
const QUALITY_QN = {
  best: 80,
  '1080': 80,
  '720': 64,
  '480': 32,
  '360': 16,
};

/** 清晰度 id → 文案（接口没给 accept_description 时兜底）。 */
const QUALITY_LABELS = {
  6: '240P',
  16: '360P',
  32: '480P',
  64: '720P',
  74: '720P60',
  80: '1080P',
  112: '1080P+',
  116: '1080P60',
  120: '4K',
  125: 'HDR',
  126: '杜比视界',
  127: '8K',
};

/** 动态类型 → 友好类型名。 */
const DYNAMIC_TYPES = {
  DYNAMIC_TYPE_AV: 'video',
  DYNAMIC_TYPE_DRAW: 'image',
  DYNAMIC_TYPE_WORD: 'text',
  DYNAMIC_TYPE_FORWARD: 'forward',
  DYNAMIC_TYPE_ARTICLE: 'article',
  DYNAMIC_TYPE_LIVE_RCMD: 'live',
  DYNAMIC_TYPE_PGC: 'bangumi',
  DYNAMIC_TYPE_MUSIC: 'music',
};

/**
 * 数字收窄：非有限数字返回 undefined。
 * @param {unknown} value - 原值。
 * @returns {number | undefined} 整数或 undefined。
 */
function toInt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : undefined;
}

/**
 * URL 归一：`//host/…` 补协议，`http://` 升 https。
 * @param {unknown} value - 原值。
 * @returns {string | undefined} 地址；空值返回 undefined。
 */
function fixUrl(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  if (text.startsWith('//')) return `https:${text}`;
  if (/^http:\/\//i.test(text)) return `https://${text.slice(7)}`;
  return text;
}

/**
 * 视频 URL。
 * @param {string} bvid - BV 号。
 * @returns {string} 视频页地址。
 */
function videoUrl(bvid) {
  return `https://www.bilibili.com/video/${bvid}`;
}

/**
 * aid → BV（越界时返回 undefined，不让一个脏 aid 毁掉整条列表）。
 * @param {unknown} aid - aid。
 * @returns {string | undefined} BV 号。
 */
function safeBvid(aid) {
  const value = toInt(aid);
  if (value === undefined || value <= 0) return undefined;
  try {
    return bvFromAid(value);
  } catch {
    return undefined;
  }
}

/**
 * 解析 `mm:ss` / `h:mm:ss` 时长文本。
 * @param {unknown} text - 原值（数字直接当秒）。
 * @returns {number | undefined} 秒。
 */
function parseClockDuration(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? Math.max(0, Math.trunc(text)) : undefined;
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  const parts = text.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return undefined;
  let seconds = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0) return undefined;
    seconds = seconds * 60 + value;
  }
  return Math.floor(seconds);
}

/**
 * 只在有值时放字段（避免归一化结果里出现一堆 `undefined` 键）。
 * @param {Record<string, unknown>} target - 目标对象。
 * @param {string} key - 字段名。
 * @param {unknown} value - 值。
 * @returns {void}
 */
function put(target, key, value) {
  if (value !== undefined) target[key] = value;
}

/**
 * 把分页参数收成 ≥1 的整数。
 * @param {unknown} value - 原值。
 * @returns {number} 页码。
 */
function pageNumber(value) {
  const number = toInt(value);
  return number !== undefined && number > 0 ? number : 1;
}

/**
 * 把 items/count 收集到 `pages` 里（契约里的 `Part[]`）。
 * @param {any} view - `x/web-interface/view` 的 data。
 * @returns {Array<{ cid: number, page: number, part: string, durationSec: number, durationText: string }>} 分P。
 */
function normalizeParts(view) {
  const pages = Array.isArray(view?.pages) ? view.pages : [];
  if (pages.length === 0) {
    const cid = toInt(view?.cid);
    return cid === undefined
      ? []
      : [{
        cid,
        page: 1,
        part: stripHtml(view?.title ?? '正片'),
        durationSec: toInt(view?.duration) ?? 0,
        durationText: durationText(toInt(view?.duration) ?? 0),
      }];
  }
  return pages.map((raw) => {
    const durationSec = toInt(raw?.duration) ?? 0;
    return {
      cid: toInt(raw?.cid) ?? 0,
      page: toInt(raw?.page) ?? 1,
      part: stripHtml(raw?.part ?? ''),
      durationSec,
      durationText: durationText(durationSec),
    };
  });
}

/**
 * 选中的分P（页码越界时夹到首/尾）。
 * @param {Array<{ cid: number, page: number, part: string, durationSec: number, durationText: string }>} parts - 分P。
 * @param {unknown} page - 页码。
 * @returns {{ part: any, page: number }} 选中的分P与实际页码。
 */
function pickPart(parts, page) {
  if (parts.length === 0) {
    return { part: { cid: 0, page: 1, part: '', durationSec: 0, durationText: '' }, page: 1 };
  }
  const wanted = Math.min(Math.max(1, pageNumber(page)), parts.length);
  return { part: parts[wanted - 1], page: wanted };
}

/**
 * 归一化 `Part`（契约 §9）。
 * @param {any} raw - 接口里的分P。
 * @returns {{ cid: number, page: number, part: string, durationSec: number, durationText: string }} 分P。
 */
function normalizePart(raw) {
  const durationSec = toInt(raw?.duration) ?? 0;
  return {
    cid: toInt(raw?.cid) ?? 0,
    page: toInt(raw?.page) ?? 1,
    part: stripHtml(raw?.part ?? ''),
    durationSec,
    durationText: durationText(durationSec),
  };
}

/**
 * 归一化 `Tag`。
 * @param {any} raw - 接口里的标签。
 * @returns {{ id: number, name: string, count?: number } | null} 标签。
 */
function normalizeTag(raw) {
  const name = stripHtml(raw?.tag_name ?? raw?.name ?? '');
  if (name === '') return null;
  return {
    id: toInt(raw?.tag_id ?? raw?.tid) ?? 0,
    name,
    ...(toInt(raw?.count?.use ?? raw?.count?.atten ?? raw?.count) !== undefined
      ? { count: toInt(raw?.count?.use ?? raw?.count?.atten ?? raw?.count) }
      : {}),
  };
}

/**
 * 归一化 `Video`（契约 §9，含 `pages`/`tags`）。
 * @param {any} view - `x/web-interface/view` 的 data。
 * @param {Array<any>} parts - 分P。
 * @param {Array<any>} tags - 标签。
 * @returns {Record<string, any>} 视频。
 */
function normalizeVideo(view, parts, tags) {
  const stat = view?.stat ?? {};
  const owner = view?.owner ?? {};
  const durationSec = toInt(view?.duration) ?? 0;
  return {
    bvid: String(view?.bvid ?? ''),
    aid: toInt(view?.aid) ?? 0,
    title: stripHtml(view?.title ?? ''),
    cover: fixUrl(view?.pic) ?? '',
    durationSec,
    durationText: durationText(durationSec),
    pubdate: toInt(view?.pubdate) ?? 0,
    pubdateText: pubdateText(view?.pubdate),
    desc: stripHtml(view?.desc ?? ''),
    owner: {
      mid: toInt(owner.mid) ?? 0,
      name: stripHtml(owner.name ?? ''),
      ...(fixUrl(owner.face) !== undefined ? { face: fixUrl(owner.face) } : {}),
    },
    stat: {
      view: toInt(stat.view) ?? 0,
      danmaku: toInt(stat.danmaku) ?? 0,
      like: toInt(stat.like) ?? 0,
      coin: toInt(stat.coin) ?? 0,
      favorite: toInt(stat.favorite) ?? 0,
      share: toInt(stat.share) ?? 0,
      reply: toInt(stat.reply) ?? 0,
    },
    pages: parts,
    tags,
    url: videoUrl(String(view?.bvid ?? '')),
  };
}

/**
 * 归一化 `User`。
 * @param {any} card - `card` 对象。
 * @param {any} bag - `x/web-interface/card` 的 data（提供粉丝数/投稿数等）。
 * @returns {Record<string, any>} 用户。
 */
function normalizeUser(card, bag) {
  const mid = toInt(card?.mid) ?? 0;
  const official = card?.official ?? card?.official_verify;
  const vip = card?.vip;
  const result = {
    mid,
    name: stripHtml(card?.name ?? card?.uname ?? ''),
    url: `https://space.bilibili.com/${mid}`,
  };
  put(result, 'face', fixUrl(card?.face));
  put(result, 'fans', toInt(card?.fans ?? bag?.data?.follower));
  put(result, 'level', toInt(card?.level_info?.current_level ?? card?.level));
  put(result, 'sign', stripHtml(card?.sign ?? card?.usign ?? ''));
  put(result, 'archiveCount', toInt(bag?.archive_count ?? card?.archive_count));
  if (official !== null && typeof official === 'object') {
    result.official = {
      type: toInt(official.type) ?? 0,
      desc: stripHtml(official.desc ?? official.title ?? ''),
    };
  }
  if (vip !== null && typeof vip === 'object') {
    result.vip = {
      status: toInt(vip.status ?? vip.vipStatus) ?? 0,
      ...(stripHtml(vip.label?.text ?? '') !== '' ? { label: stripHtml(vip.label?.text ?? '') } : {}),
    };
  }
  return result;
}

/**
 * 生成一个 `Item`（视频类），只放有值的字段。
 * @param {{ bvid?: string, aid?: number, title?: string, author?: string, cover?: string,
 *   play?: number, danmaku?: number, durationSec?: number, pubdate?: number, url?: string }} source - 字段。
 * @returns {Record<string, any>} Item。
 */
function makeVideoItem(source) {
  /** @type {Record<string, any>} */
  const item = {
    type: 'video',
    title: stripHtml(source.title ?? ''),
    url: source.url ?? (source.bvid !== undefined ? videoUrl(source.bvid) : ''),
  };
  put(item, 'bvid', source.bvid);
  put(item, 'aid', source.aid);
  put(item, 'author', source.author);
  put(item, 'cover', source.cover);
  put(item, 'play', source.play);
  put(item, 'danmaku', source.danmaku);
  put(item, 'durationSec', source.durationSec);
  put(item, 'durationText', source.durationSec === undefined ? undefined : durationText(source.durationSec));
  put(item, 'pubdate', source.pubdate);
  put(item, 'pubdateText', source.pubdate === undefined ? undefined : pubdateText(source.pubdate));
  return item;
}

/**
 * 归一化 App 搜索混合流里的一条。
 * @param {any} raw - App 搜索条目。
 * @param {string} type - 期望类型。
 * @returns {Record<string, any> | null} Item。
 */
function appSearchItem(raw, type) {
  if (raw === null || typeof raw !== 'object') return null;
  const goto = String(raw.goto ?? '');
  if (!TYPE_GOTOS[type]?.has(goto)) return null;
  if (type === 'video') {
    const aid = toInt(raw.param);
    const bvid = safeBvid(aid);
    const durationSec = parseClockDuration(raw.duration);
    return makeVideoItem({
      bvid,
      aid,
      title: raw.title,
      author: typeof raw.author === 'string' ? raw.author : undefined,
      cover: fixUrl(raw.cover),
      play: toInt(raw.play),
      danmaku: toInt(raw.danmaku),
      durationSec,
      pubdate: toInt(raw.ptime),
    });
  }
  if (type === 'user') {
    const mid = toInt(raw.param);
    if (mid === undefined) return null;
    /** @type {Record<string, any>} */
    const item = {
      type: 'user',
      mid,
      title: stripHtml(raw.title ?? ''),
      cover: fixUrl(raw.cover ?? raw.face),
      url: `https://space.bilibili.com/${mid}`,
    };
    put(item, 'fans', toInt(raw.fans));
    put(item, 'level', toInt(raw.level));
    put(item, 'sign', stripHtml(raw.sign ?? ''));
    return item;
  }
  if (type === 'live') {
    const roomId = toInt(raw.roomid ?? raw.param);
    if (roomId === undefined) return null;
    return {
      type: 'live',
      title: stripHtml(raw.title ?? ''),
      ...(typeof raw.name === 'string' && raw.name !== '' ? { author: raw.name } : {}),
      ...(fixUrl(raw.cover) !== undefined ? { cover: fixUrl(raw.cover) } : {}),
      ...(toInt(raw.online) !== undefined ? { play: toInt(raw.online) } : {}),
      url: `https://live.bilibili.com/${roomId}`,
    };
  }
  if (type === 'bangumi') {
    const seasonId = toInt(raw.season_id ?? raw.param);
    const url = seasonId !== undefined
      ? `https://www.bilibili.com/bangumi/play/ss${seasonId}`
      : (fixUrl(raw.watch_button?.link) ?? '');
    return {
      type: 'bangumi',
      title: stripHtml(raw.title ?? ''),
      ...(fixUrl(raw.cover) !== undefined ? { cover: fixUrl(raw.cover) } : {}),
      url,
    };
  }
  // article
  const articleId = toInt(raw.id ?? raw.param);
  const articleUrl = articleId !== undefined
    ? `https://www.bilibili.com/read/cv${articleId}`
    : (fixUrl(raw.uri) ?? '');
  return {
    type: 'article',
    title: stripHtml(raw.title ?? ''),
    ...(typeof raw.author === 'string' && raw.author !== '' ? { author: raw.author } : {}),
    ...(fixUrl(Array.isArray(raw.image_urls) ? raw.image_urls[0] : raw.cover) !== undefined
      ? { cover: fixUrl(Array.isArray(raw.image_urls) ? raw.image_urls[0] : raw.cover) }
      : {}),
    ...(toInt(raw.view) !== undefined ? { play: toInt(raw.view) } : {}),
    url: articleUrl,
  };
}

/**
 * 归一化 Web 搜索（`x/web-interface/wbi/search/type`）里的一条。
 * @param {any} raw - Web 搜索结果条目。
 * @param {string} type - 期望类型。
 * @returns {Record<string, any> | null} Item。
 */
function webSearchItem(raw, type) {
  if (raw === null || typeof raw !== 'object') return null;
  if (type === 'video') {
    if (raw.type !== 'video') return null;
    const bvid = typeof raw.bvid === 'string' && raw.bvid !== '' ? raw.bvid : safeBvid(raw.aid);
    return makeVideoItem({
      bvid,
      aid: toInt(raw.aid),
      title: raw.title,
      author: typeof raw.author === 'string' ? raw.author : undefined,
      cover: fixUrl(raw.pic ?? raw.cover),
      play: toInt(raw.play),
      danmaku: toInt(raw.video_review ?? raw.danmaku),
      durationSec: parseClockDuration(raw.duration),
      pubdate: toInt(raw.pubdate),
    });
  }
  if (type === 'user') {
    const mid = toInt(raw.mid);
    if (mid === undefined) return null;
    /** @type {Record<string, any>} */
    const item = {
      type: 'user',
      mid,
      title: stripHtml(raw.uname ?? ''),
      cover: fixUrl(raw.upic),
      url: `https://space.bilibili.com/${mid}`,
    };
    put(item, 'fans', toInt(raw.fans));
    put(item, 'level', toInt(raw.level));
    put(item, 'sign', stripHtml(raw.usign ?? ''));
    return item;
  }
  if (type === 'bangumi') {
    const seasonId = toInt(raw.season_id);
    return {
      type: 'bangumi',
      title: stripHtml(raw.title ?? ''),
      ...(fixUrl(raw.cover) !== undefined ? { cover: fixUrl(raw.cover) } : {}),
      url: fixUrl(raw.url) ?? (seasonId !== undefined ? `https://www.bilibili.com/bangumi/play/ss${seasonId}` : ''),
    };
  }
  if (type === 'live') {
    const roomId = toInt(raw.roomid);
    if (roomId === undefined) return null;
    return {
      type: 'live',
      title: stripHtml(raw.title ?? ''),
      ...(typeof raw.uname === 'string' && raw.uname !== '' ? { author: raw.uname } : {}),
      ...(fixUrl(raw.cover ?? raw.user_cover) !== undefined ? { cover: fixUrl(raw.cover ?? raw.user_cover) } : {}),
      ...(toInt(raw.online) !== undefined ? { play: toInt(raw.online) } : {}),
      url: `https://live.bilibili.com/${roomId}`,
    };
  }
  // article
  if (raw.type !== 'article') return null;
  const articleId = toInt(raw.id);
  return {
    type: 'article',
    title: stripHtml(raw.title ?? ''),
    ...(typeof raw.author === 'string' && raw.author !== '' ? { author: raw.author } : {}),
    ...(fixUrl(Array.isArray(raw.image_urls) ? raw.image_urls[0] : raw.cover) !== undefined
      ? { cover: fixUrl(Array.isArray(raw.image_urls) ? raw.image_urls[0] : raw.cover) }
      : {}),
    ...(toInt(raw.view) !== undefined ? { play: toInt(raw.view) } : {}),
    url: articleId !== undefined ? `https://www.bilibili.com/read/cv${articleId}` : (fixUrl(raw.url) ?? ''),
  };
}

/**
 * 归一化评论的一条回复。
 * @param {any} raw - 回复。
 * @returns {{ rpid: number, uname: string, message: string, like: number, ctimeText: string }} Reply。
 */
function normalizeReply(raw) {
  return {
    rpid: toInt(raw?.rpid) ?? 0,
    uname: stripHtml(raw?.member?.uname ?? ''),
    message: stripHtml(raw?.content?.message ?? ''),
    like: toInt(raw?.like) ?? 0,
    ctimeText: pubdateText(raw?.ctime),
  };
}

/**
 * 归一化评论（契约 §9 `Comment`）。
 * @param {any} raw - 评论。
 * @param {boolean} includeReplies - 是否带上楼中楼。
 * @returns {Record<string, any>} Comment。
 */
function normalizeComment(raw, includeReplies) {
  /** @type {Record<string, any>} */
  const item = {
    rpid: toInt(raw?.rpid) ?? 0,
    ...(toInt(raw?.mid) !== undefined ? { mid: toInt(raw?.mid) } : {}),
    uname: stripHtml(raw?.member?.uname ?? ''),
    ...(fixUrl(raw?.member?.avatar) !== undefined ? { avatar: fixUrl(raw?.member?.avatar) } : {}),
    message: stripHtml(raw?.content?.message ?? ''),
    like: toInt(raw?.like) ?? 0,
    ctime: toInt(raw?.ctime) ?? 0,
    ctimeText: pubdateText(raw?.ctime),
    replyCount: toInt(raw?.rcount) ?? 0,
  };
  if (includeReplies && Array.isArray(raw?.replies) && raw.replies.length > 0) {
    item.replies = raw.replies.map(normalizeReply);
  }
  return item;
}

/**
 * 按分钟统计弹幕分布。
 * @param {Array<{ timeMs: number }>} items - 弹幕。
 * @returns {Array<{ minute: number, count: number }>} 分布（按分钟升序）。
 */
function buildDistribution(items) {
  /** @type {Map<number, number>} */
  const buckets = new Map();
  for (const item of items) {
    const minute = Math.floor((toInt(item.timeMs) ?? 0) / 60000);
    buckets.set(minute, (buckets.get(minute) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([minute, count]) => ({ minute, count }));
}

/**
 * 从登录成功回跳的 URL 里抠出 Cookie 串（5 个键）。
 * @param {unknown} url - 回跳 URL。
 * @returns {string | undefined} Cookie 串；取不到时 undefined。
 */
function cookieStringFromLoginUrl(url) {
  if (typeof url !== 'string' || url === '') return undefined;
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  /** @type {string[]} */
  const pairs = [];
  for (const name of ['DedeUserID', 'SESSDATA', 'bili_jct', 'DedeUserID__ckMd5', 'sid']) {
    const value = parsed.searchParams.get(name);
    if (value !== null && value !== '') pairs.push(`${name}=${value}`);
  }
  return pairs.length === 0 ? undefined : pairs.join('; ');
}

/**
 * 从登录轮询响应的 `Set-Cookie` 里抠出 Cookie 串（只取需要的 5 个键）。
 *
 * 2026-11 起 B 站扫码成功的回跳 URL 可能为空，Cookie 由 `Set-Cookie` 直接下发；
 * 这里与 `cookieStringFromLoginUrl` 取并集，任一来源有值即可。
 * @param {unknown} headers - `Headers` 或带 `getSetCookie()` 的对象。
 * @returns {string | undefined} Cookie 串；没有可用键时 undefined。
 */
function cookieStringFromSetCookie(headers) {
  if (headers === null || headers === undefined || typeof headers !== 'object') return undefined;
  /** @type {string[]} */
  let list = [];
  try {
    if (typeof headers.getSetCookie === 'function') list = headers.getSetCookie();
    else if (typeof headers.get === 'function') {
      const raw = headers.get('set-cookie');
      if (typeof raw === 'string' && raw !== '') list = [raw];
    }
  } catch {
    return undefined;
  }
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const first = String(raw).split(';')[0];
    const index = first.indexOf('=');
    if (index <= 0) continue;
    const name = first.slice(0, index).trim();
    const value = first.slice(index + 1).trim();
    if (['DedeUserID', 'SESSDATA', 'bili_jct', 'DedeUserID__ckMd5', 'sid'].includes(name) && value !== '') {
      map.set(name, value);
    }
  }
  return map.size === 0 ? undefined : [...map.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * 合并两份 Cookie 串：后者覆盖前者的同名键。
 * @param {string | undefined} first - 优先来源。
 * @param {string | undefined} second - 补充来源。
 * @returns {string | undefined} 合并结果。
 */
function mergeCookieStrings(first, second) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const source of [first, second]) {
    if (typeof source !== 'string' || source.trim() === '') continue;
    for (const pair of source.split(';')) {
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (name !== '' && value !== '') map.set(name, value);
    }
  }
  return map.size === 0 ? undefined : [...map.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * 归一化番剧 `Bangumi`（契约 §9）。
 * @param {any} data - `pgc/view/web/season` 的 `result`。
 * @returns {Record<string, any>} 番剧。
 */
function normalizeBangumi(data) {
  const seasonId = toInt(data?.season_id) ?? 0;
  const episodes = Array.isArray(data?.episodes) ? data.episodes : [];
  return {
    seasonId,
    title: stripHtml(data?.title ?? ''),
    cover: fixUrl(data?.cover) ?? '',
    evaluate: stripHtml(data?.evaluate ?? data?.subtitle ?? ''),
    rating: Number(data?.rating?.score) || 0,
    totalEpisodes: toInt(data?.total_episodes) ?? episodes.length,
    episodes: episodes.map((raw) => ({
      epId: toInt(raw?.id ?? raw?.ep_id) ?? 0,
      title: stripHtml(raw?.title ?? raw?.show_title ?? ''),
      ...(typeof raw?.bvid === 'string' && raw.bvid !== '' ? { bvid: raw.bvid } : {}),
      ...(fixUrl(raw?.cover) !== undefined ? { cover: fixUrl(raw.cover) } : {}),
      // 番剧接口的 duration 单位是毫秒。
      durationSec: Math.round((toInt(raw?.duration) ?? 0) / 1000),
    })),
    url: fixUrl(data?.link) ?? `https://www.bilibili.com/bangumi/play/ss${seasonId}`,
  };
}

/**
 * 归一化直播间 `Room`。
 * @param {any} data - `room/v1/Room/get_info` 的 data。
 * @param {number} fallbackId - 入参 roomId。
 * @returns {Record<string, any>} 直播间。
 */
function normalizeRoom(data, fallbackId) {
  const roomId = toInt(data?.room_id) ?? fallbackId;
  const shortId = toInt(data?.short_id);
  return {
    roomId,
    ...(shortId !== undefined && shortId > 0 ? { shortId } : {}),
    title: stripHtml(data?.title ?? ''),
    ...(fixUrl(data?.user_cover ?? data?.cover ?? data?.keyframe) !== undefined
      ? { cover: fixUrl(data?.user_cover ?? data?.cover ?? data?.keyframe) }
      : {}),
    liveStatus: toInt(data?.live_status) ?? 0,
    online: toInt(data?.online) ?? 0,
    attention: toInt(data?.attention) ?? 0,
    url: `https://live.bilibili.com/${roomId}`,
  };
}

/**
 * 归一化 UP 主投稿列表（App iOS `x/v2/space/archive`）。
 * @param {any} data - 接口的 data（`item` 是投稿数组）。
 * @param {number} limit - 最多返回多少条。
 * @returns {Array<Record<string, any>>} Item[]。
 */
function normalizeSpaceArchive(data, limit) {
  const raw = Array.isArray(data?.item)
    ? data.item
    : Array.isArray(data?.item?.videos)
      ? data.item.videos
      : Array.isArray(data?.list)
        ? data.list
        : [];
  /** @type {Array<Record<string, any>>} */
  const items = [];
  for (const entry of raw) {
    if (items.length >= limit) break;
    const aid = toInt(entry?.param ?? entry?.aid);
    const bvid = typeof entry?.bvid === 'string' && entry.bvid !== '' ? entry.bvid : safeBvid(aid);
    items.push(makeVideoItem({
      bvid,
      aid,
      title: entry?.title,
      author: typeof entry?.author === 'string' ? entry.author : undefined,
      cover: fixUrl(entry?.cover ?? entry?.pic),
      play: toInt(entry?.play ?? entry?.stat?.view),
      danmaku: toInt(entry?.danmaku ?? entry?.stat?.danmaku),
      durationSec: toInt(entry?.duration) ?? parseClockDuration(entry?.duration),
      pubdate: toInt(entry?.ctime ?? entry?.pubdate),
    }));
  }
  return items;
}

/**
 * 归一化排行榜/热门列表条目。
 * @param {any} raw - 列表条目。
 * @returns {Record<string, any>} Item。
 */
function normalizeRankingItem(raw) {
  return makeVideoItem({
    bvid: typeof raw?.bvid === 'string' && raw.bvid !== '' ? raw.bvid : safeBvid(raw?.aid),
    aid: toInt(raw?.aid),
    title: raw?.title,
    author: typeof raw?.owner?.name === 'string' ? raw.owner.name : undefined,
    cover: fixUrl(raw?.pic),
    play: toInt(raw?.stat?.view),
    danmaku: toInt(raw?.stat?.danmaku),
    durationSec: toInt(raw?.duration),
    pubdate: toInt(raw?.pubdate),
  });
}

/**
 * 归一化观看历史条目。
 * @param {any} raw - 历史条目。
 * @returns {Record<string, any>} HistoryItem。
 */
function normalizeHistoryItem(raw) {
  // 历史接口的稿件坐标在 `history.bvid` / `history.oid`（aid）里，顶层没有 bvid/aid；
  // 以前只读顶层会生成 `av0` 链接。
  const history = raw?.history ?? {};
  const aid = toInt(history.oid) ?? toInt(raw?.aid) ?? toInt(raw?.oid);
  const rawBvid = typeof raw?.bvid === 'string' && raw.bvid !== ''
    ? raw.bvid
    : (typeof history.bvid === 'string' && history.bvid !== '' ? history.bvid : undefined);
  const bvid = rawBvid ?? safeBvid(aid);
  /** @type {Record<string, any>} */
  const item = {
    title: stripHtml(raw?.title ?? ''),
    ...(fixUrl(raw?.cover) !== undefined ? { cover: fixUrl(raw.cover) } : {}),
    ...(typeof raw?.author_name === 'string' && raw.author_name !== '' ? { author: raw.author_name } : {}),
    ...(bvid !== undefined ? { bvid } : {}),
    progressSec: toInt(raw?.progress) ?? 0,
    durationSec: toInt(raw?.duration) ?? 0,
    viewedAtText: pubdateText(raw?.view_at),
    url: bvid !== undefined ? videoUrl(bvid) : `https://www.bilibili.com/video/av${aid ?? 0}`,
  };
  return item;
}

/**
 * 归一化收藏夹里的一个视频。
 * @param {any} raw - `x/v3/fav/resource/list` 的 medias 条目。
 * @returns {Record<string, any>} Item。
 */
function normalizeFavItem(raw) {
  const aid = toInt(raw?.id);
  return makeVideoItem({
    bvid: typeof raw?.bvid === 'string' && raw.bvid !== '' ? raw.bvid : safeBvid(aid),
    aid,
    title: raw?.title,
    author: typeof raw?.upper?.name === 'string' ? raw.upper.name : undefined,
    cover: fixUrl(raw?.cover),
    play: toInt(raw?.cnt_info?.play),
    danmaku: toInt(raw?.cnt_info?.danmaku),
    durationSec: toInt(raw?.duration),
    pubdate: toInt(raw?.pubtime),
    url: '',
  });
}

/**
 * 归一化关注列表里的一个用户。
 * @param {any} raw - `x/relation/followings` 的 list 条目。
 * @returns {Record<string, any>} User。
 */
function normalizeFollowingUser(raw) {
  const mid = toInt(raw?.mid) ?? 0;
  /** @type {Record<string, any>} */
  const user = { mid, name: stripHtml(raw?.uname ?? ''), url: `https://space.bilibili.com/${mid}` };
  put(user, 'face', fixUrl(raw?.face));
  put(user, 'sign', stripHtml(raw?.sign ?? ''));
  put(user, 'level', toInt(raw?.level));
  const official = raw?.official_verify;
  if (official !== null && typeof official === 'object') {
    user.official = { type: toInt(official.type) ?? 0, desc: stripHtml(official.desc ?? '') };
  }
  const vip = raw?.vip;
  if (vip !== null && typeof vip === 'object') {
    user.vip = { status: toInt(vip.vipStatus ?? vip.status) ?? 0 };
  }
  return user;
}

/**
 * 归一化一条动态。
 * @param {any} raw - `polymer/web-dynamic/v1/feed/all` 的 items 条目。
 * @returns {Record<string, any>} DynamicItem。
 */
function normalizeDynamicItem(raw) {
  const author = raw?.modules?.module_author ?? {};
  const dynamic = raw?.modules?.module_dynamic ?? {};
  const major = dynamic?.major ?? {};
  const archive = major?.archive;
  const desc = dynamic?.desc?.text
    ?? major?.opus?.summary?.text
    ?? (Array.isArray(major?.draw?.items) ? major.draw.items[0]?.description : undefined)
    ?? archive?.desc
    ?? '';
  const id = String(raw?.id_str ?? raw?.id ?? '');
  const rawType = String(raw?.type ?? '');
  const type = DYNAMIC_TYPES[rawType] ?? rawType.replace(/^DYNAMIC_TYPE_/, '').toLowerCase();
  /** @type {{ bvid: string, title: string, cover?: string } | undefined} */
  let video;
  if (archive !== null && typeof archive === 'object' && typeof archive.bvid === 'string' && archive.bvid !== '') {
    video = { bvid: archive.bvid, title: stripHtml(archive.title ?? '') };
    const cover = fixUrl(archive.cover);
    if (cover !== undefined) video.cover = cover;
  }
  return {
    id,
    type,
    pubTimeText: stripHtml(author?.pub_time ?? ''),
    text: stripHtml(desc),
    author: {
      mid: toInt(author?.mid) ?? 0,
      name: stripHtml(author?.name ?? ''),
      ...(fixUrl(author?.face) !== undefined ? { face: fixUrl(author.face) } : {}),
    },
    ...(video !== undefined ? { video } : {}),
    url: video !== undefined ? videoUrl(video.bvid) : `https://t.bilibili.com/${id}`,
  };
}

/**
 * 归一化 DASH 流（契约 `Stream`）。
 * @param {any} raw - `dash.video[]` / `dash.audio[]` 条目。
 * @param {'video' | 'audio'} kind - 类型。
 * @param {Map<number, string>} acceptLabels - 清晰度 id → 文案。
 * @returns {Record<string, any> | null} Stream。
 */
function normalizeDashStream(raw, kind, acceptLabels) {
  const url = fixUrl(raw?.baseUrl ?? raw?.base_url);
  if (url === undefined) return null;
  const bandwidth = toInt(raw?.bandwidth);
  const id = toInt(raw?.id) ?? 0;
  const backups = Array.isArray(raw?.backupUrl)
    ? raw.backupUrl
    : Array.isArray(raw?.backup_url)
      ? raw.backup_url
      : [];
  const backupUrls = backups.map(fixUrl).filter((entry) => entry !== undefined);
  /** @type {string} */
  let label;
  if (kind === 'video') {
    label = acceptLabels.get(id) ?? QUALITY_LABELS[id] ?? String(id);
  } else {
    label = bandwidth !== undefined && bandwidth > 0 ? `${Math.round(bandwidth / 1000)} kbps` : String(id);
  }
  /** @type {Record<string, any>} */
  const stream = { id: String(id), label, url };
  put(stream, 'codec', typeof raw?.codecs === 'string' ? raw.codecs : undefined);
  put(stream, 'width', toInt(raw?.width));
  put(stream, 'height', toInt(raw?.height));
  if (backupUrls.length > 0) stream.backupUrls = backupUrls;
  return stream;
}

/**
 * 归一化一组 DASH 流：去重（同一清晰度只留第一路编码），音频按带宽从高到低排。
 * @param {any[]} list - `dash.video[]` / `dash.audio[]`。
 * @param {'video' | 'audio'} kind - 类型。
 * @param {Map<number, string>} acceptLabels - 清晰度 id → 文案。
 * @returns {Array<Record<string, any>>} Stream[]。
 */
function normalizeDashStreams(list, kind, acceptLabels) {
  /**
   * AVC 编码优先（兼容性最好，浏览器/ffmpeg 都能直接处理）。
   * @param {any} raw - 原始流。
   * @returns {number} 排序权重。
   */
  const avcRank = (raw) => (String(raw?.codecs ?? '').startsWith('avc') ? 1 : 0);
  const ordered = kind === 'audio'
    ? [...list].sort((left, right) => (toInt(right?.id) ?? 0) - (toInt(left?.id) ?? 0))
    : [...list].sort((left, right) => {
      const diff = (toInt(right?.id) ?? 0) - (toInt(left?.id) ?? 0);
      return diff !== 0 ? diff : avcRank(right) - avcRank(left);
    });
  /** @type {Array<Record<string, any>>} */
  const streams = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const raw of ordered) {
    const stream = normalizeDashStream(raw, kind, acceptLabels);
    if (stream === null || seen.has(stream.id)) continue;
    seen.add(stream.id);
    streams.push(stream);
  }
  return streams;
}

/**
 * 归一化 durl 分片（契约 `playurl().durl`）。
 * @param {any} raw - `durl[]` 条目。
 * @param {number} index - 序号兜底。
 * @returns {{ order: number, bytes: number, url: string } | null} 分片。
 */
function normalizeDurl(raw, index) {
  const url = fixUrl(raw?.url);
  if (url === undefined) return null;
  return {
    order: toInt(raw?.order) ?? index + 1,
    bytes: toInt(raw?.size) ?? 0,
    url,
  };
}

/**
 * 造 B 站 API 客户端。
 * @param {{ http: object, cookies?: object, wbi?: object, appApi?: object, ffmpeg?: object,
 *   config?: Record<string, any>, logger?: { warn?: Function, info?: Function },
 *   now?: () => number, credentials?: object }} [options] - 依赖。
 * @returns {Record<string, Function>} API 客户端（方法见契约 §9）。
 */
export function createBiliApi(options = {}) {
  const http = options.http;
  const cookies = options.cookies;
  const wbi = options.wbi;
  const appApi = options.appApi;
  const ffmpeg = options.ffmpeg;
  const config = options.config ?? {};
  const logger = options.logger;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const credentials = options.credentials;

  const maxListed = toInt(config.maxListedItems) !== undefined && toInt(config.maxListedItems) > 0
    ? Math.trunc(config.maxListedItems)
    : DEFAULT_MAX_ITEMS;

  /**
   * 记一条告警。
   * @param {string} message - 文本。
   */
  function warn(message) {
    try {
      logger?.warn?.(message);
    } catch {
      // 忽略。
    }
  }

  /**
   * 把条数收进 [1, maxListed]。
   * @param {unknown} value - 用户传入。
   * @param {number} [fallback] - 缺省值。
   * @returns {number} 条数。
   */
  function clampCount(value, fallback = maxListed) {
    const number = toInt(value);
    const base = number !== undefined && number > 0 ? number : fallback;
    return Math.max(1, Math.min(base, maxListed));
  }

  /**
   * 取 Cookie 头（罐不可用时为空串，公开接口照常工作）。
   * @returns {Promise<string>} Cookie 头。
   */
  async function cookieHeader() {
    if (cookies === null || cookies === undefined || typeof cookies.header !== 'function') return '';
    try {
      const value = await cookies.header();
      return typeof value === 'string' ? value : '';
    } catch (error) {
      warn(`[bilibili] 读取 Cookie 失败：${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  }

  /**
   * 造业务错误。
   * @param {number} code - B 站业务码。
   * @param {string} message - B 站 message。
   * @param {string} context - 上下文。
   * @returns {BiliError} 错误。
   */
  function apiError(code, message, context) {
    /** @type {BiliError} */
    let error;
    if (Number(code) === -101) {
      error = authRequired(context);
    } else {
      error = fromApiCode(code, message, { context });
    }
    /** @type {any} */ (error).apiCode = Number(code);
    return error;
  }

  /**
   * GET 一个 B 站 JSON 接口，带 Cookie，`code !== 0` 抛错。
   * @param {string} url - 地址。
   * @param {{ context?: string, headers?: Record<string, string>, retries?: number }} [requestOptions] - 选项。
   * @returns {Promise<any>} `data`。
   */
  async function getData(url, requestOptions = {}) {
    const cookie = await cookieHeader();
    /** @type {Record<string, string>} */
    const headers = { ...(cookie === '' ? {} : { cookie }), ...requestOptions.headers };
    const body = await http.getJson(url, { headers, retries: requestOptions.retries });
    const code = toInt(body?.code);
    if (code !== undefined && code !== 0) {
      throw apiError(code, typeof body?.message === 'string' ? body.message : '', requestOptions.context ?? 'B 站接口');
    }
    return body?.data;
  }

  /**
   * 取视频详情（`x/web-interface/view`）。
   * @param {string} bvid - BV 号。
   * @returns {Promise<any>} view 的 data。
   */
  async function fetchView(bvid) {
    const data = await getData(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { context: '视频信息' });
    if (data === null || typeof data !== 'object') {
      throw new BiliError('视频不存在、已删除或地区限制。', {
        code: CODES.NOT_FOUND,
        hint: '确认 BV 号/链接是否完整；部分视频仅登录或大会员可见。',
      });
    }
    return data;
  }

  /**
   * 跟随 b23.tv 短链拿到最终视频地址。
   * @param {string} shortUrl - `https://b23.tv/xxxx`。
   * @returns {Promise<{ bvid: string, aid?: number }>} 解析结果。
   */
  async function followShortLink(shortUrl) {
    /** @type {any} */
    let response;
    try {
      response = await http.open(shortUrl, {});
    } catch (cause) {
      throw new BiliError(`短链解析失败：${shortUrl}`, {
        code: CODES.NOT_FOUND,
        hint: '短链可能已失效；直接给 BV 号或完整视频链接更稳。',
        cause,
      });
    }
    const finalUrl = typeof response?.url === 'string' ? response.url : '';
    let bvid = findBvid(finalUrl);
    // 少数情况下拿不到最终 URL（代理/落地页），退一步从 HTML 里找 BV 号。
    if (bvid === undefined && response?.body !== null && response?.body !== undefined) {
      try {
        const reader = response.body.getReader();
        /** @type {Uint8Array[]} */
        const chunks = [];
        let total = 0;
        while (total < 65536) {
          const step = await reader.read();
          if (step.done === true) break;
          chunks.push(step.value);
          total += step.value.length;
        }
        try {
          await reader.cancel();
        } catch {
          // 忽略。
        }
        const buffer = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          buffer.set(chunk, offset);
          offset += chunk.length;
        }
        bvid = findBvid(new TextDecoder('utf-8', { fatal: false }).decode(buffer));
      } catch {
        // 忽略。
      }
    }
    if (bvid === undefined) {
      throw new BiliError(`短链没有指向视频：${shortUrl}`, {
        code: CODES.NOT_FOUND,
        hint: '确认这是视频短链；直接给 BV 号或完整视频链接更稳。',
      });
    }
    /** @type {{ bvid: string, aid?: number }} */
    const result = { bvid };
    try {
      result.aid = aidFromBv(bvid);
    } catch {
      // BV 解不出 aid 就交给 view 接口。
    }
    return result;
  }

  /**
   * 解析视频目标（含短链），拿 `{ bvid, aid }`。
   * @param {unknown} target - BV/av/链接/短链。
   * @returns {Promise<{ bvid: string, aid?: number, page: number }>} 解析结果。
   */
  async function identify(target) {
    const parsed = resolveTargetInput(target);
    if (parsed.shortUrl !== undefined) {
      const resolved = await followShortLink(parsed.shortUrl);
      return { bvid: resolved.bvid, ...(resolved.aid !== undefined ? { aid: resolved.aid } : {}), page: parsed.page };
    }
    if (parsed.bvid === undefined) {
      throw invalidArgument('无法从目标里解析出 BV 号。');
    }
    return { bvid: parsed.bvid, ...(parsed.aid !== undefined ? { aid: parsed.aid } : {}), page: parsed.page };
  }

  /**
   * 解析目标并取视频详情。
   * @param {unknown} target - 视频目标。
   * @returns {Promise<{ identity: { bvid: string, aid?: number, page: number }, view: any, parts: Array<any> }>}
   *   identity、view 与归一化分P。
   */
  async function loadVideo(target) {
    const identity = await identify(target);
    const view = await fetchView(identity.bvid);
    return { identity, view, parts: normalizeParts(view) };
  }

  /**
   * 取视频标签（失败不致命，视频信息照常返回）。
   * @param {string} bvid - BV 号。
   * @returns {Promise<Array<{ id: number, name: string, count?: number }>>} 标签。
   */
  async function fetchTags(bvid) {
    try {
      const data = await getData(`${API}/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`, {
        context: '视频标签',
        retries: 1,
      });
      if (!Array.isArray(data)) return [];
      return data.map(normalizeTag).filter((tag) => tag !== null);
    } catch (error) {
      warn(`[bilibili] 读取标签失败（${bvid}）：${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * 当前登录用户的 mid（未登录抛 `BILI_AUTH_REQUIRED`）。
   * @returns {Promise<number>} mid。
   */
  async function selfMid() {
    const user = await api.nav();
    if (user.loggedIn !== true || user.mid === undefined) {
      throw authRequired('读取个人数据');
    }
    return user.mid;
  }

  /**
   * App 混合流搜索：取一页并按 `goto` 过滤（该端点 page 参数不可靠，不做翻页）。
   * @param {{ keyword: string, type: string, order: string, page: number, size: number }} query - 条件。
   * @returns {Promise<{ items: Array<any>, hasMore: boolean }>} 结果。
   */
  async function searchApp(query) {
    const { keyword, type, order, page, size } = query;
    const cookie = await cookieHeader();
    const gotos = TYPE_GOTOS[type];
    /** @type {Array<any>} */
    const collected = [];
    /** @type {Set<string>} */
    const seen = new Set();
    let appPage = page;
    let lastRawCount = 0;
    let hasMore = false;
    for (let fetchIndex = 0; fetchIndex < APP_SEARCH_MAX_FETCHES; fetchIndex += 1) {
      const data = await appApi.search({
        keyword,
        search_type: SEARCH_TYPES[type],
        order,
        page: appPage,
        page_size: APP_SEARCH_PAGE_SIZE,
      }, { cookie });
      const rawItems = Array.isArray(data?.item) ? data.item : [];
      lastRawCount = rawItems.length;
      for (const raw of rawItems) {
        if (!gotos.has(String(raw?.goto ?? ''))) continue;
        const item = appSearchItem(raw, type);
        if (item === null) continue;
        const key = item.url !== '' ? String(item.url) : `${item.title}|${item.aid ?? item.mid ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(item);
        if (collected.length >= size) break;
      }
      hasMore = lastRawCount >= APP_SEARCH_FULL_PAGE;
      if (collected.length >= size || !hasMore) break;
      appPage += 1;
    }
    return { items: collected.slice(0, size), hasMore: hasMore || collected.length > size };
  }

  /**
   * Web WBI 搜索（带签名的 `x/web-interface/wbi/search/type`）。
   * @param {{ keyword: string, type: string, order: string, page: number, size: number }} query - 条件。
   * @returns {Promise<{ items: Array<any>, total?: number, hasMore: boolean }>} 结果。
   */
  async function searchWeb(query) {
    const { keyword, type, order, page, size } = query;
    const signed = await wbi.sign({
      search_type: SEARCH_TYPES[type],
      keyword,
      page,
      page_size: size,
      order,
    });
    const data = await getData(`${API}/x/web-interface/wbi/search/type?${signed}`, {
      context: 'Web 搜索',
      retries: 1,
    });
    const raw = Array.isArray(data?.result) ? data.result : [];
    /** @type {Array<any>} */
    const items = [];
    /** @type {Set<string>} */
    const seen = new Set();
    for (const entry of raw) {
      const item = webSearchItem(entry, type);
      if (item === null || item.url === '') continue;
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      items.push(item);
    }
    const total = toInt(data?.numResults);
    const numPages = toInt(data?.numPages);
    const hasMore = total !== undefined
      ? page * size < total
      : numPages !== undefined
        ? page < numPages
        : raw.length >= size;
    return { items: items.slice(0, size), ...(total !== undefined ? { total } : {}), hasMore };
  }

  /**
   * 组装搜索返回（契约 §9 `search`）。
   * @param {string} keyword - 关键词。
   * @param {string} type - 类型。
   * @param {number} page - 页码。
   * @param {number} pageSize - 每页条数。
   * @param {string} source - 数据来源（`app` / `web`）。
   * @param {{ items: Array<any>, total?: number, hasMore: boolean }} result - 搜索结果。
   * @returns {Record<string, any>} 归一化搜索结果。
   */
  function searchResult(keyword, type, page, pageSize, source, result) {
    return {
      keyword,
      type,
      page,
      pageSize,
      hasMore: result.hasMore === true,
      ...(result.total !== undefined ? { total: result.total } : {}),
      source,
      items: result.items,
    };
  }

  /**
   * 播放地址请求（WBI 签名 + Cookie）。
   * @param {Record<string, unknown>} params - playurl 参数。
   * @param {string} referer - Referer。
   * @returns {Promise<any>} `data`。
   */
  async function requestPlayurl(params, referer) {
    const signed = await wbi.sign(params);
    return getData(`${API}/x/player/wbi/playurl?${signed}`, { context: '播放地址', headers: { referer } });
  }

  /** @type {Record<string, Function>} */
  const api = {
    /**
     * 当前登录态（未登录不抛错，`loggedIn:false`）。
     * @returns {Promise<Record<string, any>>} 登录信息。
     */
    async nav() {
      const cookie = await cookieHeader();
      const body = await http.getJson(`${API}/x/web-interface/nav`, {
        headers: cookie === '' ? {} : { cookie },
      });
      const code = toInt(body?.code);
      if (code !== undefined && code !== 0 && code !== -101) {
        throw apiError(code, typeof body?.message === 'string' ? body.message : '', '账号信息');
      }
      const data = body?.data;
      if (data === null || typeof data !== 'object' || data.isLogin !== true) {
        return { loggedIn: false };
      }
      const level = toInt(data.level_info?.current_level ?? data.level);
      const vipStatus = toInt(data.vipStatus ?? data.vip?.status ?? data.vip?.vipStatus) ?? 0;
      const vipLabel = stripHtml(data.vip_label?.text ?? data.vip?.label?.text ?? '');
      /** @type {Record<string, any>} */
      const result = {
        loggedIn: true,
        ...(toInt(data.mid) !== undefined ? { mid: toInt(data.mid) } : {}),
        ...(typeof data.uname === 'string' ? { uname: data.uname } : {}),
        ...(fixUrl(data.face) !== undefined ? { face: fixUrl(data.face) } : {}),
        ...(level !== undefined ? { level } : {}),
        ...(toInt(data.coins ?? data.wallet?.coin_balance) !== undefined
          ? { coins: toInt(data.coins ?? data.wallet?.coin_balance) }
          : {}),
        vip: { status: vipStatus, ...(vipLabel !== '' ? { label: vipLabel } : {}) },
        ...(toInt(data.following) !== undefined ? { following: toInt(data.following) } : {}),
        ...(toInt(data.follower) !== undefined ? { follower: toInt(data.follower) } : {}),
      };
      return result;
    },

    /**
     * 综合状态（登录/Cookie/WBI/ffmpeg），诊断用。
     * @returns {Promise<Record<string, any>>} 状态。
     */
    async status() {
      /** @type {Record<string, any>} */
      let navInfo = { loggedIn: false };
      try {
        navInfo = await api.nav();
      } catch (error) {
        warn(`[bilibili] 读取登录态失败：${error instanceof Error ? error.message : String(error)}`);
      }
      /** @type {{ configured: boolean, source?: string, names: string[] }} */
      let cookieInfo = { configured: false, names: [] };
      if (cookies !== null && cookies !== undefined && typeof cookies.status === 'function') {
        try {
          cookieInfo = await cookies.status();
        } catch (error) {
          warn(`[bilibili] 读取 Cookie 状态失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      /** @type {{ cached: boolean, fetchedAt?: number }} */
      let wbiInfo = { cached: false };
      if (wbi !== null && wbi !== undefined && typeof wbi.status === 'function') {
        try {
          const wbiStatus = await wbi.status();
          wbiInfo = {
            cached: wbiStatus?.cached === true,
            ...(toInt(wbiStatus?.fetchedAt) !== undefined ? { fetchedAt: toInt(wbiStatus.fetchedAt) } : {}),
          };
        } catch {
          // 忽略。
        }
      }
      /** @type {Record<string, any>} */
      const result = {
        loggedIn: navInfo.loggedIn === true,
        cookie: {
          configured: cookieInfo.configured === true,
          ...(typeof cookieInfo.source === 'string' && cookieInfo.source !== '' ? { source: cookieInfo.source } : {}),
        },
        wbi: wbiInfo,
      };
      if (navInfo.loggedIn === true) {
        result.user = {
          mid: navInfo.mid ?? 0,
          uname: navInfo.uname ?? '',
          ...(navInfo.face !== undefined ? { face: navInfo.face } : {}),
          level: navInfo.level ?? 0,
        };
      }
      if (ffmpeg !== null && ffmpeg !== undefined && typeof ffmpeg.detect === 'function') {
        try {
          result.ffmpeg = await ffmpeg.detect();
        } catch (error) {
          result.ffmpeg = { available: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      return result;
    },

    /**
     * 解析视频目标为 `{ bvid, aid, page, cid, title, durationSec }`。
     * @param {unknown} target - BV/av/链接/短链。
     * @returns {Promise<Record<string, any>>} 解析结果。
     */
    async resolveTarget(target) {
      const { identity, view, parts } = await loadVideo(target);
      const { part, page } = pickPart(parts, identity.page);
      return {
        bvid: String(view.bvid),
        aid: toInt(view.aid) ?? 0,
        page,
        ...(part.cid > 0 ? { cid: part.cid } : {}),
        title: stripHtml(view.title ?? ''),
        durationSec: part.durationSec,
      };
    },

    /**
     * 搜索。
     * @param {{ keyword?: string, type?: string, order?: string, page?: number, pageSize?: number }} [args] - 参数。
     * @returns {Promise<Record<string, any>>} 搜索结果。
     */
    async search(args = {}) {
      const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : '';
      if (keyword === '') throw invalidArgument('keyword 不能为空。');
      const type = typeof args.type === 'string' && args.type !== '' ? args.type : 'video';
      if (SEARCH_TYPES[type] === undefined) {
        throw invalidArgument(`不支持的搜索类型：${type}（可选 ${Object.keys(SEARCH_TYPES).join('/')}）。`);
      }
      const order = typeof args.order === 'string' && args.order !== '' ? args.order : 'totalrank';
      if (!SEARCH_ORDERS.has(order)) {
        throw invalidArgument(`不支持的排序：${order}（可选 ${[...SEARCH_ORDERS].join('/')}）。`);
      }
      const page = pageNumber(args.page);
      const pageSize = clampCount(args.pageSize);
      const query = { keyword, type, order, page, size: pageSize };

      // Web WBI 搜索是唯一「按类型 + 可翻页」的稳定入口；App 混合流作为降级
      // （实测 App 的 page 参数不可靠，且 article/bangumi/live 每页只有 0–1 条）。
      /** @type {unknown} */
      let webError;
      try {
        const webResult = await searchWeb(query);
        if (webResult.items.length > 0) return searchResult(keyword, type, page, pageSize, 'web', webResult);
      } catch (error) {
        webError = error;
        warn(`[bilibili] Web 搜索失败，改用 App 搜索：${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const appResult = await searchApp(query);
        return searchResult(keyword, type, page, pageSize, 'app', appResult);
      } catch (error) {
        throw webError ?? error;
      }
    },

    /**
     * 视频信息（含分P与标签）。
     * @param {{ target?: unknown, page?: number }} [args] - 参数。
     * @returns {Promise<{ video: Record<string, any>, parts: Array<any>, tags: Array<any> }>} 视频。
     */
    async video(args = {}) {
      const { view, parts } = await loadVideo(args.target);
      // 分P 列表全量返回，不按 page 过滤；但越界页码要报参数错误（避免用户以为换集成功）。
      if (args.page !== undefined && args.page !== null && args.page !== '') {
        const wanted = pageNumber(args.page);
        if (wanted > parts.length) {
          throw invalidArgument(`page=${wanted} 超出视频分P数量（共 ${parts.length} 集）。`);
        }
      }
      const tags = await fetchTags(String(view.bvid));
      const video = normalizeVideo(view, parts, tags);
      return { video, parts, tags };
    },

    /**
     * UP 主信息与投稿列表。
     * @param {{ mid?: unknown, includeVideos?: boolean, limit?: number }} [args] - 参数。
     * @returns {Promise<{ user: Record<string, any>, videos: Array<any> }>} 用户与投稿。
     */
    async user(args = {}) {
      const mid = toInt(args.mid);
      if (mid === undefined || mid <= 0) throw invalidArgument('mid 必须是正整数。');
      const data = await getData(`${API}/x/web-interface/card?mid=${mid}`, { context: '用户信息' });
      const card = data?.card ?? {};
      const user = normalizeUser(card, data);
      /** @type {Array<any>} */
      let videos = [];
      if (args.includeVideos !== false) {
        const limit = clampCount(args.limit);
        const cookie = await cookieHeader();
        const request = () => appApi.spaceArchive({ vmid: mid, pn: 1, ps: limit }, { cookie });
        try {
          videos = normalizeSpaceArchive(await request(), limit);
        } catch (error) {
          const code = /** @type {any} */ (error)?.apiCode;
          if (code === -3 || code === -799) {
            warn(`[bilibili] 投稿列表返回 ${code}，重试一次…`);
            try {
              videos = normalizeSpaceArchive(await request(), limit);
            } catch (retryError) {
              warn(`[bilibili] 投稿列表仍失败，返回空列表：${retryError instanceof Error ? retryError.message : String(retryError)}`);
              videos = [];
            }
          } else {
            warn(`[bilibili] 读取投稿列表失败，返回空列表：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      return { user, videos };
    },

    /**
     * 排行榜。
     * @param {{ area?: string, type?: string, limit?: number }} [args] - 参数。
     * @returns {Promise<{ area: string, name: string, items: Array<any> }>} 榜单。
     */
    async ranking(args = {}) {
      const area = typeof args.area === 'string' && args.area !== '' ? args.area : 'all';
      const entry = RANKING_AREAS[area];
      if (entry === undefined) {
        throw invalidArgument(`不支持的分区：${area}（可选 ${Object.keys(RANKING_AREAS).join('/')}）。`);
      }
      const type = typeof args.type === 'string' && args.type !== '' ? args.type : 'all';
      const limit = clampCount(args.limit);
      /** @type {any} */
      let data;
      try {
        data = await getData(`${API}/x/web-interface/ranking/v2?rid=${entry.rid}&type=${encodeURIComponent(type)}`, {
          context: `排行榜（${entry.name}）`,
        });
      } catch (error) {
        // 资讯/综艺分区在 2026-11 实测返回 -400（排行榜接口已不支持这两个 rid）。
        if (entry.rid === 202 || entry.rid === 71) {
          throw new BiliError(`B 站排行榜当前不支持「${entry.name}」分区（接口返回参数错误）。`, {
            code: CODES.NOT_FOUND,
            hint: '改用 bili_popular（热门/每周必看），或用 area=all 看全站排行。',
          });
        }
        throw error;
      }
      const list = Array.isArray(data?.list) ? data.list : [];
      return {
        area,
        name: entry.name,
        items: list.slice(0, limit).map(normalizeRankingItem),
      };
    },

    /**
     * 热门 / 每周必看。
     * @param {{ kind?: string, limit?: number }} [args] - 参数。
     * @returns {Promise<{ kind: string, items: Array<any> }>} 列表。
     */
    async popular(args = {}) {
      const kind = typeof args.kind === 'string' && args.kind !== '' ? args.kind : 'popular';
      if (kind !== 'popular' && kind !== 'weekly') {
        throw invalidArgument(`kind 只能是 popular 或 weekly（收到 ${kind}）。`);
      }
      const limit = clampCount(args.limit);
      if (kind === 'weekly') {
        try {
          const seriesList = await getData(`${API}/x/web-interface/popular/series/list`, { context: '每周必看' });
          const list = Array.isArray(seriesList?.list) ? seriesList.list : [];
          const latest = toInt(list[0]?.number);
          if (latest === undefined) throw new BiliError('每周必看列表为空。', { code: CODES.API });
          const data = await getData(`${API}/x/web-interface/popular/series/one?number=${latest}`, {
            context: '每周必看',
          });
          const items = Array.isArray(data?.list) ? data.list : [];
          if (items.length === 0) throw new BiliError('每周必看没有条目。', { code: CODES.API });
          return { kind: 'weekly', items: items.slice(0, limit).map(normalizeRankingItem) };
        } catch (error) {
          warn(`[bilibili] 每周必看失败（${error instanceof Error ? error.message : String(error)}），回退普通热门。`);
        }
      }
      const data = await getData(`${API}/x/web-interface/popular?ps=${limit}&pn=1`, { context: '热门' });
      const list = Array.isArray(data?.list) ? data.list : [];
      return { kind: 'popular', items: list.slice(0, limit).map(normalizeRankingItem) };
    },

    /**
     * 热搜词。
     * @param {{ limit?: number }} [args] - 参数。
     * @returns {Promise<{ items: Array<{ keyword: string, showName?: string, icon?: string }> }>} 热搜。
     */
    async hotwords(args = {}) {
      const limit = clampCount(args.limit);
      const data = await getData(`${API}/x/web-interface/search/square?limit=${limit}`, { context: '热搜' });
      const list = Array.isArray(data?.trending?.list) ? data.trending.list : [];
      /** @type {Array<{ keyword: string, showName?: string, icon?: string }>} */
      const items = [];
      for (const entry of list) {
        if (items.length >= limit) break;
        const keyword = stripHtml(entry?.keyword ?? '');
        if (keyword === '') continue;
        items.push({
          keyword,
          ...(stripHtml(entry?.show_name ?? '') !== '' ? { showName: stripHtml(entry.show_name) } : {}),
          ...(fixUrl(entry?.icon) !== undefined ? { icon: fixUrl(entry.icon) } : {}),
        });
      }
      return { items };
    },

    /**
     * 评论。
     * @param {{ target?: unknown, page?: number, sort?: string, includeReplies?: boolean, limit?: number }} [args] - 参数。
     * @returns {Promise<{ count: number, page: number, hasMore: boolean, items: Array<any> }>} 评论。
     */
    async comments(args = {}) {
      const { view } = await loadVideo(args.target);
      const aid = toInt(view?.aid);
      if (aid === undefined) throw new BiliError('视频没有 aid，无法读取评论。', { code: CODES.API });
      const sort = typeof args.sort === 'string' && args.sort !== '' ? args.sort : 'hot';
      if (sort !== 'hot' && sort !== 'time') {
        throw invalidArgument(`sort 只能是 hot 或 time（收到 ${sort}）。`);
      }
      const page = pageNumber(args.page);
      const limit = clampCount(args.limit);
      const data = await getData(
        `${API}/x/v2/reply?type=1&oid=${aid}&pn=${page}&ps=${limit}&sort=${sort === 'hot' ? 2 : 0}`,
        { context: '评论' },
      );
      const replies = Array.isArray(data?.replies) ? data.replies : [];
      const count = toInt(data?.page?.count ?? data?.count) ?? replies.length;
      const items = replies.slice(0, limit).map((raw) => normalizeComment(raw, args.includeReplies !== false));
      return { count, page, hasMore: page * limit < count, items };
    },

    /**
     * 弹幕（第 1 段，由 `lib/format.js` 做 protobuf 解析）。
     * @param {{ target?: unknown, page?: number, limit?: number }} [args] - 参数。
     * @returns {Promise<{ count: number, sampled: number, distribution: Array<{ minute: number, count: number }>, items: Array<any> }>} 弹幕。
     */
    async danmaku(args = {}) {
      const { identity, view, parts } = await loadVideo(args.target);
      // 工具层的 page 参数优先；`resolveTarget` 解析出的 page（来自 URL `?p=`）兜底。
      const { part } = pickPart(parts, args.page ?? identity.page);
      const cid = part.cid > 0 ? part.cid : toInt(view?.cid) ?? 0;
      if (cid <= 0) {
        throw new BiliError('视频没有可用的 cid，无法读取弹幕。', {
          code: CODES.API,
          hint: '换一集/分P再试；也可能是视频已被删除。',
        });
      }
      const limit = clampCount(args.limit);
      const cookie = await cookieHeader();
      const url = `${API}/x/v2/dm/web/seg.so?type=1&oid=${cid}&pid=${toInt(view?.aid) ?? 0}`
        + `&segment_index=${DANMAKU_SEGMENT}`;
      const bytes = await http.getBytes(url, {
        headers: {
          ...(cookie === '' ? {} : { cookie }),
          'accept-encoding': 'identity',
          referer: identity.bvid !== undefined ? videoUrl(identity.bvid) : 'https://www.bilibili.com/',
        },
      });
      const parsed = parseDanmakuSegments(bytes);
      const total = toInt(view?.stat?.danmaku);
      return {
        count: total ?? parsed.length,
        sampled: parsed.length,
        distribution: buildDistribution(parsed),
        items: parsed.slice(0, limit),
      };
    },

    /**
     * 番剧信息。
     * @param {{ seasonId?: unknown, epId?: unknown }} [args] - 参数。
     * @returns {Promise<{ season: Record<string, any> }>} 番剧。
     */
    async bangumi(args = {}) {
      const seasonId = toInt(args.seasonId);
      const epId = toInt(args.epId);
      const hasSeason = seasonId !== undefined && seasonId > 0;
      const hasEp = epId !== undefined && epId > 0;
      if (!hasSeason && !hasEp) throw invalidArgument('seasonId 或 epId 至少给一个。');
      const query = hasSeason ? `season_id=${seasonId}` : `ep_id=${epId}`;
      const body = await (async () => {
        const cookie = await cookieHeader();
        const raw = await http.getJson(`${API}/pgc/view/web/season?${query}`, {
          headers: cookie === '' ? {} : { cookie },
        });
        const code = toInt(raw?.code);
        if (code !== undefined && code !== 0) {
          throw apiError(code, typeof raw?.message === 'string' ? raw.message : '', '番剧信息');
        }
        return raw;
      })();
      // 番剧接口把数据放在 `result`（不是 `data`）。
      const data = body?.result ?? body?.data;
      if (data === null || typeof data !== 'object' || data.title === undefined) {
        throw new BiliError('番剧不存在、已下架或地区限制。', {
          code: CODES.NOT_FOUND,
          hint: '确认 seasonId/epId 正确；部分番剧仅港澳台或大会员可见。',
        });
      }
      return { season: normalizeBangumi(data) };
    },

    /**
     * 直播间信息与主播。
     * @param {{ roomId?: unknown }} [args] - 参数。
     * @returns {Promise<{ room: Record<string, any>, anchor?: Record<string, any> }>} 直播间。
     */
    async live(args = {}) {
      const roomId = toInt(args.roomId);
      if (roomId === undefined || roomId <= 0) throw invalidArgument('roomId 必须是正整数。');
      const data = await getData(`${LIVE_API}/room/v1/Room/get_info?room_id=${roomId}`, { context: '直播间信息' });
      const room = normalizeRoom(data, roomId);
      /** @type {Record<string, any> | undefined} */
      let anchor;
      // 契约里的 getInfoByRoom 目前实测返回 1000003，退回旧的 get_anchor_in_room。
      try {
        const detail = await getData(`${LIVE_API}/room/v1/Room/getInfoByRoom?room_id=${roomId}`, {
          context: '直播间详情',
          retries: 0,
        });
        const base = detail?.anchor_info?.base_info;
        if (base !== null && typeof base === 'object') {
          anchor = normalizeLiveAnchor({ uname: base.uname, face: base.face, uid: base.uid ?? data?.uid });
        }
      } catch {
        // 忽略，走下面的兜底。
      }
      if (anchor === undefined) {
        try {
          const alt = await getData(`${LIVE_API}/live_user/v1/UserInfo/get_anchor_in_room?roomid=${roomId}`, {
            context: '主播信息',
            retries: 0,
          });
          const info = alt?.info;
          if (info !== null && typeof info === 'object') {
            anchor = normalizeLiveAnchor({ uname: info.uname, face: info.face, uid: info.uid });
          }
        } catch {
          // 拿不到主播信息不算错误。
        }
      }
      return anchor === undefined ? { room } : { room, anchor };
    },

    /**
     * 播放地址（DASH 优先，durl 兜底）。
     * @param {{ target?: unknown, page?: number, quality?: string, audioOnly?: boolean }} [args] - 参数。
     * @returns {Promise<Record<string, any>>} 播放信息。
     */
    async playurl(args = {}) {
      const qualityKey = typeof args.quality === 'string' && args.quality !== '' ? args.quality : 'best';
      let qn = QUALITY_QN[qualityKey];
      if (qn === undefined) {
        const numeric = toInt(qualityKey);
        qn = numeric !== undefined ? numeric : undefined;
      }
      if (qn === undefined) {
        throw invalidArgument(`不支持的清晰度：${qualityKey}（可选 best/1080/720/480/360）。`);
      }
      const audioOnly = args.audioOnly === true;
      // 下载器在没有 ffmpeg 时需要用整段 MP4（durl）兜底：此时只要 fnval=1 的响应。
      const durlOnly = args.durlOnly === true;
      const { identity, view, parts } = await loadVideo(args.target);
      const { part, page } = pickPart(parts, args.page ?? identity.page);
      const cid = part.cid > 0 ? part.cid : toInt(view?.cid) ?? 0;
      const bvid = String(view?.bvid ?? identity.bvid ?? '');
      if (cid <= 0) throw new BiliError('视频没有可用的 cid，无法获取播放地址。', { code: CODES.API });
      const referer = videoUrl(bvid);
      const baseParams = { bvid, cid, qn, fnval: durlOnly ? 1 : 4048, fnver: 0, fourqn: 1 };
      const data = await requestPlayurl(baseParams, referer);

      /** @type {Map<number, string>} */
      const acceptLabels = new Map();
      const acceptQuality = Array.isArray(data?.accept_quality) ? data.accept_quality : [];
      const acceptDescription = Array.isArray(data?.accept_description) ? data.accept_description : [];
      for (let index = 0; index < acceptQuality.length; index += 1) {
        const id = toInt(acceptQuality[index]);
        const label = typeof acceptDescription[index] === 'string' ? acceptDescription[index] : '';
        if (id !== undefined && label !== '') acceptLabels.set(id, label);
      }
      const accept = acceptQuality
        .map((raw) => {
          const id = toInt(raw);
          return id === undefined
            ? null
            : { id, label: acceptLabels.get(id) ?? QUALITY_LABELS[id] ?? String(id) };
        })
        .filter((entry) => entry !== null);

      const dash = data?.dash;
      /** @type {Array<any>} */
      let videoStreams = [];
      /** @type {Array<any>} */
      let audioStreams = [];
      if (dash !== null && typeof dash === 'object') {
        if (Array.isArray(dash.video)) videoStreams = normalizeDashStreams(dash.video, 'video', acceptLabels);
        if (Array.isArray(dash.audio)) audioStreams = normalizeDashStreams(dash.audio, 'audio', acceptLabels);
      }

      /** @type {Array<{ order: number, bytes: number, url: string }>} */
      let durl = Array.isArray(data?.durl)
        ? data.durl.map((raw, index) => normalizeDurl(raw, index)).filter((entry) => entry !== null)
        : [];

      // durlOnly：只要整段 MP4，不解析 DASH；拿不到就直接给可执行的安装 ffmpeg 提示。
      if (durlOnly && durl.length === 0) {
        throw new BiliError('B 站没有为这个视频提供整段 MP4（durl）。', {
          code: CODES.FFMPEG_MISSING,
          hint: '安装 ffmpeg 后重试（配置 ffmpegPath 或加入 PATH），或换更低的清晰度、或在登录后重试。',
        });
      }

      // DASH 不完整时退 durl（fnval=1）；audioOnly 没有音轨则直接报可读错误。
      if (audioOnly && audioStreams.length === 0) {
        throw new BiliError('这个视频没有可用的 DASH 音轨。', {
          code: CODES.API,
          hint: '可能是版权/大会员限制；试试不带 audioOnly 看是否有 durl 音视频合集。',
        });
      }
      if (!audioOnly && videoStreams.length === 0 && durl.length === 0) {
        const fallback = await requestPlayurl({ ...baseParams, fnval: 1, qn }, referer);
        durl = Array.isArray(fallback?.durl)
          ? fallback.durl.map((raw, index) => normalizeDurl(raw, index)).filter((entry) => entry !== null)
          : [];
        if (durl.length === 0) {
          throw new BiliError('没有拿到可用的播放地址。', {
            code: CODES.API,
            hint: '可能需要登录（bili_login start）或大会员；也有可能是版权限制。',
          });
        }
      }

      const selectedQn = toInt(data?.quality) ?? qn;
      const firstUrl = videoStreams[0]?.url ?? audioStreams[0]?.url ?? durl[0]?.url;
      const expiresAt = (firstUrl === undefined ? undefined : deadlineFromUrl(firstUrl))
        ?? Math.floor(now() / 1000) + 7200;
      return {
        media: {
          bvid,
          cid,
          page,
          durationSec: part.durationSec,
        },
        quality: { id: selectedQn, label: acceptLabels.get(selectedQn) ?? QUALITY_LABELS[selectedQn] ?? String(selectedQn) },
        accept,
        video: audioOnly ? [] : videoStreams,
        audio: audioStreams,
        durl,
        expiresAt,
      };
    },

    /**
     * 字幕列表与正文。
     * @param {{ target?: unknown, page?: number, lang?: string }} [args] - 参数。
     * @returns {Promise<{ languages: Array<{ lan: string, lanDoc: string, url: string }>, lang?: string, lines: Array<{ fromSec: number, toSec: number, text: string }> }>} 字幕。
     */
    async subtitle(args = {}) {
      const { identity, view, parts } = await loadVideo(args.target);
      const { part } = pickPart(parts, args.page ?? identity.page);
      const cid = part.cid > 0 ? part.cid : toInt(view?.cid) ?? 0;
      const bvid = String(view?.bvid ?? identity.bvid ?? '');
      if (cid <= 0) throw new BiliError('视频没有可用的 cid，无法读取字幕。', { code: CODES.API });
      const signed = await wbi.sign({ bvid, cid });
      /** @type {any} */
      let data;
      try {
        data = await getData(`${API}/x/player/wbi/v2?${signed}`, { context: '字幕列表', headers: { referer: videoUrl(bvid) } });
      } catch (error) {
        // 未登录时部分视频直接给 -101；契约要求这种情况按「没有字幕」处理。
        if (error instanceof BiliError && error.code === CODES.AUTH_REQUIRED) {
          return { languages: [], lines: [] };
        }
        throw error;
      }
      const rawSubtitles = Array.isArray(data?.subtitle?.subtitles) ? data.subtitle.subtitles : [];
      /** @type {Array<{ lan: string, lanDoc: string, url: string }>} */
      const languages = [];
      for (const raw of rawSubtitles) {
        const url = fixUrl(raw?.subtitle_url);
        const lan = typeof raw?.lan === 'string' ? raw.lan : '';
        if (url === undefined || lan === '') continue;
        languages.push({ lan, lanDoc: stripHtml(raw?.lan_doc ?? lan), url });
      }
      if (languages.length === 0) return { languages: [], lines: [] };
      /** @type {{ lan: string, lanDoc: string, url: string } | undefined} */
      let selected;
      const wanted = typeof args.lang === 'string' ? args.lang.trim().toLowerCase() : '';
      if (wanted !== '') {
        selected = languages.find((entry) => entry.lan.toLowerCase() === wanted
          || entry.lanDoc.toLowerCase() === wanted);
        if (selected === undefined) {
          throw new BiliError(`没有 ${args.lang} 字幕。`, {
            code: CODES.NOT_FOUND,
            hint: `可用语言：${languages.map((entry) => `${entry.lan}(${entry.lanDoc})`).join('、')}。`,
          });
        }
      } else {
        selected = languages.find((entry) => entry.lan === 'zh-CN')
          ?? languages.find((entry) => entry.lan.startsWith('zh'))
          ?? languages[0];
      }
      const subtitleBody = await http.getJson(selected.url, { headers: { referer: videoUrl(bvid) } });
      const lines = Array.isArray(subtitleBody?.body)
        ? subtitleBody.body.map((raw) => ({
          fromSec: Number(raw?.from) || 0,
          toSec: Number(raw?.to) || 0,
          text: String(raw?.content ?? ''),
        }))
        : [];
      return { languages, lang: selected.lan, lines };
    },

    /**
     * 扫码登录：取二维码。
     * @returns {Promise<{ qrcodeKey: string, url: string, expiresInSec: number }>} 二维码信息。
     */
    async loginStart() {
      const body = await http.getJson(`${PASSPORT}/x/passport-login/web/qrcode/generate?source=main-fe-header`);
      const code = toInt(body?.code);
      if (code !== undefined && code !== 0) {
        throw apiError(code, typeof body?.message === 'string' ? body.message : '', '扫码登录');
      }
      const data = body?.data;
      const qrcodeKey = typeof data?.qrcode_key === 'string' ? data.qrcode_key : '';
      const url = typeof data?.url === 'string' ? data.url : '';
      if (qrcodeKey === '' || url === '') {
        throw new BiliError('登录二维码接口没有返回二维码。', {
          code: CODES.API,
          hint: '稍后重试；也可以在浏览器登录后把 Cookie 配置到凭据 BILI_COOKIE。',
        });
      }
      return { qrcodeKey, url, expiresInSec: 180 };
    },

    /**
     * 扫码登录：轮询状态。
     * @param {string} qrcodeKey - `loginStart` 返回的 key。
     * @returns {Promise<{ state: string, code: number, message: string, cookieString?: string }>} 轮询结果。
     */
    async loginPoll(qrcodeKey) {
      if (typeof qrcodeKey !== 'string' || qrcodeKey.trim() === '') {
        throw invalidArgument('qrcodeKey 不能为空（先调用 loginStart）。');
      }
      const { json: body, headers } = await http.getJsonDetailed(
        `${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey.trim())}`,
      );
      const outerCode = toInt(body?.code);
      if (outerCode !== undefined && outerCode !== 0) {
        throw apiError(outerCode, typeof body?.message === 'string' ? body.message : '', '扫码登录');
      }
      const data = body?.data ?? {};
      const code = toInt(data.code) ?? -1;
      /** @type {string} */
      let state = 'waiting';
      if (code === 0) state = 'ok';
      else if (code === 86090) state = 'scanned';
      else if (code === 86038) state = 'expired';
      /** @type {Record<string, any>} */
      const result = {
        state,
        code,
        message: typeof data.message === 'string' ? data.message : '',
      };
      if (state === 'ok') {
        // Cookie 可能来自 Set-Cookie（新行为）或回跳 URL（旧行为），两者合并。
        const cookieString = mergeCookieStrings(cookieStringFromSetCookie(headers), cookieStringFromLoginUrl(data.url));
        if (cookieString !== undefined) result.cookieString = cookieString;
      }
      return result;
    },

    /**
     * 退出登录：清掉凭据（如果挂了 credentials 服务）并让 Cookie 罐失效。
     * @returns {Promise<{ cleared: true }>} 结果。
     */
    async logout() {
      if (credentials !== null && credentials !== undefined && typeof credentials.unset === 'function') {
        try {
          await credentials.unset(config.cookieEnv ?? 'BILI_COOKIE');
        } catch (error) {
          warn(`[bilibili] 清除凭据失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        cookies?.invalidate?.();
      } catch {
        // 忽略。
      }
      return { cleared: true };
    },

    /**
     * 观看历史（需登录）。
     * @param {{ limit?: number, cursor?: number | string }} [args] - 参数。
     * @returns {Promise<{ items: Array<any>, cursor: number, hasMore: boolean }>} 历史。
     */
    async history(args = {}) {
      const limit = clampCount(args.limit);
      const cursor = toInt(args.cursor);
      const search = new URLSearchParams({ ps: String(limit), type: 'archive' });
      if (cursor !== undefined && cursor > 0) search.set('max', String(cursor));
      const data = await getData(`${API}/x/web-interface/history/cursor?${search.toString()}`, {
        context: '观看历史',
      });
      const list = Array.isArray(data?.list) ? data.list : [];
      const nextCursor = toInt(data?.cursor?.max);
      const items = list.slice(0, limit).map(normalizeHistoryItem);
      return {
        items,
        cursor: nextCursor !== undefined && nextCursor > 0 ? nextCursor : 0,
        hasMore: list.length >= limit && nextCursor !== undefined && nextCursor > 0,
      };
    },

    /**
     * 收藏夹：`list` 取文件夹，`items` 取内容（需登录）。
     * @param {{ action?: string, mediaId?: unknown, page?: number, limit?: number }} [args] - 参数。
     * @returns {Promise<Record<string, any>>} 文件夹或内容。
     */
    async favorites(args = {}) {
      const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'list';
      if (action === 'list') {
        const mid = await selfMid();
        const data = await getData(`${API}/x/v3/fav/folder/created/list-all?up_mid=${mid}`, {
          context: '收藏夹列表',
        });
        const list = Array.isArray(data?.list) ? data.list : [];
        return {
          folders: list.map((raw) => {
            /** @type {Record<string, any>} */
            const folder = {
              id: toInt(raw?.id) ?? 0,
              title: stripHtml(raw?.title ?? ''),
              count: toInt(raw?.media_count) ?? 0,
            };
            const cover = fixUrl(raw?.cover);
            if (cover !== undefined) folder.cover = cover;
            return folder;
          }),
        };
      }
      if (action === 'items') {
        const mediaId = toInt(args.mediaId);
        if (mediaId === undefined || mediaId <= 0) {
          throw invalidArgument('action=items 需要 mediaId（先用 action=list 查收藏夹 id）。');
        }
        const page = pageNumber(args.page);
        const limit = clampCount(args.limit);
        const data = await getData(
          `${API}/x/v3/fav/resource/list?media_id=${mediaId}&pn=${page}&ps=${limit}&platform=web`,
          { context: '收藏内容' },
        );
        const medias = Array.isArray(data?.medias) ? data.medias : [];
        const total = toInt(data?.info?.media_count);
        return {
          items: medias.slice(0, limit).map(normalizeFavItem),
          page,
          hasMore: data?.has_more === true || (total !== undefined && page * limit < total),
        };
      }
      throw invalidArgument(`action 只能是 list 或 items（收到 ${action}）。`);
    },

    /**
     * 关注列表（需登录；不传 vmid 取自己的）。
     * @param {{ vmid?: unknown, page?: number, limit?: number }} [args] - 参数。
     * @returns {Promise<{ items: Array<any>, page: number, hasMore: boolean }>} 关注列表。
     */
    async follows(args = {}) {
      let vmid = toInt(args.vmid);
      if (vmid === undefined || vmid <= 0) vmid = await selfMid();
      const page = pageNumber(args.page);
      const limit = clampCount(args.limit);
      const data = await getData(
        `${API}/x/relation/followings?vmid=${vmid}&pn=${page}&ps=${limit}&order=desc`,
        { context: '关注列表' },
      );
      const list = Array.isArray(data?.list) ? data.list : [];
      const total = toInt(data?.total);
      return {
        items: list.slice(0, limit).map(normalizeFollowingUser),
        page,
        hasMore: total !== undefined ? page * limit < total : list.length >= limit,
      };
    },

    /**
     * 动态（需登录；风控时给可读提示）。
     * @param {{ page?: number, limit?: number }} [args] - 参数。
     * @returns {Promise<{ items: Array<any>, offset: number, hasMore: boolean }>} 动态。
     */
    async dynamic(args = {}) {
      const page = pageNumber(args.page);
      const limit = clampCount(args.limit);
      const data = await getData(`${API}/x/polymer/web-dynamic/v1/feed/all?type=all&page=${page}`, {
        context: 'B 站动态',
      });
      const list = Array.isArray(data?.items) ? data.items : [];
      const offset = toInt(data?.offset);
      return {
        items: list.slice(0, limit).map(normalizeDynamicItem),
        offset: offset ?? 0,
        hasMore: data?.has_more === true || list.length >= limit,
      };
    },
  };

  /**
   * 归一化直播主播信息。
   * @param {{ uname?: string, face?: string, uid?: unknown }} info - 字段。
   * @returns {Record<string, any>} User。
   */
  function normalizeLiveAnchor(info) {
    const mid = toInt(info.uid) ?? 0;
    return {
      mid,
      name: stripHtml(info.uname ?? ''),
      ...(fixUrl(info.face) !== undefined ? { face: fixUrl(info.face) } : {}),
      url: `https://space.bilibili.com/${mid}`,
    };
  }

  return api;
}
