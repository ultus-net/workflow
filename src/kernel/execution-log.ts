import type {
  StepId,
  StepState,
  TaskId,
  TaskState,
  TransitionAttribution,
} from "./contracts.js";

/**
 * W072 I-6/I-10: the append-only execution log — what ACTUALLY happened, as
 * distinct from the plan ledger (what SHOULD happen). Entries are write/read
 * only; canonical state is a deterministic replay of the log.
 *
 * W072 I-10: every entry carries durable identity (seq/at/task/step/session/
 * actor) so attribution survives restart, replay, and handoff. `at` and the
 * identity are CALLER-SUPPLIED — the kernel reads no clock and does no IO
 * (purity). This module defines the artifact and the pure replay contract; it
 * does NOT yet make the log the persisted source of truth.
 */
export interface ExecutionLogEntryBase {
  /** Monotonic append position; assigned by `ExecutionLog.append`. */
  readonly seq: number;
  /** Caller-supplied entry time; the kernel reads no clock. */
  readonly at: string;
  readonly taskId: TaskId;
  readonly stepId?: StepId;
  readonly sessionId?: string;
  readonly actor?: TransitionAttribution["actor"];
}

export interface TransitionLogEntry extends ExecutionLogEntryBase {
  readonly kind: "transition";
  readonly from: TaskState;
  readonly to: TaskState;
}

/**
 * An evidence admission. The payload is a caller-supplied summary/ref only —
 * the kernel never imports an integration-layer evidence store (purity); the
 * bytes would live behind `ref` outside the kernel.
 */
export interface EvidenceLogEntry extends ExecutionLogEntryBase {
  readonly kind: "evidence";
  readonly summary: string;
  readonly ref?: string;
}

export interface StepLogEntry extends ExecutionLogEntryBase {
  readonly kind: "step";
  readonly from: StepState;
  readonly to: StepState;
}

export type ExecutionLogEntry = TransitionLogEntry | EvidenceLogEntry | StepLogEntry;

/** An entry as offered to `append`, before the log assigns its `seq`. */
export type ExecutionLogDraft =
  | (Omit<TransitionLogEntry, "seq"> & { readonly seq?: number })
  | (Omit<EvidenceLogEntry, "seq"> & { readonly seq?: number })
  | (Omit<StepLogEntry, "seq"> & { readonly seq?: number });

/**
 * The append-only log. There is deliberately NO mutate/delete/clear method —
 * the absence IS the I-6 invariant (write/read only). A caller-supplied `seq`
 * is accepted only when it is exactly the next value; anything else throws.
 */
export class ExecutionLog {
  readonly #entries: ExecutionLogEntry[] = [];

  append(draft: ExecutionLogDraft): ExecutionLogEntry {
    const next = this.#entries.length;
    if (draft.seq !== undefined && draft.seq !== next) {
      throw new TypeError(`execution-log seq must be the next value ${next}; received ${draft.seq}`);
    }
    // Shallow freeze: today every entry field is a primitive, so this is a
    // complete freeze of the entry's observable shape. If a future field adds
    // a nested reference, deep-freeze or copy it here too.
    const entry = Object.freeze({ ...draft, seq: next });
    this.#entries.push(entry);
    return entry;
  }

  /** A fresh copy each call: mutating the returned array never touches the log. */
  entries(): readonly ExecutionLogEntry[] {
    return [...this.#entries];
  }

  forTask(taskId: TaskId): readonly ExecutionLogEntry[] {
    return this.#entries.filter((entry) => entry.taskId === taskId);
  }
}

/**
 * Pure deterministic projection: apply every `transition` entry over the
 * initial state map, in log order. Non-transition entries are retained in the
 * log but never affect task state. Replaying the same log twice yields
 * identical maps (no clock, no IO, no randomness).
 *
 * Fail closed: a `transition` entry naming a task absent from `initialStates`
 * is an inconsistent log (this module has no task-creation entry kind), so it
 * throws rather than silently resurrecting a task the caller never declared.
 */
export function replay(
  entries: readonly ExecutionLogEntry[],
  initialStates: ReadonlyMap<TaskId, TaskState>,
): ReadonlyMap<TaskId, TaskState> {
  const states = new Map(initialStates);
  for (const entry of entries) {
    if (entry.kind === "transition") {
      if (!states.has(entry.taskId)) {
        throw new TypeError(`execution-log transition names unknown task ${entry.taskId}; replay refuses to invent it`);
      }
      states.set(entry.taskId, entry.to);
    }
  }
  return states;
}
