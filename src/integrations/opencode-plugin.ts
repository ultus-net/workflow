import type { OpenCodeBeforeToolInput, OpenCodeBeforeToolOutput, OpenCodeHostAdapter } from "../adapters/opencode.js";
import type { WorkflowApplication } from "../application/workflow.js";

export interface WorkflowOpenCodePlugin {
  readonly "tool.execute.before": (input: OpenCodeBeforeToolInput, output: OpenCodeBeforeToolOutput) => Promise<void>;
}

export function createWorkflowOpenCodePlugin(application: WorkflowApplication, adapter: OpenCodeHostAdapter): WorkflowOpenCodePlugin {
  if (adapter.capabilities.enforcementLevel !== "enforced") {
    throw new TypeError("OpenCode plugin requires authoritative pre-mutation interception");
  }
  return {
    async "tool.execute.before"(input, output) {
      const proposal = adapter.proposalFromBeforeTool({ input, output });
      const decision = application.authorize(proposal);
      if (decision.kind === "deny") throw new Error(`Workflow denied ${proposal.tool}: ${decision.reason}`);
    },
  };
}
