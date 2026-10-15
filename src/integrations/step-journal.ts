import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { digestValue } from "./stable-digest.js";

/**
 * W199 / durability plan §4.1: the step journal with idempotency keys.
 *
 * The v2 event journal dedupes observations by `logId`
 * (`opencode-v2-event-log.ts:42-52`), but nothing keyed a *side effect* so a
 * replay would not repeat it. This module is that key. A durable step is an
 * explicit unit with a `(runId, stepId, attempt)` key and an input digest. On a
 * replay the recorded result is returned without re-running the effect. A
 * duplicate key carrying a *different* input digest is a hard error: the same
 * logical step was asked to do something else, and silently serving the old
 * result (or running both) would corrupt the run. Fail closed.
 *
 * Discipline (durability plan §3): the effect is any non-deterministic act —
 * an LLM call, an HTTP request, a shell command, a clock read, an outgoing
 * notification. Its result is recorded once and never re-executed on replay.
 * The whole point of naming the step is that replay is explicit, never implicit
 * application-code replay.
 */

export interface StepKey {
  readonly runId: string;
  /** Named unit, e.g. "notify.reminder", "search.subquestion.3". */
  readonly stepId: string;
  /**
   * Bump ONLY for a deliberate re-run of the same logical unit (a retry or an
   * escalation re-send). A replay of the same step must reuse the same attempt,
   * or it will re-execute. Plan open question §9: a genuinely different action
   * is a distinct `stepId`, not a new `attempt`.
   */
  readonly attempt: number;
}

export interface StepRecord<T = unknown> {
  readonly key: StepKey;
  /** Digest of the step input; the fail-closed guard against a key collision. */
  readonly inputDigest: string;
  /** Digest of the recorded output, so a caller can verify it on reload. */
  readonly outputDigest: string;
  readonly output: T;
  readonly recordedAt: string;
}

/** A replay whose input digest disagrees with the recorded step. */
export class StepConflictError extends Error {
  readonly key: StepKey;
  constructor(key: StepKey, expected: string, actual: string) {
    super(
      `step ${key.runId}/${key.stepId}#${key.attempt} was recorded with input digest ${expected.slice(0, 12)} but replayed with ${actual.slice(0, 12)}`,
    );
    this.name = "StepConflictError";
    this.key = key;
  }
}

const KEY_SEPARATOR = "\u0000";

function keyString(key: StepKey): string {
  return `${key.runId}${KEY_SEPARATOR}${key.stepId}${KEY_SEPARATOR}${key.attempt}`;
}

export interface StepRunResult<T> {
  readonly output: T;
  /** True when the effect was NOT invoked because a record already existed. */
  readonly replayed: boolean;
  readonly record: StepRecord<T>;
}

