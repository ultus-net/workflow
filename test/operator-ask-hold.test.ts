import assert from "node:assert/strict";
import test from "node:test";

import { createOperatorAskHold } from "../src/integrations/operator-ask-hold.js";

/**
 * The shared operator ask-hold primitive mirrors the landed daemon hold
 * (`src/integrations/opencode-server-authority.ts`): an ask parks, the operator
 * answer resolves it (tighten-never-loosen: reject wins, anything else maps to
 * the policy-allowed outcome), an unanswered hold fails closed on timeout, and
 * a stale early reply must not answer a later ask.
 */

const request = { requestId: "req-1", policy: "promotion-gate", reason: "promotion requires operator approval" } as const;

test("the hold parks an ask and exposes the pending request", () => {
  const hold = createOperatorAskHold({ timeoutMs: 60_000 });
  const parked = hold.park(request);

  assert.equal(hold.pendingCount, 1);
  assert.deepEqual(hold.pending, [request]);

  hold.answer("req-1", "once");
  assert.equal(hold.pendingCount, 0);
  return parked.then((reply) => assert.equal(reply, "once"));
});

test("the hold reconciles tighten-never-loosen: reject wins, any non-reject reply allows", async () => {
  const hold = createOperatorAskHold({ timeoutMs: 60_000 });
  const allow = hold.park({ ...request, requestId: "req-allow" });
  hold.answer("req-allow", "always");
  assert.equal(await allow, "once", "an always reply maps to the once (policy-allowed) outcome");

  const reject = hold.park({ ...request, requestId: "req-reject" });
  hold.answer("req-reject", "reject");
  assert.equal(await reject, "reject");
});

test("the hold fails an unanswered ask closed on timeout", async () => {
  const hold = createOperatorAskHold({ timeoutMs: 5 });
  const parked = hold.park(request);
  assert.equal(await parked, "reject", "an unanswered hold must never allow");
  assert.equal(hold.pendingCount, 0);
});

test("the hold consumes an early operator reply that raced ahead of the ask", async () => {
  const hold = createOperatorAskHold({ timeoutMs: 60_000 });
  assert.equal(hold.answer("req-early", "once"), false, "no pending entry yet: the reply is remembered");
  assert.equal(await hold.park({ ...request, requestId: "req-early" }), "once");
  assert.equal(hold.pendingCount, 0);
});

test("cancelAll resolves every pending hold to reject", async () => {
  const hold = createOperatorAskHold({ timeoutMs: 60_000 });
  const first = hold.park({ ...request, requestId: "req-a" });
  const second = hold.park({ ...request, requestId: "req-b" });
  assert.equal(hold.pendingCount, 2);

  hold.cancelAll();
  assert.equal(hold.pendingCount, 0);
  assert.deepEqual(await Promise.all([first, second]), ["reject", "reject"]);
});

test("a stale early reply must not answer a later ask", async () => {
  const hold = createOperatorAskHold({ timeoutMs: 5 });
  // Seed an early reply for req-stale, then time the ask out so the stale
  // entry is cleared. A second ask with the SAME id must wait for its own
  // answer, not the consumed stale one.
  hold.answer("req-stale", "once");
  assert.equal(await hold.park({ ...request, requestId: "req-stale" }), "once");

  const later = hold.park({ ...request, requestId: "req-stale" });
  assert.equal(await later, "reject", "the timeout resolves the later ask; the stale reply is gone");
});
