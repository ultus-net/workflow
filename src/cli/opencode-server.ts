#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve } from "node:path";

import { hostCapabilities, type ToolCapability } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { createOpencodeServerAuthority } from "../integrations/opencode-server-authority.js";
import { createOpencodeServerGateway, newTuiPassword } from "../integrations/opencode-server-gateway.js";
import {
  opencodeServerDiscoveryPath,
  removeOpencodeServerDiscovery,
  writeOpencodeServerDiscovery,
} from "../integrations/opencode-server-discovery.js";
import { createOpencodeServerRuntime } from "../integrations/opencode-server-runtime.js";
import { HttpRemoteEngine } from "../integrations/remote-acp/engine.js";

/**
 * W071 — the Workflow OpenCode server daemon.
 *
 * Owns a contained `opencode serve` and the authority gateway in the
 * background, and publishes only the gateway URL + client password through the
 * discovery file. The upstream server password never leaves this process.
 *
 * M1 posture: advisory. No broker hook is wired yet, so client permission
 * replies pass through the gateway; the surface must not be labeled enforced
 * until the M2 broker lands and the PERMISSION probe is green.
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

  const runtime = await createOpencodeServerRuntime({ workspace, stateHome });
  // Authority broker (M2): the background policy decision point. It subscribes
  // to the server's SSE and answers every permission request through
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
  const authority = createOpencodeServerAuthority({
    engine,
    application,
    workspace,
    onDecision: (decision) => {
      console.log(`[authority] ${decision.decision} ${decision.tool} session=${decision.sessionId} reason=${decision.reason ?? "policy allow"}`);
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

  await new Promise<void>((resolveShutdown) => {
    process.once("SIGINT", resolveShutdown);
    process.once("SIGTERM", resolveShutdown);
  });
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