/**
 * Stable Sentry grouping fingerprint for an `api/mcp` error capture.
 *
 * Why this exists: the minified edge bundle gives every tool-execution error
 * identical anonymous frames (`(vc/edge/function`, no source map, in_app=false),
 * so Sentry's default stack-based grouping merges ALL api/mcp failures — across
 * every tool AND every status code — into ONE catch-all issue (WORLDMONITOR-T8)
 * whose title only reflects the newest event. That masks a real 5xx spike in one
 * tool behind low-grade auth drift in another. Supplying an explicit fingerprint
 * overrides the stack grouping and splits each failure mode into its own
 * trackable group.
 *
 * Signature derivation:
 *  - Sibling-fetch failures are thrown as `<inner-endpoint> HTTP <status>`
 *    (see api/mcp/registry/rpc-tools.ts). Key on `<endpoint>:<status>` and drop
 *    any trailing `: <reason>` so `HTTP 401` and
 *    `HTTP 401: invalid_internal_mcp_signature` coalesce into one group rather
 *    than fragmenting on the variable reason token.
 *  - Any other failure (timeout, abort, TypeError from a bad _postFilter) keys
 *    on the stable error name so distinct runtime faults stay separable.
 *
 * The `step` distinguishes the two capture sites in dispatch.ts (`tool-execution`
 * vs `post-filter`) so a post-filter bug never re-merges with the fetch path.
 *
 * Pure + zero-import by design so it is unit-testable from the `tests/*.test.mjs`
 * runner without a Sentry DSN or a full dispatch harness.
 */
export function mcpErrorFingerprint(step: string, toolName: string, err: unknown): string[] {
  const message = err instanceof Error ? err.message : String(err);
  const siblingHttp = message.match(/^([A-Za-z0-9_-]+) HTTP (\d{3})\b/);

  // A 401 on the sibling hop is the ONE failure that must not be split per
  // tool. Every other status describes the endpoint that produced it, but a
  // 401 here describes the internal-MCP auth hop itself: the edge signs an
  // HMAC of the outbound request and the gateway verifies it, so a rejection
  // is a property of that shared mechanism, not of whichever tool happened to
  // be calling. (Nothing else reaches this branch: for an internal-MCP-signed
  // request the gateway's tier and legacy-bearer gates are bypassed, leaving
  // the signature and replay-nonce checks as the only sources of a 401.)
  //
  // Split per tool, one bug becomes a new issue for every route it touches,
  // each carrying a handful of events — small enough to read as noise and be
  // resolved, and it has been, repeatedly: four issues on four routes since
  // July (WORLDMONITOR-XZ / WZ / WN / VK, 4/8/1/3 events, three of them
  // already closed), while gateway telemetry shows 401s on two further routes
  // that have no Sentry issue at all.
  //
  // Note this does NOT merge into the existing issues — a changed fingerprint
  // opens a fresh group, so XZ and its siblings stop receiving events and the
  // history stays where it is. The point is forward-looking: from here every
  // route's rejections accumulate in ONE place, so the next occurrence reads
  // as the recurring infrastructure bug it is rather than a new curiosity.
  //
  // The `: <reason>` suffix is dropped for the same reason it is dropped
  // below — only some call sites append the gateway's response body, so
  // keying on it would re-fragment the group it is meant to unify.
  if (siblingHttp && siblingHttp[2] === '401') {
    return ['mcp-internal-auth-401'];
  }

  const signature = siblingHttp
    ? `${siblingHttp[1]}:${siblingHttp[2]}`
    : err instanceof Error
      ? err.name || err.constructor.name
      : 'non-error';
  return [`mcp-${step}`, toolName, signature];
}
