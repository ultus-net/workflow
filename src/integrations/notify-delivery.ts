import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { digestValue } from "./stable-digest.js";

/**
 * M7 / durability plan D5: exactly-once delivery of a notification side effect.
 *
 * W199 landed D1 (the step journal), D2/D3 (durable timers), and D4 (the
 * conductor checkpoint) and explicitly deferred D5 to the `notify-mcp` seam
 * (`docs/ledger/W199-durability-and-research-conductor.md`, "D5 deferred").
 * This module is D5. The acceptance check it satisfies verbatim
 * (`augur/docs/durability-plan.md` §5):
 *
 *   "A `notify` step whose sink is called twice across a simulated crash
 *    produces one delivered reminder (delivery id recorded, second attempt
 *    deduped)."
 *
 * Why a second store and not the step journal: a step journal keys a run
 * scope — `(runId, stepId, attempt)`. A reminder's identity is the *reminder*,
 * not the run that happens to compose it, and a care reminder may be re-sent
 * by the scheduler after a reboot with no run in hand. The discipline is
 * deliberately identical to `step-journal.ts` — atomic temp+rename persistence,
 * an input digest guard, fail-closed on a key/digest mismatch — because a
 * divergent idempotency mechanism would be two definitions of "delivered".
 *
 * The sink is the `notify-mcp` channel call (an outgoing side effect). It runs
 * at most once per `(reminderId, digest)`: a replay with the same digest
 * returns the recorded receipt WITHOUT invoking the sink; a replay with a
 * different digest throws, because the same reminder id was asked to deliver
 * something else and silently serving the stale receipt (or delivering both)
 * would be a real double-send.
 */

/** A reminder's stable identity. `reminderId` is the dedupe key. */
export interface DeliveryKey {
  readonly reminderId: string;
}

/**
 * The recorded delivery. `receipt` is opaque to this store — it is whatever
 * the channel returned (`DeliveryReceipt` from `notify-mcp`), persisted
 * verbatim so a replay can hand back the *same* `deliveryId` the first attempt
 * produced.
 */
export interface DeliveryRecord<T = unknown> {
  readonly key: DeliveryKey;
  /** Digest of the notification payload; the fail-closed collision guard. */
  readonly inputDigest: string;
  /** The recorded channel receipt (e.g. `{ deliveryId, channel, delivered }`). */
  readonly receipt: T;
  readonly recordedAt: string;
}

/** A replay of one reminder id carrying a different payload digest. */
export class DeliveryConflictError extends Error {
  readonly key: DeliveryKey;
  constructor(key: DeliveryKey, expected: string, actual: string) {
    super(
      "reminder " + key.reminderId + " was recorded with input digest " + expected.slice(0, 12) +
        " but replayed with " + actual.slice(0, 12),
    );
    this.name = "DeliveryConflictError";
    this.key = key;
  }
}

export interface DeliveryResult<T> {
  /** The channel's receipt, recorded on first delivery or replayed thereafter. */
  readonly receipt: T;
  /** True when the sink was NOT invoked because a record already existed. */
  readonly replayed: boolean;
  readonly record: DeliveryRecord<T>;
}

