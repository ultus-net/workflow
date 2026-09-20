type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type TaskId = Brand<string, "TaskId">;
export type StepId = Brand<string, "StepId">;
export type EvidenceId = Brand<string, "EvidenceId">;
export type ObservationId = Brand<string, "ObservationId">;
export type MutationId = Brand<string, "MutationId">;

export type TaskState =
  | "BLOCKED"
  | "READY"
  | "IN_PROGRESS"
  | "VERIFYING"
  | "VERIFIED"
  | "FAILED";

export type EvidenceAuthority = "environment" | "host" | "mcp" | "reviewer";
export type EvidenceResult = "passed" | "failed";
export type EvidenceFreshness = "fresh" | "stale";

export interface EvidenceRequirement {
  readonly authority: EvidenceAuthority;
  readonly subject: string;
}

export interface Evidence {
  readonly id: EvidenceId;
  readonly observationId: ObservationId;
  readonly authority: EvidenceAuthority;
  readonly subject: string;
  readonly result: EvidenceResult;
  readonly freshness: EvidenceFreshness;
  readonly mutationEpoch: number;
  readonly observedAt: string;
}

export interface WorkflowTask {
  readonly id: TaskId;
  readonly title: string;
  readonly state: TaskState;
  readonly dependencies: readonly TaskId[];
  readonly requiredEvidence: readonly EvidenceRequirement[];
}

/**
 * A canonical child step of a task — the third level of the decomposition
 * ledger (roadmap → tasks → steps). Steps are kernel-owned: the model may
 * propose them (or the host bridge may mirror its native todo), but only the
 * kernel validates legal step transitions and evidence-bound completion.
 */
export type StepState = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

export interface WorkflowStep {
  readonly id: StepId;
  readonly taskId: TaskId;
  readonly content: string;
  readonly state: StepState;
  /** Fresh passing evidence is required before the step can be COMPLETED. */
  readonly requiredEvidence: readonly EvidenceRequirement[];
}

export interface Mutation {
  readonly id: MutationId;
  readonly taskId: TaskId;
  readonly subjects: readonly string[];
}

export type PolicyDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly code: string; readonly reason: string };

export interface TransitionRecord {
  readonly taskId: TaskId;
  readonly from: TaskState;
  readonly to: TaskState;
}

export type TransitionResult =
  | { readonly kind: "accepted"; readonly transition: TransitionRecord }
  | {
      readonly kind: "rejected";
      readonly code: string;
      readonly reason: string;
      readonly taskId: TaskId;
      readonly from: TaskState;
      readonly requested: TaskState;
    };

function nonEmptyId<Name extends string>(value: string, name: Name): Brand<string, Name> {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }

  return value as Brand<string, Name>;
}

export const taskId = (value: string): TaskId => nonEmptyId(value, "TaskId");
export const stepId = (value: string): StepId => nonEmptyId(value, "StepId");
export const evidenceId = (value: string): EvidenceId => nonEmptyId(value, "EvidenceId");
export const observationId = (value: string): ObservationId => nonEmptyId(value, "ObservationId");
export const mutationId = (value: string): MutationId => nonEmptyId(value, "MutationId");
