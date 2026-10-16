# W210: M7 reminder acknowledge/retry/escalate state machine (Q73)

Date: 2026-10-16. Branch: `feat/w210-reminder-state-machine`. Base: `6dea4684`
(`feat/w205-assistant-mcp-dispatch`, PR #575).

## Problem

Q73 (`augur/docs/planning-questions.md:39`): "The stateless worker grows a small
reminder state machine (acknowledge, retry, escalate). Code, not residency." The
M7 row (`augur/docs/integration-plan.md:348`) places reminder jobs at
"scheduler + a notification tool" with the "acknowledgment/retry state machine
in the stateless worker". The sibling slice W208 (`feat/m7-notify-mcp`, PR #579)
built the `notify-mcp` delivery seam and D5 exactly-once delivery, and explicitly
deferred Q73 to this slice. This slice is that machine: a pure, deterministic,
port-injected lifecycle. It owns no clock, opens no socket, and spawns nothing.

## State model

`src/integrations/reminder-state-machine.ts`.

Phases: `pending -> awaiting-ack -> acknowledged | escalated`. `acknowledged`
and `escalated` are terminal (`isTerminalPhase`). One reminder carries:

| Field | Meaning |
|---|---|
| `attempt` | deliveries completed so far, `0` while `pending` |
| `maxAttempts` | the retry bound (the machine default, or per-call override) |
| `ackDeadlineMs` | the acknowledgment deadline granted after each delivery |
| `wakeAt` | ISO ack deadline; `null` while `pending` or terminal |
| `deliveries` | one `{ attempt, deliveryId, deliveredAt }` per completed attempt |
| `payload` | opaque notification content, persisted verbatim |
| `escalationReason` | set iff `phase === "escalated"` |
| `history` | the ordered audit trail (`deliver`/`retry`/`acknowledge`/`escalate`) |

Transitions, each an explicit `now: Date` argument:

- `register(id, payload, now)`: `pending`. Idempotent on `id`, so a restart that
  re-registers does not reset a mid-retry reminder.
- `start(id, now)`: deliver attempt 1, commit `awaiting-ack`, set
  `wakeAt = now + ackDeadlineMs`.
- `retry(id, now)`: if `now < wakeAt`, throw `ReminderNotDueError` (an early
  timer fire waits). Otherwise deliver the next attempt and schedule the next
  `wakeAt`, or, when `attempt + 1 > maxAttempts`, call the escalate port once and
  go terminal `escalated`.
- `acknowledge(id, now)`: `awaiting-ack -> acknowledged`, cancel every pending
  retry/escalation, terminal.
- A terminal reminder driven by `retry` (a stale durable timer) is a **no-op**,
  not a throw. Rationale: `hub-scheduler.ts:431-435` leaves a timer unfired when
  `resumeTimer` throws, so a throw on an acknowledged reminder's stale timer
  would pin that timer forever. A benign no-op is the correct terminal behavior.

An illegal transition from a live phase (e.g. `retry` while `pending`,
`acknowledge` while `pending`) throws `IllegalTransitionError`.

## Ports (all injected; tests need no clock, network, or process)

- `deliver(request): DeliveryReceipt | Promise<DeliveryReceipt>` — the send side
  effect. `request` carries `{ reminderId, attempt, deliveryKey, payload }`,
  where `deliveryKey` is the stable per-attempt idempotency key
  (`reminderId + "#" + attempt`).
- `escalate(reminderId, reason): void | Promise<void>` — called at most once.
- `schedule(wakeAt, reminderId): void` — optional D2/D3 seam. A throw is logged,
  not fatal (state is already committed; the composer reconciles wakes from state
  on startup).
- `ackDeadlineMs`, `maxAttempts`, `log` — configuration.

The machine takes `now` on every transition rather than holding a clock field,
matching the scheduler's "owns no clocks in tests" discipline
(`hub-scheduler.ts:11-13`).

## Why D2/D3 + D5 are reused, not re-implemented

- **Durable timers (D2/D3, `durable-timers.ts`).** The machine grows no second
  clock and no second wake store. `schedule(wakeAt, reminderId)` composes over
  `createDurableTimerTable().add(...)`, and the hub scheduler's existing
  `tick(now)` (`hub-scheduler.ts:426-439`) drains that table and calls
  `resumeTimer`, which the composer wires to `retry(id, now)`. One clock (the
  scheduler's), one waiter store (the timer table), as W199 intended. This slice
  does not touch `hub-scheduler.ts`; the timer wiring stays opt-in and
  byte-identical when unset.
- **D5 exactly-once delivery (`notify-delivery.ts`, `DurableDeliveryLedger`).**
  A retry must not double-send across a crash between "sent" and "recorded". The
  machine grows no second idempotency store: every delivery goes through the
  `deliver` port, which the composer implements over the ledger. Each attempt
  carries a distinct `deliveryKey`, so the ledger dedupes a replay of one attempt
  while a genuine retry (a new attempt, a new key) delivers again.

**Dependency note (why `deliver` is a port, not an import).** D5's
`src/integrations/notify-delivery.ts` lives only on the unmerged `feat/m7-notify-mcp`
(PR #579); it is not in this branch's base `6dea4684`. Importing it would either
fail to compile or create a hard cross-PR build dependency. This module therefore
depends on D5's *shape*, not the file, and documents the composition the composer
writes once:

```ts
const deliver: DeliverPort = async (request) => {
  const result = await ledger.deliver(
    { reminderId: request.deliveryKey },        // attempt-scoped D5 key
    request.payload,
    (notification) => channel.deliver(notification as NotificationRequest),
  );
  return { deliveryId: result.receipt.deliveryId };
};
```

A crash between send and record leaves no ledger row, so the same attempt
re-sends on restart (the at-least-once floor); every attempt that reaches a
completed `deliver` is recorded once and replayed thereafter (D5 scoped to the
attempt).

## Persistence

`save(path)` / `load(path, options)` / `fromJSON` / `toJSON` mirror
`notify-delivery.ts` and `step-journal.ts`: atomic temp+rename write, `version: 1`
guard, ENOENT-only empty load, and a fail-closed `requireReminderState`
validator. The validator rejects a corrupt file on shape (unknown phase, bad
instant) and on cross-field invariants (`deliveries.length === attempt`; a
pending reminder has no delivery and no `wakeAt`; an awaiting-ack reminder has
both; a terminal reminder has no `wakeAt`; `escalationReason` is set iff
`escalated`). A reminder mid-retry resumes verbatim after a restart.

## Evidence

- `node --import tsx --test test/reminder-state-machine.test.ts` — **10/10 pass**.
  Covers: delivery advances to `awaiting-ack` with `wakeAt = now + deadline`; an
  acknowledged reminder never retries or escalates; a missed ack advances to a
  retry attempt with a fresh `wakeAt`; the same attempt key never double-delivers
  across a crash (D5-scoped keying) while a genuine retry does; exhausted
  attempts escalate exactly once and go terminal; a saved mid-retry reminder
  resumes after a restart and delivers one more attempt; the `schedule` port
  receives each `wakeAt`; illegal transitions throw; a corrupt file (bad JSON, a
  broken phase invariant, a bad version) fails closed; an absent file loads
  empty.
- `npx tsc --noEmit` — 0 errors.
- `npm run lint` — 0 errors.
- `npm run build` — clean.
- `node --import tsx --test test/ci-suites-manifest.test.ts` — 5/5 pass (the new
  suite is registered in sorted `test/ci-suites.txt`).

## What remains (the composer, not this slice)

- The composer that ties `schedule -> reminder -> this machine -> notify-mcp
  delivery`: register the care route's reminder jobs, wire `resumeTimer` to
  `retry`, and implement `deliver` over `DurableDeliveryLedger` + the notify-mcp
  channel (the D5 code above).
- The real notification channel (Discord/email/ntfy/SMS), still gated on the
  operator's Q4 choice; v1 ships the recording channel seam only.
- Durable timers remain dormant in `cli/hub.ts` (it still does not pass
  `timers`/`resumeTimer`), unchanged by this slice.
