import type {
  ServerContext,
  GetSectorDependencyRequest,
  GetSectorDependencyResponse,
  DependencyFlag,
  CountryProduct,
} from '../../../../src/generated/server/worldmonitor/supply_chain/v1/service_server';

import { isCallerPremium } from '../../../_shared/premium-check';
import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { SECTOR_DEPENDENCY_KEY } from '../../../_shared/cache-keys';
import { CHOKEPOINT_REGISTRY } from '../../../_shared/chokepoint-registry';
import { BYPASS_CORRIDORS_BY_CHOKEPOINT } from '../../../_shared/bypass-corridors';
import { HS4_CODES, normalizeComtradePartner } from '../../../../scripts/shared/comtrade';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import COUNTRY_PORT_CLUSTERS from '../../../../scripts/shared/country-port-clusters.json';

const CACHE_TTL = 86400; // 24 hours

const HS2_LABELS: Record<string, string> = {
  '1': 'Live Animals', '2': 'Meat', '3': 'Fish & Seafood', '4': 'Dairy',
  '6': 'Plants & Flowers', '7': 'Vegetables', '8': 'Fruit & Nuts',
  '10': 'Cereals', '11': 'Milling Products', '12': 'Oilseeds', '15': 'Animal & Vegetable Fats',
  '16': 'Meat Preparations', '17': 'Sugar', '18': 'Cocoa', '19': 'Food Preparations',
  '22': 'Beverages & Spirits', '23': 'Residues & Animal Feed', '24': 'Tobacco',
  '25': 'Salt & Cement', '26': 'Ores, Slag & Ash', '27': 'Mineral Fuels & Energy',
  '28': 'Inorganic Chemicals', '29': 'Organic Chemicals', '30': 'Pharmaceuticals',
  '31': 'Fertilizers', '38': 'Chemical Products', '39': 'Plastics',
  '40': 'Rubber', '44': 'Wood', '47': 'Pulp & Paper', '48': 'Paper & Paperboard',
  '52': 'Cotton', '61': 'Clothing (Knitted)', '62': 'Clothing (Woven)',
  '71': 'Precious Metals & Gems', '72': 'Iron & Steel', '73': 'Iron & Steel Articles',
  '74': 'Copper', '76': 'Aluminium', '79': 'Zinc', '80': 'Tin',
  '84': 'Machinery & Mechanical Appliances', '85': 'Electrical & Electronic Equipment',
  '86': 'Railway', '87': 'Vehicles', '88': 'Aircraft', '89': 'Ships & Boats',
  '90': 'Optical & Medical Instruments', '93': 'Arms & Ammunition',
};

interface PortClusterEntry { nearestRouteIds: string[]; coastSide: string; }

interface BilateralHs4Payload {
  iso2: string;
  products: CountryProduct[];
}

function computeExposures(nearestRouteIds: string[], hs2: string) {
  // Landlocked or unmapped countries have no routes; return empty so callers
  // receive primaryChokepointId = '' and primaryChokepointExposure = 0 rather than
  // an arbitrary registry-first entry with score 0.
  if (nearestRouteIds.length === 0) return [];
  const isEnergy = hs2 === '27';
  const routeSet = new Set(nearestRouteIds);
  return CHOKEPOINT_REGISTRY.map(cp => {
    const overlap = cp.routeIds.filter(r => routeSet.has(r)).length;
    const maxRoutes = Math.max(cp.routeIds.length, 1);
    let score = (overlap / maxRoutes) * 100;
    if (isEnergy && cp.shockModelSupported) score = Math.min(score * 1.5, 100);
    return { chokepointId: cp.id, exposureScore: Math.round(score * 10) / 10 };
  }).sort((a, b) => b.exposureScore - a.exposureScore);
}

