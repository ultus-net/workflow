/**
 * `@agent-tools/mcp-server-kit` — the shared MCP-server scaffolding every
 * toolbox app otherwise copies.
 *
 * Two duplicated concerns live here:
 *
 * 1. `createLoggingServer` — an `McpServer` construction that advertises the
 *    MCP logging capability by default (the exact `{ capabilities: { logging:
 *    {} } }` every app used), while still accepting extra capabilities or a
 *    task store.
 * 2. `installToolStreaming` — the leveled log + progress wrapper installed
 *    around `server.registerTool`: a `debug` "start" log (only when a `logger`
 *    is configured) and a `notifications/progress` 0/2 pair (only when the
 *    caller supplies `_meta.progressToken`), an `info` "done" log on success,
 *    and an `error` log (re-throwing) on failure. The handler result passes
 *    through unchanged, or through an optional `transform` (e.g.
 *    `boundToolResultText`).
 *
 * Behavior is a byte-for-byte match of the per-app copies: logging is only
 * emitted when a `logger` name is configured (workflow-guard-mcp streams
 * progress only), and progress notifications are total: 2 with "start"=0 and
 * "done"=2.
 *
 * The kit deliberately has no dependency on `@agent-tools/result-bounds`: a
 * transitive workspace dependency does not survive `npm pack` bundling (a
 * packed app cannot resolve a bundled dep's workspace dep), so a server that
 * bounds its result passes `boundToolResultText` in as the `transform`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";

/** The request-handler `extra` fields the streaming wrapper touches. */
export type ToolExtra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: unknown) => Promise<void>;
};

export interface InstallToolStreamingOptions {
  /**
   * When set, emit leveled `notifications/message` logs under this logger
   * name: `debug` start, `info` done, `error` on a thrown handler. When
   * omitted, only progress notifications are emitted (workflow-guard-mcp).
   */
  readonly logger?: string;
  /**
   * Optional result transform applied to every successful tool result before
   * it is returned (e.g. `boundToolResultText` for 48k middle-cut parity).
   * Defaults to the identity function.
   */
  readonly transform?: (result: unknown) => unknown;
}

/**
 * Construct an `McpServer` with the MCP logging capability (and any extra
 * options) — the shared form of the `new McpServer({...}, { capabilities: {
 * logging: {} } })` every app repeated.
 */
export function createLoggingServer(serverInfo: Implementation, options: ServerOptions = {}): McpServer {
  const capabilities = options.capabilities ?? { logging: {} };
  return new McpServer(serverInfo, { ...options, capabilities });
}

/**
 * Install the leveled log + progress wrapper around `server.registerTool`.
 *
 * The wrapper returns the handler's result unchanged (or `transform`-ed).
 * Progress notifications fire only when the caller supplies
 * `_meta.progressToken`; logging only when `logger` is set.
 */
export function installToolStreaming(server: McpServer, options: InstallToolStreamingOptions = {}): void {
  const { logger, transform = (result: unknown) => result } = options;
  const registerTool = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, handler: (input: never, extra: ToolExtra) => Promise<unknown>) =>
    registerTool(name as never, config as never, (async (input: never, extra: ToolExtra) => {
      const progressToken = extra._meta?.progressToken;
      const progress = async (message: string, value: number) => {
        if (progressToken === undefined) return;
        await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: value, total: 2, message } } as never);
      };
      if (logger !== undefined) {
        await server.server.sendLoggingMessage({ level: "debug", logger, data: { tool: name, phase: "start" } });
      }
      await progress("start", 0);
      try {
        const result = await handler(input, extra);
        if (logger !== undefined) {
          await server.server.sendLoggingMessage({ level: "info", logger, data: { tool: name, phase: "done" } });
        }
        await progress("done", 2);
        return transform(result);
      } catch (error) {
        if (logger !== undefined) {
          await server.server.sendLoggingMessage({
            level: "error",
            logger,
            data: { tool: name, phase: "error", message: error instanceof Error ? error.message : String(error) },
          });
        }
        throw error;
      }
    }) as never)) as typeof server.registerTool;
}
