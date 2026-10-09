#!/usr/bin/env node
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, openSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isEntrypoint } from "./entrypoint.js";
import { globalOpencodeBinary } from "../integrations/opencode-agent-config.js";
import {
  opencodeServerDiscoveryPath,
  probeOpencodeServerGateway,
  readOpencodeServerDiscovery,
  type OpencodeServerDiscovery,
} from "../integrations/opencode-server-discovery.js";
import { ensureExplicitPlaneReady, planeStateLine } from "../integrations/plane-wake.js";

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
  /** W129: present only when --help/-h was requested — help resolves BEFORE
   * any discovery read or client spawn (help must precede every side effect). */
  readonly help?: true;
}

const USAGE = [
  "workflow-opencode — attach the stock OpenCode client to the Workflow OpenCode server",
  "",
  "Options:",
  "  --workspace <dir>  workspace the client attaches to (default: cwd; alias: --dir)",
  "  --no-autostart     never start the server daemon; fail when discovery is absent",
  "  --help             print this help",
  "",
  "C1 plane lane (remote gateway): set WORKFLOW_OPENCODE_GATEWAY_URL +",
  "  WORKFLOW_OPENCODE_GATEWAY_PASSWORD. The launcher probes health and wakes a",
  "  scaled-to-zero plane when WORKFLOW_PLANE_ACA_RESOURCE_GROUP +",
  "  WORKFLOW_PLANE_ACA_APP are set (an az cli session is required).",
].join("\n");

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
    if (argument === "--help" || argument === "-h") return { workspace: process.cwd(), autostart, help: true };
    throw new TypeError(`unknown argument: ${argument}`);
  }
  return { workspace: workspace ?? process.cwd(), autostart };
}

/** Stock-client arguments: connect to the gateway (password rides the env). */
export function opencodeAttachArgs(discovery: { readonly gatewayUrl: string; readonly workspace: string }): readonly string[] {
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

/**
 * C1 plane lane — an operator-supplied remote gateway (the plane FQDN behind
 * the ingress front door).
 *
 * The loopback gate above exists to reject a TAMPERED discovery file: the
 * launcher must never be steered to an arbitrary host by local state. An
 * explicitly exported URL is operator intent, not discovery state, so it is
 * trusted as-is. It still fails closed on a missing password (a remote attach
 * with no credential cannot authenticate) and on a non-http(s) scheme.
 */
export interface ExplicitGateway {
  readonly gatewayUrl: string;
  readonly tuiUsername: string;
  readonly tuiPassword: string;
}

export function resolveExplicitGateway(env: NodeJS.ProcessEnv): ExplicitGateway | undefined {
  const url = env.WORKFLOW_OPENCODE_GATEWAY_URL;
  if (url === undefined) return undefined;
  const password = env.WORKFLOW_OPENCODE_GATEWAY_PASSWORD;
  if (password === undefined || password === "") {
    throw new Error("WORKFLOW_OPENCODE_GATEWAY_URL is set but WORKFLOW_OPENCODE_GATEWAY_PASSWORD is missing");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`WORKFLOW_OPENCODE_GATEWAY_URL is not a URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`WORKFLOW_OPENCODE_GATEWAY_URL must be http(s): ${url}`);
  }
  return {
    gatewayUrl: url,
    tuiUsername: env.WORKFLOW_OPENCODE_GATEWAY_USERNAME ?? "opencode",
    tuiPassword: password,
  };
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

  // Spawn lock (review P2-3): held for the ENTIRE readiness wait, so a second
  // launcher can never spawn a second daemon — it waits for the winner's
  // discovery instead. The lock is only released once discovery is confirmed
  // (or the wait times out).
  const releaseLock = acquireSpawnLock(`${discoveryPath}.spawn.lock`);
  if (releaseLock !== undefined) {
    try {
      const child = spawnFn(candidate.cmd, [...candidate.args, "--workspace", options.workspace], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on?.("error", () => undefined);
      child.unref?.();
    } catch {
      releaseLock();
      return undefined;
    }
  }

  try {
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
  } finally {
    releaseLock?.();
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseAttachArgs(argv);
  // W129: the help contract — print and exit before ensureDiscovery, whose
  // autostart path could otherwise START THE SERVER DAEMON for `--help`.
  if (args.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const workspace = resolve(args.workspace);
  const stateHome = process.env.WORKFLOW_OPENCODE_SERVER_HOME ?? resolve(homedir(), ".workflow", "opencode-server");
  // C1 plane lane: an explicit operator-exported gateway takes precedence over
  // discovery. No autostart, no discovery read — the plane is a remote surface.
  const explicit = resolveExplicitGateway(process.env);
  let connection: { gatewayUrl: string; tuiUsername: string; tuiPassword: string; workspace: string } | undefined;
  if (explicit === undefined) {
    connection = await ensureDiscovery({ workspace, stateHome, autostart: args.autostart });
  } else {
    // Task 2b plane-awareness: classify (ready/asleep/broken/no-az) and wake a
    // proven-asleep plane before attaching. Anything but ready fails closed with
    // the honest state line rather than attaching to nothing.
    const outcome = await ensureExplicitPlaneReady(explicit, process.env, {
      report: (line) => process.stderr.write(`${line}\n`),
    });
    if (outcome.state.kind !== "ready") {
      throw new Error(planeStateLine(outcome.state));
    }
    connection = { ...explicit, workspace };
  }
  if (connection === undefined) {
    throw new Error("Workflow OpenCode server is unavailable; start it with `workflow-opencode-server` or check the upstream key/containment prerequisites");
  }
  const discovery = connection;
  const binary = process.env.WORKFLOW_OPENCODE_BIN ?? globalOpencodeBinary();
  if (binary === undefined) {
    throw new Error("No OpenCode client available: install the opencode CLI globally or set WORKFLOW_OPENCODE_BIN");
  }
  const child = nodeSpawn(binary, [...opencodeAttachArgs(discovery)], {
    detached: true,
    stdio: "inherit",
    // The client credential rides the child env, never argv (review P3l:
    // argv is readable by any host user; env is same-user-only).
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: discovery.tuiPassword },
  });
  await new Promise<void>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      process.exitCode = code ?? 1;
      terminateProcessGroup(child.pid);
      resolveExit();
    });
    // Idempotent teardown (launcher-loop LESS-0001): lifecycle signals reach
    // this process directly (terminal Ctrl+C to the foreground group, terminal
    // close/SSH hangup as SIGHUP, systemd stop) and again via the launcher's
    // forward. The detached client lives in its own process group and receives
    // neither, so without this handler the attach process dies by default
    // action and the TUI client is orphaned.
    // Kill the client group and exit; the guarded flag makes repeat
    // deliveries (direct + forwarded) no-ops.
    let tornDown = false;
    const teardown = (): void => {
      if (tornDown) return;
      tornDown = true;
      terminateProcessGroup(child.pid);
      process.exit(process.exitCode ?? 0);
    };
    process.on("SIGINT", teardown);
    process.on("SIGTERM", teardown);
    process.on("SIGHUP", teardown);
  });
}

export function terminateProcessGroup(pid: number | undefined): void {
  if (pid === undefined || pid <= 0 || process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    void 0;
  }
}

const invokedDirectly = isEntrypoint(import.meta.url, process.argv[1]);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}