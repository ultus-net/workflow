import type { ProposedToolAction } from "../adapters/host.js";
import type { WorkflowApplication } from "../application/workflow.js";
import type { WorkflowGuardProvider } from "../integrations/mcp-toolbox-guard.js";
import type { OperatorAskHold } from "../integrations/operator-ask-hold.js";
import type { ContainedProcessRequest, ContainedProcessResult, ProcessContainment } from "./contracts.js";

export class WorkflowContainedProcess {
  #askSeq = 0;

  constructor(
    readonly application: WorkflowApplication,
    readonly containment: ProcessContainment,
    readonly guard?: WorkflowGuardProvider,
    /**
     * P6 containment seat (issue #285): the operator ask hold. When the guard
     * returns `ask`, the seat parks the process request on this hold and then
     * proceeds to containment on operator approval, throwing on reject/timeout.
     * When absent there is no operator channel to answer, so an `ask` fails
     * closed exactly as before (the byte-identical guard-deny throw), the
     * brief's Q3 posture.
     */
    readonly hold?: OperatorAskHold,
  ) {}

  async execute(action: ProposedToolAction, request: ContainedProcessRequest): Promise<ContainedProcessResult> {
    if (action.capability !== "process" && !action.requiredCapabilities?.includes("process")) {
      throw new TypeError("contained process action must require the process capability");
    }
    const requiredCapabilities = new Set(action.requiredCapabilities ?? []);
    if (Object.keys(request.environment ?? {}).length > 0) requiredCapabilities.add("credentials");
    // Any network posture that grants reach beyond the private namespace
    // (host, proxied, or the mediated stub) requires the withheld `network`
    // capability; `isolated` does not.
    if (request.network !== undefined && request.network !== "isolated") requiredCapabilities.add("network");
    const mutating = action.mutating || Boolean(request.writablePaths?.length);
    const filesystemSubjects = [
      ...(request.cwd === undefined ? [] : [request.cwd]),
      ...(request.readablePaths ?? []),
      ...(request.writablePaths ?? []),
    ];
    const decision = this.application.authorize({
      ...action,
      mutating,
      requiredCapabilities: [...requiredCapabilities],
      subjects: [...action.subjects, ...filesystemSubjects],
    });
    if (decision.kind === "deny") {
      throw new Error(`Workflow denied process execution: ${decision.code}: ${decision.reason}`);
    }
    // P6 ordering (brief §2.4): the guard runs AFTER kernel authorization, the
    // one ordering story shared with the primary seat and the other three seats
    // (a held ask must park only after the kernel has ruled). The guard's facts
    // stay unenriched here (no `workspaceRoot`; the sandbox is the boundary),
    // so the hold never depends on workspace facts.
    if (this.guard !== undefined) {
      const command = commandLine(request);
      const guardDecision = await this.guard.guardCheck({ action: "shell", command });
      if (guardDecision.decision === "ask" && this.hold !== undefined) {
        // A guard `ask` is a "human decides" verdict, not a deny: park the
        // request for the operator; approval falls through to containment and
        // reject/timeout throws (fail closed). The held ask exists only because
        // policy allowed it, so the operator can only tighten.
        const requestId = `contained-process-ask-${(this.#askSeq += 1)}`;
        const reply = await this.hold.park({
          requestId,
          policy: guardDecision.policy,
          reason: guardDecision.reason,
          ...(guardDecision.matched === undefined ? {} : { matched: guardDecision.matched }),
        });
        if (reply === "reject") {
          throw new Error(`guard ask '${guardDecision.policy}' denied (operator reject or hold timeout, failing closed): ${guardDecision.reason}`);
        }
      } else if (guardDecision.decision !== "allow") {
        throw new Error(`guard denied process execution: ${guardDecision.policy}: ${guardDecision.reason}`);
      }
    }
    return await this.containment.execute(request);
  }
}

function commandLine(request: ContainedProcessRequest): string {
  if (request.executable === "/bin/bash" && request.args[0] === "-c" && request.args.length === 2) {
    return request.args[1]!;
  }
  return [request.executable, ...request.args].join(" ");
}
