import type { TaskId } from "../kernel/contracts.js";

export interface ReadFingerprint {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
  readonly modifiedNs: string;
}

export type HostTransport = "native" | "acp" | "other";
export type EnforcementLevel = "enforced" | "advisory";
export type ToolCapability = "read" | "mutation" | "process" | "spawn" | "credentials" | "network";

export interface HostCapabilities {
  readonly transport: HostTransport;
  readonly authoritativePreMutation: boolean;
  readonly enforcementLevel: EnforcementLevel;
  /** Enable Policy-1-style read-before-write freshness for this host. */
  readonly requireReadFingerprint?: boolean;
}

export interface ProposedToolAction {
  readonly sessionId: string;
  readonly taskId: TaskId;
  readonly tool: string;
  readonly capability?: ToolCapability;
  readonly requiredCapabilities?: readonly ToolCapability[];
  readonly mutating: boolean;
  readonly subjects: readonly string[];
  /** Fingerprints proving the caller read each mutation subject before writing. */
  readonly readFingerprints?: readonly ReadFingerprint[];
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
  readonly requireReadFingerprint?: boolean;
}): HostCapabilities {
  return {
    ...input,
    enforcementLevel: input.authoritativePreMutation ? "enforced" : "advisory",
  };
}
