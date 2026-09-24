#!/usr/bin/env node
import { spawn } from "node:child_process";

import { cliSibling, LAUNCHER_OPTIONS, parseAgentFlag, parseLauncherArgs, resolveAgentKind, resolveSelection } from "./launcher-args.js";
import { openBrowser } from "./open-browser.js";
import { resolveTuiWorkspace } from "./tui-args.js";
import { runWebLaunch } from "./web-launch.js";

/**
 * The `workflow` launcher: one hub, one authority, one journal — and a tiny
 * selector for which official frontend pushes traffic to it today.
 *
 *   workflow                     interactive selector (web / tui / settings / hub)
 *   workflow web [args…]         browser operator UI (+ settings tab)
 *   workflow tui [args]          official opencode TUI attached via the hub gateway
 *   workflow settings [--port n] settings panel only
 *   workflow hub                 hub daemon in the foreground
 *   workflow doctor              state the local setup honestly (W076)
 *   workflow install fleet       deploy the vendored fleet payload (W086)
 *   --agent <kind>               engine axis: opencode | goose | cline
 *                                (overrides WORKFLOW_ACP_AGENT; containment
 *                                stays per-kind, untouched by the flag)
 *
 * Every surface composes the same WorkflowApplication authority in-process;
 * the selector only picks the display. The opencode web UI becomes the web
 * surface's primary tab once the stock-UI-behind-gateway probe passes
 * (docs/ideas/hub-control-plane.md); until then the PWA is primary and
 * `WORKFLOW_OPENCODE_WEB_URL` opts into an experimental extra tab. Pure
 * surface resolution lives in `./launcher-args.js`.
 */

function spawnSurface(name: "opencode-attach" | "hub", args: readonly string[], cwd: string): void {
  const { script, execArgv } = cliSibling(import.meta.url, name);
  const child = spawn(process.execPath, [...execArgv, script, ...args], { stdio: "inherit", cwd });
  child.on("exit", (code) => process.exit(code ?? 0));
  // A failed spawn emits `error`, never `exit` — exit eagerly instead of
  // leaving a childless parent hanging on its live event loop.
  child.on("error", () => process.exit(1));
  // The child owns the terminal; the parent stays alive only for the child's
  // lifetime and forwards lifecycle signals. Repeat delivery is expected
  // (group signal + forward), so this is only safe because every spawned
  // child tears down idempotently: the hub guards its shutdown (hub.ts) and
  // the attach launcher kills its detached client group (opencode-attach.ts).
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGHUP", () => child.kill("SIGHUP"));
}

// W129: the help contract — a leading --help/-h prints the surface list and
// exits before any surface work; a verb's own --help resolves at that
// surface's own seam: web inside runWebLaunch (shared by the in-process call
// and the script entry), settings/doctor/install in their branches below
// (helpExit), and the spawned verbs (tui, hub) in their bins' guards.
const leadingArgument = process.argv.slice(2)[0];
if (leadingArgument === "--help" || leadingArgument === "-h") {
  console.log("workflow — one hub, one authority, one journal; pick a surface:");
  for (const option of LAUNCHER_OPTIONS) console.log(`  ${option.label}`);
  console.log("  doctor             state the local setup honestly");
  console.log("  install fleet      deploy the vendored fleet payload");
  console.log("  --agent <kind>     engine axis: opencode | goose | cline");
  process.exit(0);
}

const initial = parseLauncherArgs(process.argv.slice(2));
const agentChoice = parseAgentFlag(initial.rest);
if (agentChoice.error !== undefined) {
  console.error(agentChoice.error);
  process.exit(1);
}
// The engine axis composes through one mechanism: an explicit `--agent`
// writes the same env var the runtime reads (`acpAgentKind`), so every
// surface — web, tui, settings, hub — honors the operator's choice, and the
// ambient `WORKFLOW_ACP_AGENT` stays authoritative when no flag is given.
// Containment is decided downstream per kind (`LinuxBubblewrapContainment`);
// the flag selects the engine, never the isolation boundary.
if (agentChoice.agent !== undefined) {
  // Precedence flows through the same helper the tests pin: an explicit flag
  // wins over the ambient env, and the effective kind is what gets exported.
  process.env.WORKFLOW_ACP_AGENT = resolveAgentKind(agentChoice.agent, process.env.WORKFLOW_ACP_AGENT) ?? agentChoice.agent;
}
// A flag before the verb (`workflow --agent goose web`) still resolves: the
// post-strip remainder is re-parsed when argv[0] was the flag itself.
const { verb, rest } = initial.verb === undefined
  ? parseLauncherArgs(agentChoice.rest)
  : { verb: initial.verb, rest: agentChoice.rest };
