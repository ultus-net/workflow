import { existsSync, readdirSync } from "node:fs";
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
