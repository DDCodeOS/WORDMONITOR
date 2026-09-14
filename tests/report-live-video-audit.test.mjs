import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import YAML from 'yaml';

import { runCheck } from '../scripts/check-live-video-sources.mjs';
import { ISSUE_TITLE, publishAudit } from '../scripts/report-live-video-audit.mjs';

const watch = (id) => `https://www.youtube.com/watch?v=${id}`;
const CANARY_1 = 'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg';
const CANARY_2 = 'https://www.youtube.com/channel/UCknLrEdhRCp1aegoMqRaCZg';
const BBC_HLS = 'https://vs-hls-push-uk.live.fastly.md.bbci.co.uk/x=4/iptv_hd_abr_v1.m3u8';

const baseCatalog = {
  webcams: {
    jerusalem: [watch('zp6LNSoq000')],
    kyiv: [watch('e2gC37ILQmk'), watch('VGnFLdQW39A')],
    taipei: [watch('z_fY1pj1VBw')],
    sydney: [watch('5uZa3-RMFos')],
    'tel-aviv': [watch('oDCAAfOSqvA')],
  },
  gridPriority: ['jerusalem', 'kyiv', 'taipei', 'sydney', 'tel-aviv'],
  news: {
    bloomberg: [watch('QB5BNdBFujE')],
    'bbc-news': [BBC_HLS],
    rtve: [watch('KQp-e_XQnDE')],
  },
  canaries: [CANARY_1, CANARY_2],
};

const SURFACES = {
  'webcams/jerusalem': ['Webcam grid cell 1', true],
  'webcams/kyiv': ['Webcam grid cell 2', true],
  'webcams/taipei': ['Webcam grid cell 3', true],
  'webcams/sydney': ['Webcam grid cell 4', true],
  'webcams/tel-aviv': ['Webcam (Middle East)', false],
  'live-news/bloomberg': ['Live News default (full, tech)', true],
  'live-news/bbc-news': ['Live News optional', false],
  'live-news/rtve': ['Live News optional', false],
};

function attempt(entry, verdict, { why, unverifiableFromRunner = false, evidence = {} } = {}) {
  return {
    entry,
    kind: entry.endsWith('.m3u8') ? 'hls' : entry.includes('/channel/') ? 'channel' : 'video',
    verdict,
    why: why ?? (verdict === 'live'
      ? 'YouTube reports a live stream (isLive=true) and it is playing'
      : 'YouTube player error 150: the owner does not allow embedding, or the video is unavailable here'),
    unverifiableFromRunner,
    evidence: { videoId: null, title: null, author: null, isLive: null, errorCode: null, httpStatus: null, durationSeconds: null, verdictAtMs: null, ...evidence },
  };
}
const live = (entry) => attempt(entry, 'live', { evidence: { title: 'Live cam', author: 'Cams', isLive: true } });
const dead = (entry) => attempt(entry, 'failed', { evidence: { errorCode: 150 } });

/** A report for `catalog`: every entry live unless `problems` gives a slot its status and attempts. */
function reportFor(catalog, problems = {}, shownInstead = {}) {
  const slots = [
    ...Object.entries(catalog.webcams).map(([id, entries]) => [`webcams/${id}`, entries]),
    ...Object.entries(catalog.news).map(([id, entries]) => [`live-news/${id}`, entries]),
  ].map(([slot, entries]) => {
    const [surface, shownByDefault] = SURFACES[slot];
    const { status, attempts } = problems[slot] ?? { status: 'ok', attempts: entries.map(live) };
    return { slot, surface, shownByDefault, status, attempts, shownInstead: shownInstead[slot] ?? null };
  });
  return { checkedAt: '2026-09-15T05:17:00.000Z', canaries: catalog.canaries.map(live), slots };
}

function fakeGh(openIssues = []) {
  const calls = [];
  const gh = (args, payload) => {
    calls.push({ args, payload });
    return args.includes('--paginate') ? [openIssues, []] : { number: 42 };
  };
  return { calls, gh };
}

const unexpectedRetry = async () => { throw new Error('unexpected canary retry'); };
const unexpectedGh = () => { throw new Error('unexpected GitHub call'); };
const publish = (report, options) => publishAudit(report, { repository: 'owner/repo', catalog: baseCatalog, probeCanaries: unexpectedRetry, ...options });

