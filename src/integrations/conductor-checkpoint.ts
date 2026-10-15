import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { digestValue } from "./stable-digest.js";

/**
 * W199 / durability plan §4.3: the conductor checkpoint.
 *
 * A crashed research run must resume, not restart, and must not re-spend the
 * token budget. This store persists the plan plus lightweight references to
 * dispatched subagent outputs (the artifact-handoff point already chosen: the
 * shared `augur-workspace` share mounted at `/workspace`). It deliberately does
 * NOT persist subagent transcripts: their results already live in the shared
 * workspace, and copying them through the conductor is the "game of telephone"
 * the deep-research plan rejects (`planning-questions.md`: hand off artifacts,
 * not transcripts).
 *
 * Generic by design. The caller owns what a `ResearchTask` is; this module owns
 * only the durable bookkeeping: which steps are dispatched, which are done,
 * their artifact digest, and where the cursor sits.
 *
 * Resume semantics (§4.3): on restart, load the checkpoint, skip `dispatched`
 * entries whose artifacts still verify by digest, re-dispatch the rest. A
 * subagent that completed but whose artifact is missing re-runs (at-least-once),
 * guarded by its step key in `DurableStepJournal`.
 */

export type StepStatus = "pending" | "done" | "failed";

export interface ConductorDispatch {
  /** Named unit, e.g. "search.subquestion.3". Stable across a resume. */
  readonly stepId: string;
  /** Path under the shared workspace, NOT the body. */
  readonly artifactRef: string;
  readonly status: StepStatus;
  /** Digest of the artifact body, for replay dedupe on resume. */
  readonly digest: string;
}

export interface ConductorCheckpoint {
  readonly runId: string;
  /** The decomposition. Opaque to this module; the conductor owns its shape. */
  readonly plan: readonly unknown[];
  readonly dispatched: readonly ConductorDispatch[];
  /** Index of the next task in `plan` to dispatch. */
  readonly cursor: number;
}

/** A status transition that would break the append-only resume contract. */
export class CheckpointConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointConflictError";
  }
}

function requireCheckpoint(parsed: unknown): ConductorCheckpoint {
  if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1) {
    throw new TypeError("invalid conductor checkpoint: unsupported or missing version");
  }
  const runId = (parsed as { runId?: unknown }).runId;
  if (typeof runId !== "string" || runId.length === 0) throw new TypeError("invalid conductor checkpoint: runId must be a non-empty string");
  const plan = (parsed as { plan?: unknown }).plan;
  if (!Array.isArray(plan)) throw new TypeError("invalid conductor checkpoint: plan must be an array");
  const dispatched = (parsed as { dispatched?: unknown }).dispatched;
  if (!Array.isArray(dispatched)) throw new TypeError("invalid conductor checkpoint: dispatched must be an array");
  for (const entry of dispatched) {
    if (typeof entry !== "object" || entry === null) throw new TypeError("invalid conductor checkpoint: dispatched entry is not an object");
    const record = entry as Record<string, unknown>;
    for (const field of ["stepId", "artifactRef", "digest"] as const) {
      if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
        throw new TypeError(`invalid conductor checkpoint: dispatched.${field} must be a non-empty string`);
      }
    }
    if (record.status !== "pending" && record.status !== "done" && record.status !== "failed") {
      throw new TypeError("invalid conductor checkpoint: dispatched.status must be pending, done, or failed");
    }
  }
  const cursor = (parsed as { cursor?: unknown }).cursor;
  if (!Number.isInteger(cursor) || (cursor as number) < 0 || (cursor as number) > plan.length) {
    throw new TypeError("invalid conductor checkpoint: cursor must be an integer within the plan");
  }
  return { runId, plan, dispatched: dispatched as readonly ConductorDispatch[], cursor: cursor as number };
}

export class ConductorCheckpointStore {
  #checkpoint: ConductorCheckpoint;
  readonly #path: string | undefined;

  constructor(checkpoint: ConductorCheckpoint, options: { readonly path?: string } = {}) {
    this.#checkpoint = requireCheckpoint({ version: 1, ...checkpoint });
    this.#path = options.path;
    this.#persist();
  }

  get checkpoint(): ConductorCheckpoint {
    return this.#checkpoint;
  }

  /**
   * Install the plan on a fresh run (the plan is discovered by `ports.plan`
   * AFTER the store exists, so the store starts with an empty plan). A replace
   * is only legal before any dispatch has been recorded: once work is in
   * flight, changing the plan would orphan `dispatched` entries.
   */
  replacePlan(plan: readonly unknown[]): void {
    if (this.#checkpoint.dispatched.length > 0) {
      throw new CheckpointConflictError("cannot replace the plan after a dispatch has been recorded");
    }
    this.#checkpoint = { ...this.#checkpoint, plan, cursor: 0 };
    this.#persist();
  }

  #persist(): void {
    if (this.#path === undefined) return;
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, ...this.#checkpoint }, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.#path);
  }

  /**
   * Record a dispatch result. Idempotent on `stepId`: marking the same step
   * done again with the same artifact digest is a replay (no-op); a different
   * digest for a step already recorded is a conflict (fail closed).
   */
  markDispatched(dispatch: ConductorDispatch): void {
    const index = this.#checkpoint.dispatched.findIndex((entry) => entry.stepId === dispatch.stepId);
    if (index === -1) {
      this.#checkpoint = { ...this.#checkpoint, dispatched: [...this.#checkpoint.dispatched, dispatch] };
      this.#persist();
      return;
    }
    const prior = this.#checkpoint.dispatched[index]!;
    if (prior.digest !== dispatch.digest && prior.status !== "pending") {
      throw new CheckpointConflictError(
        `conductor step '${dispatch.stepId}' already ${prior.status} with a different digest`,
      );
    }
    const dispatched = [...this.#checkpoint.dispatched];
    dispatched[index] = dispatch;
    this.#checkpoint = { ...this.#checkpoint, dispatched };
    this.#persist();
  }

  /** Advance the cursor to `index` (never backwards: the plan is append-only). */
  advanceCursor(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > this.#checkpoint.plan.length) {
      throw new TypeError(`conductor cursor ${index} is outside the plan`);
    }
    if (index < this.#checkpoint.cursor) {
      throw new CheckpointConflictError(`conductor cursor cannot move backwards (${this.#checkpoint.cursor} -> ${index})`);
    }
    this.#checkpoint = { ...this.#checkpoint, cursor: index };
    this.#persist();
  }

  /**
   * The steps to run on resume: dispatched-and-done steps whose artifact digest
   * still matches `verifyArtifact` are skipped; everything from the cursor
   * forward, plus any recorded-but-not-done step, is returned for re-dispatch.
   */
  pendingAgainst(verifyArtifact: (ref: string, digest: string) => boolean): readonly ConductorDispatch[] {
    const done = new Map<string, ConductorDispatch>();
    for (const entry of this.#checkpoint.dispatched) {
      if (entry.status === "done" && verifyArtifact(entry.artifactRef, entry.digest)) done.set(entry.stepId, entry);
    }
    const pending: ConductorDispatch[] = [];
    this.#checkpoint.dispatched.forEach((entry) => {
      if (!done.has(entry.stepId)) pending.push(entry);
    });
    return pending;
  }

  static load(path: string): ConductorCheckpointStore {
    const raw = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new TypeError(`invalid conductor checkpoint: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const checkpoint = requireCheckpoint(parsed);
    return new ConductorCheckpointStore(checkpoint, { path });
  }
}

/** Digest an artifact body, matching how a dispatch records `digest`. */
export function artifactDigest(body: string): string {
  return digestValue(body);
}
