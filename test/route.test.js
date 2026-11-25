import test from 'node:test';
import assert from 'node:assert/strict';

import { createPanelResource, PANEL_ROUTE_PREFIX } from '../lib/route.js';
import { BiliError, CODES } from '../lib/errors.js';
import { createFakeApi } from './helpers.js';

/** 基础配置。 */
const CONFIG = { maxListedItems: 25, cacheTtlMs: 60000, downloadDir: '' };

/**
 * 造一个请求。
 * @param {string} path - 路由相对路径（含查询）。
 * @param {RequestInit} [init] - 请求选项。
 * @returns {Request} 请求。
 */
function request(path, init = {}) {
  return new Request(`http://127.0.0.1:53093${PANEL_ROUTE_PREFIX}${path}`, init);
}

/**
 * 造一个资源函数。
 * @param {{ api?: object, config?: object, ffmpeg?: object, fetchImpl?: Function, version?: string }} [options] - 覆盖项。
 * @returns {Function} 资源函数。
 */
function create(options = {}) {
  return createPanelResource({
    api: options.api ?? createFakeApi(),
    config: options.config ?? CONFIG,
    logger: { warn: () => {} },
    ffmpeg: options.ffmpeg ?? { detect: async () => ({ available: false }) },
    version: options.version ?? '0.1.0',
    fetchImpl: options.fetchImpl,
  });
}

/**
 * 读 JSON 响应。
 * @param {Response} response - 响应。
 * @returns {Promise<any>} 负载。
 */
async function body(response) {
  return JSON.parse(await response.text());
}

test('/status 返回版本、登录态、ffmpeg 与下载目录', async () => {
  const api = createFakeApi({
    status: { loggedIn: true, user: { uname: '测试用户', level: 6 }, cookie: { configured: true } },
  });
  const response = await create({
    api,
    ffmpeg: { detect: async () => ({ available: true, version: '7.1' }) },
  })(request('/status'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await body(response);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.version, '0.1.0');
  assert.equal(payload.data.loggedIn, true);
  assert.equal(payload.data.uname, '测试用户');
  assert.equal(payload.data.ffmpeg.available, true);
  assert.equal(payload.data.ffmpeg.version, '7.1');
  assert.match(payload.data.downloadDir, /dsh-bilibili$/);
});

test('/hot 把 limit 传给 api 并截断', async () => {
  const api = createFakeApi({ hotwords: { items: Array.from({ length: 30 }, (_, index) => ({ keyword: `k${index}` })) } });
  const response = await create({ api })(request('/hot?limit=7'));
  const payload = await body(response);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.items.length, 7);
  assert.deepEqual(api.calls[0], { method: 'hotwords', args: [{ limit: 7 }] });
});

test('/search 校验参数并返回归一化结果', async () => {
  const api = createFakeApi({ search: { keyword: '明日方舟', type: 'video', page: 1, hasMore: false, items: [{ bvid: 'BV1xx411c7mD', title: 't', type: 'video', url: 'u' }] } });
  const resource = create({ api });
  const missing = await resource(request('/search'));
  assert.equal(missing.status, 400);
  assert.equal((await body(missing)).error.code, CODES.INVALID_ARGUMENT);

  const badType = await resource(request('/search?keyword=x&type=wrong'));
  assert.equal(badType.status, 400);

  const ok = await resource(request('/search?keyword=' + encodeURIComponent('明日方舟') + '&type=video&page=2'));
  assert.equal(ok.status, 200);
  const payload = await body(ok);
  assert.equal(payload.data.keyword, '明日方舟');
  assert.equal(payload.data.page, 2);
  assert.equal(payload.data.items.length, 1);
  assert.deepEqual(api.calls.at(-1), { method: 'search', args: [{ keyword: '明日方舟', type: 'video', page: 2, pageSize: 20 }] });
});

test('/video 只接受 BV 号并透传 video/parts', async () => {
  const api = createFakeApi({ video: { video: { bvid: 'BV1GJ411x7h7', title: 't' }, parts: [{ cid: 1 }] } });
  const resource = create({ api });
  const bad = await resource(request('/video?bvid=123'));
  assert.equal(bad.status, 400);
  const ok = await resource(request('/video?bvid=BV1GJ411x7h7'));
  assert.equal(ok.status, 200);
  const payload = await body(ok);
  assert.equal(payload.data.video.bvid, 'BV1GJ411x7h7');
  assert.equal(payload.data.parts.length, 1);
});

test('未知路径 404，HEAD 没有响应体', async () => {
  const resource = create({ api: createFakeApi({ status: { loggedIn: false } }) });
  const unknown = await resource(request('/nope'));
  assert.equal(unknown.status, 404);
  const head = await resource(request('/status', { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.ok(Number(head.headers.get('content-length')) > 0);
});

test('缓存让重复请求只打一次 api，错误不缓存', async () => {
  const api = createFakeApi({ hotwords: { items: [{ keyword: 'k' }] } });
  const resource = create({ api });
  await resource(request('/hot'));
  await resource(request('/hot'));
  assert.equal(api.calls.length, 1);

  let failures = 0;
  const flaky = createFakeApi({
    hotwords: async () => {
      failures += 1;
      throw new BiliError('风控', { code: CODES.RISK, hint: '稍后重试' });
    },
  });
  const flakyResource = create({ api: flaky });
  const first = await flakyResource(request('/hot'));
  const second = await flakyResource(request('/hot'));
  assert.equal(first.status, 502);
  assert.equal(second.status, 502);
  assert.equal(failures, 2);
  assert.equal((await body(first)).error.code, CODES.RISK);
});

test('/image 只代理 *.hdslb.com/bfs，且带 Referer', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': '4' },
    });
  };
  const resource = create({ fetchImpl });
  const target = 'https://i0.hdslb.com/bfs/archive/abc.jpg';
  const ok = await resource(request('/image?u=' + encodeURIComponent(target)));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.equal(ok.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, target);
  assert.equal(calls[0].init.headers.referer, 'https://www.bilibili.com/');

  const cached = await resource(request('/image?u=' + encodeURIComponent(target)));
  assert.equal(cached.status, 200);
  assert.equal(calls.length, 1);

  const blocked = await resource(request('/image?u=' + encodeURIComponent('https://evil.example.com/bfs/x.jpg')));
  assert.equal(blocked.status, 400);
  const httpOnly = await resource(request('/image?u=' + encodeURIComponent('http://i0.hdslb.com/bfs/x.jpg')));
  assert.equal(httpOnly.status, 400);
  const notBfs = await resource(request('/image?u=' + encodeURIComponent('https://i0.hdslb.com/other/x.jpg')));
  assert.equal(notBfs.status, 400);
});

test('/image 拒绝超大与错误类型', async () => {
  const huge = create({
    fetchImpl: async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(6 * 1024 * 1024) },
    }),
  });
  const tooBig = await huge(request('/image?u=' + encodeURIComponent('https://i0.hdslb.com/bfs/huge.jpg')));
  assert.equal(tooBig.status, 400);

  const wrongType = create({
    fetchImpl: async () => new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  });
  const notImage = await wrongType(request('/image?u=' + encodeURIComponent('https://i0.hdslb.com/bfs/x.jpg')));
  assert.equal(notImage.status, 502);
});