describe('live video audit issue', () => {
  it('creates the issue with slot, where it shows, status, entry, why and shown-instead columns', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'live-video-audit-summary-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const summaryPath = join(dir, 'summary.md');
    const report = reportFor(baseCatalog, { 'webcams/jerusalem': { status: 'needs-replacement', attempts: [dead(watch('zp6LNSoq000'))] } }, { 'webcams/jerusalem': 'webcams/tel-aviv' });
    const { calls, gh } = fakeGh([]);

    const result = await publish(report, { gh, runUrl: 'https://github.com/owner/repo/actions/runs/7', summaryPath });

    assert.deepEqual(result, { findings: 1, action: 'created' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ['api', '--paginate', '--slurp', 'repos/owner/repo/issues?state=open&per_page=100']);
    assert.deepEqual(calls[1].args, ['api', '--method', 'POST', 'repos/owner/repo/issues', '--input', '-']);
    const { title, body } = calls[1].payload;
    assert.equal(title, ISSUE_TITLE);
    assert.match(body, /^\| Slot \| Where it shows \| Status \| Entry \| Why \| Shown instead \|$/m);
    assert.match(body, /^\| webcams\/jerusalem \| Webcam grid cell 1 \| needs-replacement \| `https:\/\/www\.youtube\.com\/watch\?v=zp6LNSoq000` \| YouTube player error 150: [^|]+ \| webcams\/tel-aviv \|$/m);
    assert.match(body, /actions\/runs\/7/);
    assert.match(body, /Canaries: 2 of 2 live/);
    assert.match(body, /npm run live-video:check -- <url>/);
    assert.match(body, /`src\/config\/live-video-sources\.ts`/);
    assert.equal(readFileSync(summaryPath, 'utf8'), `${body}\n`);
  });

  it('updates the open issue whose title matches exactly, ignoring pull requests and near misses', async () => {
    const report = reportFor(baseCatalog, { 'webcams/kyiv': { status: 'needs-replacement', attempts: [dead(watch('e2gC37ILQmk')), dead(watch('VGnFLdQW39A'))] } });
    const { calls, gh } = fakeGh([
      { number: 3, title: `${ISSUE_TITLE} (old)` },
      { number: 4, title: ISSUE_TITLE, pull_request: {} },
      { number: 5, title: ISSUE_TITLE.toLowerCase() },
      { number: 6, title: ISSUE_TITLE },
    ]);

    const result = await publish(report, { gh });

    assert.deepEqual(result, { findings: 1, action: 'updated' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args, ['api', '--method', 'PATCH', 'repos/owner/repo/issues/6', '--input', '-']);
    assert.equal(calls[1].payload.title, ISSUE_TITLE);
    assert.match(calls[1].payload.body, /webcams\/kyiv/);
  });

  it('comments "Recovered" and closes the open issue when no slot needs attention', async () => {
    const { calls, gh } = fakeGh([{ number: 6, title: ISSUE_TITLE }]);

    const result = await publish(reportFor(baseCatalog), { gh, runUrl: 'https://github.com/owner/repo/actions/runs/8' });

    assert.deepEqual(result, { findings: 0, action: 'closed', issue: 6 });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1].args, ['api', '--method', 'POST', 'repos/owner/repo/issues/6/comments', '--input', '-']);
    assert.match(calls[1].payload.body, /^Recovered/);
    assert.match(calls[1].payload.body, /actions\/runs\/8/);
    assert.deepEqual(calls[2].args, ['api', '--method', 'PATCH', 'repos/owner/repo/issues/6', '--input', '-']);
    assert.deepEqual(calls[2].payload, { state: 'closed', state_reason: 'completed' });
  });

  it('leaves GitHub alone after the lookup when nothing is open and nothing needs attention', async () => {
    const { calls, gh } = fakeGh([]);
    assert.deepEqual(await publish(reportFor(baseCatalog), { gh }), { findings: 0, action: 'none' });
    assert.equal(calls.length, 1);
  });

  it('closes the issue, or files none, when the only empty slots are hidden from viewers', async (t) => {
    const catalog = { ...baseCatalog, webcams: { ...baseCatalog.webcams, 'tel-aviv': [] }, news: { ...baseCatalog.news, rtve: [] } };
    const report = reportFor(catalog, {
      'webcams/tel-aviv': { status: 'empty', attempts: [] },
      'live-news/rtve': { status: 'empty', attempts: [] },
    });
    const dir = mkdtempSync(join(tmpdir(), 'live-video-audit-hidden-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const summaryPath = join(dir, 'summary.md');

    const { calls, gh } = fakeGh([{ number: 6, title: ISSUE_TITLE }]);
    assert.deepEqual(await publish(report, { gh, catalog, summaryPath }), { findings: 0, action: 'closed', issue: 6 });
    assert.equal(calls.length, 3);
    assert.match(calls[1].payload.body, /^Recovered/);
    assert.match(calls[1].payload.body, /2 unfilled slot\(s\) stay hidden from viewers/);
    assert.deepEqual(calls[2].payload, { state: 'closed', state_reason: 'completed' });
    assert.match(readFileSync(summaryPath, 'utf8'), /^Daily live video source audit: 0 slot\(s\) need attention, 0 of them shown by default\.$/m);

    const { calls: noneCalls, gh: noneGh } = fakeGh([]);
    assert.deepEqual(await publish(report, { gh: noneGh, catalog }), { findings: 0, action: 'none' });
    assert.equal(noneCalls.length, 1);
  });

  it('retries the canaries once when every canary failed, and reports on the retried result', async () => {
    const report = reportFor(baseCatalog, { 'webcams/jerusalem': { status: 'needs-replacement', attempts: [dead(watch('zp6LNSoq000'))] } });
    report.canaries = [dead(CANARY_1), dead(CANARY_2)];
    const retries = [];
    const { calls, gh } = fakeGh([]);

    const result = await publish(report, { gh, probeCanaries: async (entries) => { retries.push(entries); return [live(CANARY_1), dead(CANARY_2)]; } });

    assert.deepEqual(retries, [[CANARY_1, CANARY_2]]);
    assert.equal(result.action, 'created');
    assert.match(calls[1].payload.body, /Canaries: 1 of 2 live on retry/);
  });

  it('throws before any GitHub call when every canary fails the retry too', async () => {
    const report = reportFor(baseCatalog, { 'webcams/jerusalem': { status: 'needs-replacement', attempts: [dead(watch('zp6LNSoq000'))] } });
    report.canaries = [dead(CANARY_1), dead(CANARY_2)];
    let retries = 0;

    await assert.rejects(
      publish(report, { gh: unexpectedGh, probeCanaries: async (entries) => { retries++; return entries.map(dead); } }),
      /every audit canary failed twice/,
    );
    assert.equal(retries, 1);
  });

  it('does not retry when at least one canary is live', async () => {
    const report = reportFor(baseCatalog);
    report.canaries = [dead(CANARY_1), live(CANARY_2)];
    const { gh } = fakeGh([]);
    assert.deepEqual(await publish(report, { gh }), { findings: 0, action: 'none' });
  });

  it('retries canaries the batched page could not verify, and reports normally once one plays', async () => {
    const report = reportFor(baseCatalog);
    report.canaries = [
      attempt(CANARY_1, 'unverifiable', { why: 'the player frame loaded but never became ready', unverifiableFromRunner: true }),
      attempt(CANARY_2, 'unverifiable', { why: 'the player no longer reports whether a video is live (isLive missing)', unverifiableFromRunner: true }),
    ];
    const retries = [];
    const { calls, gh } = fakeGh([{ number: 6, title: ISSUE_TITLE }]);

    const result = await publish(report, { gh, probeCanaries: async (entries) => { retries.push(entries); return entries.map(live); } });

    assert.deepEqual(retries, [[CANARY_1, CANARY_2]]);
    assert.deepEqual(result, { findings: 0, action: 'closed', issue: 6 });
    assert.equal(calls.length, 3);
  });

  it('throws on an incomplete or malformed report before probing or calling GitHub', async () => {
    const complete = () => reportFor(baseCatalog);
    const variants = {
      'not an object': null,
      'no slots': { ...complete(), slots: undefined },
      'unparseable checkedAt': { ...complete(), checkedAt: 'yesterday' },
      'a missing canary': { ...complete(), canaries: [live(CANARY_1)] },
      'a canary for another entry': { ...complete(), canaries: [live(CANARY_1), live(CANARY_1)] },
      'a missing slot': { ...complete(), slots: complete().slots.slice(1) },
      'an unknown slot': { ...complete(), slots: [...complete().slots.slice(1), { ...complete().slots[0], slot: 'webcams/atlantis' }] },
      'a repeated slot': { ...complete(), slots: [complete().slots[1], ...complete().slots.slice(1)] },
    };
    const mutate = (edit) => {
      const report = complete();
      edit(report.slots.find((slot) => slot.slot === 'webcams/kyiv'));
      return report;
    };
    Object.assign(variants, {
      'a missing attempt': mutate((slot) => { slot.attempts.pop(); }),
      'an attempt for another entry': mutate((slot) => { slot.attempts[1] = live(watch('zp6LNSoq000')); }),
      'an unknown verdict': mutate((slot) => { slot.attempts[0].verdict = 'maybe'; }),
      'an attempt with no why': mutate((slot) => { delete slot.attempts[0].why; }),
      'a status its attempts contradict': mutate((slot) => { slot.attempts[0] = dead(watch('e2gC37ILQmk')); }),
      'an unknown status': mutate((slot) => { slot.status = 'fine'; }),
      'no surface': mutate((slot) => { slot.surface = ''; }),
      'a non-boolean shownByDefault': mutate((slot) => { slot.shownByDefault = 'yes'; }),
      'a non-string shownInstead': mutate((slot) => { slot.shownInstead = 3; }),
      'a why carrying Markdown': mutate((slot) => { slot.attempts[0].why = 'YouTube player error 150 @koala73'; }),
      'a surface carrying an issue reference': mutate((slot) => { slot.surface = 'Webcam grid #2'; }),
      'a shownInstead carrying a link': mutate((slot) => { slot.shownInstead = '[x](https://evil.example)'; }),
    });

    for (const [label, report] of Object.entries(variants)) {
      await assert.rejects(publish(report, { gh: unexpectedGh }), /incomplete/, label);
    }
  });

  it('lists an HLS 403 under "Could not verify from the runner", never as a finding', async () => {
    const geoBlocked = {
      status: 'unverifiable-from-runner',
      attempts: [attempt(BBC_HLS, 'failed', { why: 'manifest returned HTTP 403', unverifiableFromRunner: true, evidence: { httpStatus: 403 } })],
    };
    const report = reportFor(baseCatalog, {
      'webcams/jerusalem': { status: 'needs-replacement', attempts: [dead(watch('zp6LNSoq000'))] },
      'live-news/bbc-news': geoBlocked,
    });
    const { calls, gh } = fakeGh([]);

    assert.deepEqual(await publish(report, { gh }), { findings: 1, action: 'created' });
    const { body } = calls[1].payload;
    const section = body.indexOf('### Could not verify from the runner');
    assert.ok(section > 0, body);
    assert.equal(body.indexOf('live-news/bbc-news'), body.lastIndexOf('live-news/bbc-news'), 'listed once');
    assert.ok(body.indexOf('live-news/bbc-news') > section, 'listed only in the unverifiable section');
    assert.match(body.slice(section), /\| live-news\/bbc-news \| Live News optional \| `https:\/\/vs-hls-push-uk[^`]+` \| manifest returned HTTP 403 \|/);

    const { calls: closeCalls, gh: closeGh } = fakeGh([{ number: 9, title: ISSUE_TITLE }]);
    const onlyGeo = reportFor(baseCatalog, { 'live-news/bbc-news': geoBlocked });
    assert.deepEqual(await publish(onlyGeo, { gh: closeGh }), { findings: 0, action: 'closed', issue: 9 });
    assert.match(closeCalls[1].payload.body, /1 slot\(s\) could not be verified from the runner/);
  });

  it('lists a YouTube player the runner could not verify under "Could not verify from the runner", never as a finding', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'live-video-audit-unverified-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const summaryPath = join(dir, 'summary.md');
    const silent = attempt(watch('QB5BNdBFujE'), 'unverifiable', { why: 'the player frame loaded but never became ready', unverifiableFromRunner: true });
    const report = reportFor(baseCatalog, { 'live-news/bloomberg': { status: 'unverifiable-from-runner', attempts: [silent] } });
    const { gh } = fakeGh([{ number: 6, title: ISSUE_TITLE }]);

    assert.deepEqual(await publish(report, { gh, summaryPath }), { findings: 0, action: 'closed', issue: 6 });
    const body = readFileSync(summaryPath, 'utf8');
    const section = body.indexOf('### Could not verify from the runner');
    assert.ok(section > 0, body);
    assert.match(body.slice(section), /^An HLS 403[^\n]*a YouTube player that never became ready[^\n]*$/m);
    assert.match(body.slice(section), /\| live-news\/bloomberg \| Live News default \(full, tech\) \| `https:\/\/www\.youtube\.com\/watch\?v=QB5BNdBFujE` \| the player frame loaded but never became ready \|/);
    assert.equal(body.indexOf('live-news/bloomberg'), body.indexOf('live-news/bloomberg', section), 'listed only in the unverifiable section');
  });

  it('notes in the header how many never-ready entries the time budget left unchecked', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'live-video-audit-budget-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const skipped = (entry) => attempt(entry, 'unverifiable', { why: 'not re-checked: audit time budget used up', unverifiableFromRunner: true, evidence: { recheckSkipped: true } });
    const report = reportFor(baseCatalog, {
      'live-news/bloomberg': { status: 'unverifiable-from-runner', attempts: [skipped(watch('QB5BNdBFujE'))] },
      'live-news/rtve': { status: 'unverifiable-from-runner', attempts: [skipped(watch('KQp-e_XQnDE'))] },
    });

    const summaryPath = join(dir, 'summary.md');
    await publish(report, { gh: fakeGh([]).gh, summaryPath });
    assert.match(readFileSync(summaryPath, 'utf8'), /^- Alone checks skipped: 2 stalled YouTube entries, because the audit time budget was used up$/m);

    const quietPath = join(dir, 'quiet.md');
    await publish(reportFor(baseCatalog), { gh: fakeGh([]).gh, summaryPath: quietPath });
    assert.doesNotMatch(readFileSync(quietPath, 'utf8'), /Alone checks skipped/);
  });

  it('counts an empty grid hotspot as "no entries configured", first, with the slot shown in its cell', async () => {
    const catalog = { ...baseCatalog, webcams: { ...baseCatalog.webcams, jerusalem: [] } };
    const report = reportFor(catalog, {
      'webcams/jerusalem': { status: 'empty', attempts: [] },
      'live-news/bloomberg': { status: 'needs-replacement', attempts: [dead(watch('QB5BNdBFujE'))] },
    }, { 'webcams/jerusalem': 'webcams/tel-aviv' });
    report.slots.reverse();
    const { calls, gh } = fakeGh([]);

    assert.deepEqual(await publish(report, { gh, catalog }), { findings: 2, action: 'created' });
    const { body } = calls[1].payload;
    const rows = body.split('\n').filter((line) => /^\| (webcams|live-news)\//.test(line));
    assert.equal(rows[0], '| webcams/jerusalem | Webcam grid cell 1 | empty | — | no entries configured | webcams/tel-aviv |');
    assert.match(rows[1], /^\| live-news\/bloomberg \|/);
    assert.match(body, /^Daily live video source audit: 2 slot\(s\) need attention, 2 of them shown by default\.$/m);
    assert.doesNotMatch(body, /### Unfilled slots/);
  });

  it('lists hotspot wall slots first, then other slots shown by default, then the rest', async () => {
    const report = reportFor(baseCatalog, {
      'webcams/kyiv': { status: 'needs-replacement', attempts: [dead(watch('e2gC37ILQmk')), dead(watch('VGnFLdQW39A'))] },
      'webcams/tel-aviv': { status: 'needs-replacement', attempts: [dead(watch('oDCAAfOSqvA'))] },
      'live-news/bloomberg': { status: 'needs-replacement', attempts: [dead(watch('QB5BNdBFujE'))] },
      'live-news/rtve': { status: 'needs-replacement', attempts: [dead(watch('KQp-e_XQnDE'))] },
    });
    report.slots.reverse();
    const { calls, gh } = fakeGh([]);

    await publish(report, { gh });

    const { body } = calls[1].payload;
    const order = ['### Shown by default', '| webcams/kyiv |', '| live-news/bloomberg |', '### Not shown by default', '| webcams/tel-aviv |', '| live-news/rtve |']
      .map((needle) => [needle, body.indexOf(needle)]);
    for (const [needle, index] of order) assert.ok(index >= 0, `${needle} is missing:\n${body}`);
    assert.deepEqual(order.map(([needle]) => needle), [...order].sort((a, b) => a[1] - b[1]).map(([needle]) => needle));
    assert.match(body, /^Daily live video source audit: 4 slot\(s\) need attention, 2 of them shown by default\.$/m);
  });

  it('lists hidden empty slots by surface under "Unfilled slots", without counting them', async () => {
    const catalog = {
      ...baseCatalog,
      webcams: { ...baseCatalog.webcams, 'tel-aviv': [] },
      news: { ...baseCatalog.news, 'bbc-news': [], rtve: [] },
    };
    const report = reportFor(catalog, {
      'webcams/kyiv': { status: 'degraded', attempts: [dead(watch('e2gC37ILQmk')), live(watch('VGnFLdQW39A'))] },
      'webcams/tel-aviv': { status: 'empty', attempts: [] },
      'live-news/bbc-news': { status: 'empty', attempts: [] },
      'live-news/rtve': { status: 'empty', attempts: [] },
    });
    const { calls, gh } = fakeGh([]);

    assert.deepEqual(await publish(report, { gh, catalog }), { findings: 1, action: 'created' });
    const { body } = calls[1].payload;
    assert.match(body, /^Daily live video source audit: 1 slot\(s\) need attention, 1 of them shown by default\.$/m);
    assert.doesNotMatch(body, /### Not shown by default/);
    const section = body.indexOf('### Unfilled slots (hidden from viewers)');
    assert.ok(section > body.indexOf('| webcams/kyiv |'), body);
    assert.ok(section < body.indexOf('### Fix a slot'), body);
    assert.equal(body.indexOf('webcams/tel-aviv'), body.indexOf('webcams/tel-aviv', section), 'tel-aviv appears only in the unfilled section');
    assert.equal(body.indexOf('live-news/rtve'), body.indexOf('live-news/rtve', section), 'rtve appears only in the unfilled section');
    assert.match(body, /^- Webcam \(Middle East\): webcams\/tel-aviv$/m);
    assert.match(body, /^- Live News optional: live-news\/bbc-news, live-news\/rtve$/m);
    assert.doesNotMatch(body, /\| empty \|/);
  });

  it('fills the shown-instead column with the stand-in slot, the live backup entry, or a dash', async () => {
    const report = reportFor(baseCatalog, {
      'webcams/jerusalem': { status: 'needs-replacement', attempts: [dead(watch('zp6LNSoq000'))] },
      'webcams/kyiv': { status: 'degraded', attempts: [dead(watch('e2gC37ILQmk')), live(watch('VGnFLdQW39A'))] },
      'live-news/bloomberg': { status: 'needs-replacement', attempts: [dead(watch('QB5BNdBFujE'))] },
    }, { 'webcams/jerusalem': 'webcams/tel-aviv' });
    const { calls, gh } = fakeGh([]);

    await publish(report, { gh });

    const rows = calls[1].payload.body.split('\n').filter((line) => /^\| (webcams|live-news)\//.test(line));
    const shownInstead = rows.map((row) => row.split(' | ').at(-1).replace(/ \|$/, ''));
    assert.deepEqual(rows.map((row) => row.split(' | ')[0].slice(2)), ['webcams/jerusalem', 'webcams/kyiv', 'live-news/bloomberg']);
    assert.deepEqual(shownInstead, ['webcams/tel-aviv', 'entry 2 (live)', '—']);
  });

  it('renders probe titles, authors, entries and error details as inert code in the issue and the step summary', async (t) => {
    const hostile = "@koala73 @github/staff `tick` [x](https://evil.example) ![](https://evil.example/p.png) fixes #1 a\\|b | <script>alert(1)</script>\nsecond line";
    const hostileHls = 'https://evil.example/@koala73/fixes-#1/a`b|c.m3u8';
    const hostileGeo = 'https://evil.example/![](p)/[x](y).m3u8';
    const catalog = { ...baseCatalog, news: { ...baseCatalog.news, 'bbc-news': [hostileGeo], rtve: [hostileHls] } };
    const report = reportFor(catalog, {
      'webcams/kyiv': {
        status: 'needs-replacement',
        attempts: [
          attempt(watch('e2gC37ILQmk'), 'recording', { why: 'ended recording (isLive=false, duration 24,181 s)', evidence: { title: hostile, author: hostile } }),
          attempt(watch('VGnFLdQW39A'), 'failed', { evidence: { errorCode: 150, title: hostile, author: hostile } }),
        ],
      },
      'live-news/rtve': { status: 'needs-replacement', attempts: [attempt(hostileHls, 'failed', { why: 'stream failed', evidence: { detail: hostile } })] },
      'live-news/bbc-news': {
        status: 'unverifiable-from-runner',
        attempts: [attempt(hostileGeo, 'failed', { why: 'stream failed', unverifiableFromRunner: true, evidence: { detail: hostile } })],
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'live-video-audit-inert-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const summaryPath = join(dir, 'summary.md');
    const { calls, gh } = fakeGh([]);

    assert.deepEqual(await publish(report, { gh, catalog, summaryPath }), { findings: 2, action: 'created' });
    const { body } = calls[1].payload;
    assert.equal(readFileSync(summaryPath, 'utf8'), `${body}\n`, 'the step summary carries the same inert body');
    const outsideCode = body.replace(/`[^`\n]*`/g, '');
    assert.doesNotMatch(outsideCode, /@\w/, 'a mention outside a code span');
    assert.doesNotMatch(outsideCode, /#\d/, 'an issue reference outside a code span');
    assert.doesNotMatch(outsideCode, /evil\.example|<script|\]\(|!\[/, 'a link, image or HTML outside a code span');
    assert.doesNotMatch(body, /^second line/m, 'a newline in probe text started a new Markdown line');
    const cellCount = (row) => row.slice(2, -2).split(/(?<!\\)\|/).length;
    const rowsFor = (slot) => body.split('\n').filter((line) => line.startsWith(`| ${slot} |`));
    assert.equal(rowsFor('webcams/kyiv').length, 2);
    for (const row of [...rowsFor('webcams/kyiv'), ...rowsFor('live-news/rtve')]) assert.equal(cellCount(row), 6, row);
    assert.equal(rowsFor('live-news/bbc-news').length, 1);
    for (const row of rowsFor('live-news/bbc-news')) assert.equal(cellCount(row), 4, row);
    assert.match(body, /`@koala73 @github\/staff 'tick' \[x\]\(https:\/\/evil\.example\)/, 'the title stays readable inside its code span');
  });

  it('requires the repository before looking up the issue', async () => {
    await assert.rejects(publish(reportFor(baseCatalog), { repository: '', gh: unexpectedGh }), /GITHUB_REPOSITORY/);
  });
});

describe('live video audit command line', () => {
  it('reports a real-catalog audit through a fake gh, and fails on a missing report', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'live-video-audit-cli-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const reportPath = join(dir, 'live-video-audit.json');
    const payloadPath = join(dir, 'payload.json');
    const liveVerdict = { verdict: { verdict: 'live', video: { videoId: 'gCNeDWCI0vo', isLive: true, title: 'Live', author: 'Channel' } } };
    const blockedVerdict = { verdict: { verdict: 'failed', outcome: { kind: 'player-error', code: 150 } } };
    // Every video entry fails and every channel (the canaries among them) plays, so some slots need a replacement.
    await runCheck(['--all', '--report', reportPath], {
      write: () => {},
      probeYouTube: async (candidates) => candidates.map((candidate) => (candidate.kind === 'channel' ? liveVerdict : blockedVerdict)),
      probeHls: async (candidates) => candidates.map(() => ({ verdict: { verdict: 'live', video: null } })),
    });
    const hiddenEmpty = JSON.parse(readFileSync(reportPath, 'utf8')).slots
      .filter((slot) => slot.status === 'empty' && !slot.shownByDefault)
      .map((slot) => slot.slot);
    assert.ok(hiddenEmpty.length > 0, 'the catalog has hidden slots with no entries; if every slot is filled, drop the unfilled-section assertions');
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--paginate')) {
  console.log(JSON.stringify([[{ number: 1, title: 'Unrelated issue', body: 'x'.repeat(1_100_000) }]]));
} else {
  fs.writeFileSync(process.env.MOCK_PAYLOAD, fs.readFileSync(0, 'utf8'));
  console.log(JSON.stringify({ number: 123 }));
}
`, { mode: 0o755 });
    const runReporter = (env) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/report-live-video-audit.mjs'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: 'owner/repo', MOCK_PAYLOAD: payloadPath, GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), ...env },
    });

    const reported = runReporter({ LIVE_VIDEO_AUDIT_REPORT: reportPath });
    assert.equal(reported.status, 0, reported.stderr);
    const result = JSON.parse(reported.stdout);
    assert.equal(result.action, 'created');
    assert.ok(result.findings > 0, 'every video entry failed');
    const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
    assert.equal(payload.title, ISSUE_TITLE);
    assert.match(payload.body, /\| needs-replacement \| `https:\/\/www\.youtube\.com\/watch\?v=[^`]+` \| YouTube player error 150/);
    const unfilled = payload.body.indexOf('### Unfilled slots (hidden from viewers)');
    assert.ok(unfilled > 0, payload.body);
    const unfilledSlots = payload.body.slice(unfilled).split('\n')
      .filter((line) => line.startsWith('- '))
      .flatMap((line) => line.slice(line.indexOf(': ') + 2).split(', '));
    assert.deepEqual([...unfilledSlots].sort(), [...hiddenEmpty].sort());
    const tableSlots = payload.body.split('\n')
      .filter((line) => /^\| (webcams|live-news)\//.test(line))
      .map((line) => line.split(' | ')[0].slice(2));
    for (const slot of hiddenEmpty) assert.ok(!tableSlots.includes(slot), `${slot} is listed only as unfilled`);

    const missing = runReporter({ LIVE_VIDEO_AUDIT_REPORT: join(dir, 'missing.json') });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Live video audit could not report/);
  });
});

describe('live video source audit workflow', () => {
  const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/live-video-source-audit.yml', import.meta.url), 'utf8'));

  it('runs daily and on demand, never on pull requests or pushes', () => {
    assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
    assert.deepEqual(workflow.on.schedule, [{ cron: '17 5 * * *' }]);
    assert.deepEqual(workflow.permissions, { contents: 'read', issues: 'write' });
    assert.equal(workflow.concurrency.group, 'live-video-source-audit');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
  });

  it('checks every slot, then reports from the same file even when the check exits 1', () => {
    const [job, ...others] = Object.values(workflow.jobs);
    assert.deepEqual(others, []);
    assert.equal(job['timeout-minutes'], 15);
    const runs = job.steps.map((step) => step.run ?? '');
    const install = runs.indexOf('npm ci --ignore-scripts');
    const browser = runs.indexOf('npx playwright install --with-deps chromium');
    const check = job.steps.findIndex((step) => /scripts\/check-live-video-sources\.mjs/.test(step.run ?? ''));
    const report = job.steps.findIndex((step) => /scripts\/report-live-video-audit\.mjs/.test(step.run ?? ''));
    assert.ok(install >= 0 && install < browser && browser < check && check < report, runs.join('\n'));

    const checkStep = job.steps[check];
    assert.equal(checkStep.run, 'node --import tsx scripts/check-live-video-sources.mjs --all --report "$RUNNER_TEMP/live-video-audit.json"');
    assert.equal(checkStep['continue-on-error'], true, 'the checker exits 1 on findings; the reporter must still run');

    const reportStep = job.steps[report];
    assert.equal(reportStep.run, 'node --import tsx scripts/report-live-video-audit.mjs');
    assert.equal(reportStep.env.LIVE_VIDEO_AUDIT_REPORT, '${{ runner.temp }}/live-video-audit.json');
    assert.equal(reportStep.env.GH_TOKEN, '${{ github.token }}');
    assert.equal(reportStep['continue-on-error'], undefined, 'a broken report or failed canaries must turn the run red');
  });
});
