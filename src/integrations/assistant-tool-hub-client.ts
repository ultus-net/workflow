/**
 * W205 S4 (assistant tool hub client, M4): the daemon half of the hub-hosted
 * assistant tool lane.
 *
 * The M1 gateway runs in the `opencode-server` daemon; the operator
 * `PermissionBroker` and the run registry live in the `hub` process (topology
 * decision Q3b). Rather than stand a second broker in the daemon, this executor
 * forwards each authorized tool call to the hub's loopback
 * `POST /assistant/tool-call` route (`assistant-tool-host.ts` composes the other
 * end), and returns the hub's single observation to the S3 tool loop.
 *
 * Fail-closed honesty: no hub (or an unreadable discovery record) fails the call
 * as an error observation — never a fabricated success and never a silent allow.
 * A non-2xx from the hub is surfaced as its own observation. The discovery read
 * happens per call so a hub restart is picked up without restarting the daemon.
 *
 * (Template literals are deliberately absent: `+` concatenation keeps sources
 * patchable under the guard shell classifier.)
 */

import type { AssistantToolCall, AssistantToolContext, AssistantToolResult, AssistantToolExecutor } from "./assistant-tool-loop.js";
import { readHubCredentials } from "./hub-discovery.js";

export interface HubAssistantToolExecutorOptions {
  /** The bound workspace root the call executes against (absolute). */
  readonly workspace: string;
  /** The hub discovery directory; defaults to `WORKFLOW_HUB_DIR` or `~/.workflow`. */
  readonly hubDiscoveryDir?: string;
  /** Injectable transport for tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Loopback call timeout; defaults to 60s (a guard `ask` may hold past 5s). */
  readonly timeoutMs?: number;
}

/** The hub reply shape the executor reads (`{ result: AssistantToolResult }`). */
function resultFromBody(body: unknown, callId: string): AssistantToolResult {
  if (typeof body === "object" && body !== null) {
    const result = (body as Record<string, unknown>).result;
    if (typeof result === "object" && result !== null) {
      const record = result as Record<string, unknown>;
      if (typeof record.content === "string") {
        return {
          callId: typeof record.callId === "string" ? record.callId : callId,
          content: record.content,
          ...(record.isError === true ? { isError: true } : {}),
        };
      }
    }
  }
  // A 2xx the executor cannot read is dishonest to pass as success: fail closed.
  return {
    callId,
    content: "hub assistant tool call returned an unreadable observation",
    isError: true,
  };
}

export function createHubAssistantToolExecutor(options: HubAssistantToolExecutorOptions): AssistantToolExecutor {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return {
    async execute(call: AssistantToolCall, context: AssistantToolContext): Promise<AssistantToolResult> {
      const hub = readHubCredentials(options.hubDiscoveryDir);
      if (hub === undefined) {
        return {
          callId: call.id,
          content: "no workflow hub is reachable for assistant tool execution (fail closed)",
          isError: true,
        };
      }
      let response: Response;
      try {
        response = await fetchImpl(hub.url + "/assistant/tool-call", {
          method: "POST",
          headers: { authorization: "Bearer " + hub.token, "content-type": "application/json" },
          body: JSON.stringify({
            identity: context.identity,
            workspace: options.workspace,
            call: { id: call.id, name: call.name, arguments: call.arguments },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return {
          callId: call.id,
          content: "assistant tool call to the hub failed (fail closed): " +
            (error instanceof Error ? error.message : String(error)),
          isError: true,
        };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      if (!response.ok) {
        const message = typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).error === "string"
          ? (body as Record<string, unknown>).error as string
          : "status " + response.status;
        return {
          callId: call.id,
          content: "assistant tool call refused by the hub (" + response.status + "): " + message,
          isError: true,
        };
      }
      return resultFromBody(body, call.id);
    },
  };
}
