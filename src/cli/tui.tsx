#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWorkflowHub } from "./hub-client.js";
import { collectToolboxMcpServers, mergeMcpSettings, readUserMcpSettings } from "./mcp-settings.js";
import { resolveTuiWorkspace } from "./tui-args.js";

const workspace = resolveTuiWorkspace(process.argv.slice(2), process.cwd());
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const clineRoot = resolve(root, ".workflow-cline", "cline");

// The Workflow hub is the single authority for every Cline surface; the
// launcher resolves it through the discovery file and fails closed when the
// daemon is not running. See `docs/HUB.md`.
const hub = await resolveWorkflowHub();
const toolboxRoot = resolve(root, "mcp-toolbox");
const mcpServers = collectToolboxMcpServers(toolboxRoot);
const mcpSettingsPath = await writeMcpSettings(mcpServers);
const exitCode = await runClineTui(clineRoot, workspace, hub.url, hub.token, mcpSettingsPath);
process.exitCode = exitCode;

async function writeMcpSettings(servers: Record<string, unknown>): Promise<string> {
  if (Object.keys(servers).length === 0) {
    console.warn("no built toolbox MCP servers; run: npm run toolbox:build");
    return "";
  }
  const userSettings = readUserMcpSettings(resolve(process.env.HOME ?? "", ".cline", "data", "settings", "cline_mcp_settings.json"));
  const merged = mergeMcpSettings(userSettings, servers);
  const dir = await mkdtemp(join(tmpdir(), "workflow-mcp-"));
  const path = join(dir, "cline_mcp_settings.json");
  await writeFile(path, JSON.stringify(merged));
  return path;
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
          ...(mcpSettingsPath ? { CLINE_MCP_SETTINGS_PATH: mcpSettingsPath } : {}),
        },
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) return reject(new Error(`Cline TUI terminated by ${signal}`));
      resolveExit(code ?? 1);
    });
  });
}
