import { getHydratedData } from '@/services/bootstrap';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { createCircuitBreaker } from '@/utils/circuit-breaker';
import type {
  CrossSourceSignal,
  ListCrossSourceSignalsResponse,
} from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { IntelligenceServiceClient } from '@/services/generated-rpc-clients';

const client = new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<ListCrossSourceSignalsResponse>({ name: 'Cross-Source Signals', cacheTtlMs: 15 * 60 * 1000, persistCache: true });

export type { ListCrossSourceSignalsResponse };

const EMPTY: ListCrossSourceSignalsResponse = { signals: [], evaluatedAt: 0, compositeCount: 0 };

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isSignalRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize bootstrap/Redis payloads the same way the RPC reader does:
 * skip null/primitive/array rows and coerce non-finite numerics to zero so
 * the panel never receives poison that blanks renderSignal.
 */
export function sanitizeCrossSourceSignalsPayload(payload: unknown): ListCrossSourceSignalsResponse | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (!Array.isArray(raw.signals)) return null;

  const signals = raw.signals.flatMap((signal, index): CrossSourceSignal[] => {
    if (!isSignalRecord(signal)) return [];
    return [{
      id: String(signal.id || `signal:${index}`),
      type: (typeof signal.type === 'string' && signal.type
        ? signal.type
        : 'CROSS_SOURCE_SIGNAL_TYPE_UNSPECIFIED') as CrossSourceSignal['type'],
      theater: String(signal.theater || 'Global'),
      summary: String(signal.summary || ''),
      severity: (typeof signal.severity === 'string' && signal.severity
        ? signal.severity
        : 'CROSS_SOURCE_SIGNAL_SEVERITY_UNSPECIFIED') as CrossSourceSignal['severity'],
      severityScore: finiteOrZero(signal.severityScore),
      detectedAt: finiteOrZero(signal.detectedAt),
      contributingTypes: Array.isArray(signal.contributingTypes) ? signal.contributingTypes.map(String) : [],
      signalCount: finiteOrZero(signal.signalCount),
    }];
  });

  return {
    signals,
    evaluatedAt: finiteOrZero(raw.evaluatedAt),
    compositeCount: finiteOrZero(raw.compositeCount),
  };
}

export async function fetchCrossSourceSignals(): Promise<ListCrossSourceSignalsResponse> {
  const hydrated = sanitizeCrossSourceSignalsPayload(getHydratedData('crossSourceSignals'));
  if (hydrated?.signals.length) {
    breaker.recordSuccess(hydrated);
    return hydrated;
  }

  return breaker.execute(async () => {
    return await client.listCrossSourceSignals({}, { signal: AbortSignal.timeout(15_000) });
  }, EMPTY, { shouldCache: (r) => r.signals.length > 0 });
}
