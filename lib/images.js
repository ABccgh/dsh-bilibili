/**
 * 图片附件：把封面/头像/二维码挂到工具结果里。
 *
 * DSH 的图片内容块形状（`@deepseek-ai/dsh-llm` 的 `ImageBlock`）：
 * `{ type: 'image', attachment: ImageAttachmentRef }`，其中 `ImageAttachmentRef`
 * 由 `ctx.get('attachments').saveImage({ data, mediaType, name })` 返回
 * （`{ attachmentId, mediaType, bytes, width, height, name? }`）。
 *
 * 本模块**不硬依赖** attachments 服务：服务未挂载、`attachImages=false`、
 * 下载或保存失败时都静默降级为「没有图」（返回空 blocks），工具正文照常输出。
 * 这是契约 §10 的要求：图片是锦上添花，不应该是失败源。
 *
 * @module @local/bilibili/images
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** 单次附带图片的默认上限。 */
const DEFAULT_MAX_IMAGES = 4;

/** 单张图片的字节上限（超过就跳过，避免把大图塞进上下文）。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * 按魔数嗅探图片类型。
 * @param {Uint8Array} bytes - 字节。
 * @returns {{ mediaType: string, extension: string } | null} 类型；不认识时 null。
 */
export function sniffImageType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mediaType: 'image/jpeg', extension: 'jpg' };
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mediaType: 'image/png', extension: 'png' };
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { mediaType: 'image/gif', extension: 'gif' };
  }
  const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  const webp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (riff && webp) return { mediaType: 'image/webp', extension: 'webp' };
  return null;
}

/**
 * 把 URL 收成可下载的 https 地址（`//i0.hdslb.com/...` 补成 `https:`）。
 * @param {unknown} url - 原始地址。
 * @returns {string | undefined} 地址；非法时 undefined。
 */
