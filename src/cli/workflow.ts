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
  const { runDoctor, renderDoctorReport } = await import("./doctor.js");
  const checks = await runDoctor({ workspace });
  console.log(renderDoctorReport(checks));
  // Exit 1 only on hard failures; warns (a hub not running, no topology) are
  // expected states, not failures.
  process.exitCode = checks.some((check) => check.status === "fail") ? 1 : 0;
} else if (selected === "settings") {
  const { startWorkflowWeb } = await import("./web-service.js");
  const service = await startWorkflowWeb({ workspace });
  console.log(`Workflow settings panel: ${service.url}/settings`);
  if (await openBrowser(`${service.url}/settings`)) {
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
