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
import { createOpencodeServerBudget } from "../integrations/opencode-server-budget.js";
import { createOpencodeServerGateway, newTuiPassword } from "../integrations/opencode-server-gateway.js";
import {
  opencodeServerDiscoveryPath,
  removeOpencodeServerDiscovery,
  writeOpencodeServerDiscovery,
} from "../integrations/opencode-server-discovery.js";
import { createOpencodeServerRuntime } from "../integrations/opencode-server-runtime.js";
import { loadCredentialDefinitions } from "../integrations/credential-config.js";
import { upstreamCredentialBinding } from "../integrations/egress-binding.js";
import { loadEgressPolicyFile } from "../integrations/egress-policy-file.js";
import { createDefaultToolboxGuardProvider } from "../integrations/mcp-toolbox-guard.js";
import { createSessionCompactionMonitor } from "../integrations/opencode-server-monitor.js";
import { HttpRemoteEngine } from "../integrations/remote-acp/engine.js";
import { loadSettings } from "../integrations/workflow-settings.js";
import { sessionBudgetFromEnv } from "../integrations/session-budget.js";

/**
 * W082: whether the daemon's hub-written server config composes the
 * config-side auto-compaction trigger — the operator's
 * `agents.opencode.autoCompact` setting (workspace overlay over global).
 * Fail-soft by design: the trigger is an opt-in, so an unreadable settings
 * document degrades to the honest default (off) instead of refusing the
 * topology; a launch failure over a compaction preference would invert the
 * priority.
 */
export function resolveDaemonAutoCompact(workspace: string): boolean {
  try {
    return loadSettings({ workspace }).agents.opencode?.autoCompact === true;
  } catch {
    return false;
  }
}

/**
 * W082 (the data-lane backstop monitor): the operator's deterministic
 * threshold in tokens (`agents.opencode.autoCompactAtTokens`) — the monitor
 * never invents one, so absent/malformed means disabled. Same fail-soft
 * posture as the boolean above.
 */
export function resolveDaemonAutoCompactAtTokens(workspace: string): number | undefined {
  try {
    const threshold = loadSettings({ workspace }).agents.opencode?.autoCompactAtTokens;
    return typeof threshold === "number" && Number.isInteger(threshold) && threshold > 0 ? threshold : undefined;
  } catch {
    return undefined;
  }
}

/**
 * W080 (the operator-disable precedence on the topology lane): the connector
 * names the operator explicitly disabled in settings — the skill
 * declaration never mounts them here either. Fail-soft like the other
 * daemon reads.
 */
export function resolveDaemonDisabledConnectors(workspace: string): readonly string[] {
  try {
    return loadSettings({ workspace })
      .mcpServers.filter((server) => server.enabled === false)
      .map((server) => server.name);
  } catch {
    return [];
  }
}

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
  /** W129: present only when --help/-h was requested — help resolves BEFORE
   * the guard composition or any OpenCode runtime spawn. */
  readonly help?: true;
}

const USAGE = [
  "workflow-opencode-server — the Workflow-owned OpenCode server daemon (advisory enforcement)",
  "",
  "Options:",
  "  --workspace <dir>  workspace the daemon serves (default: cwd; alias: --dir)",
  "  --help             print this help",
].join("\n");

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
    if (argument === "--help" || argument === "-h") return { workspace: process.cwd(), help: true };
    throw new TypeError(`unknown argument: ${argument}`);
  }
  return { workspace: workspace ?? process.cwd() };
}

