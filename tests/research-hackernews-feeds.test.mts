import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { fetchHackerNews } from '../scripts/seed-research.mjs';
import { listHackernewsItems } from '../server/worldmonitor/research/v1/list-hackernews-items';
import contracts from '../shared/openapi-filter-param-contracts.json' with { type: 'json' };

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const feeds = contracts.researchHackerNewsFeedTypes;
const idFor = (feed: string) => feeds.indexOf(feed) + 1;
const failedFeeds = new Set<string>();
const requested: string[] = [];
beforeEach(() => {
  failedFeeds.clear(); requested.length = 0;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  globalThis.fetch = async (url) => {
    const path = String(url);
    const feed = path.match(/\/([^/]+)stories.json$/)?.[1];
    if (feed) {
      requested.push(feed);
      if (failedFeeds.has(feed)) throw new Error('fixture list failure');
      return Response.json([idFor(feed)]);
    }
    const id = Number(path.match(/\/item\/(\d+).json$/)?.[1]);
    return Response.json({ id, type: id === idFor('job') ? 'job' : 'story', title: `Item ${id}`, time: 100, url: '', score: 7 });
  };
});
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });

test('producer supplies every allowed feed including job items to the real reader', async () => {
  const produced = await fetchHackerNews();
  assert.deepEqual(requested.sort(), [...feeds].sort());
  globalThis.fetch = async (url) => {
    const key = decodeURIComponent(String(url).split('/get/')[1]);
    return Response.json({ result: produced[key] ? JSON.stringify(produced[key]) : null });
  };
  for (const feedType of feeds) {
    const context = { request: new Request('https://worldmonitor.app/research'), headers: {}, pathParams: {} };
    const response = await listHackernewsItems(context, { feedType, pageSize: 30, cursor: '' });
    assert.deepEqual(response.items.map((item) => item.id), [idFor(feedType)]);
    assert.equal(response.items[0].title, `Item ${idFor(feedType)}`);
  }
});

test('a failed added feed preserves successful sibling snapshots', async () => {
  failedFeeds.add('new');
  const produced = await fetchHackerNews();
  assert.equal(produced['research:hackernews:v1:new:30'], undefined);
  assert.deepEqual(produced['research:hackernews:v1:job:30'].items.map((item: { id: number }) => item.id), [idFor('job')]);
  assert.deepEqual(produced['research:hackernews:v1:top:30'].items.map((item: { id: number }) => item.id), [idFor('top')]);
});
