#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve } from "node:path";

import { hostCapabilities, type ToolCapability } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { TaskGraph } from "../kernel/task-graph.js";
import {
  assertAskRuleset,
  createOpencodeServerAuthority,
  type OpencodeAuthorityEnforcement,
  type OpencodeAuthorityMode,
} from "../integrations/opencode-server-authority.js";
import { createOpencodeServerGateway, newTuiPassword } from "../integrations/opencode-server-gateway.js";
import {
  opencodeServerDiscoveryPath,
  removeOpencodeServerDiscovery,
  writeOpencodeServerDiscovery,
} from "../integrations/opencode-server-discovery.js";
import { createOpencodeServerRuntime } from "../integrations/opencode-server-runtime.js";
import { HttpRemoteEngine } from "../integrations/remote-acp/engine.js";

export function authorityModeFromEnv(env: NodeJS.ProcessEnv): OpencodeAuthorityMode {
  const raw = env.WORKFLOW_OPENCODE_AUTHORITY_MODE?.trim();
  if (raw === undefined || raw === "" || raw === "auto-resolve") return "auto-resolve";
  if (raw === "ask-me") return "ask-me";
  throw new Error(`WORKFLOW_OPENCODE_AUTHORITY_MODE must be "auto-resolve" or "ask-me" (got ${JSON.stringify(raw)})`);
}

export function enforcementFromEnv(env: NodeJS.ProcessEnv): OpencodeAuthorityEnforcement {
  const raw = env.WORKFLOW_OPENCODE_ENFORCEMENT?.trim();
  if (raw === undefined || raw === "" || raw === "advisory") return "advisory";
  if (raw === "enforced") return "enforced";
  throw new Error(`WORKFLOW_OPENCODE_ENFORCEMENT must be "advisory" or "enforced" (got ${JSON.stringify(raw)})`);
}

/**
 * W071 — the Workflow OpenCode server daemon.
 *
 * Owns a contained `opencode serve`, the authority gateway, and the authority
 * broker in the background, and publishes only the gateway URL + client
 * password through the discovery file. The upstream server password never
 * leaves this process.
 *
 * M2 posture: advisory. The broker auto-resolves permission requests from
 * `WorkflowApplication` policy and the gateway intercepts client replies, but
 * the surface must not be labeled `enforced` until the live PERMISSION probe
 * is green.
 *
 * Usage: `workflow-opencode-server [--workspace DIR]`
 * Environment: WORKFLOW_OPENCODE_SERVER_HOME (state root override).
 */

export interface OpencodeServerDaemonArgs {
  readonly workspace: string;
}

export function parseDaemonArgs(argv: readonly string[]): OpencodeServerDaemonArgs {
  let workspace: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workspace" || argument === "--dir") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new TypeError(`${argument} requires a value`);
      workspace = value;
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") return { workspace: process.cwd() };
    throw new TypeError(`unknown argument: ${argument}`);
  }
  return { workspace: workspace ?? process.cwd() };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseDaemonArgs(argv);
  const workspace = resolve(args.workspace);
  const stateHome = process.env.WORKFLOW_OPENCODE_SERVER_HOME ?? resolve(homedir(), ".workflow", "opencode-server");
  const discoveryPath = opencodeServerDiscoveryPath(stateHome, workspace);
  const mode = authorityModeFromEnv(process.env);
  const enforcement = enforcementFromEnv(process.env);

  const runtime = await createOpencodeServerRuntime({ workspace, stateHome });
  // Authority broker: the background policy decision point. It subscribes to
  // the server's SSE and answers every permission request through
  // WorkflowApplication; the gateway intercepts client replies so the stock TUI
  // can never answer upstream.
  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set<ToolCapability>(["read", "mutation", "process"]),
    workspace,
  );
  const engine = new HttpRemoteEngine({
    baseUrl: runtime.url,
    cwd: workspace,
    username: runtime.username,
    password: runtime.password,
  });
  // Enforcement contract (M3): an enforced surface verifies the pinned `ask`
  // ruleset at startup and refuses to serve a permissive engine.
  if (enforcement === "enforced") {
    assertAskRuleset(await engine.config({ cwd: workspace }));
  }
  console.log(`[authority] mode=${mode} enforcement=${enforcement} workspace=${workspace}`);
  const shutdownRequested = { requested: false };
  let requestShutdown: () => void = () => undefined;
  const shutdown = new Promise<void>((resolveShutdown) => {
    requestShutdown = () => {
      if (shutdownRequested.requested) return;
      shutdownRequested.requested = true;
      resolveShutdown();
    };
  });
  const authority = createOpencodeServerAuthority({
    engine,
    application,
    workspace,
    mode,
    enforcement,
    onDecision: (decision) => {
      // Bounded log (review P3h): reasons can carry path/command fragments.
      const reason = (decision.reason ?? "policy allow").slice(0, 160);
      console.log(`[authority] ${decision.decision} ${decision.tool} session=${decision.sessionId} delivered=${decision.delivered ?? true} reason=${reason}`);
    },
    // Authority loss must tear the surface down, never keep advertising a
    // daemon whose policy point is dead (review P2-1).
    onAuthorityLost: () => {
      console.error("[authority] event stream lost — shutting down the OpenCode server surface");
      requestShutdown();
    },
    // A bypass in enforced posture is a broken invariant: shut the surface
    // down rather than keep serving a ruleset that is not asking.
    onBypass: (input) => {
      console.error(`[authority] BYPASS ${input.tool} session=${input.sessionId}: ${input.reason}`);
      requestShutdown();
    },
  });
  void authority.start();

  let gateway;
  try {
    gateway = await createOpencodeServerGateway({
      upstream: runtime.url,
      upstreamUsername: runtime.username,
      upstreamPassword: runtime.password,
      tuiPassword: newTuiPassword(),
      onPermissionReply: (reply) => authority.handleOperatorReply(reply),
      enforced: enforcement === "enforced",
    });
  } catch (error) {
    await authority.stop();
    await runtime.dispose();
    throw error;
  }

  writeOpencodeServerDiscovery(discoveryPath, {
    protocol: 1,
    pid: process.pid,
    workspace,
    gatewayUrl: gateway.url,
    tuiUsername: runtime.username,
    tuiPassword: gateway.password,
    ...(runtime.version === undefined ? {} : { version: runtime.version }),
  });
  console.log(`Workflow OpenCode server gateway at ${gateway.url} for ${workspace}`);
  console.log(`Discovery file: ${discoveryPath}`);

  // Process guards (review P2-3): a stray rejection must never crash the
  // daemon and orphan the contained server without cleanup.
  process.on("unhandledRejection", (reason) => {
    console.error(`[daemon] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on("uncaughtException", (error) => {
    console.error(`[daemon] uncaught exception: ${error.message}`);
    void (async () => {
      await authority.stop();
      if (gateway !== undefined) await gateway.close();
      await runtime.dispose();
      removeOpencodeServerDiscovery(discoveryPath);
      process.exit(1);
    })();
  });

  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  await shutdown;
  await authority.stop();
  await gateway.close();
  await runtime.dispose();
  removeOpencodeServerDiscovery(discoveryPath);
}

const invokedDirectly = process.argv[1] !== undefined && /opencode-server\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}