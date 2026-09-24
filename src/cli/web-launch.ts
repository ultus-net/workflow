#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ensureDiscovery } from "./opencode-attach.js";
import { openBrowser } from "./open-browser.js";
import { resolveTuiWorkspace } from "./tui-args.js";
import { startWorkflowWeb } from "./web-service.js";

/**
 * The `workflow web` surface: start the browser operator UI (OpenCode in ACP
 * mode by default) and open it in the operator's browser. Replaces the former
 * patched-Cline terminal launcher. Headless/CI hosts keep serving without an
 * opener; `WORKFLOW_NO_BROWSER=1` (or `--no-browser`) suppresses the open.
 * The selector (`src/cli/workflow.ts`) calls `runWebLaunch` for the `web`
 * surface; this file stays a runnable script with identical behavior.
 *
 *   workflow web [--cwd <path>] [--port <n>] [--no-browser]
 */

function parsePort(argv: readonly string[]): number | undefined {
  const index = argv.findIndex((arg) => arg === "--port" || arg === "-p");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) throw new TypeError(`${argv[index]} requires a number`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError("--port requires an integer 0-65535");
  return port;
}

export interface WebLaunchHandle {
  readonly url: string;
  readonly workspace: string;
  close(): Promise<void>;
}

/** Runs the web surface to completion; resolves on SIGINT/SIGTERM. */
export interface StockWebTabOptions {
  readonly workspace: string;
  readonly stateHome: string;
  readonly fetchImpl?: typeof fetch | undefined;
  /** Injectable opener for tests; defaults to the platform opener. */
  readonly openImpl?: (url: string) => Promise<boolean> | undefined;
}

export interface StockWebTab {
  readonly url: string;
  readonly username: string;
}

/**
 * W074a gap fix: when the Workflow-owned opencode server topology is already
 * running for this workspace (the TUI/hub daemon the operator started), the
 * stock opencode web UI is reachable THROUGH the enforced gateway — surface it
 * as a second tab with the client credential stated, never the upstream one.
 * Quiet and honest when no daemon runs: no autostart, no fabricated URL, and
 * a foreign-host discovery is refused (`isLoopbackGatewayUrl`).
 */
export async function openStockWebTab(options: StockWebTabOptions): Promise<StockWebTab | undefined> {
  const discovery = await ensureDiscovery({ workspace: options.workspace, stateHome: options.stateHome, autostart: false, ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) });
  if (discovery === undefined) return undefined;
  const opener = options.openImpl ?? openBrowser;
  const tabUrl = `${discovery.gatewayUrl}/`;
  console.log(`Stock opencode web UI (through the enforced gateway): ${tabUrl}`);
  console.log(`  sign in as ${discovery.tuiUsername} with the TUI password (client credential only)`);
  if (await opener(tabUrl)) {
    console.log("Opening the stock web UI in your browser…");
  }
  return { url: tabUrl, username: discovery.tuiUsername };
}

export async function runWebLaunch(argv: readonly string[]): Promise<WebLaunchHandle> {
  const workspace = resolveTuiWorkspace(argv, process.cwd());
  const port = parsePort(argv);
  const noBrowser = argv.includes("--no-browser") || process.env.WORKFLOW_NO_BROWSER === "1";

  const service = await startWorkflowWeb({ ...(port === undefined ? {} : { port }), workspace });
  console.log(`Workflow browser UI: ${service.url}`);
  console.log(`Workspace: ${workspace}`);
  if (noBrowser) {
    console.log("Browser open suppressed (WORKFLOW_NO_BROWSER/--no-browser).");
  } else if (await openBrowser(service.url)) {
    console.log("Opening in your default browser…");
  } else {
    console.log("No browser opener available; open the URL above manually.");
  }

  // The stock web UI tab: only when the server topology is already running
  // for this workspace; `WORKFLOW_OPENCODE_STOCK_TAB=0` suppresses it.
  if (process.env.WORKFLOW_OPENCODE_STOCK_TAB !== "0") {
    const stateHome = process.env.WORKFLOW_OPENCODE_SERVER_HOME ?? resolve(homedir(), ".workflow", "opencode-server");
    await openStockWebTab({ workspace, stateHome });
  }

  const shutdown = (): void => {
    void service.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { url: service.url, workspace, close: () => service.close() };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  // W129: the help contract — print and exit before runWebLaunch starts the
  // service (or the browser).
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("workflow-web — the browser operator UI (headless-safe)");
    console.log("  --cwd <dir>    workspace (default: cwd)");
    console.log("  --port <n>     bind port (default: env PORT or 4173; 0 = ephemeral)");
    console.log("  --no-browser   never open a browser (env WORKFLOW_NO_BROWSER=1)");
    console.log("  --help         print this help");
    process.exit(0);
  }
  await runWebLaunch(argv);
}
