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
