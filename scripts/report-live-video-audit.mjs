#!/usr/bin/env node
// Keeps one GitHub issue listing the live video slots that need a replacement, from the JSON written by
// `node --import tsx scripts/check-live-video-sources.mjs --all --report <file>`.
// Run with: LIVE_VIDEO_AUDIT_REPORT=<file> node --import tsx scripts/report-live-video-audit.mjs
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { isMainModule } from './lib/main-module.mjs';
import { auditAttempts, catalogSlots, DEFAULT_CATALOG, slotStatus } from './check-live-video-sources.mjs';

export const ISSUE_TITLE = 'Live video sources: slots needing a replacement';

const STATUSES = new Set(['ok', 'degraded', 'needs-replacement', 'empty', 'unverifiable-from-runner']);

/** A broken feed on any surface, or a slot viewers see by default with nothing configured. */
function isFinding(slot) {
  return slot.status === 'needs-replacement' || slot.status === 'degraded' || (slot.status === 'empty' && slot.shownByDefault);
}

/** A slot with no entries that the dashboard hides: listed so the owner can fill it, never counted. */
function isUnfilled(slot) {
  return slot.status === 'empty' && !slot.shownByDefault;
}
const VERDICTS = new Set(['live', 'recording', 'failed', 'unverifiable', 'invalid']);
const FINDINGS_HEADER = ['Slot', 'Where it shows', 'Status', 'Entry', 'Why', 'Shown instead'];

function ghJson(args, payload) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
    input: payload ? JSON.stringify(payload) : undefined,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'GitHub API call failed');
  return JSON.parse(result.stdout);
}

function cell(value) {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/[\\|]/g, '\\$&').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isAttempt(attempt, entry) {
  return Boolean(attempt) && attempt.entry === entry && VERDICTS.has(attempt.verdict)
    && typeof attempt.why === 'string' && attempt.why !== '' && typeof attempt.unverifiableFromRunner === 'boolean';
}

/** Every catalog slot exactly once, each attempt for the entry configured at that position, and a status its attempts agree with. */
function assertCompleteReport(report, catalog) {
  const incomplete = (detail) => new Error(`Live video audit report is incomplete: ${detail}`);
  if (!report || typeof report !== 'object') throw incomplete('not a JSON object');
  if (typeof report.checkedAt !== 'string' || Number.isNaN(Date.parse(report.checkedAt))) throw incomplete('checkedAt is not a date');
  if (!Array.isArray(report.canaries) || report.canaries.length !== catalog.canaries.length
    || !report.canaries.every((attempt, index) => isAttempt(attempt, catalog.canaries[index]))) {
    throw incomplete('the canaries do not match AUDIT_CANARIES');
  }
  if (!Array.isArray(report.slots)) throw incomplete('slots is not a list');

  const expected = new Map(catalogSlots(catalog));
  const seen = new Set();
  for (const slot of report.slots) {
    const entries = expected.get(slot?.slot);
    if (!entries || seen.has(slot.slot)) throw incomplete(`unexpected or repeated slot ${slot?.slot}`);
    seen.add(slot.slot);
    const wellFormed = typeof slot.surface === 'string' && slot.surface !== ''
      && typeof slot.shownByDefault === 'boolean'
      && (slot.shownInstead === null || typeof slot.shownInstead === 'string')
      && Array.isArray(slot.attempts) && slot.attempts.length === entries.length
      && slot.attempts.every((attempt, index) => isAttempt(attempt, entries[index]))
      && STATUSES.has(slot.status) && slotStatus(slot.attempts) === slot.status;
    if (!wellFormed) throw incomplete(`${slot.slot} is malformed`);
  }
  const missing = [...expected.keys()].filter((slot) => !seen.has(slot));
  if (missing.length > 0) throw incomplete(`missing ${missing.join(', ')}`);
}

