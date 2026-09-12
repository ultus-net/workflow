import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface ToolboxMcpServerEntry {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Collects stdio MCP server entries for every vendored toolbox app with a
 * built `dist/server.js`, keyed by the app name without the `-mcp` suffix.
 */
export function collectToolboxMcpServers(toolboxRoot: string): Record<string, ToolboxMcpServerEntry> {
  const appsDir = join(toolboxRoot, "apps");
  const servers: Record<string, ToolboxMcpServerEntry> = {};
  if (!existsSync(appsDir)) return servers;
  for (const app of readdirSync(appsDir)) {
    if (!app.endsWith("-mcp")) continue;
    const serverPath = join(appsDir, app, "dist", "server.js");
    if (!existsSync(serverPath)) continue;
    servers[app.replace(/-mcp$/, "")] = {
      type: "stdio",
      command: process.execPath,
      args: [serverPath],
    };
  }
  return servers;
}

export interface McpSettingsDocument {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Merges toolbox entries into the user's existing MCP settings document:
 * user servers survive; toolbox entries win on name conflicts; unrelated
 * top-level keys are preserved.
 */
export function mergeMcpSettings(user: McpSettingsDocument, toolbox: Record<string, unknown>): McpSettingsDocument {
  return {
    ...user,
    mcpServers: { ...(user.mcpServers ?? {}), ...toolbox },
  };
}

/** Reads the user's existing MCP settings file if present; returns {} on failure. */
export function readUserMcpSettings(path: string): McpSettingsDocument {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed as McpSettingsDocument : {};
  } catch {
    return {};
  }
}
