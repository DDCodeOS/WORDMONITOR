import type { ListPipelinesResponse } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';

/**
 * Live RPC paint gate for listPipelines. Partial registry misses set
 * upstreamUnavailable while retaining rows — keep the map when any rows
 * arrived; only blank into showError when the response has nothing to show.
 */
export function shouldErrorOnPipelineLiveResponse(
  live: Pick<ListPipelinesResponse, 'pipelines'>,
): boolean {
  return !(live.pipelines?.length > 0);
}
