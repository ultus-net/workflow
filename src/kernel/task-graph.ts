import type {
  BlockedRecord,
  DecisionRequirement,
  Evidence,
  EvidenceRequirement,
  MissingRequirement,
  OperatorDecisionRecord,
  StepId,
  StepState,
  TaskId,
  TaskState,
  TransitionAttribution,
  TransitionRecord,
  TransitionResult,
  WorkflowStep,
  WorkflowTask,
} from "./contracts.js";
import { stepId } from "./contracts.js";
import { evaluateStateDiff, type ChangeObservation } from "./state-diff.js";

const LEGAL_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  // W159/W166: the explicit exit — legal only for a live blocked record whose
  // named action the owner consumes (the gate lives in transition()).
  BLOCKED: ["READY"],
  READY: ["IN_PROGRESS", "BLOCKED"],
  IN_PROGRESS: ["VERIFYING", "FAILED", "BLOCKED"],
  VERIFYING: ["VERIFIED", "FAILED"],
  VERIFIED: [],
  FAILED: ["READY", "BLOCKED"],
};

/**
 * W159/W166: the W157 attribution vocabulary — the join the blocked record's
 * owner must match. No new actor vocabulary is invented inside the kernel;
 * a caller whose actor is outside this closed set can never name an owner.
 */
export const ACTOR_VOCABULARY = ["operator", "agent", "system", "scheduler"] as const satisfies readonly TransitionAttribution["actor"][];

/**
 * W166 P3: compile-time drift pin, both directions — the vocabulary cannot
 * drift from the transition-attribution union. The `satisfies` on the array
 * above fails typecheck if the array names an actor the W157 union dropped;
 * this fails typecheck ("'true' is not assignable to type 'never'") if
 * contracts.ts grows an actor variant without adding it to the array.
 */
export type ActorVocabularyCoversUnion = Exclude<
  TransitionAttribution["actor"],
  (typeof ACTOR_VOCABULARY)[number]
> extends never
  ? true
  : never;
export const ACTOR_VOCABULARY_COVERS_UNION: ActorVocabularyCoversUnion = true;

