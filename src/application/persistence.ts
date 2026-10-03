import { open, readFile, rename, unlink } from "node:fs/promises";

import type { HostCapabilities } from "./host.js";
import type { TransitionRecord } from "../kernel/contracts.js";
import type { ExecutionLogEntry } from "../kernel/execution-log.js";
import { ACTOR_VOCABULARY, TaskGraph } from "../kernel/task-graph.js";
import { WorkflowApplication } from "./workflow.js";

export interface PersistedWorkflow {
  readonly version: number;
  readonly state: ReturnType<WorkflowApplication["persistedState"]>;
}

export class WorkflowVersionConflict extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`workflow version conflict: expected ${expected}, found ${actual}`);
    this.name = "WorkflowVersionConflict";
  }
}

export class JsonWorkflowStore {
  constructor(readonly path: string) {}

  async load(host: HostCapabilities): Promise<{ application: WorkflowApplication; version: number }> {
    const persisted = await this.#read();
    // W072 I-6 consistency gate: the persisted append-only log's `transition`
    // entries must equal the persisted transition history, in order, by
    // (taskId, from, to). We do NOT compare replayed final states — `TaskGraph`
    // unlocks dependents internally without going through
    // `WorkflowApplication.transition` (src/kernel/task-graph.ts:719,821), so
    // replay legitimately diverges from persisted states. An absent or empty
    // log is legal (older snapshots) and skips the gate. On divergence, fail
    // closed BEFORE constructing the application. This is a cross-check, not a
    // projection swap: state stays canonical.
    if (persisted.state.executionLog !== undefined && persisted.state.executionLog.length > 0 &&
      !executionLogMatchesHistory(persisted.state.executionLog, persisted.state.history)) {
      throw new TypeError("persisted execution log diverges from transition history");
    }
    const graph = TaskGraph.restore(persisted.state);
    const recoveryHistory = persisted.state.tasks
      .filter((task) => task.state === "IN_PROGRESS")
      .map((task) => ({ taskId: task.id, from: "IN_PROGRESS" as const, to: "FAILED" as const }));
    // W072 I-6: the synthetic recovery demotion is written to the history AND to
    // the append-only log, so the two stay coherent across a restart. The
    // recovery entries continue the persisted log's `seq` (ExecutionLog.append
    // accepts a supplied seq only when it is exactly the next value).
    const observedAt = new Date().toISOString();
    const persistedLog = persisted.state.executionLog ?? [];
    const recoveryLog = recoveryHistory.map((transition, index) => ({
      kind: "transition" as const,
      seq: persistedLog.length + index,
      at: observedAt,
      taskId: transition.taskId,
      from: transition.from,
      to: transition.to,
      actor: "system" as const,
    }));
    return {
      application: new WorkflowApplication(
        graph,
        host,
        [...persisted.state.history, ...recoveryHistory],
        new Set(persisted.state.allowedCapabilities ?? ["read", "mutation"]),
        persisted.state.workspaceRoot,
        persisted.state.codingSessionCorrelation,
        [...persistedLog, ...recoveryLog],
      ),
      version: persisted.version,
    };
  }

