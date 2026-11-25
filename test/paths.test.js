import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  defaultDownloadDir,
  formatBytes,
  resolveDownloadDir,
  resolveDownloadRoot,
  sanitizeBasename,
  uniqueFilePath,
} from '../lib/paths.js';

test('默认下载根目录在用户 Downloads 下', () => {
  const root = resolveDownloadRoot('');
  assert.equal(path.basename(root), 'dsh-bilibili');
  assert.equal(path.basename(path.dirname(root)), 'Downloads');
  assert.equal(resolveDownloadRoot('   '), defaultDownloadDir());
});

test('自定义根目录被解析为绝对路径', () => {
  const root = resolveDownloadRoot('D:\\Media\\bili');
  assert.equal(root, path.resolve('D:\\Media\\bili'));
});

test('相对子目录落在根目录内，越界路径被拒绝', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-paths-'));
  try {
    const nested = resolveDownloadDir(root, 'anime/2026');
    assert.equal(nested, path.join(root, 'anime', '2026'));
    assert.ok(fs.existsSync(nested));
    const same = resolveDownloadDir(root, '');
    assert.equal(same, path.resolve(root));
    assert.throws(() => resolveDownloadDir(root, '..'), /必须在/);
    assert.throws(() => resolveDownloadDir(root, '..\\escape'), /必须在/);
    assert.throws(() => resolveDownloadDir(root, 'D:\\Windows'), /必须在/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('文件名清洗：非法字符、空白、保留名、长度', () => {
  assert.equal(sanitizeBasename('【MV】Never/Gonna:Give?You*Up'), '【MV】Never_Gonna_Give_You_Up');
  assert.equal(sanitizeBasename('  a\tb\nc  '), 'a_b_c');
  assert.equal(sanitizeBasename('con'), 'con_');
  assert.equal(sanitizeBasename('CON'), 'CON_');
  assert.equal(sanitizeBasename(''), 'bilibili');
  assert.equal(sanitizeBasename('...'), 'bilibili');
  const long = sanitizeBasename('x'.repeat(300));
  assert.equal(long.length, 120);
  assert.equal(sanitizeBasename('trailing. . '), 'trailing');
});

test('唯一文件名：不覆盖时追加序号', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-name-'));
  try {
    const first = uniqueFilePath(directory, '标题 BV1', '.mp4', false);
    assert.equal(path.basename(first), '标题 BV1.mp4');
    fs.writeFileSync(first, 'x');
    const second = uniqueFilePath(directory, '标题 BV1', '.mp4', false);
    assert.equal(path.basename(second), '标题 BV1 (2).mp4');
    fs.writeFileSync(second, 'x');
    const third = uniqueFilePath(directory, '标题 BV1', '.mp4', false);
    assert.equal(path.basename(third), '标题 BV1 (3).mp4');
    assert.equal(uniqueFilePath(directory, '标题 BV1', '.mp4', true), first);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('字节格式化', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 12.3), '12.3 MB');
  assert.equal(formatBytes(-1), '未知大小');
  assert.equal(formatBytes('x'), '未知大小');
});
