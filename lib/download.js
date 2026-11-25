/**
 * 下载器：把 `bili_download` 的「解析目标 → 选流 → 落盘 → 合并」编排成一条流水线。
 *
 * 设计要点：
 * - **有 ffmpeg**：走 DASH，把 video/audio 两条流分别下到 `%TEMP%` 的临时目录，再用
 *   `ffmpeg -y -i v -i a -c copy -movflags +faststart out.mp4` 无损合并；
 * - **没有 ffmpeg**：退回 `durl` 单文件 MP4（B 站对未登录/低清晰度会直接给整段 MP4）；
 *   两条 DASH 流又没有 durl 时明确报 `BILI_FFMPEG_MISSING`，不假装下成功；
 * - 落盘一律先写 `*.part` 再 rename，失败/取消时清理临时文件；
 * - 体积同时受 `config.maxDownloadMb` 与 `exec.signal` 约束；
 * - 探测与执行都允许注入（`ffmpeg` / `runFfmpeg`），离线测试不真跑 ffmpeg。
 *
 * @module @local/bilibili/download
 */

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BiliError, CODES, isBiliError } from './errors.js';
import { createFfmpegProbe } from './ffmpeg.js';
import { formatBytes, resolveDownloadDir, resolveDownloadRoot, sanitizeBasename, uniqueFilePath } from './paths.js';

/** 允许的清晰度关键字。 */
const QUALITY_KEYS = new Set(['best', '1080', '720', '480', '360']);

/** 清晰度关键字 → 期望画面高度。 */
const QUALITY_HEIGHTS = { 1080: 1080, 720: 720, 480: 480, 360: 360 };

/** DASH 视频流 id → 画面高度（流没带 height 字段时兜底）。 */
const VIDEO_ID_HEIGHTS = {
  6: 240, 16: 360, 32: 480, 64: 720, 74: 720, 80: 1080, 112: 1080,
  116: 1080, 120: 2160, 125: 2160, 126: 2160, 127: 4320,
};

/** DASH 音频流 id 的优先级（越大越好听）。 */
const AUDIO_ID_RANK = { 30251: 5, 30250: 4, 30280: 3, 30232: 2, 30216: 1 };

/** `maxDownloadMb` 缺省值（与 config.js 一致）。 */
const DEFAULT_MAX_DOWNLOAD_MB = 2048;

/** ffmpeg 合并的最长等待（毫秒）。 */
const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * 把错误转成一行文本（日志/包装用）。
 * @param {unknown} error - 任意错误。
 * @returns {string} 文本。
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 造「用户取消」错误。
 * @returns {BiliError} 错误。
 */
function canceledError() {
  return new BiliError('下载已取消。', {
    code: CODES.DOWNLOAD,
    hint: '任务被中断，未完成的临时文件已清理；需要时重新调用 bili_download。',
  });
}

/**
 * 造「超过体积上限」错误。
 * @param {number} limitBytes - 上限字节数。
 * @returns {BiliError} 错误。
 */
function sizeLimitError(limitBytes) {
  return new BiliError(`文件体积超过下载上限（${formatBytes(limitBytes)}）。`, {
    code: CODES.DOWNLOAD,
    hint: '调大配置 maxDownloadMb，或降低 quality / 用 audioOnly 只下音频。',
  });
}

/**
 * 把任意错误统一成 `BiliError`。
 * @param {unknown} error - 原始错误。
 * @param {string} context - 上下文前缀。
 * @param {AbortSignal | undefined} signal - 取消信号。
 * @returns {BiliError} 统一错误。
 */
function asBiliError(error, context, signal) {
  if (isBiliError(error)) return error;
  if (signal?.aborted === true) return canceledError();
  return new BiliError(`${context}：${errorMessage(error)}`, {
    code: CODES.DOWNLOAD,
    hint: '检查网络/代理后重试；若持续失败，换清晰度或稍后再试。',
    cause: error,
  });
}

/**
 * 取消时抛错。
 * @param {AbortSignal | undefined} signal - 取消信号。
 */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw canceledError();
}

