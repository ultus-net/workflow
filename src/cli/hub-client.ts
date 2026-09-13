import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
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

export interface WorkflowHubResolveOptions {
  readonly discoveryDir?: string;
  readonly autohub?: boolean;
  readonly spawnFn?: (cmd: string, args: string[], options: { detached: boolean; stdio: ("ignore" | "inherit" | "pipe")[] }) => ChildProcess;
  readonly spawnCandidates?: SpawnCandidate[];
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

const NO_HUB_MESSAGE =
  "Workflow hub is not running; start the authority daemon with `npm run hub` (source checkout) or `workflow-hub` (installed) before launching a Cline surface";

function autohubEnabled(option: boolean | undefined): boolean {
  if (option !== undefined) return option;
  const env = process.env.WORKFLOW_AUTOHUB;
  return !(env === "0" || env === "false");
}

function resolveTimeout(option: number | undefined): number {
  if (option !== undefined) return option;
  const env = Number(process.env.WORKFLOW_AUTOHUB_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 15_000;
}

async function waitForHub(discoveryPath: string, deadline: number, poll: number): Promise<ResolvedHub | undefined> {
  while (Date.now() < deadline) {
    const discovery = readHubDiscovery(discoveryPath);
    if (discovery !== undefined && (await probeHub(discovery))) {
      return { url: discovery.endpoint, token: discovery.token };
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, poll));
  }
  return undefined;
}

export async function resolveWorkflowHub(
  options: WorkflowHubResolveOptions = {},
): Promise<ResolvedHub> {
  const dir = options.discoveryDir ?? resolve(homedir(), ".workflow");
  const discoveryPath = resolveHubDiscoveryPath(dir);
  const poll = options.pollIntervalMs ?? 250;
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const lockPath = `${discoveryPath}.spawn.lock`;

  const discovery = readHubDiscovery(discoveryPath);
  if (discovery !== undefined && (await probeHub(discovery))) {
    return { url: discovery.endpoint, token: discovery.token };
  }

  if (!autohubEnabled(options.autohub)) {
    rmSync(discoveryPath, { force: true });
    throw new Error(NO_HUB_MESSAGE);
  }

  const candidates = options.spawnCandidates ?? resolveHubSpawnCandidates(process.env);
  if (candidates.length === 0) {
    rmSync(discoveryPath, { force: true });
    throw new Error(NO_HUB_MESSAGE);
  }

  mkdirSync(dirname(lockPath), { recursive: true });
  const releaseLock = acquireSpawnLock(lockPath);
  if (releaseLock === undefined) {
    // Another surface is spawning; wait for its discovery publication.
    const waited = await waitForHub(discoveryPath, deadline, poll);
    if (waited !== undefined) return waited;
    rmSync(discoveryPath, { force: true });
    throw new Error(NO_HUB_MESSAGE);
  }

  try {
    const spawnFn = options.spawnFn ?? nodeSpawn;
    const [candidate] = candidates;
    const child = spawnFn(candidate.cmd, candidate.args, { detached: true, stdio: ["ignore", "ignore", "ignore"] });
    child.on?.("error", () => undefined);
    child.unref?.();
    const resolved = await waitForHub(discoveryPath, deadline, poll);
    if (resolved !== undefined) return resolved;
    rmSync(discoveryPath, { force: true });
    throw new Error(`${NO_HUB_MESSAGE} (auto-spawn attempted via \`${candidate.cmd}\`)`);
  } finally {
    releaseLock();
  }
}
