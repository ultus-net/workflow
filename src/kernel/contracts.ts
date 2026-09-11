type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type TaskId = Brand<string, "TaskId">;
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
export const evidenceId = (value: string): EvidenceId => nonEmptyId(value, "EvidenceId");
export const observationId = (value: string): ObservationId => nonEmptyId(value, "ObservationId");
export const mutationId = (value: string): MutationId => nonEmptyId(value, "MutationId");