/**
 * 把 chunk 转成 Uint8Array。
 * @param {unknown} chunk - 数据块。
 * @returns {Uint8Array} 字节。
 */
function toBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return new TextEncoder().encode(String(chunk));
}

/**
 * 把 `http.open` 返回的 body 变成可 for-await 的字节流。
 * @param {unknown} body - ReadableStream / Node Readable / 字节数组。
 * @returns {AsyncIterable<unknown> | Iterable<unknown>} 数据块序列。
 */
async function* iterateBody(body) {
  if (body === null || body === undefined) {
    throw new BiliError('下载响应没有内容。', {
      code: CODES.DOWNLOAD,
      hint: '换清晰度或稍后重试；若持续出现说明 CDN 返回了空响应。',
    });
  }
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value !== undefined && value !== null) yield value;
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        // 忽略。
      }
    }
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    yield* body;
    return;
  }
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    yield body;
    return;
  }
  throw new BiliError('下载响应格式不受支持。', {
    code: CODES.DOWNLOAD,
    hint: '本插件需要 http.open 返回 ReadableStream；检查 http 客户端实现。',
  });
}

/**
 * 从 `http.open` 的响应里读 content-length。
 * @param {{ contentLength?: number, headers?: any }} response - 响应对象。
 * @returns {number | null} 字节数或 null。
 */
function contentLengthOf(response) {
  const direct = Number(response?.contentLength);
  if (Number.isFinite(direct) && direct >= 0) return Math.trunc(direct);
  const headers = response?.headers;
  if (headers === undefined || headers === null) return null;
  const raw = typeof headers.get === 'function' ? headers.get('content-length') : (headers['content-length'] ?? headers['Content-Length']);
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * 归一清晰度参数。
 * @param {unknown} value - 原始值。
 * @returns {'best'|'1080'|'720'|'480'|'360'} 清晰度。
 */
function normalizeQuality(value) {
  if (value === undefined || value === null || value === '') return 'best';
  const key = String(value).trim().toLowerCase();
  if (!QUALITY_KEYS.has(key)) {
    throw new BiliError(`quality 只能是 best、1080、720、480、360，收到 ${JSON.stringify(value)}。`, {
      code: CODES.INVALID_ARGUMENT,
      hint: '不传时默认 best（自动选最高可用清晰度）。',
    });
  }
  return key;
}

/**
 * 归一页码参数。
 * @param {unknown} value - 原始值。
 * @returns {number | null} 页码；未传时 null（交给 resolveTarget 的 page 兜底）。
 */
function normalizePage(value) {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BiliError(`page 必须是 ≥1 的整数，收到 ${JSON.stringify(value)}。`, {
      code: CODES.INVALID_ARGUMENT,
      hint: '不传时用目标 URL 自带的页码，否则默认 1。',
    });
  }
  return parsed;
}

/**
 * 视频流分辨率（优先 height 字段，其次按 DASH id 映射）。
 * @param {any} stream - 流对象。
 * @returns {number} 高度，未知时 0。
 */
function streamHeight(stream) {
  const height = Number(stream?.height);
  if (Number.isFinite(height) && height > 0) return Math.trunc(height);
  const id = Number(stream?.id);
  return Number.isFinite(id) ? (VIDEO_ID_HEIGHTS[id] ?? 0) : 0;
}

/**
 * 流声明的字节数。
 * @param {any} stream - 流对象。
 * @returns {number} 字节数，未知时 0。
 */
