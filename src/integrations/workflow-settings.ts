import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * The canonical Workflow settings document. This is the operator-owned source
 * of truth for settings that are projected into coding-agent launch configs
 * (MCP servers, preferred model/mode/effort, tool posture). Settings the
 * application can enforce server-side — authorization, capabilities,
 * confinement, approval mode — are NOT stored here as authority; they remain
 * in `WorkflowApplication` and this document only mirrors operator preference
 * where a surface needs a persisted default.
 *
 * Precedence is global (`~/.config/workflow/settings.json`) with an optional
 * per-workspace overlay (`<workspace>/.workflow/settings.json`); the overlay
 * wins per MCP server name and per agent preference key.
 */
export interface WorkflowSettings {
  readonly version: 1;
  readonly mcpServers: readonly McpServerSetting[];
  /** Operator runtime preferences keyed by agent id (opencode, goose, cline). */
  readonly agents: Readonly<Record<string, AgentRuntimePreference>>;
  readonly updatedAt?: string;
}

export type McpTransport = "stdio" | "http";

/** One operator-declared MCP server, projected into each agent's native config. */
export interface McpServerSetting {
  readonly name: string;
  readonly enabled: boolean;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
}

export interface AgentRuntimePreference {
  readonly model?: string;
  readonly mode?: string;
  readonly thoughtLevel?: string;
  /**
   * W082 (config-side auto-compaction trigger): when true, the hub-written
   * launch config composes `compaction: { auto: true }` for this agent — the
   * session runtime then compacts on its own at the documented threshold
   * (per-model runtime behavior; the §9 research note: the ACP lane
   * auto-compacts exactly when the model's compaction config enables it).
   * The default is OFF (absent or false — no invented runtime defaults;
   * current behavior is unchanged). An explicit `false` persists as the
   * operator's choice so an uncheck sticks through the per-key merge.
   * Launch-time applied like the other agent preferences: a change reaches a
   * NEW session. Budget-guard compatible by
   * construction: a compaction turn is a normal metered model turn through
   * the same loopback proxy the W045 interactive budget guard watches, and
   * the sticky refusal gate still bounds every later prompt — auto-compaction
   * composes no bypass lane.
   */
  readonly autoCompact?: boolean;
  /**
   * W082 (the data-lane backstop monitor): the deterministic threshold in
   * tokens at which the topology daemon fires the documented compact route
   * for a gateway-driven session whose context usage crossed it. Never
   * invented: absent/malformed means the monitor stays off (the config-side
   * trigger composes the runtime's own threshold instead). A sticky
   * session-budget violation vetoes every monitor fire.
   */
  readonly autoCompactAtTokens?: number;
}