const workspace = resolveTuiWorkspace(rest, process.cwd());

/** W129: the in-process verbs resolve --help/-h before their work (web's
 * guard lives inside runWebLaunch, which the in-process call shares). */
function helpExit(argv: readonly string[], usage: string): void {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage);
    process.exit(0);
  }
}

let selected = verb;
if (selected === undefined) {
  if (process.stdin.isTTY !== true) {
    console.error("no surface given; pass web | tui | settings | hub (interactive selector needs a TTY)");
    process.exit(1);
  }
  console.log("Workflow — pick a surface (one hub behind every option):");
  LAUNCHER_OPTIONS.forEach((option, index) => console.log(`  ${index + 1}) ${option.label}`));
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question("surface: ");
  rl.close();
  const resolved = resolveSelection(answer);
  if (resolved === undefined) {
    console.error(`unrecognized surface '${answer.trim()}'`);
    process.exit(1);
  }
  selected = resolved;
}

if (selected === "web") {
  await runWebLaunch(rest);
  // Secondary tab: the settings panel deep link. The opencode web UI becomes
  // the primary tab behind the same gateway once its probe passes; until then
  // it stays an explicit opt-in (honest-claims: no enforced claim is made).
  const opencodeWeb = process.env.WORKFLOW_OPENCODE_WEB_URL;
  if (opencodeWeb !== undefined && opencodeWeb !== "") void openBrowser(opencodeWeb);
} else if (selected === "doctor") {
  helpExit(rest, "workflow doctor — state the local setup honestly (no options; the probe verdict register lives at docs/PROBE_VERDICTS.json)");
  const { runDoctor, renderDoctorReport } = await import("./doctor.js");
  const checks = await runDoctor({ workspace });
  console.log(renderDoctorReport(checks));
  // Exit 1 only on hard failures; warns (a hub not running, no topology) are
  // expected states, not failures.
  process.exitCode = checks.some((check) => check.status === "fail") ? 1 : 0;
} else if (selected === "install") {
  helpExit(rest, "workflow install fleet — deploy the vendored fleet payload through the ask-gate (flags: see src/cli/install.ts)");
  // W086: the operator-invoked fleet deployment (the ask-gate). Never runs
  // unattended; never touches the host config document.
  const { runInstall } = await import("./install.js");
  process.exitCode = await runInstall(rest);
} else if (selected === "settings") {
  helpExit(rest, "workflow settings — the settings panel only (no flags; the port follows env PORT or 4173)");
  const { startWorkflowWeb } = await import("./web-service.js");
  const service = await startWorkflowWeb({ workspace });
  // W134: the verb used to advertise and open `${service.url}/settings` — a
  // 404 (the server has no /settings route; the settings surface is the
  // operator shell's dialog behind GET /). The CLI now points at the shell
  // root; the deeper option (serving the shell at /settings in
  // src/ui/web.ts) is deferred because that file carries the operator's
  // uncommitted W115 work (recorded in the ledger).
  console.log(`Workflow settings panel: ${service.url} (the Settings dialog lives on the operator shell)`);
  if (await openBrowser(service.url)) {
    console.log("Opening in your default browser…");
  } else {
    console.log("No browser opener available; open the URL above manually.");
  }
  const shutdown = (): void => {
    void service.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} else if (selected === "tui") {
  // The official opencode TUI, unmodified, attached through the hub gateway
  // (W071: the TUI holds only the gateway password; the hub credential stays
  // hub-only). `workflow-opencode` resolves/starts the daemon and attaches.
  spawnSurface("opencode-attach", rest, workspace);
} else {
  spawnSurface("hub", rest, workspace);
}
