/**
 * 路径与文件名工具：下载目录解析、目录白名单、文件名清洗。
 *
 * 插件以 Host 进程身份运行，**没有沙箱兜底**，所以下载落盘必须由这里显式约束：
 * 任何 `dir` 参数解析后都必须落在下载根目录内，绝不允许 `..` 或绝对路径越界。
 *
 * @module @local/bilibili/paths
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Windows 文件名里不允许出现的字符（保留字符 + 控制字符）。 */
const ILLEGAL_FILENAME = /[<>:"/\\|?*\u0000-\u001F]/g;

/** Windows 保留设备名。 */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** 文件名主体最大长度（Windows 全路径 260 的保守预留）。 */
const MAX_BASENAME = 120;

/**
 * 默认下载目录：`%USERPROFILE%\Downloads\dsh-bilibili`。
 * @returns {string} 绝对路径。
 */
export function defaultDownloadDir() {
  return path.join(os.homedir(), 'Downloads', 'dsh-bilibili');
}

/**
 * 解析下载根目录。
 * @param {string} configured - 配置里的 `downloadDir`（空字符串表示默认目录）。
 * @returns {string} 绝对路径。
 */
export function resolveDownloadRoot(configured) {
  const value = typeof configured === 'string' ? configured.trim() : '';
  return value === '' ? defaultDownloadDir() : path.resolve(value);
}

/**
 * 解析并校验一个下载子目录。
 *
 * `dir` 可以是相对下载根目录的子路径，也可以是落在下载根目录内的绝对路径；
 * 其余情况一律拒绝。目标目录会被创建。
 * @param {string} root - 下载根目录（绝对路径）。
 * @param {string} [dir] - 用户传入的目录。
 * @returns {string} 绝对路径（已创建）。
 * @throws {Error} 路径越界或无法创建时。
 */
export function resolveDownloadDir(root, dir) {
  const base = path.resolve(root);
  const target = typeof dir === 'string' && dir.trim() !== ''
    ? (path.isAbsolute(dir.trim()) ? path.resolve(dir.trim()) : path.resolve(base, dir.trim()))
    : base;
  const relative = path.relative(base, target);
  if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`下载目录必须在 ${base} 内，收到 ${target}。`);
  }
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/**
 * 清洗文件名主体（不含扩展名）。
 * @param {string} name - 原始名称。
 * @param {string} [fallback] - 清洗后为空时的兜底名。
 * @returns {string} 合法文件名主体。
 */
export function sanitizeBasename(name, fallback = 'bilibili') {
  const cleaned = String(name ?? '')
    .replace(ILLEGAL_FILENAME, '_')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  const base = cleaned === '' ? fallback : cleaned;
  const trimmed = base.length > MAX_BASENAME ? base.slice(0, MAX_BASENAME).trim() : base;
  const final = trimmed === '' ? fallback : trimmed;
  return RESERVED_NAMES.has(final.toLowerCase()) ? `${final}_` : final;
}

/**
 * 选一个不冲突的文件路径。
 * @param {string} directory - 目录。
 * @param {string} basename - 文件名主体（已清洗）。
 * @param {string} extension - 带点的扩展名（如 `.mp4`）。
 * @param {boolean} overwrite - 允许覆盖时直接返回目标路径。
 * @returns {string} 可用路径。
 */
export function uniqueFilePath(directory, basename, extension, overwrite) {
  const direct = path.join(directory, `${basename}${extension}`);
  if (overwrite || !fs.existsSync(direct)) return direct;
  for (let index = 2; index <= 999; index += 1) {
    const candidate = path.join(directory, `${basename} (${index})${extension}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`目录里同名文件过多：${direct}`);
}

/**
 * 把字节数格式化成人类可读的大小。
 * @param {number} bytes - 字节数。
 * @returns {string} 例如 `12.3 MB`。
 */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '未知大小';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const digits = index === 0 ? 0 : size >= 100 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[index]}`;
}
