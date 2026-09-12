import type { ProposedToolAction } from "../adapters/host.js";
import type { WorkflowApplication } from "../application/workflow.js";
import type { WorkflowGuardProvider } from "../integrations/mcp-toolbox-guard.js";
import type { ContainedProcessRequest, ContainedProcessResult, ProcessContainment } from "./contracts.js";

export class WorkflowContainedProcess {
  constructor(
    readonly application: WorkflowApplication,
    readonly containment: ProcessContainment,
    readonly guard?: WorkflowGuardProvider,
  ) {}

  async execute(action: ProposedToolAction, request: ContainedProcessRequest): Promise<ContainedProcessResult> {
    if (this.guard !== undefined) {
      const command = commandLine(request);
      const decision = await this.guard.guardCheck({ action: "shell", command });
      if (decision.decision !== "allow") {
        throw new Error(`guard denied process execution: ${decision.policy}: ${decision.reason}`);
      }
    }
    if (action.capability !== "process" && !action.requiredCapabilities?.includes("process")) {
      throw new TypeError("contained process action must require the process capability");
    }
    const requiredCapabilities = new Set(action.requiredCapabilities ?? []);
    if (Object.keys(request.environment ?? {}).length > 0) requiredCapabilities.add("credentials");
    if (request.network === "host") requiredCapabilities.add("network");
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
    return await this.containment.execute(request);
  }
}

function commandLine(request: ContainedProcessRequest): string {
  if (request.executable === "/bin/bash" && request.args[0] === "-c" && request.args.length === 2) {
    return request.args[1]!;
  }
  return [request.executable, ...request.args].join(" ");
}
