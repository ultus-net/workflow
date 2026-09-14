import type { TaskId } from "../kernel/contracts.js";
import type { ToolCapability } from "./host.js";

export interface AcpPermissionOption {
  readonly optionId: string;
  readonly name?: string;
  readonly kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface AcpPermissionRequestParams {
  readonly sessionId: string;
  readonly toolCall: {
    readonly toolCallId: string;
    readonly title?: string;
    readonly kind?: string;
    readonly rawInput?: unknown;
    readonly locations?: readonly { readonly path?: string }[];
  };
  readonly options: readonly AcpPermissionOption[];
}

export interface AcpPermissionCorrelation {
  readonly sessionId: string;
  readonly agentSessionId: string;
  readonly taskId: TaskId;
  readonly toolName: string;
  readonly capability?: ToolCapability;
}

export type AcpPermissionDenial =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "fail_closed"; readonly reason: string };

export function correlateAcpPermissionRequest(
  request: AcpPermissionRequestParams,
  correlation: AcpPermissionCorrelation,
) {
  if (!request.sessionId || !request.toolCall.toolCallId) throw new TypeError("invalid ACP permission request");
  if (request.sessionId !== correlation.agentSessionId) {
    throw new TypeError("ACP permission session mismatch");
  }
  const locations = request.toolCall.locations ?? [];
  if (locations.some((location) => typeof location.path !== "string" || location.path.length === 0)) {
    throw new TypeError("invalid ACP tool location");
  }
  validateOptions(request.options);

  return {
    sessionId: correlation.sessionId,
    taskId: correlation.taskId,
    toolCall: {
      name: correlation.toolName,
      kind: request.toolCall.kind,
      capability: correlation.capability,
      rawInput: request.toolCall.rawInput,
      locations,
    },
  };
}

export function acpPermissionDenial(request: AcpPermissionRequestParams): AcpPermissionDenial {
  validateOptions(request.options);
  const rejecting = request.options.find(
    (option) => (option.kind === "reject_once" || option.kind === "reject_always") && option.optionId.length > 0,
  );
  return rejecting
    ? { outcome: "selected", optionId: rejecting.optionId }
    : { outcome: "fail_closed", reason: "ACP permission request provided no rejecting option" };
}

function validateOptions(options: readonly AcpPermissionOption[]): void {
  if (options.some((option) => typeof option.optionId !== "string")) {
    throw new TypeError("invalid ACP permission option");
  }
}
