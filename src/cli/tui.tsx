#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWorkflowHub, terminateOwnedHub } from "./hub-client.js";
import { preparePersistentMcpSettings, readUserMcpSettings } from "./mcp-settings.js";
import { resolveTuiWorkspace } from "./tui-args.js";

const workspace = resolveTuiWorkspace(process.argv.slice(2), process.cwd());
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const clineRoot = resolve(root, ".workflow-cline", "cline");

// W044 resource hygiene: if THIS launch auto-spawns the hub, this launcher
// owns that hub's lifecycle and must terminate it on session exit — a hub we
// merely probed and reused is someone else's daemon and stays running.
let ownedHub: ChildProcess | undefined;
let clineChild: ChildProcess | undefined;
const terminateOwned = () => {
  terminateOwnedHub(ownedHub);
  if (clineChild !== undefined && clineChild.exitCode === null && clineChild.signalCode === null) {
    clineChild.kill("SIGTERM");
  }
};
process.on("exit", terminateOwned);
process.once("SIGTERM", () => {
  terminateOwned();
  process.exit(143);
});
process.once("SIGHUP", () => {
  terminateOwned();
  process.exit(129);
});

// The Workflow hub is the single authority for every Cline surface; the
// launcher resolves it through the discovery file and fails closed when the
// daemon is not running. See `docs/HUB.md`.
const hub = await resolveWorkflowHub({ onSpawned: (child) => { ownedHub = child; } });
const toolboxRoot = resolve(root, "mcp-toolbox");
const mcpSettingsPath = prepareMcpSettings(toolboxRoot);
process.on("SIGINT", () => {});
const exitCode = await runClineTui(clineRoot, workspace, hub.url, hub.token, mcpSettingsPath);
terminateOwned();
process.exitCode = exitCode;

/**
 * MCP settings live at a stable Workflow-owned path so servers added through
 * the surface's self-service MCP manager persist across runs. The file is
 * seeded from the user's existing Cline settings on first run and re-merged
 * with the vendored toolbox on every launch.
 */
function prepareMcpSettings(toolboxRoot: string): string {
  const settingsPath = resolve(homedir(), ".workflow", "cline_mcp_settings.json");
  if (!existsSync(settingsPath)) {
    const seed = readUserMcpSettings(resolve(homedir(), ".cline", "data", "settings", "cline_mcp_settings.json"));
    if (Object.keys(seed).length > 0) {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(seed, null, 2), { mode: 0o600 });
    }
  }
  const { servers } = preparePersistentMcpSettings({ settingsPath, toolboxRoot });
  if (Object.keys(servers).length === 0) {
    console.warn("no built toolbox MCP servers; run: npm run toolbox:build");
  }
  return settingsPath;
}

function runClineTui(clineRoot: string, cwd: string, bridgeUrl: string, bridgeToken: string, mcpSettingsPath: string): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(
      "npx",
      ["--yes", "bun@1.3.13", "run", "--cwd", clineRoot, "cli", "--", "-i", "--cwd", cwd],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          WORKFLOW_CLINE_BRIDGE_URL: bridgeUrl,
          WORKFLOW_CLINE_BRIDGE_TOKEN: bridgeToken,
          // Lazy MCP tool loading: schemas enter the model context on demand
          // via discover/call meta-tools instead of up-front for every server.
          CLINE_LAZY_MCP_TOOLS: process.env.CLINE_LAZY_MCP_TOOLS ?? "1",
          ...(mcpSettingsPath ? { CLINE_MCP_SETTINGS_PATH: mcpSettingsPath } : {}),
        },
      },
    );
    clineChild = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) return reject(new Error(`Cline TUI terminated by ${signal}`));
      resolveExit(code ?? 1);
    });
  });
}
