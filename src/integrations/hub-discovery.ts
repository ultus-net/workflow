import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The one discovery read the loopback surfaces share (extracted from the web
 * service's `hubCredentials`, which used this exact path). A process-separated
 * surface reads the hub's published `discovery.json` to learn the loopback
 * endpoint and ordinary token; the token never reaches a browser or an agent.
 * Reading is fail-closed: a missing/malformed/unreadable file answers
 * `undefined` and the caller records nothing rather than fabricating a hub.
 */

/** The hub discovery directory (the parent of the `hub/` subdirectory). */
export function hubDiscoveryDirectory(override?: string): string {
  return override ?? process.env.WORKFLOW_HUB_DIR ?? resolve(homedir(), ".workflow");
}

/**
 * Read the hub's loopback endpoint + ordinary token, re-read on every call so
 * a hub restart is picked up without restarting the caller. Returns
 * `undefined` when no hub is running or the file is malformed.
 */
export function readHubCredentials(override?: string): { url: string; token: string } | undefined {
  const path = join(hubDiscoveryDirectory(override), "hub", "discovery.json");
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof value !== "object" || value === null ||
      typeof (value as Record<string, unknown>).endpoint !== "string" ||
      typeof (value as Record<string, unknown>).token !== "string"
    ) {
      return undefined;
    }
    const record = value as { endpoint: string; token: string };
    return { url: record.endpoint, token: record.token };
  } catch {
    return undefined;
  }
}

/**
 * The hub operator Web UI's loopback endpoint, published BESIDE
 * `discovery.json` as `hub/web.json` when the hub runs with the UI enabled
 * (`WORKFLOW_HUB_WEB=1`). The gateway's hub-UI route class resolves the hub UI
 * lane through this — the same fail-closed read discipline as
 * `readHubCredentials` (missing/malformed answers `undefined`, so an absent hub
 * UI lane is a withheld capability, never a fabricated target). The file
 * carries no secret: the loopback UI is reached only through the gateway, which
 * has already enforced the client credential before dispatching here.
 */
export function readHubWebEndpoint(override?: string): string | undefined {
  const path = join(hubDiscoveryDirectory(override), "hub", "web.json");
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof value !== "object" || value === null ||
      typeof (value as Record<string, unknown>).endpoint !== "string"
    ) {
      return undefined;
    }
    const endpoint = (value as { endpoint: string }).endpoint;
    // Shape-validate to a loopback http origin. A corrupt/hostile web.json must
    // answer `undefined` (→ the gateway's 503 withheld lane), NOT a string that
    // makes the forwarded `new URL(endpoint)` throw into a 500: the read is the
    // fail-closed seam, so a malformed endpoint is withheld here.
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) return undefined;
    return endpoint;
  } catch {
    return undefined;
  }
}
