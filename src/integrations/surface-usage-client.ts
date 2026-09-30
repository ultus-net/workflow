import type { SurfaceUsageObservation } from "./task-usage.js";
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
