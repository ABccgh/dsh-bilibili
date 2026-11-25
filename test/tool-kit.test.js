import test from 'node:test';
import assert from 'node:assert/strict';

import {
  coerceArguments,
  defineTool,
  parametersToJsonSchema,
  renderResult,
  specToJsonSchema,
} from '../lib/tool-kit.js';

test('简写 spec 编译成 JSON Schema', () => {
  const schema = parametersToJsonSchema({
    keyword: { type: 'string', description: '关键词', required: true },
    page: { type: 'integer', default: 1 },
    type: { type: 'string', enum: ['video', 'user'] },
    tags: { type: 'array', items: { type: 'string' } },
    extra: { type: 'object', properties: { a: { type: 'number', required: true } }, additionalProperties: false },
  });
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['keyword']);
  assert.equal(schema.properties.keyword.description, '关键词');
  assert.equal(schema.properties.page.default, 1);
  assert.deepEqual(schema.properties.type.enum, ['video', 'user']);
  assert.equal(schema.properties.tags.items.type, 'string');
  assert.deepEqual(schema.properties.extra.required, ['a']);
  assert.equal(schema.properties.extra.additionalProperties, false);
});

test('不支持的参数类型与缺失 type 会抛错', () => {
  assert.throws(() => specToJsonSchema({ description: 'x' }), /缺少 type/);
  assert.throws(() => specToJsonSchema({ type: 'date' }), /不支持/);
  assert.throws(() => specToJsonSchema(null), /必须是一个对象/);
});

test('参数归一：字符串数字、布尔字符串、未知键与枚举', () => {
  const schema = parametersToJsonSchema({
    page: { type: 'integer' },
    ratio: { type: 'number' },
    flag: { type: 'boolean' },
    type: { type: 'string', enum: ['video', 'user'] },
    list: { type: 'array', items: { type: 'string' } },
    obj: { type: 'object' },
  });
  const args = coerceArguments(schema, {
    page: '3',
    ratio: '0.5',
    flag: 'true',
    type: 'video',
    list: ['a'],
    obj: { a: 1 },
  });
  assert.equal(args.page, 3);
  assert.equal(args.ratio, 0.5);
  assert.equal(args.flag, true);
  assert.deepEqual(args.list, ['a']);
  assert.deepEqual(args.obj, { a: 1 });
  assert.throws(() => coerceArguments(schema, { nope: 1 }), /不认识的参数/);
  assert.throws(() => coerceArguments(schema, { type: 'live' }), /只能是/);
  assert.throws(() => coerceArguments(schema, { page: 'x' }), /必须是整数/);
  assert.throws(() => coerceArguments(schema, { flag: 'maybe' }), /必须是布尔值/);
  assert.throws(() => coerceArguments(schema, []), /必须是一个对象/);
});

test('必填校验', () => {
  const schema = parametersToJsonSchema({ target: { type: 'string', required: true } });
  assert.throws(() => coerceArguments(schema, {}), /缺少必填参数 target/);
  assert.equal(coerceArguments(schema, { target: 'BV1' }).target, 'BV1');
});

test('defineTool 校验必填字段并保留回调', () => {
  assert.throws(() => defineTool({ name: '', description: 'x', output: { render() {} }, execute() {} }), /name/);
  assert.throws(() => defineTool({ name: 'a', description: '', output: { render() {} }, execute() {} }), /description/);
  assert.throws(() => defineTool({ name: 'a', description: 'x', execute() {} }), /output/);
  assert.throws(() => defineTool({ name: 'a', description: 'x', output: {}, execute() {} }), /render/);
  assert.throws(() => defineTool({ name: 'a', description: 'x', output: { render() {} } }), /execute/);
  assert.throws(
    () => defineTool({ name: 'run_code', description: 'x', output: { render() {} }, execute() {} }),
    /保留/,
  );

  const definition = defineTool({
    name: 'bili_demo',
    description: '演示',
    parameters: { target: { type: 'string', required: true } },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, render: () => [{ type: 'text', text: 'x' }] },
    execute: async (args) => ({ ok: true, echo: args.target }),
    isConcurrencySafe: () => false,
    timeoutMs: 42,
  });
  assert.equal(definition.name, 'bili_demo');
  assert.equal(definition.parameters.additionalProperties, false);
  assert.equal(definition.timeoutMs, 42);
  assert.equal(definition.isConcurrencySafe(), false);
});

test('execute 把 BiliError 的 hint 拼进 message（工具错误只展示 message）', async () => {
  const { BiliError } = await import('../lib/errors.js');
  const definition = defineTool({
    name: 'bili_hint_demo',
    description: '演示',
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, render: () => [] },
    execute: async () => {
      throw new BiliError('需要登录', { code: 'BILI_AUTH_REQUIRED', hint: '先 bili_login action=start' });
    },
  });
  await assert.rejects(
    () => definition.execute({}, {}),
    (error) => error.message === '需要登录\n提示：先 bili_login action=start',
  );
});

test('execute 不重复拼接已经包含提示的 message', async () => {
  const { BiliError } = await import('../lib/errors.js');
  const definition = defineTool({
    name: 'bili_hint_demo2',
    description: '演示',
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } }, render: () => [] },
    execute: async () => {
      throw new BiliError('需要登录\n提示：已经带了', { hint: '不该重复' });
    },
  });
  await assert.rejects(
    () => definition.execute({}, {}),
    (error) => error.message === '需要登录\n提示：已经带了',
  );
});

test('renderResult 把 JSON 围栏放在最后一段', () => {
  const blocks = renderResult('人类文本', { ok: true, data: { a: 1 } }, [{ type: 'image', attachment: { attachmentId: 'x' } }]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /^人类文本\n\n```json\n/);
  assert.match(blocks[0].text, /\n```$/);
  const fence = blocks[0].text.slice(blocks[0].text.lastIndexOf('```json'));
  assert.ok(fence.startsWith('```json'));
  assert.deepEqual(JSON.parse(fence.split('\n').slice(1, -1).join('\n')), { ok: true, data: { a: 1 } });
  assert.equal(blocks[1].type, 'image');
});

test('renderResult 空文本只输出围栏', () => {
  const blocks = renderResult('', { ok: true });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /^```json/);
});
