import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { probeHub, readHubDiscovery } from "./hub-client.js";
import { resolveHubDiscoveryPath } from "../integrations/workflow-hub.js";
import {
  opencodeServerDiscoveryPath,
  probeOpencodeServerGateway,
  readOpencodeServerDiscovery,
} from "../integrations/opencode-server-discovery.js";
import { listWebAgents } from "../ui/web-agents.js";
import { normalizeSettings, settingsPaths } from "../integrations/workflow-settings.js";
import { loadProbeVerdicts, type ProbeVerdictRegister, type ProbeVerdictResult } from "../integrations/probe-verdicts.js";

/**
 * W076 — `workflow doctor`: one command that states the truth about the
 * operator's setup — fail-loud, actionable, credential values never printed.
 * Every check is pass/warn/fail; nothing silently passes (the honest-claims
 * culture applied to diagnostics). Idea adopted from oh-my-openagent's
 * `doctor` (pattern only; SUL-1.0 upstream — no code).
 *
 * W078 follow-up: the gated live-probe check is driven by the
 * machine-readable probe verdict register (`docs/PROBE_VERDICTS.json`) —
 * host/version, probe + gate, date, result, enforcement posture, and
 * evidence per row — so documentation and runtime claims share one record
 * instead of drifting between a hardcoded gate list and prose verdicts.
 */

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  /** The actionable fix line when the check is not a pass. */
  readonly fix?: string;
}

export interface DoctorOptions {
  readonly home?: string | undefined;
  readonly workspace?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

const PASS = "✓";
const WARN = "!";
const FAIL = "✗";

/** Settings documents: both scopes parse, or the error is the value. */
export function checkSettingsDocs(options: DoctorOptions = {}): DoctorCheck {
  const name = "settings documents";
  try {
    const paths = settingsPaths({
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    });
    if (!existsSync(paths.global)) {
      return { name, status: "pass", detail: `no global settings yet (created on first write) — ${paths.global}` };
    }
    const global = normalizeSettings(JSON.parse(readFileSync(paths.global, "utf8")));
    let overlayNote = "";
    if (paths.workspace !== undefined && existsSync(paths.workspace)) {
      const overlay = normalizeSettings(JSON.parse(readFileSync(paths.workspace, "utf8")));
      overlayNote = `; workspace overlay parses (${overlay.mcpServers.length} servers, ${Object.keys(overlay.agents).length} agent prefs)`;
    }
    return {
      name,
      status: "pass",
      detail: `global parses (${global.mcpServers.length} mcp servers, ${Object.keys(global.agents).length} agent prefs) at ${paths.global}${overlayNote}`,
    };
  } catch (error) {
    return {
      name,
      status: "fail",
      detail: `settings documents do not parse: ${error instanceof Error ? error.message : String(error)}`,
      fix: "fix the JSON in ~/.config/workflow/settings.json (or the workspace overlay) — the control plane fails closed on unparseable settings",
    };
  }
}

/** Per-agent credential presence: the switcher's own truth (booleans + the
 * same reasons the UI renders), never secret values. */
export function checkAgentCredentials(): readonly DoctorCheck[] {
  return listWebAgents().map((agent) => {
    const name = `agent credentials: ${agent.name}`;
    if (agent.available) {
      return { name, status: "pass" as const, detail: `${agent.name} is available (${agent.containment} launch)` };
    }
    return {
      name,
      status: "fail" as const,
      detail: `${agent.name} unavailable — ${agent.reason ?? "prerequisites not met"}`,
      ...(agent.reason === undefined ? {} : { fix: agent.reason }),
    };
  });
}

/** Hub daemon reachability: the registry and scheduler live there. */
export async function checkHub(): Promise<DoctorCheck> {
  const name = "hub daemon";
  const discovery = readHubDiscovery(resolveHubDiscoveryPath(join(homedir(), ".workflow")));
  if (discovery === undefined) {
    return {
      name,
      status: "warn",
      detail: "no hub discovery file — scheduled runs and run gates need the hub daemon (`workflow hub`)",
      fix: "start the hub daemon: workflow hub",
    };
  }
  const reachable = await probeHub(discovery);
  if (!reachable) {
    return {
      name,
      status: "fail",
      detail: `stale hub discovery at ${discovery.endpoint} — nothing answered /health`,
      fix: "delete the stale discovery file (~/.workflow/hub/discovery.json) and start the hub daemon: workflow hub",
    };
  }
  return { name, status: "pass", detail: `reachable at ${discovery.endpoint}` };
}

/** The Workflow-owned opencode server topology: gateway up for this workspace? */
export async function checkTopologyGateway(options: DoctorOptions = {}): Promise<DoctorCheck> {
  const name = "server topology gateway";
  const workspace = options.workspace ?? process.cwd();
  const stateHome = process.env.WORKFLOW_OPENCODE_SERVER_HOME ?? join(homedir(), ".workflow", "opencode-server");
  const discovery = readOpencodeServerDiscovery(opencodeServerDiscoveryPath(stateHome, workspace));
  if (discovery === undefined) {
    return {
      name,
      status: "warn",
      detail: `no topology daemon for this workspace (${workspace}) — the stock web UI tab and live MCP/stats reads have nothing to answer`,
      fix: "start it when you want the topology: workflow tui (or the hub, which owns the daemon)",
    };
  }
  const healthy = await probeOpencodeServerGateway(discovery, options.fetchImpl);
  if (!healthy) {
    return {
      name,
      status: "fail",
      detail: `stale topology discovery at ${discovery.gatewayUrl} — nothing answered`,
      fix: "the daemon exited; restart it (workflow tui) or delete the stale discovery file under ~/.workflow/opencode-server",
    };
  }
  return { name, status: "pass", detail: `gateway live at ${discovery.gatewayUrl} (workspace ${discovery.workspace})` };
}

/**
 * The containment backend report (the last missing W078 check): what
 * isolation the agent launches will actually get on this machine, stated
 * with the same enforced/policy-only distinction the containment layer
 * guarantees at the type level. Linux is enforced-capable only when the
 * bwrap binary exists at the compiled-in path — a missing binary is a warn
 * (contained launches fail closed at spawn, which is safe but useless)
 * rather than a silent pass; non-Linux is the honest policy-only passthrough
 * the platform layer documents, with its limitation stated.
 */
export function checkContainment(options: { platform?: NodeJS.Platform; bwrapPath?: string } = {}): DoctorCheck {
  const name = "containment backend";
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    return {
      name,
      status: "warn",
      detail: `no process isolation on ${platform} — launches run with policy gating only (the typed policy-only marker, never claimed as enforced)`,
      fix: "full isolation is Linux-only today (bubblewrap); on this platform every contained launch is visibly marked policy-only",
    };
  }
  const bwrapPath = options.bwrapPath ?? "/usr/bin/bwrap";
  if (!existsSync(bwrapPath)) {
    return {
      name,
      status: "warn",
      detail: `linux is enforced-capable, but bwrap was not found at ${bwrapPath} — contained agent launches will fail closed at spawn`,
      fix: "install bubblewrap (the bwrap binary) so agent processes get the enforced filesystem boundary",
    };
  }
  return { name, status: "pass", detail: `bubblewrap present at ${bwrapPath} — contained launches run the enforced filesystem boundary` };
}

