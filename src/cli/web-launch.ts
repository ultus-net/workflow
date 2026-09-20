#!/usr/bin/env node
import { pathToFileURL } from "node:url";

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

  const shutdown = (): void => {
    void service.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return { url: service.url, workspace, close: () => service.close() };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runWebLaunch(process.argv.slice(2));
}
