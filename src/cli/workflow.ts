#!/usr/bin/env node
import { spawn } from "node:child_process";

import { cliSibling, LAUNCHER_OPTIONS, parseLauncherArgs, resolveSelection } from "./launcher-args.js";
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
 *
 * Every surface composes the same WorkflowApplication authority in-process;
 * the selector only picks the display. The opencode web UI becomes the web
 * surface's primary tab once the stock-UI-behind-gateway probe passes
 * (docs/ideas/hub-control-plane.md); until then the PWA is primary and
 * `WORKFLOW_OPENCODE_WEB_URL` opts into an experimental extra tab. Pure
 * surface resolution lives in `./launcher-args.js`.
 */

function spawnSurface(name: "opencode-attach" | "hub", args: readonly string[], cwd: string): never {
  const { script, execArgv } = cliSibling(import.meta.url, name);
  const child = spawn(process.execPath, [...execArgv, script, ...args], { stdio: "inherit", cwd });
  child.on("exit", (code) => process.exit(code ?? 0));
  // The child owns the terminal; parent exits only when it does.
  process.on("SIGINT", () => child.kill("SIGINT"));
  throw new Error("unreachable");
}

const { verb, rest } = parseLauncherArgs(process.argv.slice(2));
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
