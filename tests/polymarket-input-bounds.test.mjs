import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { afterEach, test } from 'node:test';
import handler from '../api/polymarket.js';
import { __resetRateLimitForTest } from '../api/_rate-limit.js';
const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const region = source.slice(source.indexOf('const POLYMARKET_ENABLED ='), source.indexOf('// Periodic cache cleanup to prevent memory leaks', source.indexOf('const POLYMARKET_ENABLED =')));
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
function relay() {
  const calls = [];
  let body = '[{"id":"one"},{"id":"two"}]';
  let destroyed = false;
  const context = {
    URL, URLSearchParams, Date, Buffer, PORT: 3004, process: { env: {} },
    console: { log() {}, error() {} },
    sendCompressed: (_req, res, status, headers, data) => res.done({ status, headers, data }),
    safeEnd: (res, status, headers, data) => res.done({ status, headers, data }),
    https: { get(url, _opts, callback) {
      calls.push(new URL(url));
      const request = new EventEmitter();
      request.destroy = () => { destroyed = true; };
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.resume = () => {};
        response.destroy = () => { destroyed = true; };
        callback(response);
        response.emit('data', Buffer.from(body));
        response.emit('end');
      });
      return request;
    } },
  };
  const api = runInNewContext(region + '\n({handlePolymarketRequest,polymarketCache})', context);
  return { calls, cache: api.polymarketCache, setBody: value => { body = value; }, destroyed: () => destroyed,
    request: params => new Promise(resolve => api.handlePolymarketRequest({ url: '/polymarket?' + new URLSearchParams(params) }, { done: resolve })) };
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});

test('relay restricts endpoint and enum values while canonicalizing tags and limits', async () => {
  const app = relay();
  await app.request({ endpoint: '../search?x=1', closed: 'garbage', order: 'garbage', ascending: 'garbage', limit: '1' });
  await app.request({ endpoint: 'markets', limit: '2' });
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].pathname, '/markets');
  assert.equal(app.calls[0].search, '?closed=false&order=volume&ascending=false&limit=50');
  const events = await app.request({ endpoint: 'events', closed: 'true', order: 'endDate', ascending: 'true', tag: 'geo/politics?', limit: '1' });
  assert.equal(app.calls[1].searchParams.get('tag_slug'), 'geopolitics');
  assert.deepEqual(JSON.parse(events.data), [{ id: 'one' }]);
});
test('Edge forwards only canonical query fields', async () => {
  process.env.WS_RELAY_URL = 'https://relay.example';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  process.env.WORLDMONITOR_API_KEY = 'synthetic';
  const calls = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'redis.example') return Response.json([{ result: [29, 30] }]);
    calls.push(url);
    return Response.json([]);
  };
  const response = await handler(new Request('https://worldmonitor.app/api/polymarket?' + new URLSearchParams({ endpoint: 'arbitrary', closed: 'junk', order: 'junk', ascending: 'junk', limit: '999', unknown: 'value' }), { headers: { 'X-WorldMonitor-Key': 'synthetic', 'Origin': 'https://worldmonitor.app' } }));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].search, '?endpoint=markets&closed=false&order=volume&ascending=false&limit=100');
});
test('oversized and malformed responses fail without becoming successful cached empties', async () => {
  for (const body of ['x'.repeat(2 * 1024 * 1024 + 1), '{"error":"bad"}', 'invalid json']) {
    const app = relay();
    app.setBody(body);
    assert.equal((await app.request({})).status, 502);
    assert.equal((await app.request({})).status, 502);
    assert.equal(app.calls.length, 1);
    assert.ok([...app.cache.values()].every(entry => entry.data === null));
    if (body.length > 2 * 1024 * 1024) assert.equal(app.destroyed(), true);
  }
  const app = relay();
  app.setBody('[]');
  assert.equal((await app.request({})).status, 200);
  assert.equal((await app.request({})).data, '[]');
  assert.equal(app.calls.length, 1);
});
test('distinct event tags cannot grow the relay cache beyond its entry bound', async () => {
  const app = relay();
  for (let i = 0; i < 80; i++) await app.request({ endpoint: 'events', tag: `topic-${i}` });
  assert.equal(app.cache.size, 64);
});
