import assert from "node:assert/strict";
import test from "node:test";

import { NOT_APPROVABLE_REASON, PermissionBroker } from "../src/ui/permission-broker.js";
import type { ProposedToolAction } from "../src/application/host.js";
import type { PolicyDecision } from "../src/kernel/contracts.js";

/**
 * P10 (GitHub issue #289, SECURITY_ASSURANCE residual #26): the server-side
 * approvability gate. The broker classifies at parking (the W115
 * `inputOverCap` flag — the SAME measure the approval card renders as
 * NOT-APPROVABLE-WITH-REASON and the poll transport strips on), and the
 * answer now enforces that classification: a decision that would AUTHORIZE
 * the uninspectable payload refuses fail-closed without consuming the park,
 * while every rejection path always resolves. These pins capture the gate
 * red-first; the route renders the refusal as a structured 409 (pinned in
 * test/web.test.ts).
 */

function action(tool: string, overrides: Partial<ProposedToolAction> = {}): ProposedToolAction {
  return {
    sessionId: "agent-a",
    taskId: "T1" as never,
    tool,
    mutating: true,
    subjects: [],
    input: { command: "ls" },
    ...overrides,
  };
}

function allowAll(): (candidate: ProposedToolAction) => { kind: "allow" } {
  return () => ({ kind: "allow" });
}

const OVER_CAP_INPUT = "y".repeat(64 * 1024 + 100);

async function parkOverCap(
  broker: PermissionBroker,
  sessionId = "agent-a",
): Promise<{ readonly id: string; readonly parkedAction: Promise<PolicyDecision> }> {
  broker.setMode("ask");
  // intercept returns the decision synchronously in auto mode and a pending
  // promise when it parks; Promise.resolve normalizes the union for the await.
  const parkedAction = Promise.resolve(
    broker.intercept(action("run_commands", { sessionId, input: OVER_CAP_INPUT }), allowAll()),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const parked = broker.pendingRequest(sessionId);
  assert.ok(parked !== undefined, "the over-cap request parks for the operator");
  assert.equal(parked.inputOverCap, true, "the parking-time classification flagged the payload");
  return { id: parked.id, parkedAction };
}

test("P10: the broker refuses to authorize an over-cap parked request", async () => {
  const broker = new PermissionBroker();
  const { id, parkedAction } = await parkOverCap(broker);

  const refused = broker.answer(id, "allow_once");
  assert.deepEqual(refused, {
    refused: "not-approvable",
    reason: NOT_APPROVABLE_REASON,
  }, "allow_once on an over-cap park returns the machine-readable refusal, not a resolve");

  // Fail closed WITHOUT consuming the park: the card stays, and a rejection
  // can still resolve the request.
  const stillParked = broker.pendingRequest("agent-a");
  assert.ok(stillParked !== undefined, "the refused answer does NOT consume the park");
  assert.equal(stillParked.id, id);
  assert.equal(broker.answer(id, "reject_once"), true, "a rejection still resolves the refused park");
  assert.deepEqual(await parkedAction, {
    kind: "deny",
    code: "OPERATOR_REJECTED",
    reason: "rejected by operator",
  }, "the eventual rejection resolves the parked action");
});

test("P10: allow_always on an over-cap park is refused and records NO grant", async () => {
  const broker = new PermissionBroker();
  const { id } = await parkOverCap(broker);

  assert.deepEqual(broker.answer(id, "allow_always"), {
    refused: "not-approvable",
    reason: NOT_APPROVABLE_REASON,
  }, "allow_always on an over-cap park is refused server-side");

  // The grant-lifecycle interaction: a refused approval records nothing —
  // no lifecycle grant, no live allow, and the park survives for a rejection.
  const patterns = broker.patterns();
  assert.deepEqual(patterns.alwaysAllow, [], "no always-allow is recorded from the refused answer");
  assert.deepEqual(patterns.grants, [], "no grant lifecycle record is created from the refused answer");
  assert.ok(broker.pendingRequest("agent-a") !== undefined, "the park is not consumed by the refusal");
});

test("P10: reject paths always resolve an over-cap parked request", async () => {
  // reject_once resolves the park and denies the action.
  const once = new PermissionBroker();
  const { id: onceId, parkedAction: oncePending } = await parkOverCap(once);
  assert.equal(once.answer(onceId, "reject_once"), true, "reject_once is never refused");
  assert.deepEqual(await oncePending, {
    kind: "deny",
    code: "OPERATOR_REJECTED",
    reason: "rejected by operator",
  });

  // reject_always resolves too, and records the operator's reject pattern.
  const always = new PermissionBroker();
  const { id: alwaysId, parkedAction: alwaysPending } = await parkOverCap(always);
  assert.equal(always.answer(alwaysId, "reject_always"), true, "reject_always is never refused");
  assert.deepEqual(await alwaysPending, {
    kind: "deny",
    code: "OPERATOR_REJECTED",
    reason: "rejected by operator (always)",
  });
  assert.deepEqual(always.patterns().alwaysReject, ["run_commands"]);
});

test("P10: an un-flagged parked request answers unchanged", async () => {
  const broker = new PermissionBroker();
  broker.setMode("ask");
  const parked = broker.intercept(action("run_commands", { input: { command: "build" } }), allowAll());
  await new Promise((resolve) => setImmediate(resolve));
  const request = broker.pendingRequest("agent-a");
  assert.ok(request !== undefined);
  assert.equal(request.inputOverCap, false, "an under-cap payload is not flagged");

  // allow_once resolves exactly as before the gate.
  assert.equal(broker.answer(request.id, "allow_once"), true);
  assert.deepEqual(await parked, { kind: "allow" });

  // allow_always records the W112 grant lifecycle exactly as before the gate.
  const parkedAlways = broker.intercept(action("web_search"), allowAll());
  await new Promise((resolve) => setImmediate(resolve));
  const alwaysRequest = broker.pendingRequest("agent-a");
  assert.ok(alwaysRequest !== undefined);
  assert.equal(broker.answer(alwaysRequest.id, "allow_always"), true);
  assert.deepEqual(await parkedAlways, { kind: "allow" });
  const patterns = broker.patterns();
  assert.equal(patterns.grants.length, 1, "the un-flagged allow_always still records its grant");
  assert.equal(patterns.grants[0]?.tool, "web_search");
  assert.equal(patterns.grants[0]?.sessionId, "agent-a");
});

test("P10: the approvability refusal follows the session-scoped answer rules", async () => {
  const broker = new PermissionBroker();
  const { id } = await parkOverCap(broker, "agent-a");

  // W141 ownership stays first: a foreign key does not reach the gate (and
  // does not consume the park).
  assert.equal(broker.answer(id, "allow_once", "agent-b"), false, "a foreign sessionKey still fails closed before the gate");
  assert.ok(broker.pendingRequest("agent-a") !== undefined);
  // The owning key reaches the gate and gets the structured refusal.
  assert.deepEqual(broker.answer(id, "allow_once", "agent-a"), {
    refused: "not-approvable",
    reason: NOT_APPROVABLE_REASON,
  });
});