export function normalizeImageUrl(url) {
  if (typeof url !== 'string') return undefined;
  const text = url.trim();
  if (text === '') return undefined;
  if (text.startsWith('//')) return `https:${text}`;
  if (/^https?:\/\//i.test(text)) return text;
  return undefined;
}

/**
 * 从图片 URL 猜一个文件名（附件服务用于展示）。
 * @param {string} url - 图片地址。
 * @returns {string | undefined} 文件名。
 */
export function imageNameFromUrl(url) {
  const text = normalizeImageUrl(url);
  if (text === undefined) return undefined;
  try {
    const last = new URL(text).pathname.split('/').pop() ?? '';
    return last === '' ? undefined : decodeURIComponent(last);
  } catch {
    return undefined;
  }
}

/**
 * 把附件服务返回的 ref 收成稳定的 `ImageAttachmentRef`（补全缺失字段）。
 * @param {any} ref - `saveImage` 返回值。
 * @param {Uint8Array} data - 原始字节。
 * @param {{ mediaType: string }} fallback - 嗅探到的类型。
 * @param {string | undefined} name - 文件名兜底。
 * @returns {Record<string, any> | null} 规范 ref；没有 attachmentId 时 null。
 */
export function normalizeImageRef(ref, data, fallback, name) {
  if (ref === null || typeof ref !== 'object') return null;
  const attachmentId = typeof ref.attachmentId === 'string' ? ref.attachmentId : '';
  if (attachmentId === '') return null;
  /** @type {Record<string, any>} */
  const attachment = {
    attachmentId,
    mediaType: typeof ref.mediaType === 'string' && ref.mediaType !== '' ? ref.mediaType : fallback.mediaType,
    bytes: Number.isFinite(Number(ref.bytes)) && Number(ref.bytes) >= 0 ? Math.trunc(Number(ref.bytes)) : data.length,
    width: Number.isFinite(Number(ref.width)) && Number(ref.width) > 0 ? Math.trunc(Number(ref.width)) : 0,
    height: Number.isFinite(Number(ref.height)) && Number(ref.height) > 0 ? Math.trunc(Number(ref.height)) : 0,
  };
  const finalName = typeof ref.name === 'string' && ref.name !== '' ? ref.name : name;
  if (typeof finalName === 'string' && finalName !== '') attachment.name = finalName;
  return attachment;
}

/**
 * 造图片附件器。
 * @param {{ ctx?: any, config?: Record<string, any>, logger?: { warn?: Function },
 *   http?: { getBytes: Function } }} [options] - 依赖。
 * @returns {{
 *   readonly available: boolean,
 *   attachUrls: (urls: Array<string | undefined | null>, options?: { max?: number }) => Promise<{ blocks: object[], attached: number }>,
 *   attachFile: (filePath: string) => Promise<{ blocks: object[], attached: number }>
 * }} 附件器。
 */
export function createImages(options = {}) {
  const ctx = options.ctx;
  const config = options.config ?? {};
  const logger = options.logger;
  const http = options.http;
  const enabled = config.attachImages !== false;

  /**
   * 取可选的 attachments 服务。
   * @returns {any} 服务；不可用时 undefined。
   */
  function getStore() {
    if (!enabled) return undefined;
    try {
      const store = typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined;
      if (store === null || store === undefined || typeof store.saveImage !== 'function') return undefined;
      return store;
    } catch {
      return undefined;
    }
  }

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
   * 保存一段图片字节并返回图片块。
   * @param {any} store - 附件服务。
   * @param {Uint8Array} data - 字节。
   * @param {{ mediaType: string }} type - 嗅探类型。
   * @param {string | undefined} name - 文件名。
   * @returns {Promise<object | null>} `ImageBlock`；失败 null。
   */
  async function saveBlock(store, data, type, name) {
    try {
      const ref = await store.saveImage({ data, mediaType: type.mediaType, name });
      const attachment = normalizeImageRef(ref, data, type, name);
      if (attachment === null) return null;
      return { type: 'image', attachment };
    } catch (error) {
      warn(`[bilibili] 保存图片附件失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  return {
    /** 当前是否真的能把图片挂成附件。 */
    get available() {
      return getStore() !== undefined;
    },

    /**
     * 批量下载 URL 并挂成图片附件（失败的单张静默跳过）。
     * @param {Array<string | undefined | null>} urls - 图片地址列表。
     * @param {{ max?: number }} [attachOptions] - `max` 为本次最多附几张（默认 4，上限 10）。
     * @returns {Promise<{ blocks: object[], attached: number }>} 图片块与成功数量。
     */
    async attachUrls(urls, attachOptions = {}) {
      /** @type {{ blocks: object[], attached: number }} */
      const empty = { blocks: [], attached: 0 };
      const store = getStore();
      if (store === undefined) return empty;
      if (typeof http?.getBytes !== 'function') return empty;
      if (!Array.isArray(urls)) return empty;

      const rawMax = Number(attachOptions.max);
      const max = Number.isFinite(rawMax) && rawMax > 0
        ? Math.max(1, Math.min(10, Math.trunc(rawMax)))
        : DEFAULT_MAX_IMAGES;

      /** @type {string[]} */
      const candidates = [];
      const seen = new Set();
      for (const raw of urls) {
        const url = normalizeImageUrl(raw);
        if (url === undefined || seen.has(url)) continue;
        seen.add(url);
        candidates.push(url);
        if (candidates.length >= max) break;
      }
      if (candidates.length === 0) return empty;

      /** @type {object[]} */
      const blocks = [];
      for (const url of candidates) {
        try {
          const data = await http.getBytes(url, { headers: { referer: 'https://www.bilibili.com/' } });
          if (!(data instanceof Uint8Array) || data.length === 0 || data.length > MAX_IMAGE_BYTES) {
            warn(`[bilibili] 跳过异常图片（${data instanceof Uint8Array ? data.length : 0} 字节）：${url}`);
            continue;
          }
          const type = sniffImageType(data);
          if (type === null) {
            warn(`[bilibili] 跳过无法识别的图片格式：${url}`);
            continue;
          }
          const block = await saveBlock(store, data, type, imageNameFromUrl(url));
          if (block !== null) blocks.push(block);
        } catch (error) {
          warn(`[bilibili] 下载图片失败（${url}）：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { blocks, attached: blocks.length };
    },

    /**
     * 把本地图片文件挂成附件（二维码等）。
     * @param {string} filePath - 本地绝对路径。
     * @returns {Promise<{ blocks: object[], attached: number }>} 图片块与成功数量。
     */
    async attachFile(filePath) {
      const store = getStore();
      if (store === undefined) return { blocks: [], attached: 0 };
      /** @type {Buffer} */
      let data;
      try {
        data = await fs.readFile(filePath);
      } catch (error) {
        warn(`[bilibili] 读图片失败（${filePath}）：${error instanceof Error ? error.message : String(error)}`);
        return { blocks: [], attached: 0 };
      }
      if (data.length === 0 || data.length > MAX_IMAGE_BYTES) {
        warn(`[bilibili] 图片大小异常（${data.length} 字节），跳过附件：${filePath}`);
        return { blocks: [], attached: 0 };
      }
      const type = sniffImageType(data);
      if (type === null) {
        warn(`[bilibili] 不是可识别的图片，跳过附件：${filePath}`);
        return { blocks: [], attached: 0 };
      }
      const block = await saveBlock(store, data, type, path.basename(filePath));
      if (block === null) return { blocks: [], attached: 0 };
      return { blocks: [block], attached: 1 };
    },
  };
}
