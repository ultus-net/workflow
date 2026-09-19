#!/usr/bin/env node
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, openSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { globalOpencodeBinary } from "../integrations/opencode-agent-config.js";
import {
  opencodeServerDiscoveryPath,
  probeOpencodeServerGateway,
  readOpencodeServerDiscovery,
  type OpencodeServerDiscovery,
} from "../integrations/opencode-server-discovery.js";

/**
 * W071 — the stock-TUI launcher.
 *
 * Resolves (or starts) the Workflow OpenCode server daemon and then runs the
 * UNMODIFIED `opencode attach` binary against the daemon's gateway. Workflow
 * owns no display: this process supplies connection details only.
 *
 * Usage: `workflow-opencode [--workspace DIR] [--no-autostart]`
 * Environment: WORKFLOW_OPENCODE_SERVER_HOME (state root override),
 * WORKFLOW_OPENCODE_BIN (opencode binary override).
 */

export interface OpencodeAttachArgs {
  readonly workspace: string;
  readonly autostart: boolean;
}

export function parseAttachArgs(argv: readonly string[]): OpencodeAttachArgs {
  let workspace: string | undefined;
  let autostart = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workspace" || argument === "--dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new TypeError(`${argument} requires a value`);
      workspace = value;
      index += 1;
      continue;
    }
    if (argument === "--no-autostart") { autostart = false; continue; }
    if (argument === "--help" || argument === "-h") return { workspace: process.cwd(), autostart };
    throw new TypeError(`unknown argument: ${argument}`);
  }
  return { workspace: workspace ?? process.cwd(), autostart };
}

/** Stock-client arguments: connect to the gateway (password rides the env). */
export function opencodeAttachArgs(discovery: OpencodeServerDiscovery): readonly string[] {
  return ["attach", discovery.gatewayUrl, "--dir", discovery.workspace];
}

/**
 * The discovery file is 0600 single-user state, but a tampered or foreign
 * discovery must still fail closed: the launcher only ever attaches to a
 * loopback gateway (review P3i).
 */
export function isLoopbackGatewayUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
  } catch {
    return false;
  }
}

function discoveryIsTrusted(discovery: OpencodeServerDiscovery): boolean {
  return isLoopbackGatewayUrl(discovery.gatewayUrl) && discovery.workspace !== "";
}

export interface SpawnCandidate {
  readonly cmd: string;
  readonly args: string[];
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Prefers `workflow-opencode-server` on PATH; falls back to the built dist entry. */
export function resolveDaemonSpawnCandidates(
  env: { readonly PATH?: string },
  pkgRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
): SpawnCandidate[] {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir === "") continue;
    const file = join(dir, "workflow-opencode-server");
    if (executable(file)) return [{ cmd: file, args: [] }];
  }
  const dist = resolve(pkgRoot, "dist", "cli", "opencode-server.js");
  return existsSync(dist) ? [{ cmd: process.execPath, args: [dist] }] : [];
}

/** Exclusive `wx` acquire so two concurrent launchers cannot spawn two daemons. */
function acquireSpawnLock(lockPath: string): (() => void) | undefined {
  try {
    const fd = openSync(lockPath, "wx");
    return () => {
      closeSync(fd);
      rmSync(lockPath, { force: true });
    };
  } catch {
    return undefined;
  }
}

export interface EnsureDiscoveryOptions {
  readonly workspace: string;
  readonly stateHome: string;
  readonly autostart?: boolean | undefined;
  readonly spawnFn?: ((cmd: string, args: string[], options: { detached: boolean; stdio: ("ignore" | "inherit" | "pipe")[] }) => ChildProcess) | undefined;
  readonly spawnCandidates?: readonly SpawnCandidate[] | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly pollMs?: number | undefined;
}

/**
 * Resolves a live gateway discovery for the workspace, auto-starting the
 * detached daemon when needed. Fails closed (returns undefined) rather than
 * inventing a server when no daemon can be started or probed.
 */
export async function ensureDiscovery(options: EnsureDiscoveryOptions): Promise<OpencodeServerDiscovery | undefined> {
  const discoveryPath = opencodeServerDiscoveryPath(options.stateHome, options.workspace);
  const existing = readOpencodeServerDiscovery(discoveryPath);
  if (
    existing !== undefined &&
    discoveryIsTrusted(existing) &&
    (await probeOpencodeServerGateway(existing, options.fetchImpl ?? fetch))
  ) {
    return existing;
  }
  if (options.autostart === false) return undefined;

  const candidates = options.spawnCandidates ?? resolveDaemonSpawnCandidates(process.env);
  const candidate = candidates[0];
  if (candidate === undefined) return undefined;

  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  const spawnFn = options.spawnFn ?? nodeSpawn;

  // Spawn lock (review P3j): two concurrent launchers must not start two
  // daemons. The loser waits for the winner's discovery instead.
  const releaseLock = acquireSpawnLock(`${discoveryPath}.spawn.lock`);
  if (releaseLock !== undefined) {
    try {
      const child = spawnFn(candidate.cmd, [...candidate.args, "--workspace", options.workspace], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on?.("error", () => undefined);
      child.unref?.();
    } finally {
      releaseLock();
    }
  }

  while (Date.now() < deadline) {
    const discovery = readOpencodeServerDiscovery(discoveryPath);
    if (
      discovery !== undefined &&
      discoveryIsTrusted(discovery) &&
      (await probeOpencodeServerGateway(discovery, options.fetchImpl ?? fetch))
    ) {
      return discovery;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }
  return undefined;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseAttachArgs(argv);
  const workspace = resolve(args.workspace);
  const stateHome = process.env.WORKFLOW_OPENCODE_SERVER_HOME ?? resolve(homedir(), ".workflow", "opencode-server");
  const discovery = await ensureDiscovery({ workspace, stateHome, autostart: args.autostart });
  if (discovery === undefined) {
    throw new Error("Workflow OpenCode server is unavailable; start it with `workflow-opencode-server` or check the upstream key/containment prerequisites");
  }
  const binary = process.env.WORKFLOW_OPENCODE_BIN ?? globalOpencodeBinary();
  if (binary === undefined) {
    throw new Error("No OpenCode client available: install the opencode CLI globally or set WORKFLOW_OPENCODE_BIN");
  }
  const child = nodeSpawn(binary, [...opencodeAttachArgs(discovery)], {
    stdio: "inherit",
    // The client credential rides the child env, never argv (review P3l:
    // argv is readable by any host user; env is same-user-only).
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: discovery.tuiPassword },
  });
  await new Promise<void>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      process.exitCode = code ?? 1;
      resolveExit();
    });
  });
}

const invokedDirectly = process.argv[1] !== undefined && /opencode-attach\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}