import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { BoundaryKind } from "../containment/contracts.js";
import { opencodeServerWorkspaceTag } from "./opencode-server-runtime.js";
import { probeOpencodeHealth } from "./opencode-health.js";

/**
 * W071 — launcher discovery for the Workflow-owned OpenCode server.
 *
 * The discovery file is the only thing the client-facing launcher reads. It
 * carries the gateway URL and the client-facing password, and deliberately
 * NEVER the upstream server credential — the upstream password stays in the
 * daemon process, which is what makes the gateway the sole upstream client.
 */

export interface OpencodeServerDiscovery {
  readonly protocol: 1;
  readonly pid: number;
  readonly workspace: string;
  readonly gatewayUrl: string;
  readonly tuiUsername: string;
  readonly tuiPassword: string;
  readonly version?: string;
  /**
   * C1: which containment boundary the daemon's contained `opencode serve`
   * runs behind (`bwrap` locally, `container-boundary` in the ACA pod). Set
   * only in plane mode; absent on the ambient loopback daemon, whose boundary
   * is not a deploy claim. The C1 live probe asserts `container-boundary`
   * over the wire before any pod-side `enforced` label is claimed (deploy
   * plan §2.b/§4 task 3.1).
   */
  readonly boundaryKind?: BoundaryKind;
}

export function opencodeServerDiscoveryDir(home: string = homedir()): string {
  return resolve(home, ".workflow", "opencode-server");
}

export function opencodeServerDiscoveryPath(stateHome: string, workspace: string): string {
  return join(stateHome, `${opencodeServerWorkspaceTag(resolve(workspace))}.json`);
}

export function readOpencodeServerDiscovery(path: string): OpencodeServerDiscovery | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value)) return undefined;
    if (
      value.protocol !== 1 ||
      typeof value.pid !== "number" ||
      typeof value.workspace !== "string" ||
      typeof value.gatewayUrl !== "string" ||
      typeof value.tuiUsername !== "string" ||
      typeof value.tuiPassword !== "string"
    ) {
      return undefined;
    }
    return {
      protocol: 1,
      pid: value.pid,
      workspace: value.workspace,
      gatewayUrl: value.gatewayUrl,
      tuiUsername: value.tuiUsername,
      tuiPassword: value.tuiPassword,
      ...(typeof value.version === "string" ? { version: value.version } : {}),
      ...(value.boundaryKind === "bwrap" || value.boundaryKind === "container-boundary" ? { boundaryKind: value.boundaryKind } : {}),
    };
  } catch {
    return undefined;
  }
}

export function writeOpencodeServerDiscovery(path: string, discovery: OpencodeServerDiscovery): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(discovery), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function removeOpencodeServerDiscovery(path: string): void {
  rmSync(path, { force: true });
}

/**
 * Probes the gateway through its own auth, so a stale discovery whose daemon
 * is gone fails the probe rather than being trusted. The probe walks both
 * health contracts (/api/info on v2, /global/health on v1) because the
 * enforced gateway only forwards classified routes.
 */
export async function probeOpencodeServerGateway(
  discovery: OpencodeServerDiscovery,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const auth = `Basic ${Buffer.from(`${discovery.tuiUsername}:${discovery.tuiPassword}`).toString("base64")}`;
  return (await probeOpencodeHealth(fetchImpl, discovery.gatewayUrl, auth)) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}