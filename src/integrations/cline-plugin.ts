import type { WorkflowApplication } from "../application/workflow.js";
import type { ClineHostAdapter } from "../adapters/cline.js";

export interface ClineBeforeToolHookInput {
  readonly toolCall: { readonly toolName: string; readonly toolCallId?: string };
  readonly input: unknown;
}

export interface WorkflowClinePlugin {
  readonly name: "workflow";
  readonly manifest: { readonly capabilities: readonly ["hooks"] };
  readonly hooks: {
    beforeTool(input: ClineBeforeToolHookInput): Promise<{ stop: true; reason: string } | undefined>;
  };
}

export function createWorkflowClinePlugin(
  application: WorkflowApplication,
  adapter: ClineHostAdapter,
  onToolDenied?: (tool: string, reason: string, toolCallId?: string) => void,
): WorkflowClinePlugin {
  if (adapter.capabilities.enforcementLevel !== "enforced") {
    throw new TypeError("Cline plugin requires an adapter configured for authoritative pre-mutation interception");
  }
  return {
    name: "workflow",
    manifest: { capabilities: ["hooks"] },
    hooks: {
      async beforeTool({ toolCall, input }) {
        const proposal = adapter.proposalFromBeforeTool({ tool: { name: toolCall.toolName }, input });
        const control = adapter.beforeToolControl(application.authorize(proposal));
        if (control !== undefined) onToolDenied?.(proposal.tool, control.reason, toolCall.toolCallId);
        return control;
      },
    },
  };
}
