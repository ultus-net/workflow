import type { OpenCodeBeforeToolInput, OpenCodeBeforeToolOutput, OpenCodeHostAdapter } from "../adapters/opencode.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { guardInputFromToolCall, type WorkflowGuardProvider } from "./mcp-toolbox-guard.js";
import type { OperatorAskHold } from "./operator-ask-hold.js";

export interface WorkflowOpenCodePlugin {
  readonly "tool.execute.before": (input: OpenCodeBeforeToolInput, output: OpenCodeBeforeToolOutput) => Promise<void>;
}

export function createWorkflowOpenCodePlugin(
  application: WorkflowApplication,
  adapter: OpenCodeHostAdapter,
  guard?: WorkflowGuardProvider,
  /**
   * P6 second seat (issue #285): the operator ask hold. When the guard returns
   * `ask`, the plugin parks the tool call on this hold and proceeds on operator
   * approval, throwing on reject/timeout. When absent there is no operator
   * channel, so an `ask` fails closed exactly as before (the host aborts).
   */
  hold?: OperatorAskHold,
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
            throw new Error(`guard unavailable (fail closed): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
          if (guardDecision.decision === "ask" && hold !== undefined) {
            // P6 seats (issue #285): a guard `ask` is a "human decides" verdict,
            // not a deny. Park the call for the operator; approval lets the tool
            // proceed, reject/timeout throws (fail closed). The held ask exists
            // only because policy allowed it, so the operator can only tighten.
            const reply = await hold.park({
              requestId: input.callID,
              policy: guardDecision.policy,
              reason: guardDecision.reason,
              ...(guardDecision.matched === undefined ? {} : { matched: guardDecision.matched }),
            });
            if (reply === "reject") {
              throw new Error(`Workflow denied ${proposal.tool}: guard ask '${guardDecision.policy}' denied (operator reject or hold timeout, failing closed): ${guardDecision.reason}`);
            }
          } else if (guardDecision.decision !== "allow") {
            throw new Error(`Workflow denied ${proposal.tool}: guard policy '${guardDecision.policy}': ${guardDecision.reason}`);
          }
        }
      }
    },
  };
}