function streamBytes(stream) {
  const bytes = Number(stream?.bytes);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

/**
 * 选一条视频流。
 * @param {any[]} streams - `playurl().video`。
 * @param {string} quality - 归一后的清晰度。
 * @returns {any | null} 选中的流。
 */
function pickVideoStream(streams, quality) {
  const candidates = (Array.isArray(streams) ? streams : [])
    .filter((stream) => stream !== null && typeof stream === 'object' && typeof stream.url === 'string' && stream.url !== '');
  if (candidates.length === 0) return null;
  const scored = candidates.map((stream) => ({ stream, height: streamHeight(stream), id: Number(stream.id) || 0 }));
  const targetHeight = QUALITY_HEIGHTS[quality];
  if (targetHeight === undefined) {
    scored.sort((left, right) => right.height - left.height || right.id - left.id);
    return scored[0].stream;
  }
  const exact = scored.filter((item) => item.height === targetHeight);
  if (exact.length > 0) {
    exact.sort((left, right) => right.id - left.id);
    return exact[0].stream;
  }
  const notHigher = scored.filter((item) => item.height > 0 && item.height <= targetHeight);
  if (notHigher.length > 0) {
    notHigher.sort((left, right) => right.height - left.height || right.id - left.id);
    return notHigher[0].stream;
  }
  scored.sort((left, right) => left.height - right.height || left.id - right.id);
  return scored[0].stream;
}

/**
 * 选一条音频流（优先 id 排名，再按体积/id 兜底）。
 * @param {any[]} streams - `playurl().audio`。
 * @returns {any | null} 选中的流。
 */
function pickAudioStream(streams) {
  const candidates = (Array.isArray(streams) ? streams : [])
    .filter((stream) => stream !== null && typeof stream === 'object' && typeof stream.url === 'string' && stream.url !== '');
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    const leftRank = AUDIO_ID_RANK[Number(left.id)] ?? 0;
    const rightRank = AUDIO_ID_RANK[Number(right.id)] ?? 0;
    return rightRank - leftRank || streamBytes(right) - streamBytes(left) || Number(right.id) - Number(left.id);
  });
  return candidates[0];
}

/**
 * 取播放信息的清晰度文案。
 *
 * `api.playurl` 返回的 `quality` 是 `{ id, label }`（契约 §9），但工具层输出希望是
 * 一个字符串，所以这里优先取 label、退 id、最后退回用户请求的关键字。
 * @param {any} play - `api.playurl` 的返回值。
 * @param {string} requested - 归一后的请求清晰度。
 * @returns {string} 清晰度文案。
 */
function qualityLabelOf(play, requested) {
  const raw = play?.quality;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  if (raw !== null && typeof raw === 'object') {
    if (typeof raw.label === 'string' && raw.label.trim() !== '') return raw.label.trim();
    if (Number.isFinite(Number(raw.id))) return String(raw.id);
  }
  return requested;
}

/**
 * 给 target 补上分P页码：`api.playurl` 只从 target 本身解析页码（契约参数 page
 * 在部分实现里不生效），所以页码 > 1 时用 bvid 重建一个带 `?p=` 的 URL 最稳。
 * @param {string} target - 原始目标。
 * @param {{ bvid?: string, page?: number }} resolved - `api.resolveTarget` 的结果。
 * @param {number} page - 实际要下载的页码。
 * @returns {string} 给 `api.playurl` 的 target。
 */
function targetWithPage(target, resolved, page) {
  if (!Number.isInteger(page) || page <= 1) return target;
  const bvid = typeof resolved?.bvid === 'string' ? resolved.bvid : '';
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return target;
  return `https://www.bilibili.com/video/${bvid}?p=${page}`;
}

/**
 * 拼下载文件名主体（不含扩展名）。
 * @param {{ title?: string, bvid?: string, page?: number, audioOnly?: boolean }} options - 信息。
 * @returns {string} 清洗后的文件名主体。
 */
function buildBasename(options) {
  const parts = [];
  const title = typeof options.title === 'string' && options.title.trim() !== '' ? options.title : '';
  if (title !== '') parts.push(sanitizeBasename(title, 'bilibili'));
  if (typeof options.bvid === 'string' && options.bvid !== '') parts.push(`[${options.bvid}]`);
  if (Number.isInteger(options.page) && options.page > 1) parts.push(`P${options.page}`);
  if (options.audioOnly === true) parts.push('音频');
  if (parts.length === 0) parts.push('bilibili');
  return sanitizeBasename(parts.join(' '), 'bilibili');
}