/** Legal child-step transitions. COMPLETED is terminal (reopen is a new step). */
const LEGAL_STEP_TRANSITIONS: Readonly<Record<StepState, readonly StepState[]>> = {
  PENDING: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export type StepTransitionResult =
  | { readonly kind: "accepted"; readonly step: WorkflowStep }
  | { readonly kind: "rejected"; readonly code: string; readonly reason: string };

/**
 * Run-completion predicate (llm-enhancements.md §Detect Skipping and Lost
 * Tasks): a run is complete only when every task is VERIFIED and none is
 * blocked/ready/in-progress/verifying/failed. Empty graphs are not complete.
 */
export function isRunComplete(tasks: readonly WorkflowTask[]): boolean {
  return tasks.length > 0 && tasks.every((task) => task.state === "VERIFIED");
}

/** A step is terminal when it can never advance again (COMPLETED or CANCELLED). */
export function isStepTerminal(state: StepState): boolean {
  return state === "COMPLETED" || state === "CANCELLED";
}

export class TaskGraph {
  readonly #tasks = new Map<TaskId, WorkflowTask>();
  readonly #steps = new Map<StepId, WorkflowStep>();
  readonly #evidence: Evidence[] = [];
  #mutationEpoch = 0;
  /** The readiness each task had at its previous recompute pass — the
   * W159/W166 resolution signal: a live blocked record holds the block
   * against a dependency-ready STEADY state, but the graph resolving on its
   * own (readiness flipping false → true while the record is live) is the
   * independent automatic exit. Kernel-private and derived purely from task
   * states; it survives restore because a resolved record-block cannot be
   * persisted (the resolution exits in the same recompute pass that observes
   * it), so every persisted BLOCKED-with-record task restores as held. */
  readonly #lastReady = new Map<TaskId, boolean>();

  constructor(tasks: readonly WorkflowTask[]) {
    for (const task of tasks) {
      if (this.#tasks.has(task.id)) {
        throw new TypeError(`duplicate task: ${task.id}`);
      }
      if (task.blocked !== undefined) {
        this.#assertBlockedShape(task.blocked);
      }
      this.#tasks.set(task.id, {
        ...task,
        dependencies: [...task.dependencies],
        ...(task.blocked === undefined ? {} : { blocked: { ...task.blocked } }),
      });
    }

    this.#validateDependencies();
    this.#assertAcyclic();
    for (const id of this.#tasks.keys()) this.#seedReadiness(id);
    this.#recomputeReadiness();
  }

  static restore(input: {
    readonly tasks: readonly WorkflowTask[];
    readonly evidence: readonly Evidence[];
    readonly mutationEpoch: number;
    readonly steps?: readonly WorkflowStep[];
  }): TaskGraph {
    if (!Number.isSafeInteger(input.mutationEpoch) || input.mutationEpoch < 0) {
      throw new TypeError("invalid persisted mutation epoch");
    }
    const persistedStates = new Map(input.tasks.map((task) => [task.id, task.state]));
    for (const task of input.tasks) {
      if (task.state !== "READY" && task.state !== "BLOCKED") continue;
      const shouldBeReady = task.dependencies.every((dependency) => persistedStates.get(dependency) === "VERIFIED");
      // W159/W166: BLOCKED with verified dependencies is a legal persisted
      // state when a live blocked record holds the block; the recordless
      // invariant is unchanged.
      if ((task.state === "READY") !== shouldBeReady && !(task.state === "BLOCKED" && task.blocked !== undefined)) {
        throw new TypeError(`persisted task ${task.id} has inconsistent dependency readiness`);
      }
    }
    const graph = new TaskGraph(input.tasks.map((task) => ({
      ...task,
      state: task.state === "IN_PROGRESS" ? "FAILED" : task.state,
    })));
    graph.#mutationEpoch = input.mutationEpoch;
    for (const evidence of input.evidence) {
      if (evidence.mutationEpoch > input.mutationEpoch) throw new TypeError("persisted evidence is from a future mutation epoch");
      graph.#evidence.push({ ...evidence });
    }
    for (const step of input.steps ?? []) {
      if (!graph.#tasks.has(step.taskId)) throw new TypeError(`persisted step ${step.id} references unknown task ${step.taskId}`);
      if (step.requiredEvidence.length === 0) throw new TypeError(`persisted step ${step.id} lacks a done-condition`);
      if (graph.#steps.has(step.id)) throw new TypeError(`duplicate step: ${step.id}`);
      if (step.state === "IN_PROGRESS" && graph.activeStepId(step.taskId) !== undefined) {
        throw new TypeError(`persisted task ${step.taskId} has multiple active steps`);
      }
      graph.#steps.set(step.id, { ...step, requiredEvidence: [...step.requiredEvidence] });
    }
    for (const step of graph.#steps.values()) {
      if (step.state === "COMPLETED" && !graph.#stepHasEvidence(step)) {
        throw new TypeError(`persisted completed step ${step.id} lacks fresh passing evidence`);
      }
      // W072 I-9: a persisted COMPLETED step that declares a postcondition is
      // accepted on reload without re-deriving the state diff — the observation
      // was checked at completion time and is not persisted. Re-deriving here
      // would require IO the kernel is forbidden; the evidence check above
      // remains the restore-time gate.
    }
    for (const task of graph.#tasks.values()) {
      if (task.state === "VERIFIED" && !task.requiredEvidence.every((requirement) => graph.#hasEvidence(requirement))) {
        throw new TypeError(`persisted verified task ${task.id} does not have fresh passing evidence for every requirement`);
      }
      const steps = graph.#stepsFor(task.id);
      if (task.state === "VERIFIED" && steps.length > 0 && !graph.#stepsDone(task.id)) {
        throw new TypeError(`persisted verified task ${task.id} has open steps`);
      }
    }
    return graph;
  }

  persistedState(): {
    readonly tasks: readonly WorkflowTask[];
    readonly evidence: readonly Evidence[];
    readonly mutationEpoch: number;
    readonly steps: readonly WorkflowStep[];
  } {
    return {
      tasks: this.tasks(),
      evidence: this.evidence(),
      mutationEpoch: this.#mutationEpoch,
      steps: this.steps(),
    };
  }

  get(id: TaskId): WorkflowTask {
    const task = this.#tasks.get(id);
    if (task === undefined) {
      throw new TypeError(`unknown task: ${id}`);
    }
    return task;
  }

  tasks(): readonly WorkflowTask[] {
    return [...this.#tasks.values()];
  }

  /** All steps across every task (stable insertion order). */
  steps(): readonly WorkflowStep[] {
    return [...this.#steps.values()];
  }

  /** A task's child steps, in definition order. */
  stepsFor(taskId: TaskId): readonly WorkflowStep[] {
    return this.steps().filter((step) => step.taskId === taskId);
  }

  step(id: StepId): WorkflowStep {
    const step = this.#steps.get(id);
    if (step === undefined) throw new TypeError(`unknown step: ${id}`);
    return step;
  }

  /**
   * Defines/replaces a task's step ledger. Enforces I-2 (no silent deletion):
   * an existing step that is still active (PENDING/IN_PROGRESS) must be carried
   * forward with the same id; it can only leave the ledger by being explicitly
   * completed or cancelled first. Allowed only while the task is READY or
   * IN_PROGRESS.
   */
  defineSteps(
    taskId: TaskId,
    proposed: readonly { readonly id?: string; readonly content: string; readonly requiredEvidence?: readonly EvidenceRequirement[]; readonly requiredPostcondition?: WorkflowStep["requiredPostcondition"] }[],
  ): readonly WorkflowStep[] {
    const task = this.get(taskId);
    if (task.state !== "READY" && task.state !== "IN_PROGRESS") {
      throw new TypeError(`cannot define steps for task in ${task.state}`);
    }
    const existing = this.#stepsFor(taskId);
    if (proposed.length === 0 && existing.length > 0) {
      throw new TypeError(`cannot clear task ${taskId} step ledger`);
    }
    const existingById = new Map(existing.map((step) => [step.id, step]));
    const seen = new Set<StepId>();
    const next: WorkflowStep[] = [];
    let counter = existing.length;
    for (const entry of proposed) {
      const content = entry.content.trim();
      if (content.length === 0) throw new TypeError("step content must be non-empty");
      let id: StepId;
      if (entry.id === undefined) {
        do {
          counter += 1;
          id = stepId(`${taskId}-step-${counter}`);
        } while (this.#steps.has(id) || seen.has(id));
      } else {
        id = stepId(entry.id);
        const ownedBy = this.#steps.get(id);
        if (ownedBy !== undefined && ownedBy.taskId !== taskId) {
          throw new TypeError(`step ${id} belongs to task ${ownedBy.taskId}`);
        }
      }
      if (seen.has(id)) throw new TypeError(`duplicate step: ${id}`);
      seen.add(id);
      const prior = existingById.get(id);
      const requiredEvidence = [...(entry.requiredEvidence ?? prior?.requiredEvidence ?? [])];
      if (requiredEvidence.length === 0) throw new TypeError(`step '${content}' must declare a done-condition/evidence requirement`);
      // W072 I-9: carry the postcondition through when present; absent stays
      // absent so a step without one behaves exactly as before.
      const requiredPostcondition = entry.requiredPostcondition ?? prior?.requiredPostcondition;
      next.push({
        id,
        taskId,
        content,
        state: prior?.state ?? "PENDING",
        requiredEvidence,
        ...(requiredPostcondition === undefined ? {} : { requiredPostcondition }),
      });
    }
    // I-2: an active step cannot silently disappear from the ledger.
    for (const step of existing) {
      if (!seen.has(step.id) && !isStepTerminal(step.state)) {
        throw new TypeError(`active step '${step.content}' was removed without being completed or cancelled`);
      }
    }
    for (const step of existing) this.#steps.delete(step.id);
    for (const step of next) this.#steps.set(step.id, step);
    return this.stepsFor(taskId);
  }

  startStep(id: StepId): StepTransitionResult {
    const step = this.step(id);
    const active = this.activeStepId(step.taskId);
    if (active !== undefined && active !== id) {
      return { kind: "rejected", code: "STEP_ALREADY_IN_PROGRESS", reason: `task ${step.taskId} already has active step ${active}` };
    }
    return this.#moveStep(id, "IN_PROGRESS", () => this.get(step.taskId).state === "IN_PROGRESS");
  }

  /** I-3: completion requires the step to have started and to hold fresh
   * passing evidence for every requirement it declares. W072 I-9: a step that
   * declares a `requiredPostcondition` must additionally have its claimed
   * change re-observed (the caller supplies the observation; the kernel reads
   * no clock and performs no IO). */
  completeStep(id: StepId, observation?: ChangeObservation): StepTransitionResult {
    const step = this.step(id);
    if (step.state !== "IN_PROGRESS") {
      return { kind: "rejected", code: "ILLEGAL_STEP_TRANSITION", reason: `cannot complete step ${id} from ${step.state}` };
    }
    if (!this.#stepHasEvidence(step)) {
      return { kind: "rejected", code: "STEP_EVIDENCE_REQUIRED", reason: `step ${id} lacks fresh passing evidence for every requirement` };
    }
    if (step.requiredPostcondition !== undefined) {
      const verdict = evaluateStateDiff(step.requiredPostcondition, observation ?? { observed: [] });
      if (verdict.kind !== "confirmed") {
        // The evaluator's verdict is surfaced verbatim; the kernel does not
        // fabricate a pass from an absent/empty/mismatched observation.
        return { kind: "rejected", code: "STEP_POSTCONDITION_UNMET", reason: verdict.reason };
      }
    }
    this.#steps.set(id, { ...step, state: "COMPLETED" });
    return { kind: "accepted", step: this.step(id) };
  }

  cancelStep(id: StepId): StepTransitionResult {
    return this.#moveStep(id, "CANCELLED", () => true);
  }

  /** True when every step of the task is terminal and at least one completed. */
  #stepsDone(taskId: TaskId): boolean {
    const steps = this.#stepsFor(taskId);
    return steps.length > 0 && steps.every((step) => isStepTerminal(step.state)) && steps.some((step) => step.state === "COMPLETED");
  }

  /** The step currently in progress for a task, if any (I-1 support). */
  activeStepId(taskId: TaskId): StepId | undefined {
    return this.#stepsFor(taskId).find((step) => step.state === "IN_PROGRESS")?.id;
  }

  #stepsFor(taskId: TaskId): readonly WorkflowStep[] {
    return this.stepsFor(taskId);
  }

  #moveStep(id: StepId, requested: StepState, guard: () => boolean): StepTransitionResult {
    const step = this.step(id);
    if (!LEGAL_STEP_TRANSITIONS[step.state].includes(requested)) {
      return { kind: "rejected", code: "ILLEGAL_STEP_TRANSITION", reason: `cannot transition step ${id} from ${step.state} to ${requested}` };
    }
    if (!guard()) {
      return { kind: "rejected", code: "STEP_TASK_NOT_IN_PROGRESS", reason: `step ${id}'s task is not IN_PROGRESS` };
    }
    this.#steps.set(id, { ...step, state: requested });
    return { kind: "accepted", step: this.step(id) };
  }

  #stepHasEvidence(step: WorkflowStep): boolean {
    return step.requiredEvidence.every((requirement) => this.#hasEvidence(requirement));
  }

  get mutationEpoch(): number {
    return this.#mutationEpoch;
  }

  evidenceFor(subject: string): readonly Evidence[] {
    return this.#evidence.filter((evidence) => evidence.subject === subject);
  }

  evidence(): readonly Evidence[] {
    return [...this.#evidence];
  }

  addTask(task: WorkflowTask): void {
    if (this.#tasks.has(task.id)) throw new TypeError(`duplicate task: ${task.id}`);
    if (task.blocked !== undefined) {
      this.#assertBlockedShape(task.blocked);
    }
    this.#tasks.set(task.id, {
      ...task,
      dependencies: [...task.dependencies],
      ...(task.blocked === undefined ? {} : { blocked: { ...task.blocked } }),
    });
    try {
      this.#validateDependencies();
      this.#assertAcyclic();
    } catch (error) {
      this.#tasks.delete(task.id);
      throw error;
    }
    this.#seedReadiness(task.id);
    this.#recomputeReadiness();
  }

  recordEvidence(evidence: Evidence): void {
    if (evidence.mutationEpoch !== this.#mutationEpoch) {
      throw new TypeError("evidence does not observe the current mutation epoch");
    }
    this.#evidence.push(evidence);
  }

  /** W110 (refusal legibility): why a requirement is unsatisfied — the
   * discriminating diagnosis across the kernel's evidence dimensions
   * (observed at all → authority match → result → freshness). */
  #requirementWhy(requirement: EvidenceRequirement): string {
    const records = this.#evidence.filter((record) => record.subject === requirement.subject);
    if (records.length === 0) return "no evidence observed";
    const matching = records.filter((record) => record.authority === requirement.authority);
    if (matching.length === 0) return `no evidence from authority '${requirement.authority}'`;
    const passing = matching.filter((record) => record.result === "passed");
    if (passing.length === 0) return "the observed evidence is not passing";
    return "the passing evidence is stale (a mutation landed after it)";
  }

  /** W166 P3: fail-closed validation of an offered operator decision — the
   * W112 grant-validation discipline (unknown/stale/malformed/actor-mismatch
   * refuse without consuming state). Returns a rejection or undefined. */
  #validateDecision(
    decision: OperatorDecisionRecord,
    attribution: TransitionAttribution | undefined,
  ): { readonly code: string; readonly reason: string } | undefined {
    if ("producingFlow" in decision) {
      return {
        code: "DECISION_MALFORMED",
        reason: "the producing-flow pointer is authority-recorded and never accepted from a client",
      };
    }
    if (
      decision.authority !== "operator" ||
      typeof decision.subject !== "string" || decision.subject.trim().length === 0 ||
      typeof decision.decidedAt !== "string" || decision.decidedAt.trim().length === 0 ||
      !Number.isSafeInteger(decision.mutationEpoch) || decision.mutationEpoch < 0 ||
      !ACTOR_VOCABULARY.includes(decision.actor)
    ) {
      return {
        code: "DECISION_MALFORMED",
        reason: "an operator decision needs authority 'operator', a non-empty subject and decidedAt, a non-negative integer mutationEpoch, and an actor from the W157 vocabulary",
      };
    }
    if (decision.mutationEpoch !== this.#mutationEpoch) {
      return {
        code: "DECISION_STALE",
        reason: `the operator decision was made at mutation epoch ${decision.mutationEpoch}; a mutation has landed since (current epoch ${this.#mutationEpoch})`,
      };
    }
    if (attribution === undefined || decision.actor !== attribution.actor) {
      return {
        code: "DECISION_ACTOR_MISMATCH",
        reason: `an operator decision must name the calling surface as its actor (the W157 caller-names-itself join); the caller is ${attribution === undefined ? "unattributed" : `'${attribution.actor}'`}, the decision names '${decision.actor}'`,
      };
    }
    return undefined;
  }

  /** W166 P3: a decision requirement is satisfied only by an operator decision
   * naming the same authority and subject. Evidence can never satisfy one. */
  #hasDecision(requirement: DecisionRequirement, decisions: readonly OperatorDecisionRecord[]): boolean {
    return decisions.some((decision) => decision.authority === requirement.authority && decision.subject === requirement.subject);
  }

  #decisionWhy(requirement: DecisionRequirement, decisions: readonly OperatorDecisionRecord[]): string {
    if (decisions.length === 0) return "no operator decision observed";
    return `no operator decision names '${requirement.subject}'`;
  }

  recordMutation(subjects: readonly string[], observedAt?: string): readonly TransitionRecord[] {
    this.#mutationEpoch += 1;
    const transitions: TransitionRecord[] = [];
    const affected = new Set(subjects);
    for (let index = 0; index < this.#evidence.length; index += 1) {
      const evidence = this.#evidence[index];
      if (evidence !== undefined && affected.has(evidence.subject) && evidence.freshness === "fresh") {
        this.#evidence[index] = { ...evidence, freshness: "stale" };
      }
    }

    for (const [id, task] of this.#tasks) {
      if (task.state === "VERIFIED" && task.requiredEvidence.some((requirement) => affected.has(requirement.subject))) {
        this.#tasks.set(id, { ...task, state: "VERIFYING" });
        // W157: the invalidation IS the system's doing (deterministic kernel
        // knowledge), so the actor/authority are stamped here; the time is
        // the caller's (the kernel reads no clock) — without one the row
        // stays unattributed, which stays legal.
        transitions.push({
          taskId: id,
          from: "VERIFIED",
          to: "VERIFYING",
          ...(observedAt === undefined ? {} : { attribution: { actor: "system" as const, authority: "evidence invalidation (freshness)", observedAt } }),
        });
      }
    }
    this.#recomputeReadiness();
    return transitions;
  }

  transition(id: TaskId, requested: TaskState, attribution?: TransitionAttribution, blocked?: BlockedRecord, decisions?: readonly OperatorDecisionRecord[]): TransitionResult {
    const task = this.get(id);
    if (!LEGAL_TRANSITIONS[task.state].includes(requested)) {
      return {
        kind: "rejected",
        code: "ILLEGAL_TRANSITION",
        reason: `cannot transition ${task.id} from ${task.state} to ${requested}`,
        taskId: task.id,
        from: task.state,
        requested,
      };
    }

    // W159/W166: the actor-initiated blocked record rides ONLY the
    // IN_PROGRESS|READY → BLOCKED admission; anywhere else it is misplaced
    // caller data the kernel refuses (never silently drops).
    const admission = requested === "BLOCKED" && (task.state === "IN_PROGRESS" || task.state === "READY");
    if (blocked !== undefined && !admission) {
      return {
        kind: "rejected",
        code: "BLOCKED_RECORD_MISPLACED",
        reason: `a blocked record rides only the IN_PROGRESS|READY → BLOCKED admission, not ${task.state} → ${requested}`,
        taskId: task.id,
        from: task.state,
        requested,
      };
    }

    if (requested === "VERIFYING" && this.#stepsFor(task.id).length > 0 && !this.#stepsDone(task.id)) {
      const open = this.#stepsFor(task.id).filter((step) => !isStepTerminal(step.state)).map((step) => step.id);
      return {
        kind: "rejected",
        code: "STEPS_OPEN",
        reason: `task ${task.id} has open steps: ${open.join(", ")}`,
        taskId: task.id,
        from: task.state,
        requested,
      };
    }

    // W166 P3: the decision axis. An offered operator decision is validated
    // fail-closed (the W112 grant-validation discipline: malformed, stale, or
    // actor-mismatched records refuse without consuming state) whenever the
    // task declares a decision gate. A decision offered to a task with no
    // decision gate is inert caller data: it can satisfy no requirement and
    // can never open an evidence gate (the axes are disjoint by construction).
    const decisionRequirements = task.requiredDecisions ?? [];
    const offeredDecisions = decisions ?? [];
    if (offeredDecisions.length > 0 && decisionRequirements.length > 0) {
      for (const decision of offeredDecisions) {
        const refusal = this.#validateDecision(decision, attribution);
        if (refusal !== undefined) {
          return { kind: "rejected", code: refusal.code, reason: refusal.reason, taskId: task.id, from: task.state, requested };
        }
      }
    }

    if (requested === "VERIFIED") {
      // W110 (amux C3 — refusal legibility): the rejection names the
      // UNSATISFIED requirements with a per-requirement why, in the prose
      // and as a structured field — the operator sees the exact artifact
      // needed without deriving it client-side. W166 P3 joins the decision
      // axis additively: evidence entries keep their exact W110 shape;
      // decision entries carry `source: "decision"` and the authority-recorded
      // producing-flow pointer.
      const missingEvidence: MissingRequirement[] = task.requiredEvidence
        .filter((requirement) => !this.#hasEvidence(requirement))
        .map((requirement) => ({
          authority: requirement.authority,
          subject: requirement.subject,
          why: this.#requirementWhy(requirement),
          ...(requirement.producingFlow === undefined ? {} : { producingFlow: requirement.producingFlow }),
        }));
      const missingDecisions: MissingRequirement[] = decisionRequirements
        .filter((requirement) => !this.#hasDecision(requirement, offeredDecisions))
        .map((requirement) => ({
          source: "decision" as const,
          authority: requirement.authority,
          subject: requirement.subject,
          why: this.#decisionWhy(requirement, offeredDecisions),
          ...(requirement.producingFlow === undefined ? {} : { producingFlow: requirement.producingFlow }),
        }));
      const missing = [...missingEvidence, ...missingDecisions];
      if (missing.length > 0) {
        const code = missingEvidence.length > 0 ? "EVIDENCE_REQUIRED" : "DECISION_REQUIRED";
        const detail = missing.map((entry) => `${entry.authority}:${entry.subject} — ${entry.why}`).join("; ");
        const reason = missingEvidence.length === 0
          ? `task ${task.id} does not have every decision requirement satisfied (missing: ${detail})`
          : missingDecisions.length === 0
            ? `task ${task.id} does not have fresh passing evidence for every requirement (missing: ${detail})`
            : `task ${task.id} does not have every requirement satisfied (missing: ${detail})`;
        return {
          kind: "rejected",
          code,
          reason,
          missing,
          taskId: task.id,
          from: task.state,
          requested,
        };
      }
    }

    let nextTask: WorkflowTask = { ...task, state: requested };

    // W159/W166 admission: entering BLOCKED from IN_PROGRESS|READY requires
    // the named owner + action, and the caller may only name ITSELF as the
    // owner (the W157 attribution vocabulary is the join; fail closed
    // without attribution — an agent cannot volunteer another actor).
    if (admission) {
      if (blocked === undefined || blocked === null) {
        return {
          kind: "rejected",
          code: "BLOCKED_RECORD_REQUIRED",
          reason: `entering BLOCKED requires a named owner + action (the actor-initiated blocked record); admission from ${task.state} fails closed without one`,
          taskId: task.id,
          from: task.state,
          requested,
        };
      }
      const record = blocked;
      if (
        typeof record.action !== "string" || record.action.trim().length === 0 ||
        typeof record.enteredAt !== "string" || record.enteredAt.trim().length === 0
      ) {
        return {
          kind: "rejected",
          code: "BLOCKED_RECORD_MALFORMED",
          reason: "the blocked record needs a non-empty action and a caller-supplied enteredAt (the kernel reads no clock)",
          taskId: task.id,
          from: task.state,
          requested,
        };
      }
      if (record.reason !== undefined && typeof record.reason !== "string") {
        return {
          kind: "rejected",
          code: "BLOCKED_RECORD_MALFORMED",
          reason: "the blocked record's reason must be a string when present (an absent reason stays legal)",
          taskId: task.id,
          from: task.state,
          requested,
        };
      }
      if (attribution === undefined) {
        return {
          kind: "rejected",
          code: "BLOCKED_OWNER_UNVERIFIED",
          reason: "the blocked record's owner must equal the calling actor; without attribution the kernel cannot verify self-naming (fail closed)",
          taskId: task.id,
          from: task.state,
          requested,
        };
      }
      if (!ACTOR_VOCABULARY.includes(attribution.actor) || record.owner !== attribution.actor) {
        return {
          kind: "rejected",
          code: "BLOCKED_OWNER_MISMATCH",
          reason: `only the calling actor may name itself as the unblock owner (an actor cannot volunteer another actor); the caller is '${attribution.actor}', the record names '${record.owner}'`,
          taskId: task.id,
          from: task.state,
          requested,
        };
      }
      nextTask = { ...task, state: "BLOCKED", blocked: { ...record } };
    }

    // W166 P2-1: a BLOCKED entry that is NOT an admission is the FAILED →
    // BLOCKED retry, and that path is dependency-derived by construction (a
    // record there is misplaced — the gate above refuses a caller-supplied
    // one). The spread at the nextTask initializer must not resurrect a
    // carried stale-context record as a live block (recordHolds would hold
    // the retried task on a resolved graph, reading a dependency wait — or a
    // resolved graph — as an owed action): the recordless re-entry lands
    // without the record.
    if (requested === "BLOCKED" && !admission) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the rest sibling IS the drop: the stale record is discarded by design (the repo config lacks ignoreRestSiblings; disclosed per the W115 precedent)
      const { blocked: staleContext, ...withoutRecord } = task;
      nextTask = { ...withoutRecord, state: "BLOCKED" };
    }

    // W159/W166 exit: the explicit BLOCKED → READY keeps today's
    // dependency-derived readiness AND consumes the named action one-shot
    // (the W112 grant-lifecycle shape), performed by the named owner itself.
    if (requested === "READY" && task.state === "BLOCKED") {
      const record = task.blocked;
      if (record === undefined) {
        return {
          kind: "rejected",
          code: "BLOCKED_EXIT_WITHOUT_ACTION",
          reason: `no named action to consume; task ${task.id} is dependency-derived BLOCKED and exits automatically when the dependency graph resolves`,
          taskId: task.id,
          from: task.state,
          requested,
        };
      }
      const ready = task.dependencies.every((dependency) => this.get(dependency).state === "VERIFIED");
      if (!ready) {
        return {
          kind: "rejected",
          code: "DEPENDENCY_READINESS_REQUIRED",
          reason: `BLOCKED → READY keeps dependency-derived readiness; task ${task.id}'s dependencies are not all VERIFIED`,
          taskId: task.id,
          from: task.state,
          requested,
        };
      }
      if (attribution === undefined) {
        return {
          kind: "rejected",
          code: "BLOCKED_OWNER_UNVERIFIED",
          reason: "consuming the named action requires attribution — the kernel cannot verify the actor is the named owner (fail closed)",
          taskId: task.id,
          from: task.state,
          requested,
        };
      }
      if (!ACTOR_VOCABULARY.includes(attribution.actor) || record.owner !== attribution.actor) {
        return {
          kind: "rejected",
          code: "BLOCKED_OWNER_MISMATCH",
          reason: `only the named owner consumes its action (the record names '${record.owner}', the caller is '${attribution.actor}')`,
          taskId: task.id,
          from: task.state,
          requested,
        };
      }
      // One-shot consumption: the action is spent and the record leaves the
      // task entirely (the W112 grant-lifecycle shape).
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the rest sibling IS the consumption: the record is discarded by design (the repo config lacks ignoreRestSiblings; disclosed per the W115 precedent)
      const { blocked: consumedAction, ...withoutRecord } = task;
      nextTask = { ...withoutRecord, state: "READY" };
    }

    const from = task.state;
    this.#tasks.set(id, nextTask);
    this.#recomputeReadiness();
    // W157: the caller's attribution rides the record verbatim; the kernel
    // fabricates none and reads no clock (observedAt is caller-supplied).
    return {
      kind: "accepted",
      transition: { taskId: id, from, to: requested, ...(attribution === undefined ? {} : { attribution }) },
    };
  }

  #hasEvidence(requirement: EvidenceRequirement): boolean {
    return this.#evidence.some(
      (evidence) =>
        evidence.authority === requirement.authority &&
        evidence.subject === requirement.subject &&
        evidence.result === "passed" &&
        evidence.freshness === "fresh",
    );
  }

  addDependency(taskId: TaskId, dependencyId: TaskId): void {
    const task = this.get(taskId);
    this.get(dependencyId);
    if (taskId === dependencyId) {
      throw new TypeError(`task ${taskId} cannot depend on itself`);
    }
    if (task.state !== "READY" && task.state !== "BLOCKED") {
      throw new TypeError(`cannot change dependencies for task in ${task.state}`);
    }
    if (task.dependencies.includes(dependencyId)) {
      return;
    }

    const previous = task;
    this.#tasks.set(taskId, { ...task, dependencies: [...task.dependencies, dependencyId] });
    try {
      this.#assertAcyclic();
    } catch (error) {
      this.#tasks.set(taskId, previous);
      throw error;
    }
    this.#recomputeReadiness();
  }

  #validateDependencies(): void {
    for (const task of this.#tasks.values()) {
      for (const dependency of task.dependencies) {
        if (dependency === task.id) {
          throw new TypeError(`task ${task.id} cannot depend on itself`);
        }
        if (!this.#tasks.has(dependency)) {
          throw new TypeError(`task ${task.id} has missing dependency ${dependency}`);
        }
      }
    }
  }

  #assertAcyclic(): void {
    const visiting = new Set<TaskId>();
    const visited = new Set<TaskId>();

    const visit = (id: TaskId): void => {
      if (visiting.has(id)) {
        throw new TypeError(`dependency cycle includes task ${id}`);
      }
      if (visited.has(id)) {
        return;
      }
      visiting.add(id);
      for (const dependency of this.get(id).dependencies) {
        visit(dependency);
      }
      visiting.delete(id);
      visited.add(id);
    };

    for (const id of this.#tasks.keys()) {
      visit(id);
    }
  }

  #recomputeReadiness(): void {
    for (const [id, task] of this.#tasks) {
      if (task.state !== "READY" && task.state !== "BLOCKED") {
        continue;
      }
      const ready = task.dependencies.every(
        (dependency) => this.get(dependency).state === "VERIFIED",
      );
      // W159/W166: a live blocked record holds the block against a
      // dependency-ready STEADY state (the record is the block the owner
      // owes an action for — this is what makes an admission stick). The
      // graph resolving on its own — readiness flipping false → true while
      // the record is live — is the independent automatic exit, after which
      // the record rides as stale context (it is NOT consumed). A record on
      // a READY task is already stale context and never re-blocks.
      const graphResolved = ready && this.#lastReady.get(id) === false;
      const recordHolds = task.state === "BLOCKED" && task.blocked !== undefined && !graphResolved;
      const state: TaskState = ready && !recordHolds ? "READY" : "BLOCKED";
      if (task.state !== state) {
        this.#tasks.set(id, { ...task, state });
      }
      this.#lastReady.set(id, ready);
    }
  }

  /** Seeds the W159/W166 resolution signal for one task from its current states. */
  #seedReadiness(id: TaskId): void {
    this.#lastReady.set(
      id,
      this.get(id).dependencies.every((dependency) => this.get(dependency).state === "VERIFIED"),
    );
  }

  /** W159/W166: the persisted/constructed record must be well-formed caller
   * data — a named owner from the W157 vocabulary, a non-empty action, a
   * caller-supplied enteredAt (the kernel reads no clock), and a string
   * reason when present. */
  #assertBlockedShape(record: BlockedRecord): void {
    if (
      !ACTOR_VOCABULARY.includes(record.owner) ||
      typeof record.action !== "string" || record.action.trim().length === 0 ||
      (record.reason !== undefined && typeof record.reason !== "string") ||
      typeof record.enteredAt !== "string" || record.enteredAt.trim().length === 0
    ) {
      throw new TypeError("malformed blocked record: needs an owner from the actor vocabulary, a non-empty action, a caller-supplied enteredAt, and a string reason when present");
    }
  }
}
