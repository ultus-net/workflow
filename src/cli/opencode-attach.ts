#!/usr/bin/env node
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
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

/** Stock-client arguments: connect to the gateway with the client password. */
export function opencodeAttachArgs(discovery: OpencodeServerDiscovery): readonly string[] {
  return ["attach", discovery.gatewayUrl, "--password", discovery.tuiPassword, "--dir", discovery.workspace];
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
  if (existing !== undefined && (await probeOpencodeServerGateway(existing, options.fetchImpl ?? fetch))) {
    return existing;
  }
  if (options.autostart === false) return undefined;

  const candidates = options.spawnCandidates ?? resolveDaemonSpawnCandidates(process.env);
  const candidate = candidates[0];
  if (candidate === undefined) return undefined;
  const spawnFn = options.spawnFn ?? nodeSpawn;
  const child = spawnFn(candidate.cmd, [...candidate.args, "--workspace", options.workspace], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.on?.("error", () => undefined);
  child.unref?.();

  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const discovery = readOpencodeServerDiscovery(discoveryPath);
    if (discovery !== undefined && (await probeOpencodeServerGateway(discovery, options.fetchImpl ?? fetch))) {
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
  const child = nodeSpawn(binary, [...opencodeAttachArgs(discovery)], { stdio: "inherit" });
  await new Promise<void>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.exitCode = code ?? (signal === null ? 1 : 1);
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