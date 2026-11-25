/**
 * 纯函数工具箱：BV/av 互转、弹幕 protobuf 解析、时长/计数/时间文本、HTML 清洗、
 * 视频目标解析。
 *
 * 这里**没有任何网络与状态**，全部是可以在测试里逐值断言的纯函数；`lib/api.js`
 * 只负责取数与归一化，格式转换统一走这里，避免同一个算法在两处漂移。
 *
 * @module @local/bilibili/format
 */

import { invalidArgument } from './errors.js';

/** BV 号编码用的 58 进制字典（B 站前端固定顺序，不得改动）。 */
const BV_DICT = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';

/** BV 编码的基数。 */
const BV_BASE = 58n;

/** BV 编码的异或常数。 */
const BV_XOR_CODE = 23442827791579n;

/** aid 的 51 位掩码。 */
const BV_MASK_CODE = 2251799813685247n;

/** BV 编码里 aid 的上界（1 << 51）。 */
const BV_MAX_AID = 1n << 51n;

/** b23.tv 短链路径。 */
const B23_PATH_PATTERN = /^\/[0-9A-Za-z_-]{3,32}$/;

/** 北京时间相对 UTC 的偏移（毫秒）。输出固定按 UTC+8，保证跨时区结果一致。 */
const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

/** HTML 具名实体表（只覆盖 B 站会出现在标题/简介里的那些）。 */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  copy: '©',
};

/**
 * 把 0–2^51 的 aid 编成 BV 号。
 *
 * B 站 2020 年起用 51 位 aid 做 base58 编码再异或、做两处字符交换得到 BV 号；
 * 这里与官方前端/`bilibili-API-collect` 的算法逐位一致。
 * @param {number|string} aid - 数字 aid（可传纯数字字符串）。
 * @returns {string} 12 位 BV 号。
 * @throws {BiliError} aid 不是合法非负整数或超出 51 位范围时。
 */
export function bvFromAid(aid) {
  const value = typeof aid === 'string' ? Number(aid.trim()) : aid;
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number(BV_MAX_AID)) {
    throw invalidArgument(`无效的 aid：${String(aid)}（应为 0 到 2^51-1 的整数）。`);
  }
  /** @type {string[]} */
  const bytes = ['B', 'V', '1', '0', '0', '0', '0', '0', '0', '0', '0', '0'];
  let tmp = (BV_MAX_AID | BigInt(value)) ^ BV_XOR_CODE;
  let index = bytes.length - 1;
  while (tmp > 0n) {
    bytes[index] = BV_DICT[Number(tmp % BV_BASE)];
    tmp /= BV_BASE;
    index -= 1;
  }
  // 与官方实现一致的两处交换。
  [bytes[3], bytes[9]] = [bytes[9], bytes[3]];
  [bytes[4], bytes[7]] = [bytes[7], bytes[4]];
  return bytes.join('');
}

/**
 * 把 BV 号解回 aid。
 *
 * 与 `bvFromAid` 互逆：`aidFromBv(bvFromAid(x)) === x`。
 * @param {string} bvid - BV 号（大小写敏感，`BV` 前缀可小写）。
 * @returns {number} aid。
 * @throws {BiliError} 不是合法 BV 号时。
 */
export function aidFromBv(bvid) {
  const text = typeof bvid === 'string' ? bvid.trim() : '';
  // 前缀允许 `BV`/`bv`/`Bv`，后面 10 位保持原样（BV 号本身大小写敏感）。
  if (!/^[Bb][Vv]1[0-9A-Za-z]{9}$/.test(text)) {
    throw invalidArgument(`无效的 BV 号：${String(bvid)}。`);
  }
  /** @type {string[]} */
  const bytes = text.split('');
  [bytes[3], bytes[9]] = [bytes[9], bytes[3]];
  [bytes[4], bytes[7]] = [bytes[7], bytes[4]];
  let tmp = 0n;
  for (let index = 3; index < bytes.length; index += 1) {
    const digit = BV_DICT.indexOf(bytes[index]);
    if (digit < 0) throw invalidArgument(`无效的 BV 号：${String(bvid)}。`);
    tmp = tmp * BV_BASE + BigInt(digit);
  }
  return Number((tmp & BV_MASK_CODE) ^ BV_XOR_CODE);
}

/**
 * 把秒数格式化成 `m:ss` / `h:mm:ss`。
 * @param {number} sec - 时长（秒，可带小数，向下取整）。
 * @returns {string} 文本；非法或负数返回空字符串。
 */
