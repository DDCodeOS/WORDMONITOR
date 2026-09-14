import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConvergenceCard, CorrelationDomain } from '@/services/correlation-engine';
import type { CorrelationSnapshotState } from '@/services/correlation-snapshots';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), hydrate: vi.fn(), slowTier: vi.fn(), read: vi.fn(), write: vi.fn(),
}));
vi.mock('@/services/bootstrap', () => ({
  ensureHydrated: mocks.fetch,
  getHydratedData: mocks.hydrate,
  waitForBootstrapSlowTier: mocks.slowTier,
}));
vi.mock('@/services/persistent-cache', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/persistent-cache')>(),
  getPersistentCache: mocks.read,
  setPersistentCache: mocks.write,
}));

const NOW = Date.parse('2026-09-14T03:00:00Z');
const MINUTE = 60_000;
let service: typeof import('@/services/correlation-snapshots');
let stops: Array<() => void>;

function card(domain: CorrelationDomain = 'economic', title = 'Sanctions activity'): ConvergenceCard {
  return {
    id: domain, domain, title, score: 42, timestamp: NOW - MINUTE,
    countries: ['US'], trend: 'stable',
    signals: [{ type: 'sanctions', source: 'fixture', severity: 40, timestamp: NOW - MINUTE, label: 'Test signal' }],
  };
}

function payload(economic: unknown = [card()], computedAt = NOW - MINUTE) {
  return { computedAt, military: [], escalation: [], economic, disaster: [] };
}

function saved(cards: ConvergenceCard[] = [card()], computedAt = NOW - 10 * MINUTE) {
  return { data: { economic: { cards, computedAt, origin: 'seed' } }, updatedAt: NOW };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function watch(domain: CorrelationDomain = 'economic') {
  const states: CorrelationSnapshotState[] = [];
  const stop = service.subscribeCorrelationSnapshot(domain, state => states.push(state));
  stops.push(stop);
  return { states, stop, latest: () => states[states.length - 1]! };
}

async function settle() {
  await vi.advanceTimersByTimeAsync(25);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  // Happy DOM's frame scheduling is independent of the fake timeout clock.
  // Route paints through that clock so suite load cannot delay the assertion.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    Number(setTimeout(() => callback(performance.now()), 1)));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  vi.setSystemTime(NOW);
  stops = [];
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.fetch.mockResolvedValue(payload());
  mocks.hydrate.mockReturnValue(undefined);
  mocks.slowTier.mockResolvedValue(true);
  mocks.read.mockResolvedValue(null);
  mocks.write.mockResolvedValue(undefined);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  service = await import('@/services/correlation-snapshots');
});

