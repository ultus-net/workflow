import type { TaskId } from "../kernel/contracts.js";

export type HostTransport = "native" | "acp" | "other";
export type EnforcementLevel = "enforced" | "advisory";
export type ToolCapability = "read" | "mutation" | "process" | "credentials";

export interface HostCapabilities {
  readonly transport: HostTransport;
  readonly authoritativePreMutation: boolean;
  readonly enforcementLevel: EnforcementLevel;
}

export interface ProposedToolAction {
  readonly sessionId: string;
  readonly taskId: TaskId;
  readonly tool: string;
  readonly capability?: ToolCapability;
  readonly requiredCapabilities?: readonly ToolCapability[];
  readonly mutating: boolean;
  readonly subjects: readonly string[];
  readonly input: unknown;
}

export interface TranslatingHostAdapter<RawEvent = unknown, Control = unknown> {
  readonly capabilities: HostCapabilities;
  proposalFromBeforeTool(input: RawEvent): ProposedToolAction;
  beforeToolControl(decision: import("../kernel/contracts.js").PolicyDecision): Control | undefined;
}

export function hostCapabilities(input: {
  readonly transport: HostTransport;
  readonly authoritativePreMutation: boolean;
}): HostCapabilities {
  return {
    ...input,
    enforcementLevel: input.authoritativePreMutation ? "enforced" : "advisory",
  };
}
