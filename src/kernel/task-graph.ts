import type {
  Evidence,
  EvidenceRequirement,
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

const LEGAL_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  BLOCKED: [],
  READY: ["IN_PROGRESS"],
  IN_PROGRESS: ["VERIFYING", "FAILED"],
  VERIFYING: ["VERIFIED", "FAILED"],
  VERIFIED: [],
  FAILED: ["READY", "BLOCKED"],
};

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

  constructor(tasks: readonly WorkflowTask[]) {
    for (const task of tasks) {
      if (this.#tasks.has(task.id)) {
        throw new TypeError(`duplicate task: ${task.id}`);
      }
      this.#tasks.set(task.id, { ...task, dependencies: [...task.dependencies] });
    }

    this.#validateDependencies();
    this.#assertAcyclic();
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
      if ((task.state === "READY") !== shouldBeReady) {
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
    proposed: readonly { readonly id?: string; readonly content: string; readonly requiredEvidence?: readonly EvidenceRequirement[] }[],
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
      next.push({
        id,
        taskId,
        content,
        state: prior?.state ?? "PENDING",
        requiredEvidence,
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
   * passing evidence for every requirement it declares. */
  completeStep(id: StepId): StepTransitionResult {
    const step = this.step(id);
    if (step.state !== "IN_PROGRESS") {
      return { kind: "rejected", code: "ILLEGAL_STEP_TRANSITION", reason: `cannot complete step ${id} from ${step.state}` };
    }
    if (!this.#stepHasEvidence(step)) {
      return { kind: "rejected", code: "STEP_EVIDENCE_REQUIRED", reason: `step ${id} lacks fresh passing evidence for every requirement` };
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
    this.#tasks.set(task.id, { ...task, dependencies: [...task.dependencies] });
    try {
      this.#validateDependencies();
      this.#assertAcyclic();
    } catch (error) {
      this.#tasks.delete(task.id);
      throw error;
    }
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

  transition(id: TaskId, requested: TaskState, attribution?: TransitionAttribution): TransitionResult {
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

    if (requested === "VERIFIED" && !task.requiredEvidence.every((requirement) => this.#hasEvidence(requirement))) {
      // W110 (amux C3 — refusal legibility): the rejection names the
      // UNSATISFIED requirements with a per-requirement why, in the prose
      // and as a structured field — the operator sees the exact artifact
      // needed without deriving it client-side.
      const missing = task.requiredEvidence
        .filter((requirement) => !this.#hasEvidence(requirement))
        .map((requirement) => ({ authority: requirement.authority, subject: requirement.subject, why: this.#requirementWhy(requirement) }));
      const detail = missing.map((entry) => `${entry.authority}:${entry.subject} — ${entry.why}`).join("; ");
      return {
        kind: "rejected",
        code: "EVIDENCE_REQUIRED",
        reason: `task ${task.id} does not have fresh passing evidence for every requirement (missing: ${detail})`,
        missing,
        taskId: task.id,
        from: task.state,
        requested,
      };
    }

    const from = task.state;
    this.#tasks.set(id, { ...task, state: requested });
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
      const state: TaskState = ready ? "READY" : "BLOCKED";
      if (task.state !== state) {
        this.#tasks.set(id, { ...task, state });
      }
    }
  }
}
