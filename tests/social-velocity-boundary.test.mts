import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, test } from 'node:test';
import { getSocialVelocity } from '../server/worldmonitor/intelligence/v1/get-social-velocity.ts';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const key = 'intelligence:social:reddit:v1';
const post = { id: 'abc123', title: 'A report', subreddit: 'worldnews', url: 'https://reddit.com/r/worldnews/comments/abc123/a_report/', score: 10, upvoteRatio: 0.9, numComments: 2, velocityScore: 3.5, createdAt: 1700000000000 };
async function read(value: unknown) {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  delete process.env.LOCAL_API_MODE;
  delete process.env.VERCEL_ENV;
  const redis = createRedisFetch({ [key]: value });
  globalThis.fetch = redis.fetchImpl;
  return getSocialVelocity({} as never, {});
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
});

test('rejects malformed cache envelopes and preserves a valid empty observation', async () => {
  for (const value of [null, [], 'bad', { posts: 'bad', fetchedAt: 123 }, { extra: true }]) {
    assert.deepEqual(await read(value), { posts: [], fetchedAt: 0 });
  }
  assert.deepEqual(await read({ posts: [], fetchedAt: 123 }), { posts: [], fetchedAt: 123 });
});

test('projects post fields and excludes malformed or foreign-origin links', async () => {
  const badUrls = ['https://reddit.com@attacker.example/r/x', 'https://reddit.com.attacker.example/r/x', 'javascript:alert(1)', 'https://reddit.com:8443/r/x', 'https://attacker.example', 'https://reddit.com/redirect'];
  const result = await read({ posts: [null, false, { ...post, extra: 'secret' }, ...badUrls.map(url => ({ ...post, url }))], fetchedAt: 123, extra: 'secret' });
  assert.deepEqual(result, { posts: [post], fetchedAt: 123 });
  for (const hostname of ['www.reddit.com', 'old.reddit.com']) {
    const url = post.url.replace('reddit.com', hostname);
    assert.deepEqual((await read({ posts: [{ ...post, url }], fetchedAt: 123 })).posts, [{ ...post, url }]);
  }
});

test('bounds posts and normalizes malformed scalar fields to the public shape', async () => {
  const result = await read({ posts: Array(40).fill({ ...post, id: {}, title: [], subreddit: null, score: 'bad', upvoteRatio: 9, numComments: -2, velocityScore: 'bad', createdAt: -1 }), fetchedAt: 'bad' });
  assert.equal(result.posts.length, 30);
  assert.deepEqual(result.posts[0], { ...post, id: '', title: '', subreddit: '', score: 0, upvoteRatio: 1, numComments: 0, velocityScore: 0, createdAt: 0 });
  assert.equal(result.fetchedAt, 0);
});

test('real seeder publishes only Reddit permalinks and the reader accepts its output', async () => {
  const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  const region = source.slice(source.indexOf('const SOCIAL_VELOCITY_REDIS_KEY ='), source.indexOf('async function startSocialVelocitySeedLoop()'));
  let payload: unknown;
  const seed = runInNewContext(region + '\nseedSocialVelocity', {
    URL, Date, console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn: () => void, ms: number) => { if (ms === 500) fn(); return 1; }, clearTimeout() {},
    fetchRedditHotListing: async () => ({ ok: true, posts: [
      { id: 'abc123', title: 'A report', permalink: '/r/worldnews/comments/abc123/a_report/', score: 10, upvote_ratio: 0.9, num_comments: 2, created_utc: 1700000000 },
      ...['@attacker.example/r/x', '.attacker.example/r/x', '//attacker.example/r/x', '/r/../../redirect', '/r/worldnews\\..\\..\\redirect'].map(permalink => ({ id: 'bad', permalink })),
    ] }),
    envelopeWrite: async (_key: string, value: unknown) => { payload = value; return true; },
    upstashSet: async () => true, upstashExpire: async () => true,
  }) as () => Promise<void>;
  await seed();
  const produced = payload as { posts: typeof post[]; fetchedAt: number };
  assert.equal(produced.posts.length, 2);
  assert.ok(produced.posts.every(p => p.url === post.url));
  assert.deepEqual(await read(produced), produced);
});
