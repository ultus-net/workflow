import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  IllegalTransitionError,
  ReminderNotDueError,
  ReminderStateMachine,
  type DeliverPort,
  type DeliveryRequest,
} from "../src/integrations/reminder-state-machine.js";

/**
 * Q73 (`augur/docs/planning-questions.md:39`): the care-reminder
 * acknowledge -> retry -> escalate state machine lives in the stateless worker.
 *
 * Every test here drives time by construction (an injected clock, always an
 * explicit `Date` argument) and injects the delivery and escalation side
 * effects as ports. No test opens a socket, spawns a process, or reads the
 * wall clock.
 */

const T0 = new Date("2026-10-16T08:00:00.000Z");

function at(base: Date, ms: number): Date {
  return new Date(base.getTime() + ms);
}

interface Recorder {
  readonly deliveries: DeliveryRequest[];
  readonly escalations: { readonly reminderId: string; readonly reason: string }[];
  readonly wakes: { readonly wakeAt: Date; readonly reminderId: string }[];
  readonly deliver: DeliverPort;
  readonly escalate: (reminderId: string, reason: string) => void;
  readonly schedule: (wakeAt: Date, reminderId: string) => void;
}

/** A port recorder: deterministic delivery ids, and every effect captured. */
function recorder(): Recorder {
  const deliveries: DeliveryRequest[] = [];
  const escalations: { reminderId: string; reason: string }[] = [];
  const wakes: { wakeAt: Date; reminderId: string }[] = [];
  const deliver: DeliverPort = (request) => {
    deliveries.push(request);
    return { deliveryId: "delivery-" + request.attempt };
  };
  const escalate = (reminderId: string, reason: string): void => {
    escalations.push({ reminderId, reason });
  };
  const schedule = (wakeAt: Date, reminderId: string): void => {
    wakes.push({ wakeAt, reminderId });
  };
  return { deliveries, escalations, wakes, deliver, escalate, schedule };
}

/**
 * A stand-in for the D5 `DurableDeliveryLedger`: it dedupes by the attempt's
 * `deliveryKey` and counts real sends, so the test can assert the machine never
 * double-delivers one attempt key.
 */
function dedupingSink(): { readonly deliver: DeliverPort; readonly sends: number } {
  const seen = new Map<string, string>();
  const state = { sends: 0 };
  const deliver: DeliverPort = (request) => {
    const existing = seen.get(request.deliveryKey);
    if (existing !== undefined) return { deliveryId: existing };
    state.sends += 1;
    const id = "delivery-" + state.sends;
    seen.set(request.deliveryKey, id);
    return { deliveryId: id };
  };
  return {
    deliver,
    get sends(): number {
      return state.sends;
    },
  };
}

test("Q73: start delivers attempt 1 and awaits the ack with wakeAt = now + deadline", async () => {
  const r = recorder();
  const machine = new ReminderStateMachine({ deliver: r.deliver, escalate: r.escalate, maxAttempts: 3, ackDeadlineMs: 30 * 60 * 1000 });
  machine.register("meds-0800", { body: "Take your medication." }, T0);

  const state = await machine.start("meds-0800", T0);

  assert.equal(state.phase, "awaiting-ack");
  assert.equal(state.attempt, 1);
  assert.equal(state.wakeAt, at(T0, 30 * 60 * 1000).toISOString(), "the ack deadline is now + ackDeadlineMs");
  assert.equal(r.deliveries.length, 1);
  assert.deepEqual(r.deliveries[0], {
    reminderId: "meds-0800",
    attempt: 1,
    deliveryKey: "meds-0800#1",
    payload: { body: "Take your medication." },
  });
  assert.deepEqual(state.deliveries, [{ attempt: 1, deliveryId: "delivery-1", deliveredAt: T0.toISOString() }]);
  assert.equal(r.escalations.length, 0);
});

