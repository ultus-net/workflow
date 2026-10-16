/**
 * W205 S5 (assistant MCP dispatcher, M4, topology Option B): the daemon half of
 * the split authority/dispatch.
 *
 * The hub is the sole authority for the assistant tool lane
 * (`assistant-tool-host.ts`): identity → route → per-run application →
 * withholding → kernel gate → guard → broker ask-hold. When the hub does NOT
 * own a tool's execution seat it answers the call with a DISPATCH DIRECTIVE
 * instead of an observation, and this module fulfills it.
 *
 * The seat split is honest about which process can run which tool:
 *  - the hub keeps the contained shell (it needs the run's application and the
 *    operator ask hold) and dispatches that tool itself;
 *  - every other tool is an MCP tool whose server the DAEMON is best placed to
 *    launch (it already owns the mount config, `opencode-agent-config.ts:382`,
 *    and the containment posture the vendored servers were probed under).
 *
 * The hub does NOT hold an MCP client today — it writes config and the
 * sandboxed `opencode serve` launches the servers — so this client is composed
 * here rather than reused. It deliberately cares about ONE thing: run an
 * already-authorized call against its server. It holds no authority content, so
 * an undeclared tool name fails closed before any connection is made.
 *
 * (Template literals are deliberately absent: `+` concatenation keeps sources
 * patchable under the guard shell classifier.)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AssistantToolCall, AssistantToolResult } from "./assistant-tool-loop.js";
import type { AssistantToolDispatcher } from "./assistant-tool-executor.js";
import { enabledMcpServers } from "./workflow-settings.js";
import type { WorkflowSettings } from "./workflow-settings.js";
import { resolveToolboxCatalog } from "./toolbox-catalog.js";

/** How to launch one stdio MCP server. `command` is an absolute path or a PATH name. */
export interface AssistantMcpServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** The minimal connected-server surface the dispatcher needs. Injectable for tests. */
export interface AssistantMcpConnection {
  /** Run a tool. Returns the flattened observation; never throws on a tool error. */
  callTool(name: string, args: Record<string, unknown>): Promise<{ readonly content: string; readonly isError: boolean }>;
  close(): Promise<void>;
}

export interface AssistantMcpDispatcherOptions {
  /**
   * Tool name → server NAME. Only names in this map are dispatchable: a tool
   * absent from it fails closed, so the daemon never invents an execution seat.
   */
  readonly tools: Readonly<Record<string, string>>;
  /** Server NAME → launch. A tool whose server has no launch fails closed. */
  readonly servers: Readonly<Record<string, AssistantMcpServerLaunch>>;
  /** Injectable connection factory; defaults to a stdio `Client`. */
  readonly connect?: (launch: AssistantMcpServerLaunch) => Promise<AssistantMcpConnection>;
  /** Injectable env base for the spawned server; defaults to `process.env`. */
  readonly baseEnv?: Readonly<Record<string, string>>;
}

/**
 * Flatten one MCP `ContentItem[]` into the single string the loop appends.
 * Text parts pass through; every other part is named by type so a binary or
 * resource result is still honest in the transcript rather than empty.
 */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    } else if (typeof record.type === "string") {
      parts.push("[" + record.type + " content omitted]");
    }
  }
  return parts.join("\n");
}

/** Tool name → server NAME. */
export type AssistantMcpToolServerMap = Readonly<Record<string, string>>;

/**
 * Parse the operator's tool→server declaration (`WORKFLOW_ASSISTANT_MCP_TOOLS`,
 * a JSON object of tool name → server name). Fail closed: a non-object, or any
 * entry whose value is not a non-empty string, throws.
 */
export function parseAssistantMcpToolServerMap(value: unknown): AssistantMcpToolServerMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("assistant MCP tool map must be an object of tool name -> server name");
  }
  const result: Record<string, string> = {};
  for (const [tool, server] of Object.entries(value)) {
    if (typeof server !== "string" || server.trim().length === 0) {
      throw new TypeError("assistant MCP tool '" + tool + "' must map to a non-empty server name");
    }
    result[tool.trim()] = server.trim();
  }
  return result;
}

/**
 * Resolve the stdio launches available to the dispatcher: every ENABLED stdio
 * server in the operator settings (an explicit `command` wins), plus every
 * BUILT toolbox-catalog server (its vendored `dist/server.js`) for a name the
 * operator did not declare. Settings win over the catalog, mirroring the
 * launch-config projection (`opencode-agent-config.ts:382`).
 */
