import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * C1 hub endpoint (D5): the hub operator Web UI's loopback discovery file.
 *
 * The hub publishes its own bridge endpoint + token in `hub/discovery.json`
 * (`workflow-hub.ts`). When the hub runs with the UI enabled
 * (`WORKFLOW_HUB_WEB=1`) it ALSO publishes the UI's loopback endpoint BESIDE it
 * as `hub/web.json`, so the gateway's hub route class (which runs in a sibling
 * process) can resolve the UI lane without a hardcoded port. The file carries
 * NO secret: the loopback UI is reachable only through the gateway, which has
 * already enforced the client credential before dispatching a hub-lane request.
 *
 * Written 0o600 and atomically (tmp + rename), mirroring the bridge discovery
 * write, so a reader never sees a half-written file. Unlinked on clean teardown
 * so a stale endpoint never survives the UI it described.
 */

/** The web discovery path for a given hub `discovery.json` path. */
export function hubWebDiscoveryPath(hubDiscoveryPath: string): string {
  return join(dirname(hubDiscoveryPath), "web.json");
}

/** Publish the UI loopback endpoint atomically (0o600). Idempotent rewrite. */
export function writeHubWebDiscovery(hubDiscoveryPath: string, endpoint: string): void {
  const path = hubWebDiscoveryPath(hubDiscoveryPath);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({ protocol: 1, endpoint }), { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

/** Remove the UI discovery file on teardown (idempotent). */
export function removeHubWebDiscovery(hubDiscoveryPath: string): void {
  rmSync(hubWebDiscoveryPath(hubDiscoveryPath), { force: true });
}
