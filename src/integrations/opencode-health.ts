/**
 * Server health across both pinned opencode contracts (W072 v2 qualification).
 *
 * v2 moved the authenticated liveness envelope: GET /api/info answers the
 * `{version, pid, urls, ...}` JSON, while v1 answered GET /global/health with
 * `{healthy: true, version?}`. v2 turns /global/health into its web-UI HTML
 * catch-all — a 200 whose body must never parse as healthy. Probing only the
 * v1 route dead-locked startup detection on 2.0.10 (the W071 launch test hit
 * its 30s health timeout with an empty stderr), so probes walk both contracts:
 * the v2 route first, then the v1 fallback.
 */

const HEALTH_PROBE_PATHS = ["/api/info", "/global/health"] as const;

/** True when a parsed health/info body proves the server is healthy. */
export function isHealthyOpencodeBody(path: string, body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  if (record.healthy === true) return true;
  return path === "/api/info" && typeof record.version === "string";
}

export interface OpencodeHealthVerdict {
  readonly version?: string | undefined;
}

/**
 * Proves health against either contract and returns the server's reported
 * version, or `undefined` when nothing proves health (connection errors, auth
 * failures, missing routes, non-JSON catch-alls). Auth failures are not
 * distinguished here: callers that must surface a wrong credential loudly
 * (the remote engine) re-check the response status themselves.
 */
export async function probeOpencodeHealth(
  fetchImpl: typeof fetch,
  baseUrl: string,
  auth: string | undefined,
): Promise<OpencodeHealthVerdict | undefined> {
  for (const path of HEALTH_PROBE_PATHS) {
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        headers: auth === undefined ? {} : { authorization: auth },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) continue;
      const body: unknown = await response.json();
      if (isHealthyOpencodeBody(path, body)) {
        const version = typeof body === "object" && body !== null && !Array.isArray(body)
          && typeof (body as Record<string, unknown>).version === "string"
          ? (body as Record<string, unknown>).version as string
          : undefined;
        return version === undefined ? {} : { version };
      }
    } catch {
      // Not up yet, the route is missing (v1 + /api/info), or the body is the
      // v2 HTML catch-all. Try the next contract.
    }
  }
  return undefined;
}