export class DurableDeliveryLedger {
  readonly #records = new Map<string, DeliveryRecord>();
  readonly #now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? ((): Date => new Date());
  }

  has(key: DeliveryKey): boolean {
    return this.#records.has(key.reminderId);
  }

  get<T = unknown>(key: DeliveryKey): DeliveryRecord<T> | undefined {
    return this.#records.get(key.reminderId) as DeliveryRecord<T> | undefined;
  }

  /**
   * Deliver a reminder, or replay its recorded receipt.
   *
   * - No record for the reminder id: invoke `sink`, record its receipt, return.
   * - Record with a matching input digest: return the recorded receipt WITHOUT
   *   invoking the sink (the replay path — the second call across a crash).
   * - Record with a different input digest: throw `DeliveryConflictError`
   *   (fail closed; never a silent double-send or a stale receipt).
   *
   * The sink is awaited BEFORE the record is written, so a crash mid-send
   * leaves no record and the reminder re-sends on restart. That is the
   * at-least-once floor; this store narrows it to exactly-once for every
   * attempt that reaches a completed `deliver` (D5).
   */
  async deliver<T>(
    key: DeliveryKey,
    notification: unknown,
    sink: (notification: unknown) => T | Promise<T>,
  ): Promise<DeliveryResult<T>> {
    const inputDigest = digestValue(notification);
    const existing = this.#records.get(key.reminderId);
    if (existing !== undefined) {
      if (existing.inputDigest !== inputDigest) {
        throw new DeliveryConflictError(key, existing.inputDigest, inputDigest);
      }
      return { receipt: existing.receipt as T, replayed: true, record: existing as DeliveryRecord<T> };
    }
    const receipt = await sink(notification);
    const record: DeliveryRecord<T> = {
      key,
      inputDigest,
      receipt,
      recordedAt: this.#now().toISOString(),
    };
    this.#records.set(key.reminderId, record as DeliveryRecord);
    return { receipt, replayed: false, record };
  }

  /**
   * Record a receipt directly, when the caller already holds one (e.g. after
   * the channel was reached out of band). Same fail-closed conflict rule.
   */
  record<T>(key: DeliveryKey, notification: unknown, receipt: T): DeliveryRecord<T> {
    const inputDigest = digestValue(notification);
    const existing = this.#records.get(key.reminderId);
    if (existing !== undefined) {
      if (existing.inputDigest !== inputDigest) {
        throw new DeliveryConflictError(key, existing.inputDigest, inputDigest);
      }
      return existing as DeliveryRecord<T>;
    }
    const record: DeliveryRecord<T> = {
      key,
      inputDigest,
      receipt,
      recordedAt: this.#now().toISOString(),
    };
    this.#records.set(key.reminderId, record as DeliveryRecord);
    return record;
  }

  /** Records in insertion order (the replay order). */
  entries(): readonly DeliveryRecord[] {
    return [...this.#records.values()];
  }

  toJSON(): { readonly version: 1; readonly records: readonly DeliveryRecord[] } {
    return { version: 1, records: this.entries() };
  }

  static fromJSON(parsed: unknown): DurableDeliveryLedger {
    const ledger = new DurableDeliveryLedger();
    if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1) {
      throw new TypeError("invalid delivery ledger: unsupported or missing version");
    }
    const records = (parsed as { records?: unknown }).records;
    if (!Array.isArray(records)) throw new TypeError("invalid delivery ledger: records must be an array");
    for (const entry of records) {
      const record = requireDeliveryRecord(entry);
      const prior = ledger.#records.get(record.key.reminderId);
      if (prior !== undefined && prior.inputDigest !== record.inputDigest) {
        throw new DeliveryConflictError(record.key, prior.inputDigest, record.inputDigest);
      }
      ledger.#records.set(record.key.reminderId, record);
    }
    return ledger;
  }

  /** Load from disk. An absent file is an empty ledger (ENOENT only). */
  static load(path: string, options: { readonly now?: () => Date } = {}): DurableDeliveryLedger {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return new DurableDeliveryLedger(options);
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new TypeError("invalid delivery ledger: " + (error instanceof Error ? error.message : String(error)), { cause: error });
    }
    return DurableDeliveryLedger.fromJSON(parsed);
  }

  /** Persist atomically (temp file + rename), the same discipline as the step journal. */
  save(path: string): void {
    const temporary = path + "." + process.pid + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(this.toJSON(), null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  }
}

function requireDeliveryRecord(entry: unknown): DeliveryRecord {
  if (typeof entry !== "object" || entry === null) throw new TypeError("invalid delivery ledger: record is not an object");
  const record = entry as Record<string, unknown>;
  const key = record.key;
  if (typeof key !== "object" || key === null) throw new TypeError("invalid delivery ledger: record.key is not an object");
  const reminderId = (key as Record<string, unknown>).reminderId;
  if (typeof reminderId !== "string" || reminderId.length === 0) {
    throw new TypeError("invalid delivery ledger: key.reminderId must be a non-empty string");
  }
  for (const field of ["inputDigest", "recordedAt"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      throw new TypeError("invalid delivery ledger: " + field + " must be a non-empty string");
    }
  }
  if (!("receipt" in record)) throw new TypeError("invalid delivery ledger: receipt is required");
  return record as unknown as DeliveryRecord;
}
