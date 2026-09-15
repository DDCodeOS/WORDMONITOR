import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import handler from '../api/youtube/live.js';
import { __resetRateLimitForTest } from '../api/_rate-limit.js';
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const relaySource = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const RETIRED = { error: 'channel_live_detection_retired' };
function edge() {
  const calls = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  // A configured relay must not be called: it no longer serves YouTube lookups.
  process.env.WS_RELAY_URL = 'https://relay.example';
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('redis.example')) return Response.json([{ result: [29, 30] }]);
    calls.push(url);
    return Response.json({ author_name: 'Synthetic channel', title: 'Synthetic video' });
  };
  return { calls, request: params => handler(new Request('https://worldmonitor.app/api/youtube/live?' + new URLSearchParams(params))) };
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});
test('Edge rejects path and query injection before provider work', async () => {
  const surface = edge();
  for (const channel of ['@x/../redirect?q=https://attacker.example', '..%2Fredirect%3Fq%3Dhttps:%2F%2Fattacker', '@abc?x=1', '@abc#x', '@abc\\x', '@abc\n', '@' + 'a'.repeat(1000), '@.abc', '@abc.']) {
    assert.equal((await surface.request({ channel })).status, 400, channel);
  }
  for (const videoId of ['short', 'abcdefghijk\n', 'abcdefghij?']) {
    assert.equal((await surface.request({ channel: '@Valid', videoId })).status, 400);
  }
  assert.deepEqual(surface.calls, []);
});
test('channel live detection is retired: shipped handles, international handles and channel IDs get a cacheable 410 without provider work', async () => {
  // Tabs opened before the retirement still send these handles; they must read the retirement, not an input error.
  const panel = readFileSync(new URL('../src/components/LiveNewsPanel.ts', import.meta.url), 'utf8');
  const handles = new Set([...panel.matchAll(/handle:\s*'([^']+)'/g)].map(match => match[1]));
  assert.ok(handles.size > 50);
  const surface = edge();
  for (const channel of [...handles, '@中', '@あい', '@cafe\u0301', '@a·b', 'UCabcdefghijklmnopqrstuv']) {
    const response = await surface.request({ channel });
    assert.equal(response.status, 410, channel);
    assert.deepEqual(await response.json(), RETIRED, channel);
    assert.match(response.headers.get('Cache-Control') ?? '', /\bmax-age=86400\b/, channel);
  }
  assert.deepEqual(surface.calls, []);
});
test('a video is named from YouTube oEmbed alone, even when a channel is also given', async () => {
  const surface = edge();
  for (const params of [{ videoId: 'LuKwFajn37U' }, { channel: '@DWNews', videoId: 'LuKwFajn37U' }]) {
    const response = await surface.request(params);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { channelName: 'Synthetic channel', title: 'Synthetic video', videoId: 'LuKwFajn37U' });
  }
  assert.equal(surface.calls.length, 2);
  for (const call of surface.calls) {
    const url = new URL(call);
    assert.equal(`${url.hostname}${url.pathname}`, 'www.youtube.com/oembed');
    assert.equal(url.searchParams.get('url'), 'https://www.youtube.com/watch?v=LuKwFajn37U');
  }
});
test('a video lookup YouTube never answers ends at the 5 s oEmbed deadline with the unnamed video, uncached', { timeout: 2_000 }, async (t) => {
  const surface = edge();
  const issued = [];
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    const controller = new AbortController();
    issued.push({ ms, controller });
    return controller.signal;
  });
  let oembedInit;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('redis.example')) return Response.json([{ result: [29, 30] }]);
    oembedInit = init;
    markStarted();
    // YouTube accepts the connection and never answers; only the request's own deadline ends it.
    return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  };

  const pending = surface.request({ videoId: 'LuKwFajn37U' });
  await started;
  const deadline = issued.find(({ controller }) => controller.signal === oembedInit?.signal);
  assert.equal(deadline?.ms, 5_000, 'the oEmbed request must carry the same 5 s deadline as the RPC');
  deadline.controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { channelName: null, title: null, videoId: 'LuKwFajn37U' });
  assert.equal(response.headers.get('Cache-Control'), null);
});
test('the relay no longer serves, proxies or configures YouTube live detection', () => {
  // Positive controls: the absence checks below read the real route table and the helper the relay keeps.
  assert.match(relaySource, /pathname === '\/yahoo-chart'/, 'the relay route table must still be readable');
  assert.match(relaySource, /function ytFetchViaProxy\(/, 'the shared proxy helper stays for its PROXY_URL callers');
  assert.doesNotMatch(relaySource, /['"]\/youtube-live['"]/, 'the /youtube-live route falls through to the relay 404');
  assert.doesNotMatch(relaySource, /YOUTUBE_PROXY_URL/);
  assert.doesNotMatch(relaySource, /function handleYouTubeLiveRequest|function ytFetchDirect|function ytFetch\(|ytLiveCache|YT_CACHE_TTL/);
});
test('the earlier tests leave no synthetic relay or limiter env behind', () => {
  // Runs last: afterEach must delete keys edge() added, not only restore the snapshot's own keys.
  for (const name of ['WS_RELAY_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
    assert.equal(process.env[name], originalEnv[name], name);
  }
});
