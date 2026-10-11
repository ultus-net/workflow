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
  /**
   * C1 F1: the GATEWAY's own route-matrix posture (`advisory`/`enforced`),
   * resolved from `WORKFLOW_OPENCODE_ENFORCEMENT` at daemon startup. This is a
   * DISTINCT axis from any `enforced` label the hub's authority
   * (`WorkflowApplication` host capability / `authoritativePreMutation`) reports
   * on the snapshot: that one names the hub broker answering pre-mutation, this
   * one names whether the gateway intercepts non-forward routes. They must
   * never be conflated (the C1 F1 fault: a 404 on `POST /api/config` — advisory
   * route matrix — sat beside a snapshot `enforcementLevel: "enforced"` — hub
   * authority axis). Absent on the ambient loopback daemon (no plane posture to
   * report), so a pre-F1 discovery file stays valid.
   */
  readonly gatewayPosture?: "advisory" | "enforced";
}

/**
 * C1 per-revision state-home isolation (follow-up recorded in
 * docs/ledger/control-plane-c1-composition.md, the v0.1.7 rollout collision).
 * Multiple Container App revisions can share the Azure Files mount at the
 * fixed `WORKFLOW_OPENCODE_SERVER_HOME`, so a fresh revision would otherwise
 * reuse — and clobber — the prior revision's discovery file and OpenCode DB.
 * The instance supplies its revision identity in this env var (an instance
 * value, never baked into the image); the deploy side wires the ACA revision
 * value.
 */
export const WORKFLOW_PLANE_REVISION_ENV = "WORKFLOW_PLANE_REVISION";

/**
 * Scopes the daemon state home to a revision identity by appending a single
 * revision subpath — ONLY when a non-empty identity is supplied. Absent or
 * whitespace-only input returns `base` byte-for-byte, so the ambient daemon and
 * every pre-revision deployment keep the exact path they had before.
 *
 * The tag is sanitized to one filesystem-safe segment: a malformed identity
 * that carries no safe characters fails closed rather than silently sharing the
 * base path. The sibling PID-based lock/lease defect (a separate task) is not
 * addressed here — this only makes the STATE HOME path revision-aware.
 */
export function opencodeServerStateHome(base: string, revision?: string): string {
  const identity = revision?.trim();
  if (identity === undefined || identity === "") return base;
  const segment = revisionSegment(identity);
  if (segment === "") {
    throw new TypeError(`revision identity ${JSON.stringify(revision)} has no filesystem-safe characters`);
  }
  return join(base, segment);
}

/** One path segment from a revision name: lowercase alphanumerics plus `. _ -`,
 * every other run collapses to a hyphen, and edge separators are trimmed so the
 * segment can never be `.`, `..`, or absolute. */
function revisionSegment(revision: string): string {
  return revision
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64);
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
      ...(value.gatewayPosture === "advisory" || value.gatewayPosture === "enforced" ? { gatewayPosture: value.gatewayPosture } : {}),
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