// W094: the daemon's guard dispatcher — hub-style fail-closed composition
// (src/cli/hub.ts: "if it cannot start, the hub refuses to run — a silently
// guardless authority would issue permissive decisions no operator asked
// for"). The composed guard carries the W091 promotion rule and the W090
// workspace-facts enrichment, making the W092 ask-hold reachable on the
// stock daemon.
export async function createOpencodeServerGuard(workspace: string) {
  return createDefaultToolboxGuardProvider({ workspace });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseDaemonArgs(argv);
  // W129: the help contract — print and exit before the guard composition or
  // the runtime spawn (`--help` must never start the daemon).
  if (args.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const workspace = resolve(args.workspace);
  // W094: fail-closed composition — if the vendored guard cannot start, the
  // daemon refuses to run guard-less (the hub's "no hub, no mutations"
  // posture; a guardless authority issues permissive decisions no operator
  // asked for).
  const guard = await createOpencodeServerGuard(workspace);
  const stateHome = process.env.WORKFLOW_OPENCODE_SERVER_HOME ?? resolve(homedir(), ".workflow", "opencode-server");
  const discoveryPath = opencodeServerDiscoveryPath(stateHome, workspace);
  const mode = authorityModeFromEnv(process.env);
  const enforcement = enforcementFromEnv(process.env);

  const disabledConnectors = resolveDaemonDisabledConnectors(workspace);
  // W184: the daemon is a standalone process — it has no hub revision store, so
  // it cannot park an operator-approvable rule. It CAN still enforce the W179
  // gate-2 binding and the W180 policy tier from operator config, so the seams
  // are threaded here: gate 2 from the credential definitions, the policy tier
  // from the W183 `WORKFLOW_EGRESS_POLICY_FILE`. Both are absent-safe (an
  // unconfigured operator keeps the pre-W179/W180 posture byte-identical); the
  // denial sink stays unset because there is no store in this process to hang it
  // on (a denial is still answered, just not parked).
  const upstream = process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai";
  const credentialEndpoints = upstreamCredentialBinding(upstream, loadCredentialDefinitions());
  const egressPolicy = loadEgressPolicyFile();
  const payloadPolicy = egressPolicy === undefined || egressPolicy.rules.length === 0
    ? undefined
    : { egressPolicy };
  // W094 (review P3-3): every failure path after composition reaps the guard
  // explicitly — the hub precedent closes its guard on composition failure,
  // and "the child self-reaps on EOF" is inferred semantics, not a mandate.
  let runtime;
  try {
    runtime = await createOpencodeServerRuntime({
      workspace,
      stateHome,
      ...(credentialEndpoints.length === 0 ? {} : { credentialEndpoints }),
      ...(payloadPolicy === undefined ? {} : { payloadPolicy }),
      // W082: the daemon carries the operator's autoCompact preference into the
      // hub-written server config (same trigger the ACP lane composes). A
      // settings read failure must not block the daemon — the trigger is
      // opt-in, so an unreadable settings document degrades to the honest
      // default (off) rather than refusing the topology.
      ...(resolveDaemonAutoCompact(workspace) ? { autoCompact: true } : {}),
      // W080 (the operator-disable precedence on this lane): connector names
      // the operator explicitly disabled never mount from the declaration.
      ...(disabledConnectors.length === 0 ? {} : { skillConnectorsDisabled: disabledConnectors }),
    });
  } catch (error) {
    await guard.close();
    throw error;
  }
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
    try {
      assertAskRuleset(await engine.config({ cwd: workspace }));
    } catch (error) {
      await guard.close();
      throw error;
    }
  }
  console.log(`[authority] mode=${mode} enforcement=${enforcement} workspace=${workspace}`);
  // Session budget (M4): the W045 caps, adapted to the server path. Crossing a
  // cap aborts active turns and the broker denies every later mutation.
  const budget = sessionBudgetFromEnv();
  const sessionIds = new Set<string>();
  const budgetWatcher = budget === undefined ? undefined : createOpencodeServerBudget({
    budget,
    usage: () => runtime.usage(),
    abort: async (sessionId) => {
      await engine.abort({ sessionId, cwd: workspace });
    },
    knownSessions: () => [...sessionIds],
    onViolation: (reason) => {
      console.error(`[budget] ${reason} — active turns aborted; further mutations denied`);
    },
  });
  budgetWatcher?.start();
  console.log(`[authority] budget mechanism: ${budget === undefined ? "server-side: provider account spend/credit limits (no local caps)" : "local session-budget watcher on metering-proxy usage"}`);
  // W082 (the data-lane backstop): when the operator set a deterministic
  // threshold, the monitor reads each session's context usage from the
  // documented API and fires the compact route on crossing — vetoed by a
  // sticky budget violation, hysteresis-armed, never inventing a threshold.
  const monitorThreshold = resolveDaemonAutoCompactAtTokens(workspace);
  const compactionMonitor = monitorThreshold === undefined ? undefined : createSessionCompactionMonitor({
    baseUrl: runtime.url,
    username: runtime.username,
    password: runtime.password,
    thresholdTokens: monitorThreshold,
    ...(budgetWatcher === undefined ? {} : { veto: () => budgetWatcher.violation() }),
  });
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
    guard,
    mode,
    enforcement,
    onDecision: (decision) => {
      sessionIds.add(decision.sessionId);
      // Bounded log (review P3h): reasons can carry path/command fragments.
      const reason = (decision.reason ?? "policy allow").slice(0, 160);
      console.log(`[authority] ${decision.decision} ${decision.tool} session=${decision.sessionId} delivered=${decision.delivered ?? true} reason=${reason}`);
    },
    budgetViolation: budgetWatcher === undefined ? undefined : () => budgetWatcher.violation(),
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
    await guard.close();
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
  if (compactionMonitor !== undefined) {
    compactionMonitor.start();
    console.log(`[compaction-monitor] armed at ${monitorThreshold} tokens (sticky budget violation vetoes firing)`);
  }

  // Process guards (review P2-3): a stray rejection must never crash the
  // daemon and orphan the contained server without cleanup.
  process.on("unhandledRejection", (reason) => {
    console.error(`[daemon] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on("uncaughtException", (error) => {
    console.error(`[daemon] uncaught exception: ${error.message}`);
    void (async () => {
      budgetWatcher?.stop();
      compactionMonitor?.stop();
      await authority.stop();
      if (gateway !== undefined) await gateway.close();
      await runtime.dispose();
      await guard.close();
      removeOpencodeServerDiscovery(discoveryPath);
      process.exit(1);
    })();
  });

  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  await shutdown;
  budgetWatcher?.stop();
  compactionMonitor?.stop();
  await authority.stop();
  await gateway.close();
  await runtime.dispose();
  await guard.close();
  removeOpencodeServerDiscovery(discoveryPath);
  console.log("[metering]", JSON.stringify(runtime.usage()));
}

const invokedDirectly = process.argv[1] !== undefined && /opencode-server\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}