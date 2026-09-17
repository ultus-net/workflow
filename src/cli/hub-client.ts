import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
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
function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveHubSpawnCandidates(
  env: { PATH?: string },
  pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
): SpawnCandidate[] {
  const candidates: SpawnCandidate[] = [];
  for (const dir of (env.PATH ?? "").split(":")) {
    const file = join(dir, "workflow-hub");
    if (dir !== "" && executable(file)) {
      candidates.push({ cmd: file, args: [] });
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
  /**
   * W044 resource hygiene: when autohub SPAWNS a hub, the launcher that
   * caused the spawn owns that hub's lifecycle. The child handle is handed
   * to this callback so the launcher can terminate it on session exit
   * (see terminateOwnedHub). A resolve that REUSES a probed hub never
   * invokes it — reuse must not hand out a kill switch for someone else's
   * daemon.
   */
  readonly onSpawned?: (child: ChildProcess) => void;
}

/**
 * Terminate a hub this launcher auto-spawned. The hub's own SIGTERM handler
 * performs the graceful close (removes discovery, verifier discovery, and the
 * instance lock), so this is the same path `workflow-hub` itself uses on
 * Ctrl+C. Idempotent and safe on an already-exited child.
 */
export function terminateOwnedHub(child: ChildProcess | undefined): void {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
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
  let attempts = 0;
  for (;;) {
    const deadline = Date.now() + timeoutMs;
    const releaseLock = acquireSpawnLock(lockPath);
    if (releaseLock === undefined) {
      // Another surface is spawning; wait for its discovery publication.
      const waited = await waitForHub(discoveryPath, deadline, poll);
      if (waited !== undefined) return waited;
      // Stale lock (older than the spawn timeout) is treated as abandoned:
      // remove it and retry the spawn exactly once, then fail closed.
      if (attempts === 0 && lockStale(lockPath, timeoutMs)) {
        rmSync(lockPath, { force: true });
        attempts += 1;
        continue;
      }
      rmSync(discoveryPath, { force: true });
      throw new Error(NO_HUB_MESSAGE);
    }

    try {
      const spawnFn = options.spawnFn ?? nodeSpawn;
      const candidate = candidates[0]!;
      const child = spawnFn(candidate.cmd, candidate.args, { detached: true, stdio: ["ignore", "ignore", "ignore"] });
      child.on?.("error", () => undefined);
      child.unref?.();
      options.onSpawned?.(child);
      const resolved = await waitForHub(discoveryPath, deadline, poll);
      if (resolved !== undefined) return resolved;
      rmSync(discoveryPath, { force: true });
      throw new Error(`${NO_HUB_MESSAGE} (auto-spawn attempted via \`${candidate.cmd}\`)`);
    } finally {
      releaseLock();
    }
  }
}

/** A lock older than the spawn timeout is treated as abandoned. */
function lockStale(lockPath: string, timeoutMs: number): boolean {
  try {
    return statSync(lockPath).mtimeMs < Date.now() - timeoutMs;
  } catch {
    return false;
  }
}