/**
 * W078 follow-up: the machine-readable probe verdict register
 * (`docs/PROBE_VERDICTS.json`) is the doctor's gate catalog — no second
 * hardcoded gate list to drift. The register row is the durable record
 * (host/version, probe + gate, date, result, enforcement posture, evidence);
 * the doctor renders its state honestly: green/red/negative are recorded
 * verdicts, pending/blocked are honest open states (blocked ones name the
 * missing operator environment/credential), and an armed gate whose verdict
 * is still undecided is surfaced rather than hidden. Parse/validation
 * failures fail loud — a corrupt register is drift, never an empty list.
 */
export function checkProbeVerdicts(options: { root?: string } = {}): DoctorCheck {
  const name = "probe verdict register";
  let register: ProbeVerdictRegister;
  try {
    register = loadProbeVerdicts(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name,
      status: "fail",
      detail: `the probe verdict register failed validation (fail-closed): ${message}`,
      fix: "repair docs/PROBE_VERDICTS.json — version 1, one dated row per gate (host/version, probe file, gate, result, posture, evidence); probe files must exist",
    };
  }
  const tally = { green: 0, red: 0, negative: 0, pending: 0, blocked: 0 } as Record<ProbeVerdictResult, number>;
  for (const verdict of register.verdicts) tally[verdict.result] += 1;
  const armed = register.verdicts.filter((verdict) => process.env[verdict.gate] === "1");
  const undecided = register.verdicts.filter((verdict) => verdict.result === "pending" || verdict.result === "blocked");
  const blocked = undecided.filter((verdict) => verdict.result === "blocked");
  return {
    name,
    status: undecided.length > 0 ? "warn" : "pass",
    detail: `${register.verdicts.length} verdicts — ${tally.green} green, ${tally.red} red, ${tally.negative} negative, ${tally.pending} pending, ${tally.blocked} blocked; ${
      armed.length > 0 ? `${armed.length} gate(s) armed now: ${[...new Set(armed.map((verdict) => verdict.gate))].join(", ")}` : "no gates armed"
    } — register: docs/PROBE_VERDICTS.json; dated write-ups: docs/HOST_ADAPTERS.md`,
    ...(undecided.length === 0 ? {} : {
      // Blocked rows cannot be "run" — their fix is the named operator
      // environment/credential in the register row, so the fix line says so
      // instead of telling an operator to run an impossible probe.
      fix: `pending rows: run a gated probe with WORKFLOW_<GATE>=1 node --import tsx --test test/<probe>.test.ts; blocked rows: the missing operator environment/credential is named in the register row's blocker — record every dated verdict in docs/PROBE_VERDICTS.json and docs/HOST_ADAPTERS.md (${undecided.length} still open: ${undecided.slice(0, 4).map((verdict) => verdict.id).join(", ")}${undecided.length > 4 ? ", …" : ""}${blocked.length > 0 ? `; ${blocked.length} blocked on the operator environment` : ""})`,
    }),
  };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<readonly DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(checkSettingsDocs(options));
  checks.push(...checkAgentCredentials());
  checks.push(await checkHub());
  checks.push(await checkTopologyGateway(options));
  checks.push(checkContainment());
  checks.push(checkProbeVerdicts());
  return checks;
}

export function renderDoctorReport(checks: readonly DoctorCheck[]): string {
  return [
    "Workflow doctor — the local setup, stated honestly:",
    "",
    ...checks.map((check) =>
      [
        `  ${check.status === "pass" ? PASS : check.status === "warn" ? WARN : FAIL} ${check.name}: ${check.detail}`,
        ...(check.fix === undefined ? [] : [`      fix: ${check.fix}`]),
      ].join("\n"),
    ),
    "",
  ].join("\n");
}