export function defaultSettings(): WorkflowSettings {
  return { version: 1, mcpServers: [], agents: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is string => typeof entry === "string");
  return entries.length === 0 ? undefined : entries;
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === "string" ? [[key, entry] as const] : [],
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function normalizeMcpServer(value: unknown): McpServerSetting | undefined {
  if (!isRecord(value)) return undefined;
  const name = normalizeString(value.name);
  if (name === undefined) return undefined;
  const transport = value.transport === "stdio" ? "stdio" : value.transport === "http" ? "http" : undefined;
  if (transport === undefined) return undefined;
  const enabled = value.enabled !== false;
  if (transport === "stdio") {
    const command = normalizeString(value.command);
    if (command === undefined) return undefined;
    const args = normalizeStringArray(value.args);
    const env = normalizeEnv(value.env);
    return {
      name,
      enabled,
      transport,
      command,
      ...(args === undefined ? {} : { args }),
      ...(env === undefined ? {} : { env }),
    };
  }
  const url = normalizeString(value.url);
  if (url === undefined) return undefined;
  return { name, enabled, transport, url };
}

/**
 * Fail-closed normalization: malformed servers and preferences are dropped,
 * never guessed. A corrupt document yields an empty one rather than throwing
 * into a launch path.
 */
export function normalizeSettings(value: unknown): WorkflowSettings {
  if (!isRecord(value)) return defaultSettings();
  const mcpServers = Array.isArray(value.mcpServers)
    ? value.mcpServers.flatMap((entry) => {
      const server = normalizeMcpServer(entry);
      return server === undefined ? [] : [server];
    })
    : [];
  const agents: Record<string, AgentRuntimePreference> = {};
  if (isRecord(value.agents)) {
    for (const [id, raw] of Object.entries(value.agents)) {
      if (!isRecord(raw)) continue;
      const model = normalizeString(raw.model);
      const mode = normalizeString(raw.mode);
      const thoughtLevel = normalizeString(raw.thoughtLevel);
      // W082: an explicit boolean persists as the operator's choice (so an
      // uncheck can stick in the merge); a non-boolean is dropped fail-closed.
      // Only `=== true` ever arms the trigger — the composition sites treat
      // everything else as the honest default (off).
      const autoCompact = typeof raw.autoCompact === "boolean" ? raw.autoCompact : undefined;
      // W082 (the monitor threshold): a positive integer only — absent or a
      // malformed value means the monitor stays off, never a guessed limit.
      const rawAtTokens = raw.autoCompactAtTokens;
      const autoCompactAtTokens = typeof rawAtTokens === "number" && Number.isInteger(rawAtTokens) && rawAtTokens > 0
        ? rawAtTokens
        : undefined;
      if (model === undefined && mode === undefined && thoughtLevel === undefined && autoCompact === undefined && autoCompactAtTokens === undefined) continue;
      agents[id] = {
        ...(model === undefined ? {} : { model }),
        ...(mode === undefined ? {} : { mode }),
        ...(thoughtLevel === undefined ? {} : { thoughtLevel }),
        ...(autoCompact === undefined ? {} : { autoCompact }),
        ...(autoCompactAtTokens === undefined ? {} : { autoCompactAtTokens }),
      };
    }
  }
  const updatedAt = normalizeString(value.updatedAt);
  return { version: 1, mcpServers, agents, ...(updatedAt === undefined ? {} : { updatedAt }) };
}

/** Overlay wins per MCP server name and per agent preference key. */
export function mergeSettings(base: WorkflowSettings, overlay: WorkflowSettings): WorkflowSettings {
  const servers = new Map(base.mcpServers.map((server) => [server.name, server]));
  for (const server of overlay.mcpServers) servers.set(server.name, server);
  const agents: Record<string, AgentRuntimePreference> = { ...base.agents };
  for (const [id, preference] of Object.entries(overlay.agents)) {
    agents[id] = { ...(agents[id] ?? {}), ...preference };
  }
  const updatedAt = overlay.updatedAt ?? base.updatedAt;
  return {
    version: 1,
    mcpServers: [...servers.values()],
    agents,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

export interface SettingsPaths {
  readonly global: string;
  readonly workspace?: string;
}

export function settingsPaths(options: { readonly home?: string | undefined; readonly workspace?: string | undefined } = {}): SettingsPaths {
  const home = options.home ?? homedir();
  return {
    global: resolve(home, ".config", "workflow", "settings.json"),
    ...(options.workspace === undefined ? {} : { workspace: resolve(options.workspace, ".workflow", "settings.json") }),
  };
}

export function readSettingsFile(path: string): WorkflowSettings {
  if (!existsSync(path)) return defaultSettings();
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return defaultSettings();
  }
}

/** Resolves the effective document: global base with the workspace overlay applied. */
export function loadSettings(options: { readonly home?: string | undefined; readonly workspace?: string | undefined } = {}): WorkflowSettings {
  const paths = settingsPaths(options);
  const base = readSettingsFile(paths.global);
  if (paths.workspace === undefined) return base;
  return mergeSettings(base, readSettingsFile(paths.workspace));
}

export function writeSettingsFile(path: string, settings: WorkflowSettings): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
}

/** Enabled MCP servers only — disabled entries never reach an agent config. */
export function enabledMcpServers(settings: WorkflowSettings): McpServerSetting[] {
  return settings.mcpServers.filter((server) => server.enabled);
}

/** OpenCode `mcp` map projection (`type: "local"` stdio, `type: "remote"` HTTP). */
export function opencodeMcpServers(servers: readonly McpServerSetting[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const server of servers) {
    if (server.transport === "stdio") {
      projected[server.name] = {
        type: "local",
        command: [server.command, ...(server.args ?? [])],
        ...(server.env === undefined ? {} : { environment: server.env }),
      };
    } else {
      projected[server.name] = { type: "remote", url: server.url };
    }
  }
  return projected;
}

/** Cline `mcpServers` map projection (stdio/sse/http). */
export function clineMcpServers(servers: readonly McpServerSetting[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const server of servers) {
    if (server.transport === "stdio") {
      projected[server.name] = {
        type: "stdio",
        command: server.command,
        args: [...(server.args ?? [])],
        ...(server.env === undefined ? {} : { env: server.env }),
      };
    } else {
      projected[server.name] = { type: "http", url: server.url };
    }
  }
  return projected;
}

/**
 * goose `extensions` YAML lines for the enabled MCP servers, in the documented
 * map shape the mount probe verified (type/name/enabled/cmd/args/envs/timeout).
 * Returned as lines so callers can append them to skills extension blocks.
 */
export function gooseExtensionLines(servers: readonly McpServerSetting[], indent = "  "): string[] {
  const lines: string[] = [];
  for (const server of servers) {
    lines.push(`${indent}${server.name}:`);
    if (server.transport === "stdio") {
      lines.push(`${indent}  type: stdio`);
      lines.push(`${indent}  name: ${server.name}`);
      lines.push(`${indent}  enabled: true`);
      lines.push(`${indent}  cmd: ${JSON.stringify(server.command)}`);
      lines.push(`${indent}  args: ${JSON.stringify([...(server.args ?? [])])}`);
      const env = server.env ?? {};
      lines.push(`${indent}  env_keys: ${JSON.stringify(Object.keys(env))}`);
      lines.push(`${indent}  envs:`);
      for (const [key, value] of Object.entries(env)) lines.push(`${indent}    ${key}: ${JSON.stringify(value)}`);
      lines.push(`${indent}  timeout: 300`);
    } else {
      lines.push(`${indent}  type: streamable_http`);
      lines.push(`${indent}  name: ${server.name}`);
      lines.push(`${indent}  enabled: true`);
      lines.push(`${indent}  uri: ${JSON.stringify(server.url)}`);
      lines.push(`${indent}  timeout: 300`);
    }
  }
  return lines;
}
