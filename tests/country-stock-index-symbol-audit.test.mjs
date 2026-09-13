import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditCountryStockIndexes,
  chartUrl,
  classify,
  countFiniteCloses,
} from '../scripts/audit-country-stock-index-symbols.mjs';

// #6240: the audit is the only thing that can say when an `unavailable` flag
// should be lifted or a live symbol has died, so its decision table is pinned
// here without the network. The seeder's URL shape is reused verbatim so the
// audit cannot pass on a chart the seeder would never request.

function chart(closes) {
  return { chart: { result: [{ meta: { currency: 'EUR' }, indicators: { quote: [{ close: closes }] } }] } };
}

test('the audit requests the exact chart the seeder requests', () => {
  assert.equal(
    chartUrl('^PX'),
    'https://query1.finance.yahoo.com/v8/finance/chart/%5EPX?range=1mo&interval=1d',
  );
});

test('finite-close counting ignores nulls and a missing result', () => {
  assert.equal(countFiniteCloses(chart([1, null, 2, Number.NaN, 3])), 3);
  assert.equal(countFiniteCloses({ chart: { result: [] } }), 0);
  assert.equal(countFiniteCloses(undefined), 0);
});

test('the decision table distinguishes all four contract-versus-Yahoo outcomes', () => {
  const live = { code: 'DE', symbol: '^GDAXI', name: 'DAX' };
  const flagged = { ...live, code: 'RU', unavailable: { checked: '2026-09-13', reason: 'dead' } };
  assert.equal(classify(live, { closes: 22, error: null }), 'ok');
  assert.equal(classify(live, { closes: 1, error: null }), 'dead-but-serviceable');
  assert.equal(classify(live, { closes: 0, error: 'HTTP 429' }), 'dead-but-serviceable');
  assert.equal(classify(flagged, { closes: 0, error: null }), 'flagged-still-dead');
  assert.equal(classify(flagged, { closes: 22, error: null }), 'flag-can-lift');
});

test('a probe failure is recorded per country and never aborts the run', async () => {
  const indexes = [
    { code: 'DE', symbol: '^GDAXI', name: 'DAX' },
    { code: 'PL', symbol: '^WIG20', name: 'WIG20', unavailable: { checked: '2026-09-13', reason: 'dead' } },
    { code: 'PT', symbol: 'PSI20.LS', name: 'PSI' },
  ];
  const requested = [];
  const rows = await auditCountryStockIndexes({
    indexes,
    delayMs: 0,
    fetchJson: async (url) => {
      requested.push(url);
      if (url.includes('GDAXI')) return chart([100, 101, 102]);
      if (url.includes('WIG20')) return chart([]);
      throw new Error('retries exhausted');
    },
  });

  assert.equal(requested.length, 3, 'every declared entry is probed, flagged ones included');
  assert.deepEqual(
    rows.map((row) => [row.code, row.verdict, row.snapshot]),
    [
      ['DE', 'ok', true],
      ['PL', 'flagged-still-dead', false],
      ['PT', 'dead-but-serviceable', false],
    ],
  );
  assert.equal(rows[2].error, 'retries exhausted');
});
