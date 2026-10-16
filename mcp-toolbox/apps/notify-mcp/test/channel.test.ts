import assert from "node:assert/strict";
import test from "node:test";

import { channelByName, defaultChannel, RecordingChannel } from "../src/channel.js";

/**
 * The channel seam's v1 contract: recording only, no network, deterministic
 * with an injected clock and id source. A future real channel must satisfy the
 * same `deliver` shape; these pins hold the seam so that swap is mechanical.
 */

test("the recording channel captures the notification and returns a receipt", async () => {
  const channel = new RecordingChannel({ now: () => new Date("2026-10-16T08:00:00.000Z"), newId: () => "delivery-fixed" });
  const receipt = await channel.deliver({ reminderId: "reminder-meds-0800", recipient: "care-recipient", body: "Take your 08:00 medication." });
  assert.deepEqual(receipt, {
    deliveryId: "delivery-fixed",
    channel: "recording",
    delivered: true,
    deliveredAt: "2026-10-16T08:00:00.000Z",
  });
  assert.deepEqual(channel.recorded(), [{ reminderId: "reminder-meds-0800", recipient: "care-recipient", body: "Take your 08:00 medication." }]);
});

test("the default channel is the recording channel (v1 ships the seam only)", () => {
  assert.equal(defaultChannel().name, "recording");
  assert.equal(channelByName("recording").name, "recording");
});

test("an unknown channel name fails closed", () => {
  assert.throws(() => channelByName("discord"), /unknown notification channel 'discord'/);
  assert.throws(() => channelByName(""), /unknown notification channel/);
});