test("Q73: an acknowledged reminder never retries or escalates", async () => {
  const r = recorder();
  const machine = new ReminderStateMachine({ deliver: r.deliver, escalate: r.escalate, maxAttempts: 3, ackDeadlineMs: 1000 });
  machine.register("meds-0800", {}, T0);
  await machine.start("meds-0800", T0);

  const acked = machine.acknowledge("meds-0800", at(T0, 60 * 1000));
  assert.equal(acked.phase, "acknowledged");
  assert.equal(acked.wakeAt, null, "a terminal reminder holds no wakeAt");

  // A late timer (long past the deadline) is a terminal no-op, not a retry.
  const after = await machine.retry("meds-0800", at(T0, 10 * 60 * 60 * 1000));
  assert.equal(after.phase, "acknowledged");
  assert.equal(r.deliveries.length, 1, "the retry never reached the delivery port");
  assert.equal(r.escalations.length, 0, "the retry never escalated");

  // Acknowledge is idempotent.
  assert.equal(machine.acknowledge("meds-0800", at(T0, 9_000_000)).phase, "acknowledged");
});

test("Q73: a missed ack advances to a retry attempt with a fresh wakeAt", async () => {
  const r = recorder();
  const machine = new ReminderStateMachine({ deliver: r.deliver, escalate: r.escalate, maxAttempts: 3, ackDeadlineMs: 1000 });
  machine.register("meds-0800", {}, T0);
  await machine.start("meds-0800", T0);

  await assert.rejects(() => machine.retry("meds-0800", at(T0, 999)), ReminderNotDueError);

  const state = await machine.retry("meds-0800", at(T0, 1000));
  assert.equal(state.attempt, 2);
  assert.equal(state.phase, "awaiting-ack");
  assert.equal(state.wakeAt, at(T0, 2000).toISOString(), "each attempt schedules the next deadline");
  assert.deepEqual(r.deliveries.map((delivery) => delivery.deliveryKey), ["meds-0800#1", "meds-0800#2"]);
  assert.equal(r.escalations.length, 0);
});

test("Q73: the same attempt key never double-delivers (D5-scoped keying)", async () => {
  const sink = dedupingSink();
  const machine = new ReminderStateMachine({ deliver: sink.deliver, escalate: () => undefined, maxAttempts: 3, ackDeadlineMs: 1000 });
  machine.register("meds-0800", { body: "x" }, T0);
  const first = await machine.start("meds-0800", T0);
  assert.equal(sink.sends, 1);

  // Crash BEFORE the state was persisted: a fresh machine resumes from the
  // pre-start (pending) state and re-runs start. It asks for the SAME attempt
  // key, so the D5-backed sink replays instead of sending again.
  const restarted = new ReminderStateMachine({ deliver: sink.deliver, escalate: () => undefined, maxAttempts: 3, ackDeadlineMs: 1000 });
  restarted.register("meds-0800", { body: "x" }, T0);
  const replay = await restarted.start("meds-0800", T0);
  assert.equal(sink.sends, 1, "the same attempt key replays, never a second send");
  assert.equal(replay.deliveries[0]?.deliveryId, first.deliveries[0]?.deliveryId, "the recorded delivery id is returned verbatim");

  // A genuine retry is a NEW attempt and a NEW key, so it does deliver.
  await restarted.retry("meds-0800", at(T0, 1000));
  assert.equal(sink.sends, 2, "a retry is a new attempt, so it delivers again");
});

test("Q73: exhausted attempts escalate exactly once and go terminal", async () => {
  const r = recorder();
  const machine = new ReminderStateMachine({ deliver: r.deliver, escalate: r.escalate, maxAttempts: 3, ackDeadlineMs: 1000 });
  machine.register("meds-0800", {}, T0);

  await machine.start("meds-0800", T0); // attempt 1
  await machine.retry("meds-0800", at(T0, 1000)); // attempt 2
  await machine.retry("meds-0800", at(T0, 2000)); // attempt 3
  assert.equal(r.deliveries.length, 3);
  assert.equal(r.escalations.length, 0);

  const escalated = await machine.retry("meds-0800", at(T0, 3000)); // none left
  assert.equal(escalated.phase, "escalated");
  assert.equal(escalated.wakeAt, null);
  assert.equal(escalated.escalationReason, "no acknowledgment after 3 attempt(s)");
  assert.equal(r.escalations.length, 1, "exactly one escalation");
  assert.equal(r.deliveries.length, 3, "the escalating attempt performs no delivery");

  // A stale timer after escalation is a terminal no-op; still exactly one.
  const again = await machine.retry("meds-0800", at(T0, 99_000));
  assert.equal(again.phase, "escalated");
  assert.equal(r.escalations.length, 1);
});

