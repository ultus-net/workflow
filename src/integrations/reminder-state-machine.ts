import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * M7 / Q73: the care-reminder acknowledge -> retry -> escalate state machine.
 *
 * Q73 (`augur/docs/planning-questions.md:39`): "The stateless worker grows a
 * small reminder state machine (acknowledge, retry, escalate). Code, not
 * residency." The M7 row (`augur/docs/integration-plan.md:348`) puts reminder
 * jobs at "scheduler + a notification tool" with the "acknowledgment/retry
 * state machine in the stateless worker". This module is that machine, and
 * nothing else: it is pure, deterministic, and port-injected. It owns no
 * clock, opens no socket, and spawns no process.
 *
 * Reuse, not divergence (the two primitives that already exist):
 *
 * - D2/D3 durable timers (`durable-timers.ts`): a wait that survives a
 *   reboot. This machine does NOT grow a second clock or a second wake store.
 *   When a `wakeAt` is established it hands the instant to an optional
 *   `schedule(wakeAt, reminderId)` port, whose documented default composition
 *   is `createDurableTimerTable().add({ id, runId, wakeAt, payload })`. The
 *   hub scheduler's existing `tick(now)` (`hub-scheduler.ts:426-439`) drains
 *   that table and calls `resumeTimer`, which the composer wires back to
 *   `retry(reminderId, now)`. There is one clock (the scheduler's) and one
 *   waiter store (the timer table), exactly as W199 intended.
 *
 * - D5 exactly-once delivery (`notify-delivery.ts`, `DurableDeliveryLedger`):
 *   a retry must not double-send across a crash between "sent" and "recorded".
 *   This machine does NOT open a second idempotency store. Every delivery goes
 *   through the injected `deliver` PORT, which the composer implements over the
 *   ledger. Each attempt carries a stable `deliveryKey` (`reminderId#attempt`)
 *   so the ledger dedupes a replay of one attempt while a genuine retry (a new
 *   attempt) is a new key and therefore delivers again. See "Default delivery
 *   composition" below.
 *
 * Discipline (mirrors `notify-delivery.ts` and `step-journal.ts`): durable
 * state persists with an atomic temp+rename write, a `version: 1` guard, and a
 * fail-closed `requireReminderState` validator. A reminder mid-retry survives
 * a restart because `load()` rebuilds it verbatim, ports aside.
 *
 * Clock discipline (matches `hub-scheduler.ts:11-13`): the machine owns no
 * clock. Every transition takes `now: Date` as an argument, so a test drives
 * time by construction and two hosts produce identical bytes.
 *
 * Default delivery composition (documented, not imported): D5's ledger lives
 * on `feat/m7-notify-mcp`; this module depends on its *shape*, not the file, by
 * taking the delivery action as a port. The composer writes, once:
 *
 *   const deliver: DeliverPort = async (request) => {
 *     const result = await ledger.deliver(
 *       { reminderId: request.deliveryKey },   // attempt-scoped D5 key
 *       request.payload,
 *       (notification) => channel.deliver(notification as NotificationRequest),
 *     );
 *     return { deliveryId: result.receipt.deliveryId };
 *   };
 *
 * A crash between send and record leaves no ledger row, so the same attempt
 * re-sends on restart (the at-least-once floor); every attempt that reaches a
 * completed `deliver` is recorded once and replayed thereafter (D5 exactly-once
 * scoped to the attempt).
 */

/** The lifecycle phases. `acknowledged` and `escalated` are terminal. */
export type ReminderPhase = "pending" | "awaiting-ack" | "acknowledged" | "escalated";

/** The audit events a transition appends. */
export type ReminderEvent = "deliver" | "retry" | "acknowledge" | "escalate";

export function isTerminalPhase(phase: ReminderPhase): boolean {
  return phase === "acknowledged" || phase === "escalated";
}

/** One delivery the machine performed (one per attempt that reached the sink). */
export interface DeliveryAttempt {
  readonly attempt: number;
  readonly deliveryId: string;
  readonly deliveredAt: string;
}

/** One lifecycle event, appended in order. The audit trail. */
export interface TransitionEvent {
  readonly at: string;
  readonly event: ReminderEvent;
  readonly attempt: number;
}

/**
 * The durable state of one reminder. Everything the machine needs to resume
 * after a restart is here; the ports are re-injected, never persisted.
 */
export interface ReminderState {
  readonly reminderId: string;
  readonly phase: ReminderPhase;
  /** Deliveries completed so far (0 while `pending`). */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** The acknowledgment deadline granted after each delivery, in ms. */
  readonly ackDeadlineMs: number;
  /** ISO instant the ack is due; `null` while `pending` or terminal. */
  readonly wakeAt: string | null;
  /** Opaque notification content supplied by the composer; persisted verbatim. */
  readonly payload: unknown;
  readonly deliveries: readonly DeliveryAttempt[];
  /** Set only when `phase === "escalated"`. */
  readonly escalationReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly history: readonly TransitionEvent[];
}

/** What the machine hands the delivery port. */
export interface DeliveryRequest {
  readonly reminderId: string;
  /** 1-based attempt number. */
  readonly attempt: number;
  /**
   * The stable per-attempt idempotency key (`reminderId + "#" + attempt`). A
   * replay of one attempt reuses it; the composer maps it to the D5 ledger key.
   */
  readonly deliveryKey: string;
  readonly payload: unknown;
}

export interface DeliveryReceipt {
  readonly deliveryId: string;
}

/** The send side effect. The composer implements it over the D5 ledger. */
export type DeliverPort = (request: DeliveryRequest) => DeliveryReceipt | Promise<DeliveryReceipt>;

/** The escalation side effect. Called at most once per reminder. */
export type EscalatePort = (reminderId: string, reason: string) => void | Promise<void>;

/**
 * The optional D2/D3 seam: register a durable wake. The documented default is
 * `createDurableTimerTable().add(...)`. A throw is propagated so the composer
 * can reconcile.
 */
export type SchedulePort = (wakeAt: Date, reminderId: string) => void;

export type ReminderLog = (message: string) => void;

/** The machine was asked for a transition its phase does not permit. */
export class IllegalTransitionError extends Error {
  readonly reminderId: string;
  readonly phase: ReminderPhase;
  readonly transition: string;
  constructor(reminderId: string, phase: ReminderPhase, transition: string) {
    super("reminder '" + reminderId + "' cannot " + transition + " from phase '" + phase + "'");
    this.name = "IllegalTransitionError";
    this.reminderId = reminderId;
    this.phase = phase;
    this.transition = transition;
  }
}

/** A retry arrived before the acknowledgment deadline. */
export class ReminderNotDueError extends Error {
  readonly reminderId: string;
  readonly wakeAt: string;
  constructor(reminderId: string, wakeAt: string) {
    super("reminder '" + reminderId + "' is not due until " + wakeAt);
    this.name = "ReminderNotDueError";
    this.reminderId = reminderId;
    this.wakeAt = wakeAt;
  }
}

export interface ReminderMachineOptions {
  readonly deliver: DeliverPort;
  readonly escalate: EscalatePort;
  /** Bounded retry count. Default 3. */
  readonly maxAttempts?: number;
  /** Acknowledgment deadline per delivery, in ms. Default 30 minutes. */
  readonly ackDeadlineMs?: number;
  /** Optional D2/D3 durable-wake seam. Absent means "the composer tracks wakes". */
  readonly schedule?: SchedulePort;
  readonly log?: ReminderLog;
  /** Pre-loaded state (used by `load`). Not for callers. */
  readonly reminders?: readonly ReminderState[];
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_ACK_DEADLINE_MS = 30 * 60 * 1000;

const KEY_SEPARATOR = "#";

function deliveryKeyFor(reminderId: string, attempt: number): string {
  return reminderId + KEY_SEPARATOR + attempt;
}

function parseInstant(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("invalid reminder state: " + field + " is not an ISO instant: '" + value + "'");
  return date;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("invalid reminder state: " + field + " must be a non-empty string");
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError("invalid reminder state: " + field + " must be a non-negative integer");
  }
  return value;
}

function isReminderPhase(value: unknown): value is ReminderPhase {
  return value === "pending" || value === "awaiting-ack" || value === "acknowledged" || value === "escalated";
}

function isReminderEvent(value: unknown): value is ReminderEvent {
  return value === "deliver" || value === "retry" || value === "acknowledge" || value === "escalate";
}

/**
 * Validate one persisted reminder. Fail closed: a shape error, an unknown
 * phase, or a broken phase/attempt invariant throws rather than resuming a
 * reminder in a state the machine never produces.
 */
export function requireReminderState(entry: unknown): ReminderState {
  if (typeof entry !== "object" || entry === null) throw new TypeError("invalid reminder state: entry is not an object");
  const record = entry as Record<string, unknown>;
  requireNonEmptyString(record.reminderId, "reminderId");
  if (!isReminderPhase(record.phase)) throw new TypeError("invalid reminder state: unknown phase '" + String(record.phase) + "'");
  const phase = record.phase;
  const attempt = requireNonNegativeInteger(record.attempt, "attempt");
  const maxAttempts = requireNonNegativeInteger(record.maxAttempts, "maxAttempts");
  if (maxAttempts < 1) throw new TypeError("invalid reminder state: maxAttempts must be at least 1");
  requireNonNegativeInteger(record.ackDeadlineMs, "ackDeadlineMs");

  if (record.wakeAt !== null) {
    if (typeof record.wakeAt !== "string") throw new TypeError("invalid reminder state: wakeAt must be a string or null");
    parseInstant(record.wakeAt, "wakeAt");
  }
  if (record.escalationReason !== null && typeof record.escalationReason !== "string") {
    throw new TypeError("invalid reminder state: escalationReason must be a string or null");
  }
  parseInstant(requireNonEmptyString(record.createdAt, "createdAt"), "createdAt");
  parseInstant(requireNonEmptyString(record.updatedAt, "updatedAt"), "updatedAt");
  if (!("payload" in record)) throw new TypeError("invalid reminder state: payload is required");

  if (!Array.isArray(record.deliveries)) throw new TypeError("invalid reminder state: deliveries must be an array");
  const seenAttempts = new Set<number>();
  for (const raw of record.deliveries) {
    if (typeof raw !== "object" || raw === null) throw new TypeError("invalid reminder state: delivery is not an object");
    const delivery = raw as Record<string, unknown>;
    const deliveryAttempt = requireNonNegativeInteger(delivery.attempt, "delivery.attempt");
    if (deliveryAttempt < 1) throw new TypeError("invalid reminder state: delivery.attempt must be at least 1");
    if (seenAttempts.has(deliveryAttempt)) throw new TypeError("invalid reminder state: duplicate delivery attempt " + deliveryAttempt);
    seenAttempts.add(deliveryAttempt);
    requireNonEmptyString(delivery.deliveryId, "delivery.deliveryId");
    parseInstant(requireNonEmptyString(delivery.deliveredAt, "delivery.deliveredAt"), "delivery.deliveredAt");
  }

  if (!Array.isArray(record.history)) throw new TypeError("invalid reminder state: history must be an array");
  for (const raw of record.history) {
    if (typeof raw !== "object" || raw === null) throw new TypeError("invalid reminder state: history entry is not an object");
    const event = raw as Record<string, unknown>;
    parseInstant(requireNonEmptyString(event.at, "history.at"), "history.at");
    if (!isReminderEvent(event.event)) throw new TypeError("invalid reminder state: unknown history event '" + String(event.event) + "'");
    requireNonNegativeInteger(event.attempt, "history.attempt");
  }

  // Cross-field invariants the machine guarantees by construction. A file that
  // violates one is corrupt and must not be resumed.
  if (record.deliveries.length !== attempt) {
    throw new TypeError("invalid reminder state: deliveries.length must equal attempt");
  }
  if (phase === "pending" && (attempt !== 0 || record.wakeAt !== null)) {
    throw new TypeError("invalid reminder state: a pending reminder has no delivery and no wakeAt");
  }
  if (phase === "awaiting-ack" && (attempt < 1 || record.wakeAt === null)) {
    throw new TypeError("invalid reminder state: an awaiting-ack reminder has a delivery and a wakeAt");
  }
  if (isTerminalPhase(phase) && record.wakeAt !== null) {
    throw new TypeError("invalid reminder state: a terminal reminder has no wakeAt");
  }
  const escalated = phase === "escalated";
  if (escalated !== (record.escalationReason !== null)) {
    throw new TypeError("invalid reminder state: escalationReason must be set iff phase is escalated");
  }

  return entry as ReminderState;
}

/**
 * The reminder lifecycle machine. Deterministic and port-injected: the same
 * inputs and the same injected ports produce the same transitions on any host.
 */
export class ReminderStateMachine {
  readonly #reminders = new Map<string, ReminderState>();
  readonly #deliver: DeliverPort;
  readonly #escalate: EscalatePort;
  readonly #schedule: SchedulePort | undefined;
  readonly #log: ReminderLog;
  readonly #maxAttempts: number;
  readonly #ackDeadlineMs: number;

  constructor(options: ReminderMachineOptions) {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const ackDeadlineMs = options.ackDeadlineMs ?? DEFAULT_ACK_DEADLINE_MS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError("reminder machine: maxAttempts must be a positive integer");
    if (!Number.isInteger(ackDeadlineMs) || ackDeadlineMs < 0) throw new TypeError("reminder machine: ackDeadlineMs must be a non-negative integer");
    this.#deliver = options.deliver;
    this.#escalate = options.escalate;
    this.#schedule = options.schedule;
    this.#log = options.log ?? ((): void => undefined);
    this.#maxAttempts = maxAttempts;
    this.#ackDeadlineMs = ackDeadlineMs;
    for (const reminder of options.reminders ?? []) {
      const validated = requireReminderState(reminder);
      if (this.#reminders.has(validated.reminderId)) throw new TypeError("invalid reminder state: duplicate reminder id '" + validated.reminderId + "'");
      this.#reminders.set(validated.reminderId, validated);
    }
  }

  state(reminderId: string): ReminderState | undefined {
    return this.#reminders.get(reminderId);
  }

  /** Every reminder, in reminder-id order (deterministic). */
  all(): readonly ReminderState[] {
    return [...this.#reminders.values()].sort((a, b) => (a.reminderId < b.reminderId ? -1 : a.reminderId > b.reminderId ? 1 : 0));
  }

  /**
   * Register a reminder in `pending`. Idempotent on `reminderId`: a second
   * register returns the existing state unchanged (a restart that re-registers
   * must not reset a mid-retry reminder to `pending`).
   */
  register(reminderId: string, payload: unknown, now: Date): ReminderState {
    if (typeof reminderId !== "string" || reminderId.length === 0) throw new TypeError("reminder machine: reminderId must be a non-empty string");
    const existing = this.#reminders.get(reminderId);
    if (existing !== undefined) return existing;
    const at = now.toISOString();
    const state: ReminderState = {
      reminderId,
      phase: "pending",
      attempt: 0,
      maxAttempts: this.#maxAttempts,
      ackDeadlineMs: this.#ackDeadlineMs,
      wakeAt: null,
      payload,
      deliveries: [],
      escalationReason: null,
      createdAt: at,
      updatedAt: at,
      history: [],
    };
    this.#reminders.set(reminderId, state);
    return state;
  }

  /**
   * `pending -> awaiting-ack`: deliver attempt 1, then wait for an
   * acknowledgment. The `wakeAt` is `now + ackDeadlineMs`.
   */
  async start(reminderId: string, now: Date): Promise<ReminderState> {
    const state = this.#require(reminderId);
    if (state.phase !== "pending") throw new IllegalTransitionError(reminderId, state.phase, "start");
    const attempt = 1;
    const receipt = await this.#deliver({
      reminderId,
      attempt,
      deliveryKey: deliveryKeyFor(reminderId, attempt),
      payload: state.payload,
    });
    const wakeAt = new Date(now.getTime() + state.ackDeadlineMs);
    const next = this.#advance(state, {
      phase: "awaiting-ack",
      attempt,
      wakeAt,
      delivery: { attempt, deliveryId: receipt.deliveryId, deliveredAt: now.toISOString() },
      event: "deliver",
      now,
    });
    return next;
  }

  /**
   * Drive a due retry, or escalate when attempts are exhausted.
   *
   * - Terminal phase: a no-op returning the current state. This is deliberate:
   *   the composer drives `retry` from a durable timer, and a throw here would
   *   leave that timer unfired forever (`hub-scheduler.ts:431-435`). An
   *   acknowledged reminder's stale timer is therefore benign.
   * - `pending`: illegal (start it first).
   * - Before `wakeAt`: `ReminderNotDueError` (an early timer fire waits).
   * - Otherwise: deliver the next attempt, or `escalate` if none remain.
   */
  async retry(reminderId: string, now: Date): Promise<ReminderState> {
    const state = this.#require(reminderId);
    if (isTerminalPhase(state.phase)) return state;
    if (state.phase !== "awaiting-ack") throw new IllegalTransitionError(reminderId, state.phase, "retry");
    if (state.wakeAt !== null && now.getTime() < parseInstant(state.wakeAt, "wakeAt").getTime()) {
      throw new ReminderNotDueError(reminderId, state.wakeAt);
    }
    if (state.attempt + 1 > state.maxAttempts) {
      const reason = "no acknowledgment after " + state.attempt + " attempt(s)";
      await this.#escalate(reminderId, reason);
      return this.#commit({
        ...state,
        phase: "escalated",
        wakeAt: null,
        escalationReason: reason,
        updatedAt: now.toISOString(),
        history: [...state.history, { at: now.toISOString(), event: "escalate", attempt: state.attempt }],
      });
    }
    const attempt = state.attempt + 1;
    const receipt = await this.#deliver({
      reminderId,
      attempt,
      deliveryKey: deliveryKeyFor(reminderId, attempt),
      payload: state.payload,
    });
    const wakeAt = new Date(now.getTime() + state.ackDeadlineMs);
    return this.#advance(state, {
      phase: "awaiting-ack",
      attempt,
      wakeAt,
      delivery: { attempt, deliveryId: receipt.deliveryId, deliveredAt: now.toISOString() },
      event: "retry",
      now,
    });
  }

  /**
   * `awaiting-ack -> acknowledged`: cancel every pending retry and escalation.
   * Idempotent on a terminal reminder.
   */
  acknowledge(reminderId: string, now: Date): ReminderState {
    const state = this.#require(reminderId);
    if (isTerminalPhase(state.phase)) return state;
    if (state.phase !== "awaiting-ack") throw new IllegalTransitionError(reminderId, state.phase, "acknowledge");
    return this.#commit({
      ...state,
      phase: "acknowledged",
      wakeAt: null,
      updatedAt: now.toISOString(),
      history: [...state.history, { at: now.toISOString(), event: "acknowledge", attempt: state.attempt }],
    });
  }

  #require(reminderId: string): ReminderState {
    const state = this.#reminders.get(reminderId);
    if (state === undefined) throw new TypeError("reminder machine: unknown reminder '" + reminderId + "'");
    return state;
  }

  /** Commit an awaiting-ack advance and (best effort) register the durable wake. */
  #advance(
    state: ReminderState,
    change: {
      readonly phase: ReminderPhase;
      readonly attempt: number;
      readonly wakeAt: Date;
      readonly delivery: DeliveryAttempt;
      readonly event: ReminderEvent;
      readonly now: Date;
    },
  ): ReminderState {
    const next = this.#commit({
      ...state,
      phase: change.phase,
      attempt: change.attempt,
      wakeAt: change.wakeAt.toISOString(),
      deliveries: [...state.deliveries, change.delivery],
      updatedAt: change.now.toISOString(),
      history: [...state.history, { at: change.now.toISOString(), event: change.event, attempt: change.attempt }],
    });
    this.#registerWake(change.wakeAt, state.reminderId);
    return next;
  }

  #registerWake(wakeAt: Date, reminderId: string): void {
    if (this.#schedule === undefined) return;
    try {
      this.#schedule(wakeAt, reminderId);
    } catch (error) {
      // The state is already committed. The composer reconciles wakes from
      // state on startup, so a failed registration is logged, not fatal.
      this.#log("reminder '" + reminderId + "': could not register wake: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  #commit(state: ReminderState): ReminderState {
    this.#reminders.set(state.reminderId, state);
    return state;
  }

  toJSON(): { readonly version: 1; readonly reminders: readonly ReminderState[] } {
    return { version: 1, reminders: this.all() };
  }

  static fromJSON(parsed: unknown, options: ReminderMachineOptions): ReminderStateMachine {
    if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1) {
      throw new TypeError("invalid reminder state: unsupported or missing version");
    }
    const reminders = (parsed as { reminders?: unknown }).reminders;
    if (!Array.isArray(reminders)) throw new TypeError("invalid reminder state: reminders must be an array");
    return new ReminderStateMachine({ ...options, reminders: reminders.map((entry) => requireReminderState(entry)) });
  }

  /** Load from disk. An absent file is an empty machine (ENOENT only). */
  static load(path: string, options: ReminderMachineOptions): ReminderStateMachine {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return new ReminderStateMachine(options);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new TypeError("invalid reminder state: " + (error instanceof Error ? error.message : String(error)), { cause: error });
    }
    return ReminderStateMachine.fromJSON(parsed, options);
  }

  /** Persist atomically (temp file + rename), the sibling modules' discipline. */
  save(path: string): void {
    const temporary = path + "." + process.pid + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(this.toJSON(), null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  }
}