export function durationText(sec) {
  const value = Number(sec);
  if (!Number.isFinite(value) || value < 0) return '';
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  /**
   * 两位补零。
   * @param {number} part - 数字。
   * @returns {string} 文本。
   */
  const pad = (part) => String(part).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * 把数字格式化成中文计数（万/亿）。
 * @param {number} n - 计数（播放量、粉丝数等）。
 * @returns {string} 文本；非法或负数返回空字符串。
 */
export function countText(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value < 0) return '';
  const total = Math.trunc(value);
  /**
   * 保留一位小数并去掉多余的 `.0`。
   * @param {number} part - 数字。
   * @returns {string} 文本。
   */
  const oneDecimal = (part) => {
    const text = part.toFixed(1);
    return text.endsWith('.0') ? text.slice(0, -2) : text;
  };
  if (total >= 100000000) return `${oneDecimal(total / 100000000)}亿`;
  if (total >= 10000) {
    const wan = total / 10000;
    // 9999.95 万以上按亿显示，避免出现「10000万」。
    if (wan >= 9999.95) return `${oneDecimal(total / 100000000)}亿`;
    return `${oneDecimal(wan)}万`;
  }
  return String(total);
}

/**
 * 把 Unix 时间戳格式化成北京时间文本。
 *
 * 固定按 UTC+8 输出（B 站是中文站，且测试跨时区可复现）；秒与毫秒时间戳都接受。
 * @param {number} ts - Unix 时间戳（秒或毫秒）。
 * @returns {string} `YYYY-MM-DD HH:mm`；非法或非正数返回空字符串。
 */