export class DurableStepJournal {
  readonly #records = new Map<string, StepRecord>();
  readonly #now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? ((): Date => new Date());
  }

  has(key: StepKey): boolean {
    return this.#records.has(keyString(key));
  }

  get<T = unknown>(key: StepKey): StepRecord<T> | undefined {
    return this.#records.get(keyString(key)) as StepRecord<T> | undefined;
  }

  /**
   * Run a durable step, or replay its recorded result.
   *
   * - No record for the key: invoke `effect`, record its output, return it.
   * - Record with a matching input digest: return the recorded output WITHOUT
   *   invoking the effect (the replay path).
   * - Record with a different input digest: throw `StepConflictError`.
   *
   * The effect may be async; it is awaited before the record is written, so a
   * crash mid-effect leaves no partial record (the step re-runs on restart,
   * which is the at-least-once contract the plan documents in §4.3).
   */
  async step<T>(
    key: StepKey,
    input: unknown,
    effect: (input: unknown) => T | Promise<T>,
  ): Promise<StepRunResult<T>> {
    const id = keyString(key);
    const inputDigest = digestValue(input);
    const existing = this.#records.get(id);
    if (existing !== undefined) {
      if (existing.inputDigest !== inputDigest) {
        throw new StepConflictError(key, existing.inputDigest, inputDigest);
      }
      return { output: existing.output as T, replayed: true, record: existing as StepRecord<T> };
    }
    const output = await effect(input);
    const record: StepRecord<T> = {
      key,
      inputDigest,
      outputDigest: digestValue(output),
      output,
      recordedAt: this.#now().toISOString(),
    };
    this.#records.set(id, record as StepRecord);
    return { output, replayed: false, record };
  }

  /**
   * Record a step's result directly, when the caller already holds it (e.g.
   * hydrating from a conductor checkpoint). Same fail-closed conflict rule:
   * a matching key with a different digest throws rather than overwriting.
   */
  record<T>(key: StepKey, input: unknown, output: T): StepRecord<T> {
    const id = keyString(key);
    const inputDigest = digestValue(input);
    const existing = this.#records.get(id);
    if (existing !== undefined) {
      if (existing.inputDigest !== inputDigest) {
        throw new StepConflictError(key, existing.inputDigest, inputDigest);
      }
      return existing as StepRecord<T>;
    }
    const record: StepRecord<T> = {
      key,
      inputDigest,
      outputDigest: digestValue(output),
      output,
      recordedAt: this.#now().toISOString(),
    };
    this.#records.set(id, record as StepRecord);
    return record;
  }

  /** Entries in insertion order (the replay order). */
  entries(): readonly StepRecord[] {
    return [...this.#records.values()];
  }

  toJSON(): { readonly version: 1; readonly records: readonly StepRecord[] } {
    return { version: 1, records: this.entries() };
  }

  static fromJSON(parsed: unknown): DurableStepJournal {
    const journal = new DurableStepJournal();
    if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1) {
      throw new TypeError("invalid step journal: unsupported or missing version");
    }
    const records = (parsed as { records?: unknown }).records;
    if (!Array.isArray(records)) throw new TypeError("invalid step journal: records must be an array");
    for (const entry of records) {
      const record = requireStepRecord(entry);
      // Re-insertion through the map keeps last-write-wins scoped to the same
      // key; a corrupt file with two records for one key is rejected upstream
      // by `requireStepRecord` only on shape, so digest agreement is enforced
      // here by refusing the second conflicting copy.
      const id = keyString(record.key);
      const prior = journal.#records.get(id);
      if (prior !== undefined && prior.inputDigest !== record.inputDigest) {
        throw new StepConflictError(record.key, prior.inputDigest, record.inputDigest);
      }
      journal.#records.set(id, record);
    }
    return journal;
  }

  /** Load from disk. An absent file is an empty journal (ENOENT only). */
  static load(path: string, options: { readonly now?: () => Date } = {}): DurableStepJournal {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return new DurableStepJournal(options);
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new TypeError(`invalid step journal: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const journal = DurableStepJournal.fromJSON(parsed);
    return journal;
  }

  /** Persist atomically (temp file + rename), the same discipline as the schedule table. */
  save(path: string): void {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.toJSON(), null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  }
}

function requireStepRecord(entry: unknown): StepRecord {
  if (typeof entry !== "object" || entry === null) throw new TypeError("invalid step journal: record is not an object");
  const record = entry as Record<string, unknown>;
  const key = record.key;
  if (typeof key !== "object" || key === null) throw new TypeError("invalid step journal: record.key is not an object");
  const keyRecord = key as Record<string, unknown>;
  for (const field of ["runId", "stepId"] as const) {
    if (typeof keyRecord[field] !== "string" || (keyRecord[field] as string).length === 0) {
      throw new TypeError(`invalid step journal: key.${field} must be a non-empty string`);
    }
  }
  if (!Number.isInteger(keyRecord.attempt) || (keyRecord.attempt as number) < 0) {
    throw new TypeError("invalid step journal: key.attempt must be a non-negative integer");
  }
  for (const field of ["inputDigest", "outputDigest", "recordedAt"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      throw new TypeError(`invalid step journal: ${field} must be a non-empty string`);
    }
  }
  if (!("output" in record)) throw new TypeError("invalid step journal: output is required");
  return record as unknown as StepRecord;
}
