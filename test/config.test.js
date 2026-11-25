import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, PLUGIN_VERSION, normalizeConfig, normalizeConfigWithWarnings } from '../lib/config.js';

test('默认配置与 package.json 版本一致', () => {
  const { config, warnings } = normalizeConfigWithWarnings({});
  assert.deepEqual(config, DEFAULTS);
  assert.deepEqual(warnings, []);
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/);
});

test('未定义字段取默认值，允许空字符串的字段保持空', () => {
  const config = normalizeConfig({ downloadDir: '', ffmpegPath: '  ', cookieEnv: '  MY_COOKIE  ' });
  assert.equal(config.downloadDir, '');
  assert.equal(config.ffmpegPath, '');
  assert.equal(config.cookieEnv, 'MY_COOKIE');
});

test('非法值逐字段告警并回退', () => {
  const { config, warnings } = normalizeConfigWithWarnings({
    requestTimeoutMs: 10,
    maxListedItems: -3,
    attachImages: 'yes',
    maxDownloadMb: 0,
    cacheTtlMs: 'fast',
    wbiCacheTtlMs: 1,
    downloadDir: 42,
  });
  assert.equal(config.requestTimeoutMs, DEFAULTS.requestTimeoutMs);
  assert.equal(config.maxListedItems, DEFAULTS.maxListedItems);
  assert.equal(config.attachImages, DEFAULTS.attachImages);
  assert.equal(config.maxDownloadMb, DEFAULTS.maxDownloadMb);
  assert.equal(config.cacheTtlMs, DEFAULTS.cacheTtlMs);
  assert.equal(config.wbiCacheTtlMs, DEFAULTS.wbiCacheTtlMs);
  assert.equal(config.downloadDir, DEFAULTS.downloadDir);
  assert.equal(warnings.length, 7);
  for (const warning of warnings) assert.match(warning, /配置项/);
});

test('合法边界值被接受并取整', () => {
  const config = normalizeConfig({
    requestTimeoutMs: 1000,
    maxListedItems: 200,
    requestTimeoutMs2: 1,
    maxDownloadMb: 1,
    cacheTtlMs: 1000,
    wbiCacheTtlMs: 86400000,
    attachImages: false,
    panelEnabled: false,
    publicRoute: false,
    ffmpegPath: 'C:\\tools\\ffmpeg.exe',
  });
  assert.equal(config.requestTimeoutMs, 1000);
  assert.equal(config.maxListedItems, 200);
  assert.equal(config.maxDownloadMb, 1);
  assert.equal(config.cacheTtlMs, 1000);
  assert.equal(config.wbiCacheTtlMs, 86400000);
  assert.equal(config.attachImages, false);
  assert.equal(config.panelEnabled, false);
  assert.equal(config.publicRoute, false);
  assert.equal(config.ffmpegPath, 'C:\\tools\\ffmpeg.exe');
});

test('小数被截断而不是拒绝', () => {
  const config = normalizeConfig({ requestTimeoutMs: 1500.9, maxListedItems: 9.7 });
  assert.equal(config.requestTimeoutMs, 1500);
  assert.equal(config.maxListedItems, 9);
});

test('cookieEnv 非法标识符回退并告警', () => {
  const { config, warnings } = normalizeConfigWithWarnings({ cookieEnv: '坏 名字' });
  assert.equal(config.cookieEnv, DEFAULTS.cookieEnv);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cookieEnv/);
});
