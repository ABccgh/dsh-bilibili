/**
 * ffmpeg 探测：下载合并需要 ffmpeg，但插件本身不能假定它存在。
 *
 * 探测顺序：配置的 `ffmpegPath` → PATH 里的 `ffmpeg`。结果缓存（一次进程生命周期），
 * 失败也缓存，避免每次调用都 spawn 一次。真正的合并命令由 `lib/download.js` 执行。
 *
 * @module @local/bilibili/ffmpeg
 */

import { execFile } from 'node:child_process';

/** 探测超时（毫秒）。 */
const PROBE_TIMEOUT_MS = 8000;

/** 探测失败后的重试间隔（毫秒）：装好 ffmpeg 后不必重启 DSH，等一分钟再调即可。 */
const FAILURE_RETRY_MS = 60000;

/**
 * 执行一次 `ffmpeg -version` 并解析版本。
 * @param {string} command - 可执行文件或命令名。
 * @returns {Promise<{ available: boolean, path?: string, version?: string, error?: string }>} 探测结果。
 */
function probe(command) {
  return new Promise((resolve) => {
    execFile(command, ['-version'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error !== null && error !== undefined) {
        resolve({ available: false, error: error.message });
        return;
      }
      const match = /ffmpeg version\s+([^\s]+)/i.exec(String(stdout ?? ''));
      resolve({ available: true, path: command, version: match === null ? 'unknown' : match[1] });
    });
  });
}

/**
 * 造一个 ffmpeg 探测器。
 * @param {{ config?: { ffmpegPath?: string }, logger?: { warn?: Function } }} [options] - 依赖。
 * @returns {{ detect: (options?: { force?: boolean }) => Promise<{ available: boolean, path?: string, version?: string, error?: string }>, invalidate: () => void, status: () => { available: boolean, version?: string } | null }}
 *   探测器。
 */
export function createFfmpegProbe(options = {}) {
  const config = options.config ?? {};
  const logger = options.logger;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  /** @type {Promise<object> | null} */
  let pending = null;
  /** @type {object | null} */
  let result = null;
  /** 最近一次探测完成的时间；失败结果按 `FAILURE_RETRY_MS` 过期。 */
  let checkedAt = 0;

  /**
   * 取探测结果（懒执行 + 缓存；失败结果会过期重试）。
   * @param {{ force?: boolean }} [detectOptions] - 选项。
   * @returns {Promise<object>} 探测结果。
   */
  async function detect(detectOptions = {}) {
    const force = detectOptions.force === true;
    const staleFailure = result !== null && result.available !== true && now() - checkedAt >= FAILURE_RETRY_MS;
    if (force || staleFailure) {
      pending = null;
      result = null;
    }
    if (result !== null) return result;
    if (pending !== null) return pending;
    const configured = typeof config.ffmpegPath === 'string' ? config.ffmpegPath.trim() : '';
    pending = (async () => {
      const first = configured === ''
        ? await probe('ffmpeg')
        : await probe(configured);
      if (first.available) {
        result = first;
      } else if (configured !== '') {
        const fallback = await probe('ffmpeg');
        result = fallback.available ? { ...fallback, error: undefined } : { ...first, error: first.error ?? fallback.error };
      } else {
        result = first;
      }
      if (result.available !== true) {
        try {
          logger?.warn?.(`[bilibili] 未找到可用的 ffmpeg（${result.error ?? '未知原因'}）：高清 DASH 合并不可用，下载会退回单文件 MP4。`);
        } catch {
          // 忽略日志失败。
        }
      }
      pending = null;
      checkedAt = now();
      return result;
    })();
    return pending;
  }

  return {
    detect,
    /** 清空缓存（测试与配置热更新用）。 */
    invalidate() {
      pending = null;
      result = null;
    },
    /** 同步快照：还没探测过时返回 null。 */
    status() {
      return result;
    },
  };
}
