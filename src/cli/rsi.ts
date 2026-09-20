#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveHubDiscoveryPath } from "../integrations/workflow-hub.js";
import type { SelfImprovementSpec } from "../integrations/self-improvement-registry.js";
import { readHubDiscovery, type ResolvedHub } from "./hub-client.js";

/**
 * W073 operator trigger: `workflow-rsi start|status|cancel` talks to the hub's
 * `/rsi/*` routes. The hub owns the loop registry; this client holds no
 * authority and never runs a loop in-process. `start` requires the verifier
 * credential (`verifier.json`, distributed separately from the ordinary
 * discovery token) — the same credential that may finish runs — because
 * starting an autonomous mutation loop is a consequential action (P1-1,
 * adversarial review). `status`/`cancel` use the ordinary operator token.
 *
 * Usage:
 *   workflow-rsi start --workspace <abs> --objective <text> --max-iterations <n>
 *                      [--no-review] [--budget <usd>] [--direction higher|lower]
 *                      [--baseline <score>] [--max-consecutive-rejections <n>]
 *                      [--discovery-dir <dir>]
 *   workflow-rsi status [--id <loopId>] [--discovery-dir <dir>]
 *   workflow-rsi cancel (--id <loopId> | --workspace <abs>) [--discovery-dir <dir>]
 */

export interface RsiArgs {
  readonly command: "start" | "status" | "cancel" | "help";
  readonly discoveryDir: string;
  readonly workspace?: string;
  readonly id?: string;
  readonly spec?: Partial<SelfImprovementSpec>;
}

export function parseRsiArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): RsiArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined || !token.startsWith("--")) throw new TypeError(`unexpected argument: ${String(token)}`);
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  const discoveryDir = typeof flags.get("discovery-dir") === "string"
    ? (flags.get("discovery-dir") as string)
    : env.WORKFLOW_HUB_DIR ?? resolve(homedir(), ".workflow");
  if (command !== "start" && command !== "status" && command !== "cancel" && command !== "help") {
    throw new TypeError(`unknown command: ${command}`);
  }
  if (command === "help") return { command, discoveryDir };
  if (command === "status") {
    const id = typeof flags.get("id") === "string" ? (flags.get("id") as string) : undefined;
    return { command, discoveryDir, ...(id === undefined ? {} : { id }) };
  }
  if (command === "cancel") {
    const id = typeof flags.get("id") === "string" ? (flags.get("id") as string) : undefined;
    const workspace = typeof flags.get("workspace") === "string" ? (flags.get("workspace") as string) : undefined;
    if (id === undefined && workspace === undefined) throw new TypeError("cancel requires --id or --workspace");
    return { command, discoveryDir, ...(id === undefined ? {} : { id }), ...(workspace === undefined ? {} : { workspace }) };
  }
  // start
  const workspace = typeof flags.get("workspace") === "string" ? (flags.get("workspace") as string) : undefined;
  const objective = typeof flags.get("objective") === "string" ? (flags.get("objective") as string) : undefined;
  const maxIterations = typeof flags.get("max-iterations") === "string" ? Number(flags.get("max-iterations")) : undefined;
  if (workspace === undefined || objective === undefined || maxIterations === undefined) {
    throw new TypeError("start requires --workspace, --objective, and --max-iterations");
  }
  const budget = typeof flags.get("budget") === "string" ? Number(flags.get("budget")) : undefined;
  const baseline = typeof flags.get("baseline") === "string" ? Number(flags.get("baseline")) : undefined;
  const streak = typeof flags.get("max-consecutive-rejections") === "string" ? Number(flags.get("max-consecutive-rejections")) : undefined;
  const direction = flags.get("direction");
  if (direction !== undefined && direction !== "higher" && direction !== "lower") {
    throw new TypeError("--direction must be higher or lower");
  }
  return {
    command,
    discoveryDir,
    workspace,
    spec: {
      workspace,
      objective,
      maxIterations,
      // P0-2 (adversarial review): the review gate is on by default; opting
      // out is the explicit `--no-review` flag. (The old presence-based
      // `--requires-review` silently dropped the gate when given a value.)
      ...(flags.get("no-review") === true ? { requiresReview: false } : {}),
      ...(budget === undefined ? {} : { budgetUsd: budget }),
      ...(baseline === undefined ? {} : { baselineScore: baseline }),
      ...(streak === undefined ? {} : { maxConsecutiveRejections: streak }),
      ...(direction === undefined ? {} : { direction }),
    },
  };
}

async function resolveHub(discoveryDir: string): Promise<ResolvedHub> {
  const discovery = readHubDiscovery(resolveHubDiscoveryPath(discoveryDir));
  if (discovery === undefined) throw new Error(`no Workflow hub discovery found under ${discoveryDir}`);
  return { url: discovery.endpoint, token: discovery.token };
}

/** The verifier credential lives beside the discovery file (`verifier.json`). */
export function readVerifierDiscovery(discoveryDir: string): ResolvedHub {
  const path = join(dirname(resolveHubDiscoveryPath(discoveryDir)), "verifier.json");
  if (!existsSync(path)) {
    throw new Error(`no Workflow hub verifier discovery at ${path} (is the hub running?)`);
  }
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof value !== "object" || value === null ||
    typeof (value as Record<string, unknown>).endpoint !== "string" ||
    typeof (value as Record<string, unknown>).token !== "string"
  ) {
    throw new Error("verifier discovery file is malformed");
  }
  const record = value as { endpoint: string; token: string };
  return { url: record.endpoint, token: record.token };
}

async function call(hub: ResolvedHub, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${hub.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as unknown;
  if (response.status !== 200) {
    const detail = typeof payload === "object" && payload !== null && "error" in payload ? String((payload as { error: unknown }).error) : `status ${response.status}`;
    throw new Error(`hub ${path} failed: ${detail}`);
  }
  return payload;
}

async function main(): Promise<void> {
  const args = parseRsiArgs(process.argv.slice(2));
  if (args.command === "help") {
    console.log("usage: workflow-rsi start|status|cancel [flags]  (see src/cli/rsi.ts for flags)");
    return;
  }
  const hub = await resolveHub(args.discoveryDir);
  if (args.command === "start") {
    // P1-1: starting a loop is a consequential autonomous action and requires
    // the verifier credential, not the ordinary surface token.
    const verifier = readVerifierDiscovery(args.discoveryDir);
    console.log(JSON.stringify(await call(verifier, "/rsi/start", args.spec ?? {}), null, 2));
  } else if (args.command === "status") {
    console.log(JSON.stringify(await call(hub, "/rsi/status", args.id === undefined ? {} : { id: args.id }), null, 2));
  } else {
    console.log(JSON.stringify(await call(hub, "/rsi/cancel", {
      ...(args.id === undefined ? {} : { id: args.id }),
      ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
    }), null, 2));
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}