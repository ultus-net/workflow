import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

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

/**
 * Prepares the persistent, Workflow-owned MCP settings file. Cline is pointed
 * at this stable path, so servers the user adds through the surface's
 * self-service MCP manager survive across runs. On each launch the file is
 * re-merged: stale toolbox-managed entries (identified by their server path
 * under the toolbox root) are pruned, current toolbox entries win conflicts,
 * and everything else — including self-service additions — is preserved.
 */
export function preparePersistentMcpSettings(options: {
  settingsPath: string;
  toolboxRoot: string;
}): { path: string; servers: Record<string, ToolboxMcpServerEntry> } {
  const existing = readUserMcpSettings(options.settingsPath);
  const pruned = pruneToolboxEntries(existing, options.toolboxRoot);
  const servers = collectToolboxMcpServers(options.toolboxRoot);
  const merged = mergeMcpSettings(pruned, servers);
  mkdirSync(dirname(options.settingsPath), { recursive: true });
  writeFileSync(options.settingsPath, JSON.stringify(merged, null, 2), { encoding: "utf8", mode: 0o600 });
  return { path: options.settingsPath, servers };
}

function pruneToolboxEntries(doc: McpSettingsDocument, toolboxRoot: string): McpSettingsDocument {
  const appsPrefix = join(toolboxRoot, "apps") + sep;
  const servers = Object.entries(doc.mcpServers ?? {}).filter(([, entry]) => !isToolboxEntry(entry, appsPrefix));
  return { ...doc, mcpServers: Object.fromEntries(servers) };
}

function isToolboxEntry(entry: unknown, appsPrefix: string): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const args = (entry as Record<string, unknown>).args;
  return Array.isArray(args) && args.some((arg) => typeof arg === "string" && arg.startsWith(appsPrefix));
}
