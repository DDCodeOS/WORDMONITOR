import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleFeedsModule } from './_lib/bundle-feeds-module.mts';
import { VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import { selectCountryHeadlines } from '../scripts/freeze-crawlable-live-pulse.mjs';
import { briefGroundingGap, briefGroundingPublisherCount } from '../scripts/crawlable-developments.mjs';
import { isAllowedDomain } from '../api/_rss-allowed-domain-match.js';
import { SOURCE_PROPAGANDA_RISK, SOURCE_TYPES } from '../shared/source-provenance';
import { SOURCE_TIERS } from '../server/_shared/source-tiers';
import { publisherFamilyFor } from '../shared/publisher-families.js';

const REGIONAL_FEEDS = [
  { name: 'Guardian Africa', category: 'africa', path: 'https://www.theguardian.com/world/africa/rss', publisher: 'Guardian World', code: 'UG', title: 'Uganda announces changes to its cabinet' },
  { name: 'France 24 Africa', category: 'africa', path: 'https://www.france24.com/en/africa/rss', publisher: 'France 24', code: 'DZ', title: 'Algeria cuts diplomatic ties with United Arab Emirates' },
  { name: 'Guardian Caribbean', category: 'latam', path: 'https://www.theguardian.com/world/caribbean/rss', publisher: 'Guardian World', code: 'JM', title: 'Jamaican delegation submits slavery reparations petition' },
  { name: 'France 24 LatAm', category: 'latam', path: 'https://www.france24.com/en/americas/rss', publisher: 'France 24', code: 'BR', title: 'Brazil prepares for national election' },
  { name: 'Mexico News Daily', category: 'latam', path: 'https://mexiconewsdaily.com/feed/', publisher: 'Mexico News Daily', code: 'MX', title: 'Mexico reports record exports' },
  { name: 'Guardian Pacific', category: 'asia', path: 'https://www.theguardian.com/world/pacific-islands/rss', publisher: 'Guardian World', code: 'VU', title: 'Rescue teams search for missing ferry passengers in Vanuatu' },
  { name: 'France 24 Asia Pacific', category: 'asia', path: 'https://www.france24.com/en/asia-pacific/rss', publisher: 'France 24', code: 'MY', title: 'Malaysia announces refugee policy review' },
] as const;

type Client = { FULL_FEEDS: Record<string, { name: string; url: string }[]> };
const tempDir = mkdtempSync(join(tmpdir(), 'regional-feeds-'));
let client: Client;
before(async () => {
  client = await bundleFeedsModule<Client>({ repoRoot: process.cwd(), tempDir });
});
after(() => rmSync(tempDir, { recursive: true, force: true }));

describe('curated regional country coverage (#7748)', () => {
  it('acquires every regional feed in the English digest with matching browser routing', () => {
    const { batches } = __testing__.buildDigestFeedBatches('full', 'en');
    const scheduled = batches.flat();
    for (const row of REGIONAL_FEEDS) {
      const serverFeed = VARIANT_FEEDS.full[row.category].find(feed => feed.name === row.name);
      assert.ok(serverFeed, `${row.name} must reach the server digest`);
      assert.equal(serverFeed.url, row.path);
      assert.equal(client.FULL_FEEDS[row.category].find(feed => feed.name === row.name)?.url, row.path);
      assert.ok(scheduled.some(entry => entry.category === row.category && entry.feed.name === row.name));
      assert.ok(isAllowedDomain(new URL(row.path).hostname));
      assert.equal(SOURCE_TIERS[row.name], 2);
      assert.equal(SOURCE_TYPES[row.name], 'mainstream');
      assert.ok(SOURCE_PROPAGANDA_RISK[row.name]);
      assert.equal(publisherFamilyFor(row.name), publisherFamilyFor(row.publisher));
    }
  });

  it('parses registered RSS into dated country grounding while excluding unrelated countries', () => {
    for (const row of REGIONAL_FEEDS) {
      const feed = VARIANT_FEEDS.full[row.category].find(feed => feed.name === row.name);
      assert.ok(feed, `${row.name} is registered`);
      const articleUrl = new URL('/news/coverage-fixture', row.path).href;
      const xml = `<rss version="2.0"><channel><title>${row.name}</title><item><title>${row.title}</title><link>${articleUrl}</link><pubDate>Sun, 13 Sep 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
      const parsed = __testing__.parseRssXml(xml, feed, 'full');
      assert.ok(parsed);
      const headlines = selectCountryHeadlines(parsed.items, row.code);
      assert.equal(headlines.length, 1, row.name);
      assert.equal(headlines[0].source, row.name);
      assert.equal(headlines[0].publishedAt, '2026-09-13T00:00:00.000Z');
      assert.equal(headlines[0].url, articleUrl);
      assert.equal(selectCountryHeadlines(parsed.items, 'IS').length, 0);
      assert.equal(briefGroundingGap(headlines), 'thin-grounding');
      const index = { title: row.title, source: 'independent.example', url: 'https://independent.example/news', publishedAt: headlines[0].publishedAt, origin: 'country-index' };
      assert.equal(briefGroundingGap([index, { ...index, source: 'second.example', url: 'https://second.example/news' }]), 'uncurated-grounding');
      assert.equal(briefGroundingGap([...headlines, index]), null);
    }
  });

  it('never counts regional editions of one publisher as independent grounding', () => {
    for (const publisher of ['Guardian World', 'France 24']) {
      const rows = REGIONAL_FEEDS.filter(feed => feed.publisher === publisher).map(feed => ({ source: feed.name, url: feed.path }));
      assert.equal(briefGroundingPublisherCount(rows), 1);
      assert.equal(briefGroundingGap(rows), 'thin-grounding');
    }
  });
});