/** When no canary is live the probe itself may be broken; channel embeds are occasionally flaky, so look once more. */
async function confirmProbeWorks(canaries, probeCanaries) {
  const liveCount = (attempts) => attempts.filter((attempt) => attempt.verdict === 'live').length;
  if (liveCount(canaries) > 0) return `${liveCount(canaries)} of ${canaries.length} live`;
  const entries = canaries.map((attempt) => attempt.entry);
  const retried = await probeCanaries(entries);
  if (!Array.isArray(retried) || retried.length !== entries.length || !retried.every((attempt, index) => isAttempt(attempt, entries[index]))) {
    throw new Error('the canary retry returned an incomplete result');
  }
  if (liveCount(retried) === 0) {
    const reasons = retried.map((attempt) => `${attempt.entry} (${attempt.why})`).join('; ');
    throw new Error(`every audit canary failed twice, so the probe is broken rather than the catalog: ${reasons}`);
  }
  return `${liveCount(retried)} of ${retried.length} live on retry (none were live on the first check)`;
}

function because(attempt) {
  const { title, author } = attempt.evidence ?? {};
  const byline = [title && `"${title}"`, author && `by ${author}`].filter(Boolean).join(' ');
  return byline ? `${attempt.why}: ${byline}` : attempt.why;
}

function entryCell(attempt, index) {
  return `${index > 0 ? `#${index + 1} ` : ''}\`${attempt.entry}\``;
}

/** One row per entry that failed ahead of whatever plays; an empty slot gets one row. */
function findingRows(slot) {
  const lead = [slot.slot, slot.surface, slot.status];
  if (slot.status === 'empty') return [[...lead, '—', 'no entries configured', slot.shownInstead ?? '—']];
  const liveAt = slot.attempts.findIndex((attempt) => attempt.verdict === 'live');
  const instead = liveAt > 0 ? `entry #${liveAt + 1} (live)` : slot.shownInstead ?? '—';
  return slot.attempts
    .map((attempt, index) => ({ attempt, index }))
    .filter(({ attempt, index }) => (liveAt < 0 || index < liveAt) && !attempt.unverifiableFromRunner)
    .map(({ attempt, index }) => [...lead, entryCell(attempt, index), because(attempt), instead]);
}