  async create(application: WorkflowApplication): Promise<number> {
    return this.#withLock(async () => {
      try {
        await readFile(this.path, "utf8");
        throw new WorkflowVersionConflict(-1, (await this.#read()).version);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.#write({ version: 0, state: application.persistedState() });
      return 0;
    });
  }

  async save(application: WorkflowApplication, expectedVersion: number): Promise<number> {
    return this.#withLock(async () => {
      const current = await this.#read();
      if (current.version !== expectedVersion) throw new WorkflowVersionConflict(expectedVersion, current.version);
      const next = expectedVersion + 1;
      await this.#write({ version: next, state: application.persistedState() });
      return next;
    });
  }

  async #read(): Promise<PersistedWorkflow> {
    const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
    if (!isPersistedWorkflow(parsed)) throw new TypeError("invalid persisted workflow");
    return parsed;
  }

  async #write(value: PersistedWorkflow): Promise<void> {
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value, null, 2), "utf8");
      await file.sync();
      await file.close();
      await rename(temporary, this.path);
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`;
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("workflow store is locked by another writer", { cause: error });
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}

function isPersistedWorkflow(value: unknown): value is PersistedWorkflow {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 0) return false;
  if (typeof record.state !== "object" || record.state === null) return false;
  const state = record.state as Record<string, unknown>;
  if (!(
    Array.isArray(state.tasks) && state.tasks.every(isWorkflowTask) &&
    Array.isArray(state.evidence) && state.evidence.every(isEvidence) &&
    Array.isArray(state.history) && state.history.every(isTransitionRecord) &&
    Number.isSafeInteger(state.mutationEpoch) && (state.mutationEpoch as number) >= 0 &&
    (state.allowedCapabilities === undefined || (Array.isArray(state.allowedCapabilities) && state.allowedCapabilities.every(isToolCapability))) &&
    (state.workspaceRoot === undefined || (typeof state.workspaceRoot === "string" && state.workspaceRoot.startsWith("/"))) &&
    (state.codingSessionCorrelation === undefined || isNonEmptyString(state.codingSessionCorrelation)) &&
    (state.steps === undefined || (Array.isArray(state.steps) && state.steps.every(isWorkflowStep))) &&
    (state.executionLog === undefined || isExecutionLog(state.executionLog))
  )) return false;
  const taskIds = new Set((state.tasks as Record<string, unknown>[]).map((task) => task.id));
  return taskIds.size === state.tasks.length &&
    isCoherentHistory(
      state.tasks as Record<string, unknown>[],
      state.history as Record<string, unknown>[],
    );
}

const TASK_STATES = new Set(["BLOCKED", "READY", "IN_PROGRESS", "VERIFYING", "VERIFIED", "FAILED"]);
const STEP_STATES = new Set(["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"]);
const EVIDENCE_AUTHORITIES = new Set(["environment", "host", "mcp", "reviewer"]);
const TOOL_CAPABILITIES = new Set(["read", "mutation", "process", "spawn", "credentials", "network"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isToolCapability(value: unknown): value is import("./host.js").ToolCapability {
  return typeof value === "string" && TOOL_CAPABILITIES.has(value);
}

function isWorkflowTask(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Record<string, unknown>;
  return isNonEmptyString(task.id) && isNonEmptyString(task.title) && TASK_STATES.has(task.state as string) &&
    Array.isArray(task.dependencies) && task.dependencies.every(isNonEmptyString) &&
    Array.isArray(task.requiredEvidence) && task.requiredEvidence.every((requirement) => {
      if (typeof requirement !== "object" || requirement === null) return false;
      const record = requirement as Record<string, unknown>;
      return EVIDENCE_AUTHORITIES.has(record.authority as string) && isNonEmptyString(record.subject);
    });
}

function isWorkflowStep(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const step = value as Record<string, unknown>;
  return isNonEmptyString(step.id) && isNonEmptyString(step.taskId) && isNonEmptyString(step.content) &&
    STEP_STATES.has(step.state as string) &&
    (step.requiredPostcondition === undefined || isChangeClaim(step.requiredPostcondition)) &&
    Array.isArray(step.requiredEvidence) && step.requiredEvidence.every((requirement) => {
      if (typeof requirement !== "object" || requirement === null) return false;
      const record = requirement as Record<string, unknown>;
      return EVIDENCE_AUTHORITIES.has(record.authority as string) && isNonEmptyString(record.subject);
    });
}

/**
 * W072 I-9: validates a persisted state-diff postcondition against the
 * `ChangeClaim` contract. A malformed claim must be rejected at load — the
 * kernel's `evaluateStateDiff` assumes a well-formed `subjects` array and would
 * otherwise throw (or silently disable the gate) during `completeStep`.
 */
function isChangeClaim(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const claim = value as Record<string, unknown>;
  return Array.isArray(claim.subjects) && claim.subjects.every((subject) => {
    if (typeof subject !== "object" || subject === null) return false;
    const record = subject as Record<string, unknown>;
    return isNonEmptyString(record.path) && isNonEmptyString(record.expectedFingerprint);
  });
}

function isEvidence(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const evidence = value as Record<string, unknown>;
  return isNonEmptyString(evidence.id) && isNonEmptyString(evidence.observationId) &&
    EVIDENCE_AUTHORITIES.has(evidence.authority as string) && isNonEmptyString(evidence.subject) &&
    (evidence.result === "passed" || evidence.result === "failed") &&
    (evidence.freshness === "fresh" || evidence.freshness === "stale") &&
    Number.isSafeInteger(evidence.mutationEpoch) && (evidence.mutationEpoch as number) >= 0 &&
    typeof evidence.observedAt === "string" && !Number.isNaN(Date.parse(evidence.observedAt));
}

function isLegalHistoryTransition(from: string, to: string): boolean {
  return (from === "READY" && to === "IN_PROGRESS") ||
    (from === "IN_PROGRESS" && (to === "VERIFYING" || to === "FAILED")) ||
    (from === "VERIFYING" && (to === "VERIFIED" || to === "FAILED")) ||
    (from === "VERIFIED" && to === "VERIFYING") ||
    (from === "FAILED" && (to === "READY" || to === "BLOCKED"));
}

const TRANSITION_ACTORS = new Set<string>(ACTOR_VOCABULARY);

function isTransitionRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const transition = value as Record<string, unknown>;
  if (!(isNonEmptyString(transition.taskId) && TASK_STATES.has(transition.from as string) && TASK_STATES.has(transition.to as string) &&
    isLegalHistoryTransition(transition.from as string, transition.to as string))) return false;
  // W157/W072 I-10: caller-supplied attribution is optional (absence is the
  // legal "unattributed" state), but when present it must carry the closed
  // actor vocabulary, a non-empty authority, and a parseable observedAt — the
  // same shape the kernel contract and the activity timeline consume. A
  // record with a malformed attribution is rejected, never silently dropped.
  if (transition.attribution === undefined) return true;
  if (typeof transition.attribution !== "object" || transition.attribution === null) return false;
  const attribution = transition.attribution as Record<string, unknown>;
  return TRANSITION_ACTORS.has(attribution.actor as string) &&
    isNonEmptyString(attribution.authority) &&
    typeof attribution.observedAt === "string" && !Number.isNaN(Date.parse(attribution.observedAt));
}

/**
 * W072 I-6: validates a persisted execution-log entry. Absence of the whole
 * field is legal (older snapshots keep loading); an entry that IS present must
 * be well-formed, so a malformed entry is rejected rather than silently
 * dropped. The `seq` is checked for non-negative integer and the entry's
 * per-kind payload is checked against the kernel's own `ExecutionLogEntry`
 * union shape.
 */
function isExecutionLog(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const entries = value as Record<string, unknown>[];
  return entries.every((entry, index) => {
    if (typeof entry !== "object" || entry === null) return false;
    if (!Number.isSafeInteger(entry.seq) || entry.seq !== index) return false;
    if (!isNonEmptyString(entry.taskId)) return false;
    if (entry.stepId !== undefined && !isNonEmptyString(entry.stepId)) return false;
    if (entry.sessionId !== undefined && !isNonEmptyString(entry.sessionId)) return false;
    if (entry.actor !== undefined && !TRANSITION_ACTORS.has(entry.actor as string)) return false;
    if (!(typeof entry.at === "string" && !Number.isNaN(Date.parse(entry.at)))) return false;
    if (entry.kind === "transition" || entry.kind === "step") {
      const states = entry.kind === "transition" ? TASK_STATES : STEP_STATES;
      return states.has(entry.from as string) && states.has(entry.to as string);
    }
    if (entry.kind === "evidence") {
      return isNonEmptyString(entry.summary) && (entry.ref === undefined || isNonEmptyString(entry.ref));
    }
    return false;
  });
}

/**
 * W072 I-6 consistency gate: the persisted append-only execution log's
 * `transition` entries must equal the persisted transition history, in order,
 * pairwise on (taskId, from, to). Evidence/step entries are log-only and are
 * skipped. This is deliberately NOT a comparison of replayed final states:
 * `TaskGraph` unlocks dependents internally without routing through
 * `WorkflowApplication.transition`, so replay legitimately diverges from the
 * persisted state while the two journals stay aligned. Pure and ordering-based.
 */
function executionLogMatchesHistory(
  log: readonly ExecutionLogEntry[],
  history: readonly TransitionRecord[],
): boolean {
  let index = 0;
  for (const entry of log) {
    if (entry.kind !== "transition") continue;
    const record = history[index];
    if (record === undefined ||
      entry.taskId !== record.taskId ||
      entry.from !== record.from ||
      entry.to !== record.to) return false;
    index += 1;
  }
  return index === history.length;
}

function isCoherentHistory(tasks: Record<string, unknown>[], history: Record<string, unknown>[]): boolean {
  const taskStates = new Map(tasks.map((task) => [task.id as string, task.state as string]));
  const dependencies = new Map(tasks.map((task) => [task.id as string, task.dependencies as string[]]));
  const tasksWithHistory = new Set(history.map((transition) => transition.taskId as string));
  const verified = new Set(
    tasks
      .filter((task) => task.state === "VERIFIED" && !tasksWithHistory.has(task.id as string))
      .map((task) => task.id as string),
  );
  const lastTransitions = new Map<string, Record<string, unknown>>();
  for (const transition of history) {
    const id = transition.taskId as string;
    if (!taskStates.has(id)) return false;
    const previous = lastTransitions.get(id);
    if (previous !== undefined && previous.to !== transition.from) return false;
    if (transition.from === "READY" && transition.to === "IN_PROGRESS" &&
      !(dependencies.get(id) ?? []).every((dependency) => verified.has(dependency))) return false;
    if (transition.to === "VERIFIED") verified.add(id);
    if (transition.from === "VERIFIED" && transition.to === "VERIFYING") verified.delete(id);
    lastTransitions.set(id, transition);
  }
  for (const [id, transition] of lastTransitions) {
    const current = taskStates.get(id);
    if (current !== transition.to) return false;
  }
  return true;
}
