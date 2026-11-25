/**
 * HTTP 客户端：默认头、重试、超时/取消、错误码映射、各返回类型。
 *
 * 全部用注入的假 fetch，不联网。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CODES, BiliError } from '../lib/errors.js';
import { createHttpClient, DEFAULT_USER_AGENT } from '../lib/http.js';
import { createFakeLogger } from './helpers.js';

/**
 * 造一个 Response 替身。
 * @param {{ status?: number, body?: any, headers?: Record<string, string>, url?: string }} [options] - 选项。
 * @returns {object} 假 Response。
 */
function makeResponse(options = {}) {
  const status = options.status ?? 200;
  const body = options.body ?? '';
  const headers = new Headers(options.headers ?? {});
  return {
    status,
    ok: status >= 200 && status < 300,
    url: options.url ?? '',
    headers,
    body: null,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
    async arrayBuffer() {
      /** @type {Uint8Array} */
      let bytes;
      if (body instanceof Uint8Array) bytes = body;
      else bytes = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

/**
 * 按顺序返回预设结果的假 fetch。
 * @param {Array<object | Error | ((url: string, options: any) => any)>} steps - 每一步：假 Response / 要抛的错 / 处理函数。
 * @param {Array<{ url: string, options: any }>} calls - 调用记录。
 * @returns {Function} 假 fetch。
 */
function scriptFetch(steps, calls = []) {
  let index = 0;
  return async (url, options) => {
    calls.push({ url, options });
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(url, options);
    return step;
  };
}

test('默认请求头：UA/Referer/Accept-Language，调用方可覆盖', async () => {
  const calls = [];
  const http = createHttpClient({
    fetchImpl: scriptFetch([makeResponse({ body: { code: 0 } })], calls),
    sleep: async () => {},
  });
  assert.equal(http.userAgent, DEFAULT_USER_AGENT);
  assert.match(http.userAgent, /Chrome\/\d+/);

  const body = await http.getJson('https://api.bilibili.com/x/test');
  assert.deepEqual(body, { code: 0 });
  assert.equal(calls.length, 1);
  const headers = calls[0].options.headers;
  assert.equal(headers['user-agent'], DEFAULT_USER_AGENT);
  assert.equal(headers.referer, 'https://www.bilibili.com/');
  assert.equal(headers['accept-language'], 'zh-CN,zh;q=0.9');
  assert.match(headers.accept, /application\/json/);
  assert.equal(calls[0].options.redirect, 'follow');

  const overridden = [];
  const custom = createHttpClient({
    userAgent: 'my-agent/1.0',
    fetchImpl: scriptFetch([makeResponse({ body: {} })], overridden),
    sleep: async () => {},
  });
  assert.equal(custom.userAgent, 'my-agent/1.0');
  await custom.getJson('https://api.bilibili.com/x/test', {
    headers: { 'user-agent': 'caller-agent', Referer: 'https://example.com/' },
  });
  assert.equal(overridden[0].options.headers['user-agent'], 'caller-agent');
  assert.equal(overridden[0].options.headers.referer, 'https://example.com/');
});

test('getJson 网络错误重试 2 次（共 3 次），并在第 3 次成功', async () => {
  const calls = [];
  /** @type {number[]} */
  const sleeps = [];
  const http = createHttpClient({
    fetchImpl: scriptFetch([
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      makeResponse({ body: { code: 0, data: { ok: true } } }),
    ], calls),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const body = await http.getJson('https://api.bilibili.com/x/test');
  assert.deepEqual(body.data, { ok: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [300, 600]);
});

test('getJson 对 5xx 重试、对 4xx 不重试；超限后抛 BILI_HTTP', async () => {
  const okCalls = [];
  const retryOk = createHttpClient({
    fetchImpl: scriptFetch([
      makeResponse({ status: 503, body: 'busy' }),
      makeResponse({ status: 200, body: { code: 0 } }),
    ], okCalls),
    sleep: async () => {},
  });
  assert.deepEqual(await retryOk.getJson('https://api.bilibili.com/x/test', { retries: 1 }), { code: 0 });
  assert.equal(okCalls.length, 2);

  const notFoundCalls = [];
  const notFound = createHttpClient({
    fetchImpl: scriptFetch([makeResponse({ status: 404, body: 'nope' })], notFoundCalls),
    sleep: async () => {},
  });
  await assert.rejects(
    notFound.getJson('https://api.bilibili.com/x/test'),
    (error) => {
      assert.ok(error instanceof BiliError);
      assert.equal(error.code, CODES.HTTP);
      assert.equal(error.status, 404);
      return true;
    },
  );
  assert.equal(notFoundCalls.length, 1, '404 不应重试');

  const exhausted = createHttpClient({
    fetchImpl: scriptFetch([makeResponse({ status: 503, body: 'busy' })]),
    sleep: async () => {},
  });
  await assert.rejects(
    exhausted.getJson('https://api.bilibili.com/x/test', { retries: 1 }),
    (error) => {
      assert.equal(error.code, CODES.HTTP);
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test('412 是可读的风控错误（HTTP 码 + 风控提示）', async () => {
  const http = createHttpClient({
    fetchImpl: scriptFetch([makeResponse({ status: 412, body: '<html>blocked</html>' })]),
    sleep: async () => {},
  });
  await assert.rejects(
    http.getJson('https://api.bilibili.com/x/test'),
    (error) => {
      assert.equal(error.code, CODES.HTTP);
      assert.equal(error.status, 412);
      assert.match(error.hint, /风控/);
      return true;
    },
  );
});

test('JSON 解析失败归一成 BILI_API', async () => {
  const http = createHttpClient({
    fetchImpl: scriptFetch([makeResponse({ body: '<html>not json</html>' })]),
    sleep: async () => {},
  });
  await assert.rejects(
    http.getJson('https://api.bilibili.com/x/test'),
    (error) => {
      assert.equal(error.code, CODES.API);
      assert.match(error.message, /不是合法 JSON/);
      return true;
    },
  );
});

test('getText 返回文本并默认重试 1 次', async () => {
  const calls = [];
  const http = createHttpClient({
    fetchImpl: scriptFetch([
      new TypeError('fetch failed'),
      makeResponse({ body: 'hello 世界' }),
    ], calls),
    sleep: async () => {},
  });
  const text = await http.getText('https://www.bilibili.com/');
  assert.equal(text, 'hello 世界');
  assert.equal(calls.length, 2);
});

test('getBytes 返回 Uint8Array，非 2xx 抛 BILI_HTTP', async () => {
  const bytes = Uint8Array.from([0x0a, 0x03, 0x01, 0x02, 0x03]);
  const http = createHttpClient({
    fetchImpl: scriptFetch([makeResponse({ body: bytes, headers: { 'content-type': 'application/octet-stream' } })]),
    sleep: async () => {},
  });
  const result = await http.getBytes('https://api.bilibili.com/x/v2/dm/web/seg.so');
  assert.ok(result instanceof Uint8Array);
  assert.deepEqual([...result], [...bytes]);

  const failing = createHttpClient({
    fetchImpl: scriptFetch([makeResponse({ status: 403, body: 'forbidden' })]),
    sleep: async () => {},
  });
  await assert.rejects(
    failing.getBytes('https://api.bilibili.com/x/v2/dm/web/seg.so'),
    (error) => {
      assert.equal(error.code, CODES.HTTP);
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test('open 返回 status/headers/body/contentLength/url', async () => {
  const http = createHttpClient({
    fetchImpl: scriptFetch([
      makeResponse({
        status: 200,
        body: 'video-bytes',
        headers: { 'content-length': '1024', 'content-type': 'video/mp4' },
        url: 'https://upos.example.com/video.m4s',
      }),
    ]),
    sleep: async () => {},
  });
  const response = await http.open('https://upos.example.com/video.m4s');
  assert.equal(response.status, 200);
  assert.equal(response.contentLength, 1024);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.url, 'https://upos.example.com/video.m4s');
  assert.equal(response.body, null);
});

test('超时抛 BILI_TIMEOUT（不是网络错误）', async () => {
  const http = createHttpClient({
    timeoutMs: 25,
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
    sleep: async () => {},
  });
  await assert.rejects(
    http.getJson('https://api.bilibili.com/x/slow', { retries: 0 }),
    (error) => {
      assert.ok(error instanceof BiliError);
      assert.equal(error.code, CODES.TIMEOUT);
      assert.equal(error.retryable, true);
      assert.match(error.hint, /requestTimeoutMs/);
      return true;
    },
  );
});

test('调用方取消保留原始 AbortError，且不重试', async () => {
  const calls = [];
  const controller = new AbortController();
  const http = createHttpClient({
    fetchImpl: (url, options) => {
      calls.push({ url, options });
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
    sleep: async () => {},
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    http.getJson('https://api.bilibili.com/x/slow', { signal: controller.signal }),
    (error) => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error instanceof BiliError, false);
      return true;
    },
  );
  assert.equal(calls.length, 1);

  // 已经取消的信号：直接抛 AbortError，不发请求。
  const aborted = new AbortController();
  aborted.abort();
  const second = createHttpClient({ fetchImpl: scriptFetch([makeResponse({})]) });
  await assert.rejects(second.getJson('https://api.bilibili.com/x/test', { signal: aborted.signal }), (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
});

test('重试时会记告警日志', async () => {
  const logger = createFakeLogger();
  const http = createHttpClient({
    fetchImpl: scriptFetch([new TypeError('fetch failed'), makeResponse({ body: { code: 0 } })]),
    logger,
    sleep: async () => {},
  });
  await http.getJson('https://api.bilibili.com/x/test', { retries: 1 });
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].level, 'warn');
  assert.match(logger.entries[0].message, /重试/);
});