/**
 * 默认的 ffmpeg 执行器（`execFile`，不经过 shell）。
 * @param {string[]} args - ffmpeg 参数。
 * @param {{ signal?: AbortSignal, cwd?: string, command?: string }} [options] - 选项。
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>} 执行结果。
 */
function defaultRunFfmpeg(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      options.command ?? 'ffmpeg',
      args,
      { signal: options.signal, cwd: options.cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error !== null && error !== undefined) {
          const tail = String(stderr ?? '').trim().split(/\r?\n/).filter((line) => line !== '').pop() ?? '';
          reject(new BiliError(`ffmpeg 合并失败${tail === '' ? '' : `：${tail}`}`, {
            code: CODES.DOWNLOAD,
            hint: '先用 bili_status 确认 ffmpeg 可用；也可以改用 audioOnly，或删掉 ffmpegPath 让插件退回 durl 单文件。',
            cause: error,
          }));
          return;
        }
        resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/**
 * 原子替换文件：先删目标（Windows 上 rename 不能覆盖），再 rename。
 * @param {string} temporaryPath - 临时文件。
 * @param {string} targetPath - 目标路径。
 * @returns {Promise<void>} 无。
 */
async function replaceFile(temporaryPath, targetPath) {
  await fsp.rm(targetPath, { force: true });
  await fsp.rename(temporaryPath, targetPath);
}

/**
 * 造一个下载器。
 * @param {{ ctx?: any, config?: Record<string, any>, api: object, http: object,
 *   ffmpeg?: { detect: Function }, logger?: { warn?: Function, info?: Function },
 *   runFfmpeg?: Function, now?: () => number }} options - 依赖。
 *   `ffmpeg` 由 `lib/index.js` 注入（`createFfmpegProbe` 的产物），缺省时自行创建；
 *   `runFfmpeg(args, { signal, cwd, command })` 可注入，默认用 `execFile` 调真 ffmpeg。
 * @returns {{ run: (args?: Record<string, any>, exec?: { signal?: AbortSignal }) => Promise<object> }}
 *   下载器；`run` 返回契约 §10 的下载结果。
 */
export function createDownloader(options = {}) {
  const { api, http, ffmpeg, logger, runFfmpeg, now = () => Date.now() } = options;
  const config = options.config !== null && typeof options.config === 'object' ? options.config : {};
  if (api === undefined || api === null || typeof api.resolveTarget !== 'function') {
    throw new TypeError('createDownloader 需要 api（含 resolveTarget/playurl）。');
  }
  if (http === undefined || http === null || typeof http.open !== 'function') {
    throw new TypeError('createDownloader 需要 http（含 open）。');
  }

  const probe = ffmpeg ?? createFfmpegProbe({ config, logger });
  const executeFfmpeg = typeof runFfmpeg === 'function' ? runFfmpeg : defaultRunFfmpeg;
  const maxDownloadMb = Number.isFinite(Number(config.maxDownloadMb)) && Number(config.maxDownloadMb) > 0
    ? Math.trunc(Number(config.maxDownloadMb))
    : DEFAULT_MAX_DOWNLOAD_MB;
  const maxBytes = maxDownloadMb * 1024 * 1024;

  /**
   * 记一条告警。
   * @param {string} message - 消息。
   */
  const logWarn = (message) => {
    try {
      logger?.warn?.(`[bilibili] ${message}`);
    } catch {
      // 忽略日志失败。
    }
  };

  /**
   * 探测 ffmpeg；探测失败按「不可用」处理，不影响 durl 回退。
   * @returns {Promise<{ available: boolean, path?: string, version?: string, error?: string }>} 探测结果。
   */
  const detectFfmpeg = async () => {
    try {
      const detection = await probe.detect();
      if (detection !== null && typeof detection === 'object') return detection;
      return { available: false, error: '探测结果为空' };
    } catch (error) {
      logWarn(`ffmpeg 探测失败：${errorMessage(error)}`);
      return { available: false, error: errorMessage(error) };
    }
  };

  /**
   * 把一条 HTTP 流写进目标文件（先 `.part`，成功后 rename）。
   * @param {string} url - 下载地址。
   * @param {string} destination - 目标文件路径。
   * @param {AbortSignal | undefined} signal - 取消信号。
   * @param {number} budget - 本次允许写入的字节上限。
   * @returns {Promise<number>} 写入字节数。
   */
  const downloadStream = async (url, destination, signal, budget) => {
    throwIfAborted(signal);
    const limit = Math.min(budget, maxBytes);
    if (!Number.isFinite(limit) || limit <= 0) throw sizeLimitError(maxBytes);

    let response;
    try {
      response = await http.open(url, {
        signal,
        headers: { referer: 'https://www.bilibili.com/' },
      });
    } catch (error) {
      throw asBiliError(error, '打开下载流失败', signal);
    }

    const status = Number(response?.status);
    if (Number.isFinite(status) && status !== 0 && (status < 200 || status >= 300)) {
      throw new BiliError(`下载请求失败：HTTP ${status}。`, {
        code: CODES.DOWNLOAD,
        hint: '播放地址可能已过期（playurl 一般有效 2 小时），重新调用 bili_download；若持续 403 说明需要登录或换清晰度。',
      });
    }

    const contentLength = contentLengthOf(response);
    if (contentLength !== null && contentLength > limit) throw sizeLimitError(limit);

    const partPath = `${destination}.part`;
    const handle = await fsp.open(partPath, 'w');
    let written = 0;
    try {
      try {
        for await (const chunk of iterateBody(response?.body)) {
          throwIfAborted(signal);
          const bytes = toBytes(chunk);
          written += bytes.length;
          if (written > limit) throw sizeLimitError(limit);
          await handle.write(bytes);
        }
        if (contentLength !== null && written !== contentLength) {
          throw new BiliError(`下载不完整：期望 ${contentLength} 字节，实际收到 ${written} 字节。`, {
            code: CODES.DOWNLOAD,
            hint: '网络中断或 CDN 连接被重置；重试一次，仍失败就换清晰度/稍后再试。',
            retryable: true,
          });
        }
      } finally {
        await handle.close().catch(() => {});
      }
    } catch (error) {
      await fsp.rm(partPath, { force: true }).catch(() => {});
      throw asBiliError(error, '写入下载文件失败', signal);
    }

    throwIfAborted(signal);
    await replaceFile(partPath, destination);
    return written;
  };

  /**
   * 走 ffmpeg 合并路径。
   * @param {{ videoStream: any, audioStream: any, filePath: string, ffmpegPath?: string,
   *   signal?: AbortSignal }} params - 参数。
   * @returns {Promise<{ bytes: number, merged: boolean }>} 结果。
   */
  const downloadMerged = async ({ videoStream, audioStream, filePath, ffmpegPath, signal }) => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-bilibili-'));
    try {
      const inputs = [];
      let total = 0;
      if (videoStream !== null) {
        const videoPath = path.join(tempDir, 'video.m4s');
        total += await downloadStream(videoStream.url, videoPath, signal, maxBytes - total);
        inputs.push(videoPath);
      }
      if (audioStream !== null) {
        const audioPath = path.join(tempDir, 'audio.m4s');
        total += await downloadStream(audioStream.url, audioPath, signal, maxBytes - total);
        inputs.push(audioPath);
      }
      if (total > maxBytes) throw sizeLimitError(maxBytes);
      throwIfAborted(signal);

      const partOutput = `${filePath}.part${path.extname(filePath)}`;
      const ffmpegArgs = ['-y'];
      for (const input of inputs) ffmpegArgs.push('-i', input);
      ffmpegArgs.push('-c', 'copy', '-movflags', '+faststart', partOutput);
      try {
        await executeFfmpeg(ffmpegArgs, { signal, cwd: tempDir, command: ffmpegPath });
        throwIfAborted(signal);
        await replaceFile(partOutput, filePath);
      } catch (error) {
        await fsp.rm(partOutput, { force: true }).catch(() => {});
        throw asBiliError(error, 'ffmpeg 合并失败', signal);
      }
      const stat = await fsp.stat(filePath);
      return { bytes: stat.size, merged: videoStream !== null && audioStream !== null };
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  /**
   * 下载一个整段单文件（durl 或裸音频流）。
   * @param {{ url: string, filePath: string, signal?: AbortSignal }} params - 参数。
   * @returns {Promise<number>} 字节数。
   */
  const downloadSingle = async ({ url, filePath, signal }) => {
    return downloadStream(url, filePath, signal, maxBytes);
  };

  /**
   * 执行一次下载。
   * @param {Record<string, any>} [args] - 工具参数：`target`（必填）、`page`、`quality`、
   *   `audioOnly`、`dir`、`overwrite`。
   * @param {{ signal?: AbortSignal }} [exec] - 执行上下文。
   * @returns {Promise<{ file: string, bytes: number, sizeText: string, quality: string,
   *   durationSec?: number, merged: boolean, audioOnly: boolean, elapsedMs: number }>} 下载结果。
   * @throws {BiliError} 参数非法、流不可用、超限、取消或 io/ffmpeg 失败时。
   */
  const run = async (args = {}, exec = {}) => {
    const startedAt = now();
    const signal = exec?.signal;
    throwIfAborted(signal);

    const target = typeof args.target === 'string' ? args.target.trim() : '';
    if (target === '') {
      throw new BiliError('缺少下载目标：请传 BV 号、av 号或视频链接。', {
        code: CODES.INVALID_ARGUMENT,
        hint: '例如 bili_download target=BV1xx411c7mD。',
      });
    }
    const quality = normalizeQuality(args.quality);
    const audioOnly = args.audioOnly === true;
    const requestedPage = normalizePage(args.page);
    const overwrite = args.overwrite === true;

    let resolved;
    try {
      resolved = await api.resolveTarget(target);
    } catch (error) {
      throw asBiliError(error, '解析下载目标失败', signal);
    }
    throwIfAborted(signal);
    const resolvedPage = requestedPage ?? (Number.isInteger(resolved?.page) && resolved.page > 0 ? resolved.page : 1);

    let play;
    const playTarget = targetWithPage(target, resolved, resolvedPage);
    try {
      play = await api.playurl({ target: playTarget, page: resolvedPage, quality, audioOnly });
    } catch (error) {
      throw asBiliError(error, '获取播放地址失败', signal);
    }
    throwIfAborted(signal);

    let streams = Array.isArray(play?.video) ? play.video : [];
    let audioStreams = Array.isArray(play?.audio) ? play.audio : [];
    let durlEntries = Array.isArray(play?.durl) ? play.durl : [];
    let durl = durlEntries.find((entry) => entry !== null && typeof entry === 'object' && typeof entry.url === 'string' && entry.url !== '') ?? null;

    const detection = await detectFfmpeg();
    const ffmpegAvailable = detection.available === true;

    // 没有 ffmpeg 且不是纯音频：DASH 分轨没法合并，改要 B 站的整段 MP4（durl）。
    // 这一步在第一个 playurl 响应里通常为空，必须显式带 durlOnly 再请求一次。
    if (!ffmpegAvailable && !audioOnly && durl === null) {
      try {
        const fallbackPlay = await api.playurl({ target: playTarget, page: resolvedPage, quality, durlOnly: true });
        const fallbackDurl = Array.isArray(fallbackPlay?.durl) ? fallbackPlay.durl : [];
        const firstDurl = fallbackDurl.find((entry) => entry !== null && typeof entry === 'object' && typeof entry.url === 'string' && entry.url !== '') ?? null;
        if (firstDurl !== null) {
          play = fallbackPlay;
          streams = Array.isArray(fallbackPlay?.video) ? fallbackPlay.video : [];
          audioStreams = Array.isArray(fallbackPlay?.audio) ? fallbackPlay.audio : [];
          durlEntries = fallbackDurl;
          durl = firstDurl;
        }
      } catch {
        // 保留最初的 DASH 响应，让下面的策略分支给出 FFMPEG_MISSING 的可执行提示。
      }
      throwIfAborted(signal);
    }

    const hasVideo = streams.length > 0;
    const hasAudio = audioStreams.length > 0;

    /** @type {'merge'|'durl'|'raw-audio'|null} */
    let strategy = null;
    if (ffmpegAvailable && (hasVideo || hasAudio)) strategy = 'merge';
    else if (audioOnly && hasAudio) strategy = 'raw-audio';
    else if (durl !== null) strategy = 'durl';
    else if (hasVideo) {
      throw new BiliError('没有可用的 ffmpeg，无法把 DASH 音视频合并成 MP4。', {
        code: CODES.FFMPEG_MISSING,
        hint: '安装 ffmpeg 并配置 ffmpegPath（或加入 PATH），或者用 audioOnly=true 只下音频；B 站这次没有提供 durl 单文件。',
      });
    } else {
      throw new BiliError('播放地址里没有任何可下载的流。', {
        code: CODES.DOWNLOAD,
        hint: '换清晰度或换目标；仍失败说明该视频有地区/版权/会员限制。',
      });
    }

    const extension = strategy === 'raw-audio' ? '.m4s' : (audioOnly ? '.m4a' : '.mp4');
    const bvid = typeof resolved?.bvid === 'string' && resolved.bvid !== '' ? resolved.bvid : (typeof play?.media?.bvid === 'string' ? play.media.bvid : '');
    const title = typeof resolved?.title === 'string' && resolved.title !== ''
      ? resolved.title
      : (typeof play?.media?.title === 'string' ? play.media.title : '');
    const basename = buildBasename({ title, bvid, page: resolvedPage, audioOnly });

    const root = resolveDownloadRoot(config.downloadDir);
    let directory;
    try {
      directory = resolveDownloadDir(root, typeof args.dir === 'string' ? args.dir : undefined);
    } catch (error) {
      throw new BiliError(`下载目录不合法：${errorMessage(error)}`, {
        code: CODES.INVALID_ARGUMENT,
        hint: `dir 只能是下载根目录（${root}）内的相对子路径；检查是否用了 .. 或根目录外的绝对路径。`,
        cause: error,
      });
    }
    const filePath = uniqueFilePath(directory, basename, extension, overwrite);

    let bytes;
    let merged = false;
    if (strategy === 'merge') {
      const result = await downloadMerged({
        videoStream: hasVideo ? pickVideoStream(streams, quality) : null,
        audioStream: hasAudio ? pickAudioStream(audioStreams) : null,
        filePath,
        ffmpegPath: typeof detection.path === 'string' ? detection.path : undefined,
        signal,
      });
      bytes = result.bytes;
      merged = result.merged;
    } else if (strategy === 'durl') {
      if (durl === null) throw new BiliError('没有可下载的 durl 地址。', { code: CODES.DOWNLOAD, hint: '重新调用 bili_download 获取新的播放地址。' });
      bytes = await downloadSingle({ url: durl.url, filePath, signal });
    } else {
      const audioStream = pickAudioStream(audioStreams);
      if (audioStream === null) throw new BiliError('没有可下载的音频流。', { code: CODES.DOWNLOAD, hint: '换目标或换清晰度重试。' });
      bytes = await downloadSingle({ url: audioStream.url, filePath, signal });
    }

    throwIfAborted(signal);
    const durationSource = Number.isFinite(Number(play?.media?.durationSec))
      ? Number(play.media.durationSec)
      : (Number.isFinite(Number(resolved?.durationSec)) ? Number(resolved.durationSec) : undefined);
    const qualityLabel = qualityLabelOf(play, quality);

    /** @type {{ file: string, bytes: number, sizeText: string, quality: string,
     *   durationSec?: number, merged: boolean, audioOnly: boolean, elapsedMs: number }} */
    const result = {
      file: filePath,
      bytes,
      sizeText: formatBytes(bytes),
      quality: qualityLabel,
      merged,
      audioOnly,
      elapsedMs: Math.max(0, now() - startedAt),
    };
    if (durationSource !== undefined) result.durationSec = durationSource;
    return result;
  };

  return { run };
}
