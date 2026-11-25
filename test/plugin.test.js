import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, PANEL_ROUTE, registerCommands } from '../lib/index.js';
import {
  createFakeApi,
  createFakeCtx,
  createFakeWebServer,
  createMemoryAttachments,
  createMemoryCredentials,
} from './helpers.js';

/** 20 个工具名（顺序无关）。 */
const TOOL_NAMES = [
  'bili_status', 'bili_search', 'bili_video', 'bili_user', 'bili_ranking', 'bili_popular',
  'bili_hotwords', 'bili_comments', 'bili_danmaku', 'bili_bangumi', 'bili_live', 'bili_playurl',
  'bili_subtitle', 'bili_login', 'bili_me', 'bili_history', 'bili_favorites', 'bili_follows',
  'bili_dynamic', 'bili_download',
];

/**
 * 装配一个带全套假服务的上下文。
 * @param {Record<string, unknown>} [config] - 配置覆盖。
 * @returns {Promise<{ ctx: any, tools: object[], disposers: Function[], webServer: object, credentials: object, attachments: object }>}
 *   装配结果。
 */
async function boot(config = {}) {
  const webServer = createFakeWebServer();
  const credentials = createMemoryCredentials({});
  const attachments = createMemoryAttachments();
  const fake = createFakeCtx({
    credentials,
    attachments,
    webServer,
    skills: { register: (definition) => () => definition },
    commands: { register: (definition) => () => definition },
  });
  await apply(fake.ctx, config);
  return { ...fake, webServer, credentials, attachments };
}

test('apply 注册 20 个工具、面板路由、技能与 3 个命令', async () => {
  const { tools, webServer, disposers } = await boot();
  assert.equal(tools.length, 20);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.output.schema.type, 'object');
  }
  assert.equal(webServer.routes.length, 1);
  assert.equal(webServer.routes[0].kind, 'prefix');
  assert.equal(webServer.routes[0].path, PANEL_ROUTE);
  assert.equal(typeof webServer.routes[0].resource, 'function');
  assert.ok(disposers.length >= 24);
});

test('webServer 晚于插件挂载时，inject 后补注册面板路由', async () => {
  const fake = createFakeCtx({
    credentials: createMemoryCredentials({}),
    attachments: createMemoryAttachments(),
    skills: { register: () => () => {} },
    commands: { register: () => () => {} },
  });
  await apply(fake.ctx, {});
  assert.equal(fake.tools.length, 20);

  const webServer = createFakeWebServer();
  fake.provide('webServer', webServer);
  assert.equal(webServer.routes.length, 1);
  assert.equal(webServer.routes[0].kind, 'prefix');
  assert.equal(webServer.routes[0].path, PANEL_ROUTE);
});

test('publicRoute=false 时不注册面板路由，也不等待服务', async () => {
  const { webServer, tools } = await boot({ publicRoute: false });
  assert.equal(tools.length, 20);
  assert.equal(webServer.routes.length, 0);
});

test('工具名唯一且都带 bili_ 前缀', async () => {
  const { tools } = await boot();
  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^bili_[a-z]+$/);
});

test('配置告警写进日志但不阻断激活', async () => {
  const { logger } = await boot({ requestTimeoutMs: 5, attachImages: 'nope' });
  const warnings = logger.entries.filter((entry) => entry.level === 'warn' && entry.message.includes('配置项'));
  assert.equal(warnings.length, 2);
});

test('两个必需参数的工具在 coerce 层就拒绝缺参', async () => {
  const { tools } = await boot();
  const search = tools.find((tool) => tool.name === 'bili_search');
  await assert.rejects(() => search.execute({}, { signal: undefined }), /缺少必填参数 keyword/);
  const bangumi = tools.find((tool) => tool.name === 'bili_bangumi');
  assert.equal(bangumi.parameters.required, undefined);
  const video = tools.find((tool) => tool.name === 'bili_video');
  await assert.rejects(() => video.execute({}, { signal: undefined }), /缺少必填参数 target/);
});

test('registerCommands 注册 3 个命令并共享工具实现', async () => {
  const definitions = [
    {
      name: 'bili_status',
      execute: async () => ({ ok: true, data: { version: '0.1.0' } }),
      output: { render: () => [{ type: 'text', text: 'status-ok' }] },
    },
  ];
  const registered = [];
  const commands = {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
  };
  const disposers = registerCommands(commands, definitions);
  assert.equal(disposers.length, 3);
  assert.deepEqual(registered.map((definition) => definition.name), ['bili-status', 'bili-search', 'bili-download']);

  const status = await registered[0].handler({ rawInput: '', signal: undefined });
  assert.equal(status.kind, 'success');
  assert.equal(status.text, 'status-ok');

  const empty = await registered[1].handler({ rawInput: '   ', signal: undefined });
  assert.equal(empty.kind, 'error');
  assert.match(empty.text, /用法/);

  const download = await registered[2].handler({ rawInput: 'BV1GJ411x7h7 audio', signal: undefined });
  assert.equal(download.kind, 'error');
  assert.match(download.text, /bili_download 未注册/);
});

test('createFakeApi 覆盖方法是可用的测试底座', async () => {
  const api = createFakeApi({ hotwords: { items: [{ keyword: '测试' }] } });
  assert.deepEqual(await api.hotwords({ limit: 1 }), { items: [{ keyword: '测试' }] });
  assert.equal(api.calls.length, 1);
  await assert.rejects(() => api.search({}), /未实现/);
});
