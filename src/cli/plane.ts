#!/usr/bin/env node
import { spawn } from "node:child_process";

import { cliSibling } from "./launcher-args.js";
import { isEntrypoint } from "./entrypoint.js";
import { MIN_CLIENT_PASSWORD_LENGTH, resolvePlaneConfig, type PlaneConfig } from "./plane-config.js";

/**
 * C1 plane supervisor (`workflow-plane`).
 *
 * The single container entrypoint for the Azure control plane. It supervises
 * the two long-lived processes the plane needs and forwards their lifecycle:
 *
 *   - `workflow-hub`            the authority (loopback HTTP bridge, scheduler,
 *                               run registry, guard) — kernel tasks/evidence
 *   - `workflow-opencode-server` the OpenCode server daemon: a contained
 *                               `opencode serve` + the authority broker + the
 *                               gateway, with the gateway bound to the fixed
 *                               ingress front door (`0.0.0.0:4096`) and a
 *                               stable injected client credential
 *
 * Why a process supervisor and not one in-process composition: the hub
 * (`src/cli/hub.ts`) and the daemon (`src/cli/opencode-server.ts`) are each
 * large, individually-tested compositions that already tear down idempotently
 * on SIGTERM. `workflow` (the desktop launcher) already supervises surfaces
 * this way (`src/cli/workflow.ts`). Reusing that pattern keeps the C1 change
 * additive and each daemon's existing tests meaningful, rather than folding a
 * 650-line hub composition into a new process where its tests no longer
 * exercise the real entry.
 *
 * The gateway stays the ONLY ingress listener (spec §10: the container is the
 * boundary, one ingress port per app); the hub keeps its loopback bind.
 */

export interface PlaneChildSpec {
  readonly name: "hub" | "opencode-server";
  readonly script: string;
  readonly execArgv: readonly string[];
  readonly args: readonly string[];
}

/**
 * The supervised child list. Pure and injectable so the wiring is testable
 * without spawning: `resolve` maps a surface name to its sibling script (the
 * real `cliSibling` in production).
 */
export function planeChildSpecs(
  config: PlaneConfig,
  resolve: (name: string) => { script: string; execArgv: readonly string[] },
): readonly PlaneChildSpec[] {
  return [
    { name: "hub", ...resolve("hub"), args: [] },
    { name: "opencode-server", ...resolve("opencode-server"), args: ["--workspace", config.workspace] },
  ];
}

/**
 * The environment the daemon child needs for plane mode: the opt-in flag, the
 * binding, and the stable client credential. The password rides the child env
 * (never argv), matching the daemon's existing secret handling.
 */
export function planeEnv(config: PlaneConfig): Record<string, string> {
  return {
    WORKFLOW_PLANE: "1",
    WORKFLOW_PLANE_WORKSPACE: config.workspace,
    WORKFLOW_PLANE_GATEWAY_HOST: config.gatewayHost,
    WORKFLOW_PLANE_GATEWAY_PORT: String(config.gatewayPort),
    WORKFLOW_PLANE_CLIENT_PASSWORD: config.clientPassword,
  };
}

/**
 * The plane env keys. The hub must never inherit them, so the split scrubs
 * them by name rather than trusting the base env to be clean.
 */
export const PLANE_ENV_KEYS = [
  "WORKFLOW_PLANE",
  "WORKFLOW_PLANE_WORKSPACE",
  "WORKFLOW_PLANE_GATEWAY_HOST",
  "WORKFLOW_PLANE_GATEWAY_PORT",
  "WORKFLOW_PLANE_CLIENT_PASSWORD",
] as const;

/**
 * Per-child environment. ONLY the OpenCode server daemon receives the plane
 * env (the client credential, the bind). The hub gets the base env with every
 * `WORKFLOW_PLANE*` key SCRUBBED: in plane mode the supervisor's own
 * `process.env` carries the credential (it is how `resolvePlaneConfig` read
 * it), so returning `baseEnv` unchanged would leak the credential into the hub
 * process and its children. Pure and exported so the split is pinned against a
 * base env that actually holds the secret, not a clean fixture.
 */
export function planeChildEnv(
  spec: PlaneChildSpec,
  config: PlaneConfig,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (spec.name === "opencode-server") return { ...baseEnv, ...planeEnv(config) };
  const scrubbed: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of PLANE_ENV_KEYS) delete scrubbed[key];
  return scrubbed;
}

