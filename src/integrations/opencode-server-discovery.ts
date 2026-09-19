import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { opencodeServerWorkspaceTag } from "./opencode-server-runtime.js";

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
 * Probes the gateway through its own auth (`/global/health`), so a stale
 * discovery whose daemon is gone fails the probe rather than being trusted.
 */
export async function probeOpencodeServerGateway(
  discovery: OpencodeServerDiscovery,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const auth = `Basic ${Buffer.from(`${discovery.tuiUsername}:${discovery.tuiPassword}`).toString("base64")}`;
    const response = await fetchImpl(`${discovery.gatewayUrl}/global/health`, {
      headers: { authorization: auth },
      signal: AbortSignal.timeout(2_000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}