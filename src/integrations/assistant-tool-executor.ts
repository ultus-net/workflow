/**
 * W205 S2 (assistant tool executor, M4): the executor the S3 wiring injects
 * into the tool loop (`assistant-tool-loop.ts`).
 *
 * It implements the canonical authority ordering the daemon seat already uses
 * (`opencode-server-authority.ts:318-395`): classify the tool's capability
 * (S1's map, `mcp-tool-capability.ts`), parse its arguments fail-closed, build a
 * `ProposedToolAction`, run `application.authorize()` FIRST (the kernel gate),
 * then the guard; a guard `ask` parks on the operator hold
 * (`operator-ask-hold.ts`) and a `reject`/timeout fails closed. Only an allowed
 * call reaches the dispatcher.
 *
 * Dispatch is a SINGLE injected port (`AssistantToolDispatcher`): S2 ships no
 * real implementation, so its tests run against a fake and the daemon wiring
 * (S4) composes the real one (an MCP client for the tool's server, or the
 * contained shell executor for a coding-route shell tool).
 *
 * The executor never throws: every failure becomes an error observation the loop
 * appends as `role: "tool"`, exactly like the loop's own executor-throw path.
 *
 * (Template literals are deliberately absent: `+` concatenation keeps sources
 * patchable under the guard shell classifier.)
 */

import type { WorkflowApplication } from "../application/workflow.js";
import type { TaskId } from "../kernel/contracts.js";
import { classifyMcpTool, type McpToolClass, type McpToolCapabilityMap } from "./mcp-tool-capability.js";
import type { GuardCheckInput } from "./guard-policy/index.js";
import type { WorkflowGuardProvider } from "./mcp-toolbox-guard.js";
import type { OperatorAskHold } from "./operator-ask-hold.js";
import type { AssistantToolCall, AssistantToolContext, AssistantToolResult, AssistantToolExecutor } from "./assistant-tool-loop.js";

/**
 * The injected dispatch port. Given an authorized call, run the side effect and
 * return its observation. S4 composes the real one; S2 tests use a fake.
 */
export interface AssistantToolDispatcher {
  dispatch(call: AssistantToolCall, context: AssistantToolContext, toolClass: McpToolClass): Promise<AssistantToolResult>;
}

export interface AssistantToolExecutorOptions {
  readonly application: WorkflowApplication;
  readonly capabilities: McpToolCapabilityMap;
  readonly dispatcher: AssistantToolDispatcher;
  readonly sessionId: string;
  readonly taskId: TaskId;
  /** In-process guard seat. Absent → the guard stage is skipped (authorize still ran). */
  readonly guard?: WorkflowGuardProvider;
  /** Operator ask hold. Absent → a guard `ask` fails closed, never dangles. */
  readonly hold?: OperatorAskHold;
  /** Workspace root passed to the guard's `mcp` action when present. */
  readonly workspace?: string;
}

export function createAssistantToolExecutor(options: AssistantToolExecutorOptions): AssistantToolExecutor {
  return {
    async execute(call, context) {
      const toolClass = classifyMcpTool(call.name, options.capabilities);

      // Parse arguments, fail closed. Empty is not valid JSON.
      let parsed: unknown;
      try {
        if (call.arguments.trim().length === 0) {
          return {
            callId: call.id,
            content: "tool arguments are not valid JSON: the arguments string is empty",
            isError: true,
          };
        }
        parsed = JSON.parse(call.arguments);
      } catch (error) {
        return {
          callId: call.id,
          content: "tool arguments are not valid JSON: " + (error instanceof Error ? error.message : String(error)),
          isError: true,
        };
      }

      // Kernel gate first. A throw (unknown task, malformed proposal) fails the
      // call closed, never past the loop.
      try {
        const decision = options.application.authorize({
          sessionId: options.sessionId,
          taskId: options.taskId,
          tool: call.name,
          capability: toolClass.capability,
          mutating: toolClass.mutating,
          subjects: [],
          input: parsed,
        });
        if (decision.kind === "deny") {
          return {
            callId: call.id,
            content: "capability or policy denied (" + decision.code + "): " + decision.reason,
            isError: true,
          };
        }
      } catch (error) {
        return {
          callId: call.id,
          content: "tool execution failed: " + (error instanceof Error ? error.message : String(error)),
          isError: true,
        };
      }

      // Guard: an MCP tool is the `mcp` action, keyed on the tool name. The
      // host-tool mapper (`guardInputFromToolCall`) has no MCP mapping, so the
      // input is built directly.
      if (options.guard !== undefined) {
        const guardInput: GuardCheckInput = {
          action: "mcp",
          toolName: call.name,
          ...(options.workspace === undefined ? {} : { workspaceRoot: options.workspace }),
        };
        let decision;
        try {
          decision = await options.guard.guardCheck(guardInput);
        } catch (error) {
          return {
            callId: call.id,
            content: "guard unavailable (fail closed): " + (error instanceof Error ? error.message : String(error)),
            isError: true,
          };
        }
        if (decision.decision === "deny") {
          return {
            callId: call.id,
            content: "guard policy '" + decision.policy + "': " + decision.reason,
            isError: true,
          };
        }
        if (decision.decision === "ask") {
          // No operator channel: fail closed rather than dangle or allow.
          if (options.hold === undefined) {
            return {
              callId: call.id,
              content: "guard ask '" + decision.policy + "' requires operator approval but no operator channel is configured",
              isError: true,
            };
          }
          let reply;
          try {
            reply = await options.hold.park({
              requestId: call.id,
              policy: decision.policy,
              reason: decision.reason,
              ...(decision.matched === undefined ? {} : { matched: decision.matched }),
            });
          } catch (error) {
            return {
              callId: call.id,
              content: "operator ask hold unavailable (fail closed): " + (error instanceof Error ? error.message : String(error)),
              isError: true,
            };
          }
          if (reply === "reject") {
            return {
              callId: call.id,
              content: "operator rejected guard ask '" + decision.policy + "'",
              isError: true,
            };
          }
          // `once` / `always` proceeds.
        }
      }

      return options.dispatcher.dispatch(call, context, toolClass);
    },
  };
}
