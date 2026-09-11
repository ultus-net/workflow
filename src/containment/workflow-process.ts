import type { ProposedToolAction } from "../adapters/host.js";
import type { WorkflowApplication } from "../application/workflow.js";
import type { ContainedProcessRequest, ContainedProcessResult, ProcessContainment } from "./contracts.js";

export class WorkflowContainedProcess {
  constructor(
    readonly application: WorkflowApplication,
    readonly containment: ProcessContainment,
  ) {}

  async execute(action: ProposedToolAction, request: ContainedProcessRequest): Promise<ContainedProcessResult> {
    if (action.capability !== "process" && !action.requiredCapabilities?.includes("process")) {
      throw new TypeError("contained process action must require the process capability");
    }
    const requiredCapabilities = new Set(action.requiredCapabilities ?? []);
    if (Object.keys(request.environment ?? {}).length > 0) requiredCapabilities.add("credentials");
    if (request.network === "host") requiredCapabilities.add("network");
    const mutating = action.mutating || Boolean(request.writablePaths?.length);
    const decision = this.application.authorize({ ...action, mutating, requiredCapabilities: [...requiredCapabilities] });
    if (decision.kind === "deny") {
      throw new Error(`Workflow denied process execution: ${decision.code}: ${decision.reason}`);
    }
    return await this.containment.execute(request);
  }
}