test("Q73: a saved mid-retry reminder resumes after a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-reminder-"));
  const path = join(dir, "reminders.json");
  try {
    const r = recorder();
    const options = { deliver: r.deliver, escalate: r.escalate, maxAttempts: 3, ackDeadlineMs: 1000 } as const;
    const machine = new ReminderStateMachine(options);
    machine.register("meds-0800", { body: "x" }, T0);
    await machine.start("meds-0800", T0);
    await machine.retry("meds-0800", at(T0, 1000)); // now attempt 2, awaiting ack
    machine.save(path);

    const reloaded = ReminderStateMachine.load(path, options);
    const state = reloaded.state("meds-0800");
    assert.equal(state?.phase, "awaiting-ack");
    assert.equal(state?.attempt, 2);
    assert.equal(state?.wakeAt, at(T0, 2000).toISOString());

    // The resumed machine continues the lifecycle from where it stopped.
    const next = await reloaded.retry("meds-0800", at(T0, 2000));
    assert.equal(next.attempt, 3);
    assert.equal(r.deliveries.length, 3, "the resumed machine delivered exactly one more attempt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Q73: the optional schedule port receives each wakeAt (D2/D3 seam)", async () => {
  const r = recorder();
  const machine = new ReminderStateMachine({ deliver: r.deliver, escalate: r.escalate, schedule: r.schedule, maxAttempts: 3, ackDeadlineMs: 1000 });
  machine.register("meds-0800", {}, T0);
  await machine.start("meds-0800", T0);
  await machine.retry("meds-0800", at(T0, 1000));
  assert.deepEqual(r.wakes, [
    { wakeAt: at(T0, 1000), reminderId: "meds-0800" },
    { wakeAt: at(T0, 2000), reminderId: "meds-0800" },
  ]);
});

test("Q73: retry before start and acknowledge before delivery are illegal transitions", async () => {
  const machine = new ReminderStateMachine({ deliver: () => ({ deliveryId: "x" }), escalate: () => undefined });
  machine.register("meds-0800", {}, T0);
  await assert.rejects(() => machine.retry("meds-0800", at(T0, 99999)), IllegalTransitionError);
  assert.throws(() => machine.acknowledge("meds-0800", T0), IllegalTransitionError);
});

test("Q73: corrupt persisted state fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-reminder-bad-"));
  const path = join(dir, "reminders.json");
  const options = { deliver: (): { deliveryId: string } => ({ deliveryId: "x" }), escalate: (): void => undefined };
  try {
    writeFileSync(path, "{ not json", "utf8");
    assert.throws(() => ReminderStateMachine.load(path, options), /invalid reminder state/);

    // A well-formed file whose phase/field invariants are broken (a terminal
    // reminder that still carries a wakeAt) is rejected, not silently resumed.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        reminders: [
          {
            reminderId: "meds-0800",
            phase: "escalated",
            attempt: 1,
            maxAttempts: 3,
            ackDeadlineMs: 1000,
            wakeAt: T0.toISOString(),
            payload: {},
            deliveries: [{ attempt: 1, deliveryId: "d", deliveredAt: T0.toISOString() }],
            escalationReason: "x",
            createdAt: T0.toISOString(),
            updatedAt: T0.toISOString(),
            history: [],
          },
        ],
      }),
      "utf8",
    );
    assert.throws(() => ReminderStateMachine.load(path, options), /terminal reminder has no wakeAt/);

    writeFileSync(path, JSON.stringify({ version: 2, reminders: [] }), "utf8");
    assert.throws(() => ReminderStateMachine.load(path, options), /unsupported or missing version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Q73: an absent state file loads as an empty machine (ENOENT only)", () => {
  const machine = ReminderStateMachine.load(join(tmpdir(), "wf-reminder-does-not-exist.json"), {
    deliver: (): { deliveryId: string } => ({ deliveryId: "x" }),
    escalate: (): void => undefined,
  });
  assert.deepEqual(machine.all(), []);
});
