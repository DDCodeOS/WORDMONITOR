#!/usr/bin/env node
/**
 * Audit every symbol declared in `marketCountryStockIndexes` against Yahoo
 * Finance, through the same helper and URL shape the seeder uses (#6240).
 *
 * Reports, per country, how many finite daily closes the 1-month chart carries.
 * `buildCountryStockIndexSnapshot` needs at least two, so anything below that
 * is a country the RPC can only ever answer `available: false`.
 *
 * Exit status is non-zero when the contract disagrees with Yahoo in either
 * direction:
 *   - a serviceable entry returned fewer than two closes (flag it, or fix the
 *     symbol), or
 *   - an `unavailable` entry now returns usable closes (lift the flag).
 *
 * Network-bound, so it is not part of `npm run test:data`; run it by hand when
 * adding a country or revisiting a flag:
 *
 *   node scripts/audit-country-stock-index-symbols.mjs
 *
 * Yahoo rate-limits aggressively; the seeder's 150 ms stagger is reused here.
 */
import { loadDeclaredCountryStockIndexes } from './_country-stock-index-registry.mjs';
import { buildCountryStockIndexSnapshot } from './_country-stock-index.mjs';
import { fetchYahooJson } from './_yahoo-fetch.mjs';

const YAHOO_DELAY_MS = 150;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function chartUrl(symbol) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
}

export function countFiniteCloses(chart) {
  const closes = chart?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
  return Array.isArray(closes) ? closes.filter((value) => Number.isFinite(value)).length : 0;
}

/**
 * Classify one declared entry against its probe result. Pure, so the decision
 * table is unit-testable without touching the network.
 *
 * @returns {'ok' | 'flagged-still-dead' | 'dead-but-serviceable' | 'flag-can-lift'}
 */
export function classify(index, { closes, error }) {
  const usable = !error && closes >= 2;
  if (index.unavailable) return usable ? 'flag-can-lift' : 'flagged-still-dead';
  return usable ? 'ok' : 'dead-but-serviceable';
}

export async function auditCountryStockIndexes({
  indexes = loadDeclaredCountryStockIndexes(),
  fetchJson = fetchYahooJson,
  delayMs = YAHOO_DELAY_MS,
} = {}) {
  const rows = [];
  for (const index of indexes) {
    let probe;
    try {
      if (rows.length > 0) await sleep(delayMs);
      const chart = await fetchJson(chartUrl(index.symbol), { label: `${index.code} country index audit` });
      const closes = countFiniteCloses(chart);
      probe = { closes, snapshot: Boolean(buildCountryStockIndexSnapshot(chart, undefined, index)), error: null };
    } catch (err) {
      probe = { closes: 0, snapshot: false, error: err?.message || String(err) };
    }
    rows.push({ ...index, ...probe, verdict: classify(index, probe) });
  }
  return rows;
}

function formatRow(row) {
  const flag = row.unavailable ? `unavailable since ${row.unavailable.checked}` : '';
  const detail = row.error ? `error: ${row.error}` : `${row.closes} closes`;
  return `${row.code.padEnd(3)} ${row.symbol.padEnd(12)} ${detail.padEnd(28)} ${row.verdict.padEnd(22)} ${flag}`;
}

async function main() {
  const rows = await auditCountryStockIndexes();
  for (const row of rows) console.log(formatRow(row));
  const dead = rows.filter((row) => row.verdict === 'dead-but-serviceable');
  const liftable = rows.filter((row) => row.verdict === 'flag-can-lift');
  console.log(
    `\n${rows.length} declared, ${rows.filter((row) => row.verdict === 'ok').length} serving, `
    + `${rows.filter((row) => row.unavailable).length} flagged unavailable.`,
  );
  if (dead.length > 0) {
    console.error(`\nServiceable entries Yahoo cannot serve — fix the symbol or flag them: ${dead.map((r) => r.code).join(', ')}`);
  }
  if (liftable.length > 0) {
    console.error(`\nFlagged entries that now return closes — lift the flag: ${liftable.map((r) => r.code).join(', ')}`);
  }
  process.exitCode = dead.length > 0 || liftable.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
