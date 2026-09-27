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
  /**
   * W158: an optional bounded-content REFERENCE — the kernel record carries
   * only the reference (kind + ref + byte size); the bytes live in an
   * integration-layer store and ride no kernel purity line. A record without
   * content renders as its plain self (the honest absence the W154 strip
   * already handles); an over-cap capture is never recorded as a fabricated
   * empty reference.
   */
  readonly content?: EvidenceContentRef;
}

export interface EvidenceContentRef {
  readonly kind: "test-output" | "screenshot";
  /** The integration-layer store's key; the bytes never enter the kernel. */
  readonly ref: string;
  readonly byteSize: number;
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
  /**
   * W157: caller-supplied attribution. The kernel never fabricates it — a
   * site that does not know its actor leaves the block absent, and absence
   * is legal (the timeline renders the explicit "unattributed" state). The
   * actor is a closed set (the same families the W150 posture projection
   * named: operator, agent, system, scheduler); the authority string says
   * WHERE the attribution came from; observedAt is caller-supplied so the
   * kernel reads no clock (purity).
   */
  readonly attribution?: TransitionAttribution;
}

export interface TransitionAttribution {
  readonly actor: "operator" | "agent" | "system" | "scheduler";
  /** The authority basis the transition stands on — the site names its own source. */
  readonly authority: string;
  /** Caller-supplied observation time; the kernel reads no clock. */
  readonly observedAt: string;
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
      /** W110 (refusal legibility): the unsatisfied evidence requirements with
       * a per-requirement diagnosis. Present on EVIDENCE_REQUIRED rejections;
       * absent elsewhere (never fabricated for gates that do not produce
       * it). */
      readonly missing?: readonly {
        readonly authority: EvidenceAuthority;
        readonly subject: string;
        readonly why: string;
      }[];
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