/** The minimal child surface the supervisor uses (satisfied by ChildProcess). */
export interface PlaneChild {
  kill(signal: NodeJS.Signals): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface PlaneSupervisorDeps {
  /** Spawns one child for a spec; injected so the lifecycle is testable. */
  readonly spawnChild: (spec: PlaneChildSpec, env: NodeJS.ProcessEnv) => PlaneChild;
  readonly baseEnv: NodeJS.ProcessEnv;
  /** Diagnostics sink; injected so a test can capture supervisor messages. */
  readonly report: {
    readonly error: (message: string) => void;
  };
}

export interface PlaneSupervisorHandle {
  /** The children the supervisor started, in spec order. */
  readonly children: readonly PlaneChild[];
  /** Resolves once every child has exited; carries the plane's exit code. */
  readonly done: Promise<number>;
  /** Tear every child down with `signal` (idempotent). */
  shutdown(signal: NodeJS.Signals): void;
}

/**
 * Starts every child, tears the sibling set down when any one exits or fails to
 * start, and resolves `done` with the plane's exit code once all children have
 * exited. Injected deps keep this exercisable without a real subprocess.
 */
export function supervisePlane(
  config: PlaneConfig,
  specs: readonly PlaneChildSpec[],
  deps: PlaneSupervisorDeps,
): PlaneSupervisorHandle {
  const children: PlaneChild[] = [];
  let shuttingDown = false;
  let exitCode = 0;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  };

  const done = new Promise<number>((resolve) => {
    const remaining = new Set<PlaneChild>();
    const settle = (child: PlaneChild): void => {
      remaining.delete(child);
      if (remaining.size === 0) resolve(exitCode);
    };
    for (const spec of specs) {
      const env = planeChildEnv(spec, config, deps.baseEnv);
      const child = deps.spawnChild(spec, env);
      children.push(child);
      remaining.add(child);
      child.on("error", (error: Error) => {
        deps.report.error(`[plane] ${spec.name} failed to start: ${error.message}`);
        exitCode = 1;
        shutdown("SIGTERM");
        settle(child);
      });
      child.on("exit", (code, signal) => {
        if (!shuttingDown) {
          // A supervised child exiting is a plane failure: never keep
          // advertising a half-plane (a hub without a listener on 4096, or a
          // gateway without an authority). Tear the sibling down and exit with
          // the child's code (1 for a signal death, which carries no code).
          deps.report.error(`[plane] ${spec.name} exited (code=${code ?? "null"} signal=${signal ?? "none"}) — shutting the plane down`);
          exitCode = code ?? 1;
          shutdown("SIGTERM");
        }
        settle(child);
      });
    }
    if (remaining.size === 0) resolve(exitCode);
  });

  return { children, done, shutdown };
}

export function planeUsage(): string {
  return [
    "workflow-plane — the C1 control-plane supervisor (hub + OpenCode server gateway)",
    "",
    "Plane mode is explicit: set WORKFLOW_PLANE=1 and",
    `  WORKFLOW_PLANE_CLIENT_PASSWORD  stable client credential (>= ${MIN_CLIENT_PASSWORD_LENGTH} chars)`,
    "  WORKFLOW_PLANE_WORKSPACE        absolute workspace path (default: cwd)",
    "  WORKFLOW_PLANE_GATEWAY_HOST     default 0.0.0.0",
    "  WORKFLOW_PLANE_GATEWAY_PORT     default 4096",
    "",
    "Options:",
    "  --help    print this help",
  ].join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${planeUsage()}\n`);
    return;
  }
  if (argv.length > 0) throw new TypeError(`unknown argument: ${argv[0]}`);
  const config = resolvePlaneConfig(process.env, process.cwd());
  const specs = planeChildSpecs(config, (name) => cliSibling(import.meta.url, name as "hub" | "opencode-server"));

  const handle = supervisePlane(config, specs, {
    baseEnv: process.env,
    spawnChild: (spec, env) =>
      spawn(process.execPath, [...spec.execArgv, spec.script, ...spec.args], {
        stdio: "inherit",
        cwd: config.workspace,
        env,
      }),
    report: {
      error: (message) => console.error(message),
    },
  });

  const forward = (signal: NodeJS.Signals) => (): void => handle.shutdown(signal);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGHUP", forward("SIGHUP"));

  console.log(`[plane] supervising ${specs.map((spec) => spec.name).join(" + ")}; gateway on ${config.gatewayHost}:${config.gatewayPort}`);

  // Stay alive until every child exits; the resolved code is the plane's verdict.
  process.exitCode = await handle.done;
}

const invokedDirectly = isEntrypoint(import.meta.url, process.argv[1]);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