async function getTopExporterShare(iso2: string, hs2: string): Promise<{ exporterIso2: string; share: number; diversified: boolean } | null> {
  const expectedHs4s = HS4_CODES.filter(code => code.startsWith(hs2.padStart(2, '0')));
  if (expectedHs4s.length === 0) return null;
  const payload = await getCachedJson(`comtrade:bilateral-hs4:${iso2}:v1`, true) as BilateralHs4Payload | null;
  if (payload?.iso2 !== iso2 || !Array.isArray(payload.products)) return null;
  const products = payload.products.filter(p => p && expectedHs4s.includes(p.hs4));
  if (products.length !== expectedHs4s.length || new Set(products.map(p => p.hs4)).size !== expectedHs4s.length) return null;
  if (new Set(products.map(p => p.year)).size !== 1) return null;

  const totals = new Map<string, number>();
  let grandTotal = 0;
  let knownTotal = 0;
  for (const product of products) {
    if (!Number.isFinite(product.totalValue) || product.totalValue <= 0
      || !Number.isInteger(product.year) || product.year <= 0 || !Array.isArray(product.topExporters)) return null;
    grandTotal += product.totalValue;
    const origins = new Set<string>();
    let knownProductValue = 0;
    for (const exporter of product.topExporters) {
      if (!exporter || !Number.isFinite(exporter.value) || exporter.value <= 0) continue;
      const partner = normalizeComtradePartner(exporter.partnerCode);
      if (!partner.iso2 || partner.iso2 === iso2 || !['country', 'standard'].includes(partner.kind)) continue;
      if (origins.has(partner.iso2)) return null;
      origins.add(partner.iso2);
      totals.set(partner.iso2, (totals.get(partner.iso2) ?? 0) + exporter.value);
      knownProductValue += exporter.value;
    }
    if (knownProductValue > product.totalValue) return null;
    knownTotal += knownProductValue;
  }
  if (!Number.isFinite(grandTotal) || totals.size === 0) return null;
  const ranked = [...totals].sort((a, b) => b[1] - a[1]);
  const [exporterIso2, topValue] = ranked[0]!;
  const share = topValue / grandTotal;
  const unassignedValue = grandTotal - knownTotal;
  const diversified = totals.size > 1 && (topValue + unassignedValue) / grandTotal <= 0.8;
  if (share <= 0.8 && !diversified) return null;
  if (topValue < (ranked[1]?.[1] ?? 0) + unassignedValue) return null;
  return { exporterIso2, share, diversified };
}

export async function getSectorDependency(
  ctx: ServerContext,
  req: GetSectorDependencyRequest,
): Promise<GetSectorDependencyResponse> {
  const isPro = await isCallerPremium(ctx.request);
  const empty: GetSectorDependencyResponse = {
    iso2: req.iso2,
    hs2: req.hs2 || '27',
    hs2Label: HS2_LABELS[req.hs2 || '27'] ?? `HS ${req.hs2}`,
    flags: [],
    primaryExporterIso2: '',
    primaryExporterShare: 0,
    primaryChokepointId: '',
    primaryChokepointExposure: 0,
    hasViableBypass: false,
    fetchedAt: new Date().toISOString(),
  };
  if (!isPro) return empty;

  const iso2 = req.iso2?.trim().toUpperCase();
  const hs2 = req.hs2?.trim().replace(/\D/g, '') || '27';

  if (!/^[A-Z]{2}$/.test(iso2 ?? '') || !/^\d{1,2}$/.test(hs2)) {
    return { ...empty, iso2: iso2 ?? '', hs2 };
  }

  const cacheKey = SECTOR_DEPENDENCY_KEY(iso2, hs2);

  try {
    const result = await cachedFetchJson<GetSectorDependencyResponse>(
      cacheKey,
      CACHE_TTL,
      async () => {
        const clusters = COUNTRY_PORT_CLUSTERS as unknown as Record<string, PortClusterEntry>;
        const cluster = clusters[iso2];
        const nearestRouteIds = cluster?.nearestRouteIds ?? [];

        const exposures = computeExposures(nearestRouteIds, hs2);
        const primary = exposures[0];

        const primaryChokepointId = primary?.chokepointId ?? '';
        const primaryChokepointExposure = primary?.exposureScore ?? 0;

        const bypassCorridors = BYPASS_CORRIDORS_BY_CHOKEPOINT[primaryChokepointId] ?? [];
        const hasViableBypass = bypassCorridors.some(c => c.suitableCargoTypes.length > 0);

        const concentration = await getTopExporterShare(iso2, hs2);
        if (!concentration) return null;
        const { exporterIso2, share: primaryExporterShare } = concentration;

        const isSingleSource = primaryExporterShare > 0.8;
        const isSingleCorridor = primaryChokepointExposure > 80 && !hasViableBypass;
        const isDiversifiable = hasViableBypass && concentration.diversified;

        const flags: DependencyFlag[] = [];
        if (isSingleSource && isSingleCorridor) {
          flags.push('DEPENDENCY_FLAG_COMPOUND_RISK');
        } else if (isSingleSource) {
          flags.push('DEPENDENCY_FLAG_SINGLE_SOURCE_CRITICAL');
        } else if (isSingleCorridor) {
          flags.push('DEPENDENCY_FLAG_SINGLE_CORRIDOR_CRITICAL');
        } else if (isDiversifiable) {
          flags.push('DEPENDENCY_FLAG_DIVERSIFIABLE');
        }

        return {
          iso2,
          hs2,
          hs2Label: HS2_LABELS[hs2] ?? `HS ${hs2}`,
          flags,
          primaryExporterIso2: exporterIso2,
          primaryExporterShare: Math.round(primaryExporterShare * 1000) / 1000,
          primaryChokepointId,
          primaryChokepointExposure,
          hasViableBypass,
          fetchedAt: new Date().toISOString(),
        };
      },
    );

    return result ?? markNoStoreFallbackResponse(ctx.request, { ...empty, iso2, hs2, fetchedAt: '' });
  } catch {
    return markNoStoreFallbackResponse(ctx.request, { ...empty, iso2, hs2, fetchedAt: '' });
  }
}
