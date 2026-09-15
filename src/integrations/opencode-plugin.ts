import type { OpenCodeBeforeToolInput, OpenCodeBeforeToolOutput, OpenCodeHostAdapter } from "../adapters/opencode.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { guardInputFromToolCall, type WorkflowGuardProvider } from "./mcp-toolbox-guard.js";

export interface WorkflowOpenCodePlugin {
  readonly "tool.execute.before": (input: OpenCodeBeforeToolInput, output: OpenCodeBeforeToolOutput) => Promise<void>;
}

export function createWorkflowOpenCodePlugin(
  application: WorkflowApplication,
  adapter: OpenCodeHostAdapter,
  guard?: WorkflowGuardProvider,
): WorkflowOpenCodePlugin {
  if (adapter.capabilities.enforcementLevel !== "enforced") {
    throw new TypeError("OpenCode plugin requires authoritative pre-mutation interception");
  }
  return {
    async "tool.execute.before"(input, output) {
      const proposal = adapter.proposalFromBeforeTool({ input, output });
      const decision = application.authorize(proposal);
      const control = adapter.beforeToolControl(decision);
      if (control !== undefined) throw new Error(`Workflow denied ${proposal.tool}: ${control.reason}`);
      if (guard !== undefined) {
        // Plan Task G2: identical policy decisions on OpenCode sessions —
        // guard after kernel authorization; any guard failure throws (the
        // host aborts the tool call), fail closed.
        const guardInput = guardInputFromToolCall(proposal.tool, input, application.workspaceRoot);
        if (guardInput !== undefined) {
          let guardDecision;
          try {
            guardDecision = await guard.guardCheck(guardInput);
          } catch (error) {
            throw new Error(`guard unavailable (fail closed): ${error instanceof Error ? error.message : String(error)}`);
          }
          if (guardDecision.decision !== "allow") {
            throw new Error(`Workflow denied ${proposal.tool}: guard policy '${guardDecision.policy}': ${guardDecision.reason}`);
          }
        }
      }
    },
  };
}
