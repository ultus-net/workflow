/**
 * W205 S4 (assistant tool dispatcher, M4): the concrete side-effect runner the
 * S2 executor's dispatch port was left open for.
 *
 * S2 shipped the executor with dispatch INJECTED (`assistant-tool-executor.ts`)
 * so its authority ordering could be tested against a fake with no live server.
 * This module supplies the first real dispatcher: the CODING route's tool calls
 * run through the hub's contained shell executor (the same
 * `WorkflowContainedProcess` seat the hub's `/bash`, diff-sourcing, and test
 * lanes use). The tool call's `command` argument is executed under containment,
 * so a file write the model requests becomes a real, guard-gated, contained
 * shell write — the M4 acceptance.
 *
 * Authority is NOT here: the S2 executor has already run `application.authorize`
 * (kernel gate, incl. the withheld capability set) and `guard_check` before
 * dispatch is ever reached, and the contained shell executor runs its OWN
 * process-authorize + guard pass. This module only maps a tool call shape to a
 * command and hands it to that seat.
 *
 * MCP-tool dispatch (calling the tool's own MCP server) is deliberately NOT
 * composed here: W205 decision (a) keeps the sandboxed agent as the MCP server
 * launcher, so the hub holds no MCP client to dispatch through. Until that seam
 * is decided, a call whose name is not the configured shell tool fails closed
 * with a named absence rather than running anything.
 *
 * (Template literals are deliberately absent: `+` concatenation keeps sources
 * patchable under the guard shell classifier.)
 */

import type { AssistantToolCall, AssistantToolResult } from "./assistant-tool-loop.js";
import type { AssistantToolDispatcher } from "./assistant-tool-executor.js";
import type { WorkflowContainedShellExecutor } from "./contained-shell-executor.js";

export interface ContainedShellDispatcherOptions {
  /** The one tool name this dispatcher executes. Any other name fails closed. */
  readonly toolName: string;
  /** The hub's contained shell seat (already composed with its ask hold). */
  readonly shell: WorkflowContainedShellExecutor;
  /** The working directory every call runs in (the bound workspace root). */
  readonly cwd: string;
}

/**
 * Extract the `command` from a tool call's parsed arguments. Accepts the shape
 * the coding route advertises (`{ "command": "..." }`); a missing or non-string
 * command fails closed.
 */
function commandFromArguments(call: AssistantToolCall): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const command = (parsed as Record<string, unknown>).command;
  return typeof command === "string" && command.length > 0 ? command : undefined;
}

export function createContainedShellAssistantDispatcher(options: ContainedShellDispatcherOptions): AssistantToolDispatcher {
  return {
    async dispatch(call: AssistantToolCall): Promise<AssistantToolResult> {
      if (call.name !== options.toolName) {
        return {
          callId: call.id,
          content:
            "no assistant dispatcher is configured for tool '" + call.name +
            "': the coding route executes only '" + options.toolName + "' through the contained shell",
          isError: true,
        };
      }
      const command = commandFromArguments(call);
      if (command === undefined) {
        return {
          callId: call.id,
          content: "tool '" + call.name + "' requires a non-empty string 'command' argument",
          isError: true,
        };
      }
      try {
        const output = await options.shell(command, options.cwd, undefined);
        return { callId: call.id, content: output };
      } catch (error) {
        return {
          callId: call.id,
          content: "assistant shell dispatch failed: " + (error instanceof Error ? error.message : String(error)),
          isError: true,
        };
      }
    },
  };
}
