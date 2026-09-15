import { expect, it, vi } from 'vitest';
const source = vi.hoisted(() => ({ hydrated: undefined as unknown, read: vi.fn() }));
vi.mock('@/services/bootstrap', () => ({ getHydratedData: () => source.hydrated }));
vi.mock('@/services/generated-rpc-clients', () => ({ InfrastructureServiceClient: class {
  listTemporalAnomalies = source.read;
} }));
import { consumeServerAnomalies, fetchLiveAnomalies, hasTemporalBaselineSnapshot } from '@/services/temporal-baseline';

it('distinguishes absent, failed, valid empty and recovered temporal snapshots', async () => {
  source.hydrated = undefined;
  consumeServerAnomalies();
  expect(hasTemporalBaselineSnapshot()).toBe(false);
  source.hydrated = { anomalies: [], trackedTypes: ['news'], computedAt: '2026-09-15T00:00:00Z' };
  consumeServerAnomalies();
  expect(hasTemporalBaselineSnapshot()).toBe(true);
  source.read.mockRejectedValueOnce(new Error('Synthetic upstream failure'));
  await fetchLiveAnomalies();
  expect(hasTemporalBaselineSnapshot()).toBe(false);
  source.read.mockResolvedValueOnce({ anomalies: [], trackedTypes: [], computedAt: '' });
  await fetchLiveAnomalies();
  expect(hasTemporalBaselineSnapshot()).toBe(false);
  source.read.mockResolvedValueOnce({ anomalies: [], trackedTypes: ['news'], computedAt: '2026-09-15T00:01:00Z' });
  await fetchLiveAnomalies();
  expect(hasTemporalBaselineSnapshot()).toBe(true);
});