afterEach(() => {
  stops.forEach(stop => stop());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('correlation snapshot recovery', () => {
  it('shares one request across domains and treats a valid empty domain as success', async () => {
    const economic = watch();
    const military = watch('military');
    watch('disaster');
    watch('escalation');
    await settle();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith('correlationCards');
    expect(economic.latest().snapshot?.cards).toHaveLength(1);
    expect(military.latest()).toEqual({ status: 'current', snapshot: { cards: [], computedAt: NOW - MINUTE, origin: 'seed' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps saved cards on a failed first request and replaces them after automatic recovery', async () => {
    mocks.read.mockResolvedValue(saved());
    mocks.fetch.mockResolvedValueOnce(undefined).mockResolvedValueOnce(payload([], NOW + 15_000));
    const result = watch();
    await settle();
    expect(result.latest().status).toBe('updating');
    expect(result.latest().snapshot?.computedAt).toBe(NOW - 10 * MINUTE);
    expect(result.latest().snapshot?.cards).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(result.latest().status).toBe('current');
    expect(result.latest().snapshot?.cards).toEqual([]);
    expect(mocks.write.mock.calls[mocks.write.mock.calls.length - 1]?.[1].economic.cards).toEqual([]);
  });

  it('restores a confirmed empty result without reviving old activity', async () => {
    mocks.read.mockResolvedValue(saved([]));
    mocks.fetch.mockResolvedValue(undefined);
    const result = watch();
    await settle();
    expect(result.latest().snapshot?.cards).toEqual([]);
    expect(result.latest().status).toBe('updating');
  });

  it.each([
    undefined,
    payload(null),
    payload([{}]),
    payload([{ ...card(), signals: [null] }]),
    payload([{ ...card(), location: { lat: NaN, lon: 0, label: 'Invalid' } }]),
    payload([card()], NOW + 10 * MINUTE),
  ])('retains last known data when a response is missing or malformed: %j', async bad => {
    const result = watch();
    await settle();
    const original = result.latest().snapshot;
    mocks.fetch.mockResolvedValue(bad);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(result.latest().snapshot).toBe(original);
    expect(result.latest().status).toBe('updating');
    expect(console.warn).toHaveBeenCalled();
  });

  it('does not let a malformed sibling remove valid domain data', async () => {
    mocks.fetch.mockResolvedValue({ ...payload(), military: [null] });
    const economic = watch();
    const military = watch('military');
    await settle();
    expect(economic.latest().snapshot?.cards).toHaveLength(1);
    expect(military.latest()).toEqual({ status: 'waiting', snapshot: null });
  });

  it('starts network recovery without waiting for a stuck cache read', async () => {
    mocks.read.mockReturnValue(new Promise(() => {}));
    const result = watch();
    await settle();
    expect(result.latest().snapshot?.cards).toHaveLength(1);
  });

  it('remains usable when persistent reads and writes reject', async () => {
    mocks.read.mockRejectedValue(new Error('storage blocked'));
    mocks.write.mockRejectedValue(new Error('storage full'));
    const result = watch();
    await settle();
    expect(result.latest().status).toBe('current');
    expect(result.latest().snapshot?.cards).toHaveLength(1);
  });

  it('rejects expired or corrupt cache without turning missing data into zero', async () => {
    mocks.read.mockResolvedValue(saved([card()], NOW - 61 * MINUTE));
    mocks.fetch.mockResolvedValue(undefined);
    const result = watch();
    await settle();
    expect(result.latest()).toEqual({ status: 'waiting', snapshot: null });
  });

  it('ages out retained cards while mounted and preserves their computation timestamp', async () => {
    mocks.read.mockResolvedValue(saved([card()], NOW - 59 * MINUTE));
    mocks.fetch.mockResolvedValue(undefined);
    const result = watch();
    await settle();
    expect(result.latest().snapshot?.computedAt).toBe(NOW - 59 * MINUTE);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(result.latest()).toEqual({ status: 'waiting', snapshot: null });
  });

  it('does not let delayed storage or network data replace a newer local computation', async () => {
    const cache = deferred<ReturnType<typeof saved>>();
    const network = deferred<ReturnType<typeof payload>>();
    mocks.read.mockReturnValue(cache.promise);
    mocks.fetch.mockReturnValue(network.promise);
    const result = watch();
    await settle();
    service.publishLocalCorrelationCards('economic', [card('economic', 'New local analysis')]);
    network.resolve(payload());
    cache.resolve(saved());
    await settle();
    expect(result.latest().snapshot?.cards[0]?.title).toBe('New local analysis');
    expect(result.latest().snapshot?.origin).toBe('local');
    expect(result.latest().snapshot?.computedAt).toBe(NOW + 25);
  });

  it('replays a local result to a late subscriber and keeps raw source objects out of storage', async () => {
    const local = card();
    local.assessment = 'Session-specific premium assessment';
    local.signals[0]!.rawData = { bulky: 'source payload' };
    service.publishLocalCorrelationCards('economic', [local]);
    const result = watch();
    await settle();
    expect(result.latest().snapshot?.origin).toBe('local');
    expect(mocks.write.mock.calls[0]?.[1].economic.cards[0].signals[0]).not.toHaveProperty('rawData');
    expect(mocks.write.mock.calls[0]?.[1].economic.cards[0].assessment).toBeUndefined();
  });

  it('does not clear known activity when the local engine has no loaded inputs', async () => {
    const result = watch();
    await settle();
    const known = result.latest().snapshot;
    service.publishLocalCorrelationCards('economic', []);
    expect(result.latest().snapshot).toBe(known);
    mocks.fetch.mockResolvedValue(payload([], NOW + 5 * MINUTE));
    await vi.advanceTimersByTimeAsync(5 * MINUTE + 25);
    expect(result.latest().snapshot?.cards).toEqual([]);
  });

  it('does not call an empty local result a confirmed empty on cold start', async () => {
    mocks.fetch.mockResolvedValue(undefined);
    service.publishLocalCorrelationCards('economic', []);
    const result = watch();
    await settle();
    expect(result.latest()).toEqual({ status: 'waiting', snapshot: null });
  });

  it('makes no offline requests and recovers on reconnect', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const result = watch();
    await settle();
    expect(result.latest()).toEqual({ status: 'waiting', snapshot: null });
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(mocks.fetch).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(result.latest().snapshot?.cards).toHaveLength(1);
  });

  it('stops polling and ignores a late result after the final unsubscribe', async () => {
    const request = deferred<ReturnType<typeof payload>>();
    mocks.fetch.mockReturnValue(request.promise);
    const result = watch();
    await settle();
    result.stop();
    const stateCount = result.states.length;
    request.resolve(payload());
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    window.dispatchEvent(new Event('online'));
    expect(result.states).toHaveLength(stateCount);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('keeps a remounted panel subscribed if the old cleanup runs twice', async () => {
    const first = watch();
    await settle();
    first.stop();
    const second = watch();
    first.stop();
    await settle();
    service.publishLocalCorrelationCards('economic', [card('economic', 'After remount')]);
    expect(second.latest().snapshot?.cards[0]?.title).toBe('After remount');
  });
});

describe('CorrelationPanel presentation', () => {
  async function panel() {
    const { initTestI18n } = await import('./helpers/i18n.mts');
    await initTestI18n();
    const { Panel } = await import('@/components/Panel');
    vi.spyOn(Panel.prototype, 'observeNearViewport').mockImplementation(callback => { queueMicrotask(callback); });
    const { CorrelationPanel } = await import('@/components/CorrelationPanel');
    const result = new CorrelationPanel('economic-correlation', 'Economic Warfare', 'economic');
    document.body.appendChild(result.getElement());
    stops.push(() => result.destroy());
    await settle();
    return result;
  }

  function expectNoError(element: HTMLElement) {
    expect(element.querySelector('.panel-error-state')).toBeNull();
    expect(element.querySelector('.panel-error-countdown')).toBeNull();
    expect(element.querySelector('.panel-header-error')).toBeNull();
  }

  it('renders confirmed empty as content, with a known count', async () => {
    mocks.fetch.mockResolvedValue(payload([]));
    const result = await panel();
    expectNoError(result.getElement());
    expect(result.getElement().textContent).toContain('No active convergence detected');
    expect(result.getElement().querySelector<HTMLElement>('.panel-count')?.hidden).toBe(false);
  });

  it('uses a neutral waiting state without a false zero on cold failure', async () => {
    mocks.fetch.mockResolvedValue(undefined);
    const result = await panel();
    expectNoError(result.getElement());
    expect(result.getElement().textContent).toContain('Waiting for the next data update');
    expect(result.getElement().textContent).not.toContain('No active convergence detected');
    expect(result.getElement().querySelector<HTMLElement>('.panel-count')?.hidden).toBe(true);
  });

  it('retains interactive cards during failure and clears stale status on recovery', async () => {
    const result = await panel();
    mocks.fetch.mockResolvedValueOnce(undefined).mockResolvedValue(payload([], NOW + 5 * MINUTE));
    await vi.advanceTimersByTimeAsync(5 * MINUTE + 25);
    expectNoError(result.getElement());
    expect(result.getElement().textContent).toContain('Sanctions activity');
    expect(result.getElement().textContent).toContain('Last known update');
    result.getElement().querySelector<HTMLElement>('.correlation-card-header')!.click();
    expect(result.getElement().textContent).toContain('Test signal');
    await vi.advanceTimersByTimeAsync(15_000 + 25);
    expectNoError(result.getElement());
    expect(result.getElement().textContent).toContain('No active convergence detected');
    expect(result.getElement().textContent).not.toContain('Last known update');
  });
});
