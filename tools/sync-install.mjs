#!/usr/bin/env node
/**
 * 仓库 → 安装副本同步 / 比对。
 *
 * 用法（在仓库根或任意目录）：
 *   node tools/sync-install.mjs            # robocopy /MIR 同步到 %USERPROFILE%\dsh-bundles\bilibili
 *   node tools/sync-install.mjs --check    # 只比对（路径集合 + SHA256），不写任何文件
 *   node tools/sync-install.mjs --to <目录> # 覆盖目标目录
 *
 * 同步后必须重启 DSH：Host 进程缓存已加载的 ESM 模块。
 *
 * @module @local/bilibili/tools/sync-install
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXCLUDED_DIRS = new Set(['.git', 'test', '.admin', 'node_modules']);
const EXCLUDED_FILES = new Set(['.gitignore']);

/**
 * 解析命令行参数。
 * @param {string[]} argv - `process.argv.slice(2)`。
 * @returns {{ check: boolean, to: string }} 选项。
 */
function parseArgs(argv) {
  let check = false;
  let to = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') check = true;
    else if (arg === '--to') {
      to = argv[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--to=')) to = arg.slice('--to='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node tools/sync-install.mjs [--check] [--to <目录>]');
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return { check, to };
}

/**
 * 递归收集相对文件路径。
 * @param {string} root - 根目录。
 * @returns {string[]} 排序后的相对路径（POSIX 分隔符）。
 */
function listFiles(root) {
  /** @type {string[]} */
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(path.join(directory, entry.name));
      } else if (entry.isFile()) {
        if (EXCLUDED_FILES.has(entry.name)) continue;
        files.push(path.relative(root, path.join(directory, entry.name)).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return files.sort();
}

/**
 * 文件 SHA256。
 * @param {string} file - 文件路径。
 * @returns {string} 十六进制摘要。
 */
function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 比对两个目录。
 * @param {string} source - 源。
 * @param {string} target - 目标。
 * @returns {{ missing: string[], extra: string[], changed: string[] }} 差异。
 */
function diffTrees(source, target) {
  const sourceFiles = listFiles(source);
  const targetFiles = fs.existsSync(target) ? listFiles(target) : [];
  const targetSet = new Set(targetFiles);
  const sourceSet = new Set(sourceFiles);
  const missing = sourceFiles.filter((file) => !targetSet.has(file));
  const extra = targetFiles.filter((file) => !sourceSet.has(file) && file !== 'DO-NOT-DELETE.txt');
  const changed = sourceFiles.filter((file) => {
    if (!targetSet.has(file)) return false;
    return hashFile(path.join(source, file)) !== hashFile(path.join(target, file));
  });
  return { missing, extra, changed };
}

/**
 * 用 robocopy 镜像同步；失败时回退到逐文件复制。
 * @param {string} source - 源。
 * @param {string} target - 目标。
 * @returns {number} 退出码（0 成功）。
 */
function syncWithRobocopy(source, target) {
  fs.mkdirSync(target, { recursive: true });
  const args = [
    source, target, '/MIR',
    '/XD', '.git', 'test', '.admin', 'node_modules',
    '/XF', '.gitignore',
    '/NFL', '/NDL', '/NJH', '/NJS', '/R:2', '/W:1',
  ];
  const result = spawnSync('robocopy', args, { stdio: 'inherit' });
  if (result.error !== undefined) {
    console.error(`robocopy 不可用（${result.error.message}），回退到逐文件复制。`);
    return copyFallback(source, target);
  }
  return (result.status ?? 1) < 8 ? 0 : (result.status ?? 1);
}

/**
 * 无 robocopy 时的回退：复制缺失/变更文件，删除多余文件（保留 marker）。
 * @param {string} source - 源。
 * @param {string} target - 目标。
 * @returns {number} 退出码。
 */
function copyFallback(source, target) {
  const { missing, extra, changed } = diffTrees(source, target);
  for (const file of [...missing, ...changed]) {
    const to = path.join(target, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(source, file), to);
  }
  for (const file of extra) fs.rmSync(path.join(target, file), { force: true });
  return 0;
}

const options = parseArgs(process.argv.slice(2));
const destination = options.to !== ''
  ? path.resolve(options.to)
  : path.join(os.homedir(), 'dsh-bundles', 'bilibili');

if (options.check) {
  const { missing, extra, changed } = diffTrees(repoRoot, destination);
  if (missing.length === 0 && extra.length === 0 && changed.length === 0) {
    console.log(`一致：${repoRoot} → ${destination}`);
    process.exit(0);
  }
  console.error(`不一致：${repoRoot} → ${destination}`);
  for (const file of missing) console.error(`  缺失 ${file}`);
  for (const file of changed) console.error(`  变更 ${file}`);
  for (const file of extra) console.error(`  多出 ${file}`);
  process.exit(1);
}

console.log(`同步：${repoRoot} → ${destination}`);
const code = syncWithRobocopy(repoRoot, destination);
console.log(code === 0 ? '同步完成。同步后必须重启 DSH 才生效。' : `同步失败，退出码 ${code}。`);
process.exit(code);
