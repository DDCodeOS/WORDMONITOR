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
  'webcams/jerusalem': ['Webcam grid #1', true],
  'webcams/kyiv': ['Webcam grid #2', true],
  'webcams/taipei': ['Webcam grid #3', true],
  'webcams/sydney': ['Webcam grid #4', true],
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
      ? 'YouTube reports a live stream (isLive=true)'
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
    assert.match(body, /^\| webcams\/jerusalem \| Webcam grid #1 \| needs-replacement \| `https:\/\/www\.youtube\.com\/watch\?v=zp6LNSoq000` \| YouTube player error 150: [^|]+ \| webcams\/tel-aviv \|$/m);
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

  it('reports a slot with no entries as "no entries configured"', async () => {
    const catalog = { ...baseCatalog, news: { ...baseCatalog.news, rtve: [] } };
    const report = reportFor(catalog, { 'live-news/rtve': { status: 'empty', attempts: [] } });
    const { calls, gh } = fakeGh([]);

    assert.deepEqual(await publish(report, { gh, catalog }), { findings: 1, action: 'created' });
    assert.match(calls[1].payload.body, /^\| live-news\/rtve \| Live News optional \| empty \| — \| no entries configured \| — \|$/m);
  });

  it('lists hotspot wall slots first, then other slots shown by default, then the rest', async () => {
    const catalog = {
      ...baseCatalog,
      webcams: { ...baseCatalog.webcams, 'tel-aviv': [] },
      news: { ...baseCatalog.news, rtve: [] },
    };
    const report = reportFor(catalog, {
      'webcams/kyiv': { status: 'needs-replacement', attempts: [dead(watch('e2gC37ILQmk')), dead(watch('VGnFLdQW39A'))] },
      'webcams/tel-aviv': { status: 'empty', attempts: [] },
      'live-news/bloomberg': { status: 'needs-replacement', attempts: [dead(watch('QB5BNdBFujE'))] },
      'live-news/rtve': { status: 'empty', attempts: [] },
    });
    report.slots.reverse();
    const { calls, gh } = fakeGh([]);

    await publish(report, { gh, catalog });

    const { body } = calls[1].payload;
    const order = ['### Shown by default', '| webcams/kyiv |', '| live-news/bloomberg |', '### Not shown by default', '| webcams/tel-aviv |', '| live-news/rtve |']
      .map((needle) => [needle, body.indexOf(needle)]);
    for (const [needle, index] of order) assert.ok(index >= 0, `${needle} is missing:\n${body}`);
    assert.deepEqual(order.map(([needle]) => needle), [...order].sort((a, b) => a[1] - b[1]).map(([needle]) => needle));
    assert.match(body, /^Daily live video source audit: 4 slot\(s\) need attention, 2 of them shown by default\.$/m);
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
    assert.deepEqual(shownInstead, ['webcams/tel-aviv', 'entry #2 (live)', '—']);
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
    await runCheck(['--all', '--report', reportPath], {
      write: () => {},
      probeYouTube: async (candidates) => candidates.map(() => liveVerdict),
      probeHls: async (candidates) => candidates.map(() => ({ verdict: { verdict: 'live', video: null } })),
    });
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
    assert.ok(result.findings > 0, 'the catalog has slots with no entries');
    const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
    assert.equal(payload.title, ISSUE_TITLE);
    assert.match(payload.body, /\| webcams\/tel-aviv \| [^|]+ \| empty \| — \| no entries configured \|/);

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
