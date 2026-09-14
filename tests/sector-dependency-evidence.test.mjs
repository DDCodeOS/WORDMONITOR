import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getSectorDependency } from '../server/worldmonitor/supply-chain/v1/get-sector-dependency.ts';
import { SECTOR_DEPENDENCY_KEY } from '../server/_shared/cache-keys.ts';
import { drainResponseHeaders } from '../server/_shared/response-headers.ts';
import { groupByProduct, toCanonicalProduct } from '../scripts/shared/comtrade.mjs';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const env = { ...process.env };
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let sequence = 0;
afterEach(() => { process.env = { ...env }; globalThis.fetch = originalFetch; Date.now = originalNow; });
const codes = ['2709', '2710', '2711'];
const fixture = (partners = [['124', 90], ['484', 10]]) => ({
  iso2: 'US', requestedHs4s: codes, fetchedAt: '2026-09-14T00:00:00Z',
  products: groupByProduct(codes.flatMap(cmdCode => [['0', 100], ...partners].map(([partnerCode, primaryValue]) => ({
    cmdCode, partnerCode, primaryValue, year: 2025,
  })))).map(toCanonicalProduct),
});

async function call(payload, iso2 = 'US', hs2 = '27', readFailure = false) {
  const now = originalNow() + ++sequence * 180000;
  Date.now = () => now;
  process.env.WORLDMONITOR_VALID_KEYS = 'sector-fixture';
  process.env.VERCEL_ENV = 'production';
  const state = installRedis({
    [`supply-chain:sector-dep:${iso2}:${hs2}:v1`]: { flags: ['DEPENDENCY_FLAG_DIVERSIFIABLE'], primaryExporterShare: 0 },
    ...(payload == null ? {} : { [`comtrade:bilateral-hs4:${iso2}:v1`]: payload }),
  }, { keepVercelEnv: true });
  if (readFailure) {
    const redisFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => String(input).includes('bilateral-hs4')
      ? Promise.resolve(Response.json({ error: 'fixture read failure' })) : redisFetch(input, init);
  }
  const request = new Request('https://app.fixture/api/supply-chain/v1/get-sector-dependency', { headers: { 'X-WorldMonitor-Key': 'sector-fixture' } });
  const result = await getSectorDependency({ request }, { iso2, hs2 });
  return { result, state, headers: drainResponseHeaders(request) };
}

test('sector concentration consumes the import producer shape across the HS2 chapter', async () => {
  const payload = fixture();
  payload.products.push(...groupByProduct([{ cmdCode: '8542', partnerCode: '156', primaryValue: 10000, year: 2025 }]).map(toCanonicalProduct));
  const { result, state } = await call(payload);
  assert.equal(result.primaryExporterIso2, 'CA');
  assert.equal(result.primaryExporterShare, 0.9);
  assert.deepEqual(result.flags, ['DEPENDENCY_FLAG_SINGLE_SOURCE_CRITICAL']);
  assert.equal(SECTOR_DEPENDENCY_KEY('US', '27'), 'supply-chain:sector-dep:US:27:v2');
  assert.equal(state.expires.get(SECTOR_DEPENDENCY_KEY('US', '27')), 86400);
});

test('sector shares keep the full product denominator and weight different heading values', async () => {
  const payload = fixture([['124', 50], ['484', 30]]);
  payload.products[0].totalValue = 200;
  payload.products[0].topExporters[0].value = 100;
  payload.products[0].topExporters[1].value = 60;
  const { result } = await call(payload, 'US', '27');
  assert.equal(result.primaryExporterShare, 0.5);
  assert.equal(result.primaryExporterIso2, 'CA');
  assert.ok(result.flags.includes('DEPENDENCY_FLAG_DIVERSIFIABLE'));
});

test('World, unspecified and invalid partners cannot become the primary exporter', async () => {
  const payload = fixture([['124', 50], ['484', 30]]);
  for (const product of payload.products) product.topExporters.push(
    { partnerCode: '000', value: 100, partnerIso2: 'XX' },
    { partnerCode: 899, value: 100, partnerIso2: 'XX' },
    { partnerCode: 999, value: 0, partnerIso2: 'XX' },
    { partnerCode: 156, value: -10, partnerIso2: 'CN' },
    { partnerCode: 392, value: Number.NaN, partnerIso2: 'JP' },
  );
  const { result } = await call(payload);
  assert.equal(result.primaryExporterIso2, 'CA');
  assert.equal(result.primaryExporterShare, 0.5);
  assert.ok(result.flags.includes('DEPENDENCY_FLAG_DIVERSIFIABLE'));
});

for (const [label, payload] of [
  ['missing', null], ['empty', { iso2: 'DE', products: [] }],
  ['wrong reporter', fixture()],
  ['malformed products', { iso2: 'DE', products: {} }],
  ['World-only', { ...fixture([['000', 100]]), iso2: 'DE' }],
  ['duplicate origins', { ...fixture(), iso2: 'DE', products: fixture().products.map(p => ({ ...p, topExporters: [...p.topExporters, p.topExporters[0]] })) }],
  ['missing heading', { ...fixture(), iso2: 'DE', products: fixture().products.slice(1) }],
  ['unresolved partners', { ...fixture([['899', 100]]), iso2: 'DE' }],
  ['hidden concentration', { ...fixture([['124', 10], ['484', 5]]), iso2: 'DE' }],
  ['truncated origins', { ...fixture([['124', 20], ['484', 15], ['156', 14], ['392', 13], ['276', 12], ['410', 11], ['360', 10]]), iso2: 'DE' }],
  ['mixed years', { ...fixture(), iso2: 'DE', products: fixture().products.map((p, i) => ({ ...p, year: 2025 - i })) }],
]) {
  test(`sector ${label} stays no-data and never receives a positive 24h cache`, async () => {
    const { result, state, headers } = await call(payload, 'DE', String(27));
    assert.equal(result.primaryExporterShare, 0);
    assert.deepEqual(result.flags, []);
    assert.equal(headers?.['X-No-Cache'], '1');
    assert.notEqual(state.expires.get(SECTOR_DEPENDENCY_KEY('DE', '27')), 86400);
  });
}


test('sector evidence is keyed by the requested reporter outside the legacy flow universe', async () => {
  const { result } = await call({ ...fixture(), iso2: 'ZA' }, 'ZA');
  assert.equal(result.iso2, 'ZA');
  assert.equal(result.primaryExporterIso2, 'CA');
  assert.equal(result.primaryExporterShare, 0.9);
});


test('a failed bilateral read returns no-data without a positive derived cache', async () => {
  const { result, state, headers } = await call({ ...fixture(), iso2: 'GB' }, 'GB', '27', true);
  assert.equal(result.primaryExporterShare, 0);
  assert.deepEqual(result.flags, []);
  assert.equal(headers?.['X-No-Cache'], '1');
  assert.notEqual(state.expires.get(SECTOR_DEPENDENCY_KEY('GB', '27')), 86400);
});