export function resolveAssistantMcpServers(options: {
  readonly settings: WorkflowSettings;
  /** Defaults to `process.execPath`; the vendored servers run under node. */
  readonly nodePath?: string;
  /** Toolbox catalog probe root; defaults to the package root. */
  readonly toolboxRoot?: string;
  readonly exists?: (path: string) => boolean;
}): Readonly<Record<string, AssistantMcpServerLaunch>> {
  const node = options.nodePath ?? process.execPath;
  const launches: Record<string, AssistantMcpServerLaunch> = {};
  for (const server of enabledMcpServers(options.settings)) {
    if (server.transport !== "stdio" || server.command === undefined) continue;
    launches[server.name] = {
      command: server.command,
      args: [...(server.args ?? [])],
      ...(server.env === undefined ? {} : { env: server.env }),
    };
  }
  const catalogOptions = {
    ...(options.toolboxRoot === undefined ? {} : { root: options.toolboxRoot }),
    ...(options.exists === undefined ? {} : { exists: options.exists }),
  };
  for (const entry of resolveToolboxCatalog(catalogOptions)) {
    if (!entry.available || launches[entry.name] !== undefined) continue;
    launches[entry.name] = { command: node, args: [entry.serverPath] };
  }
  return launches;
}

/** The default connection: a stdio `Client`, connected lazily, closed per call. */function defaultConnect(
  launch: AssistantMcpServerLaunch,
  baseEnv: Readonly<Record<string, string>>,
): Promise<AssistantMcpConnection> {
  const client = new Client({ name: "workflow-assistant-tool-dispatch", version: "1.0.0" });
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) merged[key] = value;
  for (const [key, value] of Object.entries(launch.env ?? {})) merged[key] = value;
  const transport = new StdioClientTransport({
    command: launch.command,
    args: [...launch.args],
    stderr: "pipe",
    env: merged,
  });
  const ready = client.connect(transport).then(() => {
    return {
      async callTool(name: string, args: Record<string, unknown>): Promise<{ readonly content: string; readonly isError: boolean }> {
        const result = await client.callTool({ name, arguments: args });
        return { content: flattenContent(result.content), isError: result.isError === true };
      },
      async close(): Promise<void> {
        await client.close();
      },
    };
  });
  return ready;
}

/**
 * Compose the dispatcher the daemon hands to `createHubAssistantToolExecutor`.
 * Connections are opened per call and closed in a `finally`, mirroring the
 * one-shot stdio clients the plane already uses (`project-memory.ts:66-92`).
 * A per-call lifecycle is deliberate: an assistant tool call is not a hot path,
 * and a leaked child is a worse failure than a reconnect.
 */
export function createAssistantMcpDispatcher(options: AssistantMcpDispatcherOptions): AssistantToolDispatcher {
  const connect = options.connect ?? ((launch) => defaultConnect(launch, options.baseEnv ?? process.env as Readonly<Record<string, string>>));
  return {
    async dispatch(call: AssistantToolCall): Promise<AssistantToolResult> {
      const serverName = options.tools[call.name];
      if (serverName === undefined) {
        return {
          callId: call.id,
          content: "no assistant MCP server is declared for tool '" + call.name + "' (fail closed)",
          isError: true,
        };
      }
      const launch = options.servers[serverName];
      if (launch === undefined) {
        return {
          callId: call.id,
          content: "assistant MCP server '" + serverName + "' has no launch configured for tool '" + call.name + "' (fail closed)",
          isError: true,
        };
      }
      let args: Record<string, unknown>;
      try {
        const parsed = call.arguments.trim().length === 0 ? {} : JSON.parse(call.arguments);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return {
            callId: call.id,
            content: "tool arguments must be a JSON object for tool '" + call.name + "'",
            isError: true,
          };
        }
        args = parsed as Record<string, unknown>;
      } catch (error) {
        return {
          callId: call.id,
          content: "tool arguments are not valid JSON: " + (error instanceof Error ? error.message : String(error)),
          isError: true,
        };
      }
      let connection: AssistantMcpConnection;
      try {
        connection = await connect(launch);
      } catch (error) {
        return {
          callId: call.id,
          content: "assistant MCP server '" + serverName + "' could not be started (fail closed): " +
            (error instanceof Error ? error.message : String(error)),
          isError: true,
        };
      }
      try {
        const result = await connection.callTool(call.name, args);
        return {
          callId: call.id,
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (error) {
        return {
          callId: call.id,
          content: "assistant MCP tool '" + call.name + "' on server '" + serverName + "' failed (fail closed): " +
            (error instanceof Error ? error.message : String(error)),
          isError: true,
        };
      } finally {
        try {
          await connection.close();
        } catch {
          // A close failure must not mask the call's own outcome.
        }
      }
    },
  };
}