export function pubdateText(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return '';
  const millis = value >= 1e12 ? value : value * 1000;
  const date = new Date(millis + CN_OFFSET_MS);
  /**
   * 两位补零。
   * @param {number} part - 数字。
   * @returns {string} 文本。
   */
  const pad = (part) => String(part).padStart(2, '0');
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hour = pad(date.getUTCHours());
  const minute = pad(date.getUTCMinutes());
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

/**
 * 去掉 B 站返回文本里的 HTML 标签并解常见实体。
 *
 * 搜索结果的标题会带 `<em class="keyword">` 高亮，视频简介里会有 `<br>`、`&amp;`，
 * 客户端卡片只吃纯文本，所以统一在这里清洗。
 * @param {unknown} text - 原始文本。
 * @returns {string} 纯文本（`<br>`/`</p>` 变回车，多余空行压成一行空行）。
 */
export function stripHtml(text) {
  if (typeof text !== 'string') return '';
  let result = text.replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\s*\/\s*p\s*>/gi, '\n');
  result = result.replace(/<\/?[A-Za-z][^>]*>/g, '');
  result = result.replace(/&(#?[A-Za-z0-9]+);/g, (match, code) => {
    if (code.startsWith('#')) {
      const numeric = code.startsWith('#x') || code.startsWith('#X')
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      if (Number.isFinite(numeric) && numeric > 0 && numeric <= 0x10ffff) {
        try {
          return String.fromCodePoint(numeric);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[code] ?? match;
  });
  return result
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 从一段字符串里抠出 BV 号（用于短链落地页/HTML）。
 * @param {string} text - 文本。
 * @returns {string | undefined} 第一个 BV 号。
 */
export function findBvid(text) {
  if (typeof text !== 'string') return undefined;
  const match = /BV1[0-9A-Za-z]{9}/.exec(text);
  return match === null ? undefined : match[0];
}

/**
 * 把各种写法的视频目标解析成 `{ bvid, aid, page, shortUrl }`。
 *
 * 支持：`BV1xx411c7mD`、`av170001`、裸数字 aid、`https://www.bilibili.com/video/BV…?p=2`、
 * `https://m.bilibili.com/video/av170001`、`https://b23.tv/xxxx`（短链只做域名与格式
 * 判断，落地页解析在 `lib/api.js` 里用真实 HTTP 完成）。
 * @param {unknown} target - 用户给的视频目标。
 * @returns {{ bvid?: string, aid?: number, page: number, shortUrl?: string }} 解析结果。
 * @throws {BiliError} 目标为空或无法识别时。
 */
export function resolveTargetInput(target) {
  const raw = typeof target === 'string' ? target.trim() : '';
  if (raw === '') throw invalidArgument('需要一个视频目标：BV 号、av 号或 B 站视频链接。');
  // 去掉粘贴时混进来的空白（如「BV1xx411c7mD ?p=2」）。
  const compact = raw.replace(/\s+/g, '');

  /** @type {{ bvid?: string, aid?: number, page: number, shortUrl?: string }} */
  const result = { page: 1 };

  /** 纯 BV 号。 */
  if (/^[Bb][Vv]1[0-9A-Za-z]{9}$/.test(compact)) {
    result.bvid = `BV${compact.slice(2)}`;
    try {
      result.aid = aidFromBv(result.bvid);
    } catch {
      // BV 号里含字典外字符时解不出 aid，交给 API 层用 view 接口兜底。
    }
    return result;
  }

  /** av 号或裸数字 aid。 */
  const aidMatch = /^(?:av)?(\d{1,16})$/i.exec(compact);
  if (aidMatch !== null) {
    const aid = Number(aidMatch[1]);
    if (!Number.isSafeInteger(aid) || aid <= 0) throw invalidArgument(`无效的 aid：${raw}。`);
    result.aid = aid;
    result.bvid = bvFromAid(aid);
    return result;
  }

  /** 剩下都当 URL 处理；缺协议时补 https://。 */
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(compact) ? compact : `https://${compact}`;
  /** @type {URL} */
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw invalidArgument(`无法识别的视频目标：${raw}。示例：BV17x411w7KC、av170001 或 https://www.bilibili.com/video/BV17x411w7KC。`);
  }
  const host = url.hostname.toLowerCase();

  /** b23.tv 短链：只判断域名 + 路径格式。 */
  if (host === 'b23.tv' || host.endsWith('.b23.tv')) {
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const directBv = /\/BV1[0-9A-Za-z]{9}$/.exec(pathname);
    if (directBv !== null) {
      result.bvid = directBv[0].slice(1);
      try {
        result.aid = aidFromBv(result.bvid);
      } catch {
        // 忽略：交给 API 层兜底。
      }
      return result;
    }
    if (!B23_PATH_PATTERN.test(pathname)) {
      throw invalidArgument(`无法识别的 b23.tv 短链：${raw}。`);
    }
    result.shortUrl = `https://b23.tv${pathname}`;
    return result;
  }

  if (host !== 'bilibili.com' && !host.endsWith('.bilibili.com')) {
    throw invalidArgument(`只支持 B 站域名的视频链接（收到 ${host}）。`);
  }

  /** 播放器地址：query 里直接给 bvid/aid/page。 */
  if (host.startsWith('player.')) {
    const queryBvid = url.searchParams.get('bvid');
    const queryAid = url.searchParams.get('aid');
    if (queryBvid !== null && /^[Bb][Vv]1[0-9A-Za-z]{9}$/.test(queryBvid.trim())) {
      result.bvid = `BV${queryBvid.trim().slice(2)}`;
      try {
        result.aid = aidFromBv(result.bvid);
      } catch {
        // 忽略。
      }
    } else if (queryAid !== null && /^\d+$/.test(queryAid.trim())) {
      result.aid = Number(queryAid.trim());
      result.bvid = bvFromAid(result.aid);
    } else {
      throw invalidArgument(`播放器链接里没有 bvid/aid 参数：${raw}。`);
    }
    result.page = parsePageNumber(url.searchParams.get('page') ?? url.searchParams.get('p'));
    return result;
  }

  const videoMatch = /\/video\/([Bb][Vv]1[0-9A-Za-z]{9}|[Aa][Vv]\d{1,16})/.exec(url.pathname);
  if (videoMatch === null) {
    throw invalidArgument(`这个 B 站链接不是视频页：${raw}。支持 /video/BV… 与 /video/av…。`);
  }
  const token = videoMatch[1];
  if (/^[Aa][Vv]/.test(token)) {
    result.aid = Number(token.slice(2));
    result.bvid = bvFromAid(result.aid);
  } else {
    result.bvid = `BV${token.slice(2)}`;
    try {
      result.aid = aidFromBv(result.bvid);
    } catch {
      // 忽略。
    }
  }
  result.page = parsePageNumber(url.searchParams.get('p') ?? url.searchParams.get('page'));
  return result;
}

/**
 * 解析分P序号（把非法值收成 1）。
 * @param {string | null} value - query 里的 `p`/`page`。
 * @returns {number} 从 1 开始的页码。
 */
export function parsePageNumber(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const page = Number.parseInt(text, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

/**
 * 把输入收成 `Uint8Array`。
 * @param {Uint8Array | ArrayBuffer | ArrayLike<number>} bytes - 输入。
 * @returns {Uint8Array} 字节视图。
 */
function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  if (bytes !== null && typeof bytes === 'object' && typeof bytes.length === 'number') {
    return Uint8Array.from(/** @type {ArrayLike<number>} */ (bytes));
  }
  throw invalidArgument('弹幕分段必须是字节数组。');
}

/**
 * 读一个 protobuf varint。
 * @param {Uint8Array} buffer - 字节。
 * @param {number} start - 起点。
 * @returns {{ value: number, pos: number } | null} 值（超过 2^53 会失去精度，仅用于长度/跳过）与下一位置；越界或超长返回 null。
 */
function readVarint(buffer, start) {
  let value = 0;
  let factor = 1;
  let pos = start;
  while (pos < buffer.length && pos - start < 10) {
    const byte = buffer[pos];
    pos += 1;
    value += (byte & 0x7f) * factor;
    if ((byte & 0x80) === 0) return { value, pos };
    factor *= 128;
  }
  return null;
}

/**
 * 跳过一个未知字段。
 * @param {Uint8Array} buffer - 字节。
 * @param {number} pos - 字段值起点。
 * @param {number} wireType - wire type（0/1/2/5）。
 * @returns {number | null} 下一字段位置；格式错误返回 null。
 */
function skipField(buffer, pos, wireType) {
  if (wireType === 0) {
    const varint = readVarint(buffer, pos);
    return varint === null ? null : varint.pos;
  }
  if (wireType === 1) return pos + 8 <= buffer.length ? pos + 8 : null;
  if (wireType === 5) return pos + 4 <= buffer.length ? pos + 4 : null;
  if (wireType === 2) {
    const length = readVarint(buffer, pos);
    if (length === null) return null;
    const next = length.pos + length.value;
    return next <= buffer.length ? next : null;
  }
  return null;
}

/**
 * 解析一条 `DanmakuElem` 消息。
 * @param {Uint8Array} buffer - 字节。
 * @returns {{ timeMs: number, mode: number, color: number, text: string, ctime: number } | null} 弹幕；格式坏掉时 null。
 */
function parseDanmakuElem(buffer) {
  /** @type {{ timeMs: number, mode: number, color: number, text: string, ctime: number }} */
  const item = { timeMs: 0, mode: 1, color: 0xffffff, text: '', ctime: 0 };
  let pos = 0;
  while (pos < buffer.length) {
    const tag = readVarint(buffer, pos);
    if (tag === null) return null;
    pos = tag.pos;
    const field = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (field === 2 && wireType === 0) {
      const value = readVarint(buffer, pos);
      if (value === null) return null;
      item.timeMs = value.value;
      pos = value.pos;
    } else if (field === 3 && wireType === 0) {
      const value = readVarint(buffer, pos);
      if (value === null) return null;
      item.mode = value.value;
      pos = value.pos;
    } else if (field === 5 && wireType === 0) {
      const value = readVarint(buffer, pos);
      if (value === null) return null;
      item.color = value.value;
      pos = value.pos;
    } else if (field === 7 && wireType === 2) {
      const length = readVarint(buffer, pos);
      if (length === null) return null;
      const end = length.pos + length.value;
      if (end > buffer.length) return null;
      item.text = new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(length.pos, end));
      pos = end;
    } else if (field === 8 && wireType === 0) {
      const value = readVarint(buffer, pos);
      if (value === null) return null;
      item.ctime = value.value;
      pos = value.pos;
    } else {
      const next = skipField(buffer, pos, wireType);
      if (next === null) return null;
      pos = next;
    }
  }
  return item;
}

/**
 * 解析弹幕分段的 protobuf 字节。
 *
 * 接口：`/x/v2/dm/web/seg.so?type=1&oid=<cid>&pid=<aid>&segment_index=1`，
 * 消息结构是 `repeated DanmakuElem elems = 1`，元素里关心的字段：
 * `progress(2,uint32,毫秒) mode(3) color(5) content(7,string) ctime(8,int64)`。
 * 未知字段按 wire type 跳过；末尾被截断时不抛错，返回截断前的完整元素。
 * @param {Uint8Array | ArrayBuffer | ArrayLike<number>} bytes - 原始响应字节。
 * @returns {Array<{ timeMs: number, mode: number, color: number, text: string, ctime: number }>} 弹幕。
 */
export function parseDanmakuSegments(bytes) {
  const buffer = toBytes(bytes);
  if (buffer.length === 0) return [];
  // 风控/未登录时接口可能直接返回 JSON 文本（形如 {"code":-101,…}），按无弹幕处理。
  if (buffer[0] === 0x7b) return [];

  /** @type {Array<{ timeMs: number, mode: number, color: number, text: string, ctime: number }>} */
  const items = [];
  let pos = 0;
  while (pos < buffer.length) {
    const tag = readVarint(buffer, pos);
    if (tag === null) break;
    pos = tag.pos;
    const field = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (field === 1 && wireType === 2) {
      const length = readVarint(buffer, pos);
      if (length === null) break;
      const end = length.pos + length.value;
      if (end > buffer.length) break;
      const item = parseDanmakuElem(buffer.subarray(length.pos, end));
      if (item === null) break;
      items.push(item);
      pos = end;
    } else {
      const next = skipField(buffer, pos, wireType);
      if (next === null) break;
      pos = next;
    }
  }
  return items;
}

/**
 * 从 DASH 播放地址里抠出 `deadline` 参数（Unix 秒）。
 * @param {string} url - 播放地址。
 * @returns {number | undefined} 过期时间戳（秒）。
 */
export function deadlineFromUrl(url) {
  if (typeof url !== 'string' || url === '') return undefined;
  const match = /[?&]deadline=(\d{9,13})/.exec(url);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}
