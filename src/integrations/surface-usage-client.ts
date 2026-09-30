import type { SurfaceUsageCounters, SurfaceUsageObservation, TaskUsageSummary } from "./task-usage.js";
import { readHubCredentials } from "./hub-discovery.js";

/**
 * W111 / P4 topology Option A1 (issue #283): the client half of the
 * cross-process record path. A process-separated interactive surface computes
 * its boundary delta locally and calls the returned `post` to relay it to the
 * hub's observability-only `POST /usage/record` route. The hub stays the
 * single writer; the surface holds only the ordinary loopback token it reads
 * from discovery (never a browser or agent).
 *
 * Fail-closed honesty: no hub (or an unreadable discovery record) means the
 * observation is NOT recorded — never a fabricated journal entry. A transport
 * failure is swallowed: the record path must never throw into a live turn
 * boundary. Loopback-only by construction (the discovery endpoint is the hub's
 * `127.0.0.1` bridge).
 */
export interface SurfaceUsagePostOptions {
  /** The hub discovery directory; defaults to `WORKFLOW_HUB_DIR` or `~/.workflow`. */
  readonly hubDiscoveryDir?: string;
  /** Injectable transport for tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export function createSurfaceUsagePost(
  options: SurfaceUsagePostOptions = {},
): (observation: SurfaceUsageObservation) => void {
  const fetchImpl = options.fetchImpl ?? fetch;
  return (observation): void => {
    const hub = readHubCredentials(options.hubDiscoveryDir);
    // No hub → record nothing. Absence is honest; never a fabricated entry.
    if (hub === undefined) return;
    void fetchImpl(`${hub.url}/usage/record`, {
      method: "POST",
      headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" },
      body: JSON.stringify(observation),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  };
}

/** The numeric half of a delta — the counters-only A2 wire shape. */
function countersOf(delta: Omit<TaskUsageSummary, "recordedAt">): SurfaceUsageCounters {
  return {
    requests: delta.requests,
    promptTokens: delta.promptTokens,
    completionTokens: delta.completionTokens,
    totalTokens: delta.totalTokens,
    costUsd: delta.costUsd,
    cacheReadTokens: delta.cacheReadTokens,
    cacheCreateTokens: delta.cacheCreateTokens,
  };
}

/**
 * P4 topology Option A2 (issue #283): the client half of the hub-BOUND record
 * path. At a turn boundary the surface asks the hub to MINT a single-use
 * session id bound to the delta's task (the task is the surface's declared
 * bind, hub-recorded), then posts ONLY the counters plus that id to
 * `/usage/record` — the `taskId` field is REMOVED from the record wire, so the
 * hub derives attribution from its own session→task record. The hub stays the
 * single writer of canonical `taskUsage`.
 *
 * Fail-closed honesty matches A1: no hub (or an unreadable discovery record) →
 * nothing minted and nothing recorded, never a fabricated entry. A transport
 * failure or a refused mint is swallowed: the record path never throws into a
 * live turn boundary. Loopback-only by construction.
 */
export function createSurfaceUsageSessionPost(
  options: SurfaceUsagePostOptions = {},
): (delta: Omit<TaskUsageSummary, "recordedAt">) => void {
  const fetchImpl = options.fetchImpl ?? fetch;
  return (delta): void => {
    const hub = readHubCredentials(options.hubDiscoveryDir);
    // No hub → record nothing. Absence is honest; never a fabricated entry.
    if (hub === undefined) return;
    void (async () => {
      const minted = await fetchImpl(`${hub.url}/usage/session`, {
        method: "POST",
        headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" },
        body: JSON.stringify({ taskId: delta.taskId }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!minted.ok) return;
      const body = (await minted.json()) as { sessionId?: unknown };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) return;
      await fetchImpl(`${hub.url}/usage/record`, {
        method: "POST",
        headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: body.sessionId, ...countersOf(delta) }),
        signal: AbortSignal.timeout(5_000),
      });
    })().catch(() => undefined);
  };
}
