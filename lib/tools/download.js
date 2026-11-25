/**
 * `bili_download` 工具：把视频/音频下载到本地下载目录。
 *
 * 真正的下载逻辑在 `lib/download.js`（`deps.downloader.run`）。这里只做参数收集、
 * 进度无关的结果渲染，以及 DSH 工具契约要求的两件事：`timeoutMs: 1800000`（长任务）
 * 与 `isConcurrencySafe: () => false`（同一个下载目录并发写会互相踩）。
 *
 * @module @local/bilibili/tools/download
 */

import { BiliError, CODES, invalidArgument } from '../errors.js';
import { defineTool, renderResult } from '../tool-kit.js';

/** 允许的清晰度取值。 */
const QUALITY_VALUES = ['best', '1080', '720', '480', '360'];

/**
 * 把秒数渲染成 `mm:ss` / `h:mm:ss`。
 * @param {unknown} value - 秒数。
 * @returns {string} 文本。
 */
function formatDuration(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '未知';
  const total = Math.trunc(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (part) => String(part).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/**
 * `bili_download` 的渲染文本。
 * @param {Record<string, any>} _args - 工具参数。
 * @param {{ data?: Record<string, any> }} value - 工具返回值。
 * @returns {string} 文本。
 */
function renderDownloadText(_args, value) {
  const data = value?.data ?? {};
  const lines = [
    `已下载：${data.file ?? '(未知路径)'}`,
    `大小：${data.sizeText ?? '未知'}（${data.bytes ?? 0} 字节）`,
    `清晰度：${data.quality ?? '?'}，时长：${formatDuration(data.durationSec)}，耗时：${((Number(data.elapsedMs) || 0) / 1000).toFixed(1)} 秒`,
  ];
  if (data.merged === true) lines.push('音视频已由 ffmpeg 无损合并为 MP4（-c copy）。');
  else if (data.audioOnly === true) {
    lines.push(String(data.file ?? '').endsWith('.m4a')
      ? '音频已由 ffmpeg 转封装为 .m4a（-c copy，未重新编码）。'
      : '这是仅音频文件；没有 ffmpeg 时保存的是 DASH 原始分片（.m4s）。');
  } else lines.push('这是 B 站直接提供的单文件 MP4（durl，无 ffmpeg 回退路径）。');
  return lines.join('\n');
}

/**
 * 造 `bili_download` 工具。
 * @param {{ downloader: object, config?: Record<string, any>, logger?: object }} deps - 插件依赖。
 * @returns {object[]} 只含 `bili_download` 的工具定义数组。
 */
export function createDownloadTools(deps = {}) {
  const { downloader } = deps;

  const definition = defineTool({
    name: 'bili_download',
    description:
      '把一个 B 站视频（或分P/音频）下载到本地下载目录：有 ffmpeg 时下 DASH 音视频并无损合并为 MP4，'
      + '没有 ffmpeg 时退回 B 站提供的 durl 单文件 MP4。支持清晰度选择、体积上限与取消。',
    parameters: {
      target: { type: 'string', required: true, description: 'BV 号、av 号或视频链接（例如 BV1xx411c7mD 或 https://www.bilibili.com/video/BV…）。' },
      page: { type: 'integer', description: '分P 序号，默认 1。' },
      quality: { type: 'string', enum: QUALITY_VALUES, description: '清晰度：best（默认）、1080、720、480、360。' },
      audioOnly: { type: 'boolean', description: '只下载音频（存在 ffmpeg 时转成 .m4a）。' },
      dir: { type: 'string', description: '下载根目录内的子目录（相对路径）；不允许 .. 或根目录外的绝对路径。' },
      overwrite: { type: 'boolean', description: '允许覆盖同名文件，默认 false（自动加 (2)、(3) 后缀）。' },
    },
    output: {
      schema: { type: 'object' },
      render(args, value) {
        return renderResult(renderDownloadText(args, value), value);
      },
    },
    timeoutMs: 1800000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (downloader === undefined || downloader === null || typeof downloader.run !== 'function') {
        throw new BiliError('下载器不可用：插件装配异常。', {
          code: CODES.INTERNAL,
          hint: '重启宿主后重试；持续出现请把日志里的装配错误报给插件作者。',
        });
      }
      if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') {
        throw invalidArgument('overwrite 必须是布尔值。');
      }
      const result = await downloader.run(
        {
          target: args.target,
          page: args.page,
          quality: args.quality,
          audioOnly: args.audioOnly === true,
          dir: args.dir,
          overwrite: args.overwrite === true,
        },
        exec,
      );
      return { ok: true, data: result };
    },
  });

  return [definition];
}