/** Hotspot wall slots first, in grid priority order; everything else keeps the report's order. */
function inAttentionOrder(slots, gridPriority) {
  const hotspot = ({ slot }) => {
    const index = slot.startsWith('webcams/') ? gridPriority.indexOf(slot.slice('webcams/'.length)) : -1;
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  return slots
    .map((slot, order) => ({ slot, order }))
    .sort((a, b) => (hotspot(a.slot) - hotspot(b.slot)) || (a.order - b.order))
    .map(({ slot }) => slot);
}

function table(header, rows) {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
}

export function renderAuditBody(report, { runUrl = '', canaries, gridPriority = [] }) {
  const findings = report.slots.filter(isFinding);
  const shown = inAttentionOrder(findings.filter((slot) => slot.shownByDefault), gridPriority);
  const hidden = inAttentionOrder(findings.filter((slot) => !slot.shownByDefault), gridPriority);
  const unverifiable = report.slots.filter((slot) => slot.status === 'unverifiable-from-runner');
  const recheckSkipped = report.slots.flatMap((slot) => slot.attempts).filter((attempt) => attempt.evidence?.recheckSkipped === true).length;
  const lines = [
    `Daily live video source audit: ${findings.length} slot(s) need attention, ${shown.length} of them shown by default.`,
    '',
    `- Checked: ${cell(report.checkedAt)}${runUrl ? ` — [Workflow run](${runUrl})` : ''}`,
    `- Canaries: ${canaries}`,
    ...(recheckSkipped > 0
      ? [`- Not re-checked alone: ${recheckSkipped} never-ready ${recheckSkipped === 1 ? 'entry' : 'entries'}, because the audit time budget was used up`]
      : []),
    '',
    'Status `needs-replacement` means no entry is live, `degraded` means an earlier entry failed and a later one plays, and `empty` means a slot viewers see by default has no entries.',
  ];
  if (shown.length > 0) lines.push('', '### Shown by default', '', ...table(FINDINGS_HEADER, shown.flatMap(findingRows)));
  if (hidden.length > 0) lines.push('', '### Not shown by default', '', ...table(FINDINGS_HEADER, hidden.flatMap(findingRows)));
  if (unverifiable.length > 0) {
    const rows = unverifiable.flatMap((slot) => slot.attempts.map((attempt, index) => [slot.slot, slot.surface, entryCell(attempt, index), because(attempt)]));
    lines.push(
      '', '### Could not verify from the runner', '',
      'An HLS 403 or 451, an HLS timeout, a YouTube player that never became ready while no canary played, a player that stopped reporting whether a video is live, or a YouTube player API that did not load can depend on the runner (its network, its region, or YouTube itself). These slots may still play for viewers, so they are not counted above. A player that never became ready while a canary played is checked alone up to twice within the audit time budget, and is counted above only if both checks stall.',
      '', ...table(['Slot', 'Where it shows', 'Entry', 'Why'], rows),
    );
  }
  const unfilled = report.slots.filter(isUnfilled);
  if (unfilled.length > 0) {
    const bySurface = new Map();
    for (const slot of unfilled) bySurface.set(slot.surface, [...(bySurface.get(slot.surface) ?? []), slot.slot]);
    lines.push(
      '', '### Unfilled slots (hidden from viewers)', '',
      `${unfilled.length} slot(s) have no entries, so the dashboard hides them. They are not counted above; fill one the same way as a broken slot.`,
      '', ...[...bySurface].map(([surface, slots]) => `- ${surface}: ${slots.join(', ')}`),
    );
  }
  lines.push(
    '', '### Fix a slot', '',
    '1. Find a live stream for the slot and check it: `npm run live-video:check -- <url>`',
    '2. When it prints `LIVE`, paste its `paste:` line into the slot\'s list in `src/config/live-video-sources.ts`. Entries are tried in order.',
    '3. Re-check the slot before committing: `npm run live-video:check -- --slot <slot>`',
    '',
    'Each daily run rewrites this issue, and closes it once no slot needs attention.',
  );
  return lines.join('\n');
}

function recoveredComment(report, runUrl) {
  const unverifiable = report.slots.filter((slot) => slot.status === 'unverifiable-from-runner').length;
  const unfilled = report.slots.filter(isUnfilled).length;
  return [
    `Recovered: no live video slot needs attention as of ${report.checkedAt}.`,
    unverifiable > 0 ? `${unverifiable} slot(s) could not be verified from the runner; the run summary lists them.` : '',
    unfilled > 0 ? `${unfilled} unfilled slot(s) stay hidden from viewers; the run summary lists them.` : '',
    runUrl ? `[Workflow run](${runUrl})` : '',
  ].filter(Boolean).join(' ');
}

export async function publishAudit(report, {
  repository = process.env.GITHUB_REPOSITORY,
  runUrl = '',
  summaryPath,
  catalog = DEFAULT_CATALOG,
  gh = ghJson,
  probeCanaries = auditAttempts,
} = {}) {
  assertCompleteReport(report, catalog);
  const canaries = await confirmProbeWorks(report.canaries, probeCanaries);
  const body = renderAuditBody(report, { runUrl, canaries, gridPriority: catalog.gridPriority ?? [] });
  if (summaryPath) appendFileSync(summaryPath, `${body}\n`);
  if (!repository) throw new Error('GITHUB_REPOSITORY is required to publish the live video audit');

  const findings = report.slots.filter(isFinding).length;
  const pages = gh(['api', '--paginate', '--slurp', `repos/${repository}/issues?state=open&per_page=100`]);
  const existing = pages.flat().find((issue) => !issue.pull_request && issue.title === ISSUE_TITLE);
  if (findings === 0) {
    if (!existing) return { findings, action: 'none' };
    gh(['api', '--method', 'POST', `repos/${repository}/issues/${existing.number}/comments`, '--input', '-'], { body: recoveredComment(report, runUrl) });
    gh(['api', '--method', 'PATCH', `repos/${repository}/issues/${existing.number}`, '--input', '-'], { state: 'closed', state_reason: 'completed' });
    return { findings, action: 'closed', issue: existing.number };
  }
  const endpoint = `repos/${repository}/issues${existing ? `/${existing.number}` : ''}`;
  gh(['api', '--method', existing ? 'PATCH' : 'POST', endpoint, '--input', '-'], { title: ISSUE_TITLE, body });
  return { findings, action: existing ? 'updated' : 'created' };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    const report = JSON.parse(readFileSync(process.env.LIVE_VIDEO_AUDIT_REPORT, 'utf8'));
    const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
    const runUrl = GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
      ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
      : '';
    console.log(JSON.stringify(await publishAudit(report, { runUrl, summaryPath: process.env.GITHUB_STEP_SUMMARY })));
  } catch (error) {
    console.error(`Live video audit could not report: ${error.message}`);
    process.exitCode = 1;
  }
}
