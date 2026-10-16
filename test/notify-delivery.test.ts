import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeliveryConflictError, DurableDeliveryLedger, type DeliveryKey } from "../src/integrations/notify-delivery.js";

/**
 * W208 / durability plan acceptance check D5.
 *
 * "A `notify` step whose sink is called twice across a simulated crash
 *  produces one delivered reminder (delivery id recorded, second attempt
 *  deduped)."
 *
 * The "sink" is the notify-mcp channel call. The delivery id is whatever the
 * channel returns; the ledger records it once and returns the SAME id on a
 * replay without invoking the sink.
 */

const key: DeliveryKey = { reminderId: "reminder-meds-0800" };

/** A stand-in channel sink that hands back a stable delivery id and counts hits. */
function countingSink(counter: { calls: number }): (notification: unknown) => { deliveryId: string; channel: string; delivered: boolean } {
  return (): { deliveryId: string; channel: string; delivered: boolean } => {
    counter.calls += 1;
    return { deliveryId: "delivery-" + counter.calls, channel: "recording", delivered: true };
  };
}

test("D5: a notify step whose sink is called twice across a crash delivers once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-notify-delivery-"));
  const path = join(dir, "delivery-ledger.json");
  try {
    const notification = { reminderId: key.reminderId, recipient: "care-recipient", body: "Take your 08:00 medication." };
    const counter = { calls: 0 };

    // First attempt: the sink runs and its delivery id is recorded.
    const first = new DurableDeliveryLedger({ now: () => new Date("2026-10-16T08:00:00.000Z") });
    const delivered = await first.deliver(key, notification, countingSink(counter));
    assert.equal(delivered.replayed, false);
    assert.equal(counter.calls, 1, "the first attempt invokes the sink");
    assert.equal(delivered.receipt.deliveryId, "delivery-1");
    first.save(path);

    // Simulated crash: the in-memory ledger is gone. Reload from disk — the
    // SAME durable state a restarted worker would see.
    const reloaded = DurableDeliveryLedger.load(path);

    // Second attempt across the crash: the sink must NOT run again, and the
    // recorded delivery id must be handed back verbatim.
    const replay = await reloaded.deliver(key, notification, countingSink(counter));
    assert.equal(replay.replayed, true, "the second attempt is a replay");
    assert.equal(counter.calls, 1, "the sink ran exactly once across the crash");
    assert.equal(replay.receipt.deliveryId, "delivery-1", "the recorded delivery id is returned, not a fresh one");
    assert.deepEqual(replay.receipt, delivered.receipt);
    assert.deepEqual(replay.record, delivered.record);
    assert.equal(reloaded.entries().length, 1, "exactly one delivered reminder is recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D5: the same reminder with a different payload throws (fail closed, never a double-send)", async () => {
  const ledger = new DurableDeliveryLedger();
  const counter = { calls: 0 };
  await ledger.deliver(key, { reminderId: key.reminderId, body: "the original text" }, countingSink(counter));
  await assert.rejects(
    () => ledger.deliver(key, { reminderId: key.reminderId, body: "something else entirely" }, countingSink(counter)),
    (error: unknown) => error instanceof DeliveryConflictError && (error as DeliveryConflictError).key.reminderId === key.reminderId,
  );
  assert.equal(counter.calls, 1, "the conflicting attempt never reaches the sink");
});

test("D5: distinct reminders each deliver (the key is the reminder id, not the digest)", async () => {
  const ledger = new DurableDeliveryLedger();
  const counter = { calls: 0 };
  const first = await ledger.deliver(key, { reminderId: key.reminderId, body: "08:00" }, countingSink(counter));
  const second = await ledger.deliver({ reminderId: "reminder-meds-2000" }, { reminderId: "reminder-meds-2000", body: "20:00" }, countingSink(counter));
  assert.equal(counter.calls, 2, "two distinct reminders deliver twice");
  assert.notEqual(first.receipt.deliveryId, second.receipt.deliveryId);
  assert.equal(ledger.entries().length, 2);
});

test("D5: the ledger round-trips through disk and still dedupes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-notify-delivery-rt-"));
  const path = join(dir, "delivery-ledger.json");
  try {
    const counter = { calls: 0 };
    const notification = { reminderId: key.reminderId, body: "persist me" };
    const first = new DurableDeliveryLedger();
    await first.deliver(key, notification, countingSink(counter));
    first.save(path);

    const reloaded = DurableDeliveryLedger.load(path);
    const replay = await reloaded.deliver(key, notification, countingSink(counter));
    assert.equal(replay.replayed, true);
    assert.equal(counter.calls, 1, "the sink did not run after a reload");
    assert.equal(replay.receipt.deliveryId, "delivery-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D5: an absent ledger file loads as empty (ENOENT only)", () => {
  const ledger = DurableDeliveryLedger.load(join(tmpdir(), "wf-notify-delivery-does-not-exist.json"));
  assert.deepEqual(ledger.entries(), []);
});

test("D5: a corrupt ledger file is rejected, not silently emptied", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-notify-delivery-bad-"));
  const path = join(dir, "delivery-ledger.json");
  try {
    writeFileSync(path, "{ not json", "utf8");
    assert.throws(() => DurableDeliveryLedger.load(path), /invalid delivery ledger/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D5: a record() hydration with a conflicting digest is rejected (fail closed)", () => {
  const ledger = new DurableDeliveryLedger();
  ledger.record(key, { reminderId: key.reminderId, body: "original" }, { deliveryId: "delivery-1" });
  assert.throws(
    () => ledger.record(key, { reminderId: key.reminderId, body: "different" }, { deliveryId: "delivery-2" }),
    DeliveryConflictError,
  );
  // The matching-digest hydration is idempotent and preserves the first receipt.
  const same = ledger.record(key, { reminderId: key.reminderId, body: "original" }, { deliveryId: "delivery-1" });
  assert.deepEqual(same.receipt, { deliveryId: "delivery-1" });
});
