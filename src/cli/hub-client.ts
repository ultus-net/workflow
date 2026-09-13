import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHubDiscoveryPath } from "../integrations/workflow-hub.js";

/**
 * Launcher-side hub client. Resolves the global Workflow hub through its
 * discovery file and fails closed when the daemon is unavailable.
 * See `docs/HUB.md` operational semantics.
 */

export interface HubDiscovery {
  readonly hubId: string;
  readonly endpoint: string;
  readonly token: string;
}

export interface ResolvedHub {
  readonly url: string;
  readonly token: string;
}

export function readHubDiscovery(discoveryPath: string): HubDiscovery | undefined {
  if (!existsSync(discoveryPath)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(discoveryPath, "utf8"));
    if (
      typeof value !== "object" || value === null ||
      typeof (value as Record<string, unknown>).hubId !== "string" ||
      typeof (value as Record<string, unknown>).endpoint !== "string" ||
      typeof (value as Record<string, unknown>).token !== "string"
    ) {
      return undefined;
    }
    return value as HubDiscovery;
  } catch {
    return undefined;
  }
}

export async function probeHub(discovery: HubDiscovery): Promise<boolean> {
  try {
    const response = await fetch(`${discovery.endpoint}/health`, {
      method: "POST",
      headers: { authorization: `Bearer ${discovery.token}` },
      signal: AbortSignal.timeout(2_000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

export interface SpawnCandidate {
  readonly cmd: string;
  readonly args: string[];
}

/**
 * Resolve the command used to spawn the detached hub daemon. Prefers a
 * `workflow-hub` executable on PATH (global install) and falls back to the
 * built `<pkgRoot>/dist/cli/hub.js` under the current Node runtime (source
 * checkout).
 */
export function resolveHubSpawnCandidates(
  env: { PATH?: string },
  pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
): SpawnCandidate[] {
  const candidates: SpawnCandidate[] = [];
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir !== "" && existsSync(join(dir, "workflow-hub"))) {
      candidates.push({ cmd: join(dir, "workflow-hub"), args: [] });
      break;
    }
  }
  const distHub = resolve(pkgRoot, "dist", "cli", "hub.js");
  if (candidates.length === 0 && existsSync(distHub)) {
    candidates.push({ cmd: process.execPath, args: [distHub] });
  }
  return candidates;
}

/** Exclusive `wx` acquire; release closes the fd and removes the lock file. */
export function acquireSpawnLock(lockPath: string): (() => void) | undefined {
  try {
    const fd = openSync(lockPath, "wx");
    return () => {
      try {
        closeSync(fd);
      } finally {
        rmSync(lockPath, { force: true });
      }
    };
  } catch {
    return undefined;
  }
}

export async function resolveWorkflowHub(
  options: { discoveryDir?: string } = {},
): Promise<ResolvedHub> {
  const dir = options.discoveryDir ?? resolve(homedir(), ".workflow");
  const discoveryPath = resolveHubDiscoveryPath(dir);
  const discovery = readHubDiscovery(discoveryPath);
  if (discovery !== undefined && (await probeHub(discovery))) {
    return { url: discovery.endpoint, token: discovery.token };
  }
  // Obsolete or missing discovery: remove the stale file and fail closed.
  rmSync(discoveryPath, { force: true });
  throw new Error(
    "Workflow hub is not running; start the authority daemon with `npm run hub` (source checkout) or `workflow-hub` (installed) before launching a Cline surface",
  );
}
