import type { ChangeClaim } from "./state-diff.js";

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

/**
 * W166 P3 (the kernel authority vocabulary): the DECISION axis, disjoint from
 * `EvidenceAuthority` by construction. A decision answers WHO DECIDED an
 * action (the operator); it opens decision gates ONLY and can never open an
 * evidence gate. `EvidenceAuthority` keeps its current members unchanged —
 * `operator`/`claim` are deliberately NOT evidence authorities, so an
 * operator assertion cannot be minted as evidence (the W114 hazard, LESS-0035)
 * and a claim has no class at all (not representable as a gate input).
 */
export type DecisionAuthority = "operator";

/**
 * W166 P3 (the authorized-attach machinery): the inert producing-flow pointer
 * — descriptive metadata naming an EXISTING authorized producer that can
 * satisfy a requirement (the hub test runner, the run-registry reviewer
 * verdict flow, the environment adapter, the MCP normalizer, the operator
 * decision route). It is authored by the authority at requirement-declaration
 * time, mirrored onto the refusal diagnosis, and NEVER accepted from a client:
 * a client-supplied pointer would be a claim by another name (the W114
 * precedent). It produces nothing, satisfies nothing, and mints nothing.
 */
export interface ProducingFlow {
  readonly flow: string;
  readonly ref?: string;
}

export interface EvidenceRequirement {
  readonly authority: EvidenceAuthority;
  readonly subject: string;
  /** W166 P3: authority-recorded producing-flow pointer (inert; never client-supplied). */
  readonly producingFlow?: ProducingFlow;
}

/**
 * W166 P3: an operator-decision requirement. Separating the axes into distinct
 * arrays makes "a decision satisfied an evidence gate" a TYPE error rather
 * than a policy check — the kernel-purity way to fail closed.
 */
export interface DecisionRequirement {
  readonly authority: DecisionAuthority;
  readonly subject: string;
  /** W166 P3: authority-recorded producing-flow pointer (inert; never client-supplied). */
  readonly producingFlow?: ProducingFlow;
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

/**
 * W159/W166: the actor-initiated blocked record — the canonical home for a
 * task blocked for a REASON (awaiting a decision, an external dependency, a
 * named unblocker). Plain caller data: the kernel reads no clock (enteredAt
 * is caller-supplied), performs no IO, and invents no actor vocabulary — the
 * owner reuses the W157 attribution vocabulary, and the admission/exit gates
 * verify the caller names ITSELF (owner must equal the transition's calling
 * actor; fail closed otherwise — an agent cannot volunteer another actor).
 */
export interface BlockedRecord {
  /** The actor whose action unblocks; the caller may only name ITSELF (the W157 vocabulary join). */
  readonly owner: TransitionAttribution["actor"];
  /** The named action whose consumption exits the block one-shot on BLOCKED → READY. */
  readonly action: string;
  readonly reason?: string;
  /** Caller-supplied entry time; the kernel reads no clock (purity). */
  readonly enteredAt: string;
}

export interface WorkflowTask {
  readonly id: TaskId;
  readonly title: string;
  readonly state: TaskState;
  readonly dependencies: readonly TaskId[];
  readonly requiredEvidence: readonly EvidenceRequirement[];
  /**
   * W166 P3: operator-decision requirements, optional and additive. Absence
   * means no decision gate (today's behavior, byte-identical). Only the
   * `DecisionAuthority` axis may appear here; evidence can never satisfy one.
   */
  readonly requiredDecisions?: readonly DecisionRequirement[];
  /**
   * W159/W166: the actor-initiated blocked record, present while the task
   * carries a named block. A record on a non-BLOCKED task is stale context
   * (the dependency graph resolved on its own and the block exited
   * automatically); the explicit BLOCKED → READY exit consumes the named
   * action one-shot and removes the record.
   */
  readonly blocked?: BlockedRecord;
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
  /** W166 P3: operator-decision requirements for the step (optional, additive). */
  readonly requiredDecisions?: readonly DecisionRequirement[];
  /**
   * W072 I-9 (§3.9): the state-diff postcondition. A step declaring it must
   * re-observe the claimed change (the caller supplies the observation — the
   * kernel performs no IO and reads no clock) before it can be COMPLETED.
   * Absence means no state-diff gate (today's behavior, byte-identical).
   */
  readonly requiredPostcondition?: ChangeClaim;
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
      /** W110 (refusal legibility): the unsatisfied requirements with a
       * per-requirement diagnosis. Present on EVIDENCE_REQUIRED and
       * DECISION_REQUIRED rejections; absent elsewhere (never fabricated for
       * gates that do not produce it).
       *
       * W166 P3: entries are extended ADDITIVELY. An evidence entry keeps its
       * original `{ authority, subject, why }` shape byte-for-byte (W110/W114
       * pins preserved); a decision entry carries `source: "decision"` so a
       * reader can tell which gate refused (absence of `source` means the
       * evidence axis), plus the authority-recorded inert `producingFlow`
       * pointer when the requirement declared one. No existing field changes
       * meaning. */
      readonly missing?: readonly MissingRequirement[];
    };

/** W166 P3: one unsatisfied gate requirement in a refusal diagnosis. */
export interface MissingRequirement {
  /** Absent means the evidence axis; `"decision"` marks a decision-gate entry. */
  readonly source?: "evidence" | "decision";
  readonly authority: EvidenceAuthority | DecisionAuthority;
  readonly subject: string;
  readonly why: string;
  /** W166 P3: the authority-recorded producing-flow pointer, when declared. */
  readonly producingFlow?: ProducingFlow;
}

/**
 * W166 P3: an operator decision offered to a transition. It is the ONLY shape
 * that can satisfy a `DecisionRequirement` and can never satisfy an
 * `EvidenceRequirement`. Transient: it rides the transition call (the
 * application authority is the only site that admits one) and is never
 * stored — the reference implementation admits a decision per transition.
 * Fail-closed: the authority must be `operator`, the actor must equal the
 * calling transition's actor (the W157 caller-names-itself join), the subject
 * plus `mutationEpoch` must match a live requirement (a superseded epoch is
 * stale), and a client-supplied `producingFlow` is refused outright.
 */
export interface OperatorDecisionRecord {
  readonly authority: DecisionAuthority;
  readonly subject: string;
  /** The actor the decision names; must equal the calling transition's actor. */
  readonly actor: TransitionAttribution["actor"];
  /** Caller-supplied decision time; the kernel reads no clock (purity). */
  readonly decidedAt: string;
  /** The mutation epoch the decision was made at; a superseded epoch is stale. */
  readonly mutationEpoch: number;
}

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
