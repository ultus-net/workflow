import assert from "node:assert/strict";
import test from "node:test";

import { PermissionBroker } from "../src/ui/permission-broker.js";
import type { PolicyDecision } from "../src/kernel/contracts.js";
import type { ProposedToolAction } from "../src/application/host.js";

// W112 — the grant lifecycle (docs/PARKED_AND_LIMITATIONS.md P2): allow_always
// gains expiry (a bounded TTL recorded at grant time), ownership (the granting
// session scope), and consumption accounting, with the fail-closed posture —
// unknown/stale/malformed/foreign grant state re-asks; nothing auto-allows on
// ambiguity. The un-expired same-session path is pinned behaviorally identical
// so the lifecycle cannot drift the common path.

function action(tool: string, overrides: Partial<ProposedToolAction> = {}): ProposedToolAction {
  return {
    sessionId: "session",
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

function denyAll(reason: string): (candidate: ProposedToolAction) => { kind: "deny"; code: string; reason: string } {
  return () => ({ kind: "deny", code: "TEST", reason });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Awaits the intercept decision without hanging when the request parks
 * (parked asks never resolve until the operator answers). */
async function decisionOrPark(
  pending: PolicyDecision | Promise<PolicyDecision>,
): Promise<PolicyDecision | "parked"> {
  return Promise.race([pending, settle().then(() => "parked" as const)]);
}

/** Injectable clock for the expiry boundary pins. */
function clock(start = 1_000_000): { readonly now: () => number; readonly advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

/** Parks a request and answers it allow_always the way the owning session's
 * channel would (the channel passes its own session key). */
async function grantAlways(broker: PermissionBroker, tool: string, sessionId: string): Promise<void> {
  broker.setMode("ask");
  const pending = broker.intercept(action(tool, { sessionId }), allowAll());
  await settle();
  const request = broker.pendingRequest(sessionId);
  assert.ok(request !== undefined, "the ask parks before the grant exists");
  assert.equal(broker.answer(request.id, "allow_always", sessionId), true);
  await pending;
}

test("W112 grants: the allow_always grant expires at its recorded TTL (before/after)", async () => {
  const time = clock();
  const TTL = 10_000;
  const broker = new PermissionBroker({ now: time.now, grantTtlMs: TTL });
  await grantAlways(broker, "run_commands", "session");

  const grant = broker.patterns().grants[0];
  assert.ok(grant !== undefined, "the grant record exists");
  assert.equal(grant.expiresAt, 1_000_000 + TTL, "the expiry is recorded at grant time");

  // Before the TTL: the un-expired path — no park, policy consulted.
  time.advance(TTL - 1);
  assert.deepEqual(await decisionOrPark(broker.intercept(action("run_commands"), allowAll())), { kind: "allow" });
  assert.equal(broker.pendingRequest("session"), undefined, "no park before the TTL");

  // At the boundary the bounded TTL is spent: fail closed, the request re-asks.
  time.advance(1);
  assert.equal(await decisionOrPark(broker.intercept(action("run_commands"), allowAll())), "parked", "an expired grant re-asks");
  assert.ok(broker.pendingRequest("session") !== undefined, "the expired grant does not auto-allow");
  const stale = broker.pendingRequest("session")!;
  assert.equal(broker.answer(stale.id, "reject_always", "session"), true);
  assert.deepEqual(broker.patterns(), { alwaysAllow: [], alwaysReject: ["run_commands"], grants: [] }, "the operator's newest answer wins: reject_always removes the stale grant");

  // A fresh grant after expiry and reset auto-allows again (a lifecycle, not a tombstone).
  broker.resetPatterns();
  await grantAlways(broker, "run_commands", "session");
  assert.deepEqual(await decisionOrPark(broker.intercept(action("run_commands"), allowAll())), { kind: "allow" }, "a fresh grant auto-allows again");
});

test("W112 grants: a grant never leaks across sessions", async () => {
  const broker = new PermissionBroker();
  await grantAlways(broker, "run_commands", "agent-a");

  // Another session's identical tool does NOT ride A's grant: it re-asks.
  const foreign = broker.intercept(action("run_commands", { sessionId: "agent-b" }), allowAll());
  await settle();
  assert.ok(broker.pendingRequest("agent-b") !== undefined, "session B re-asks (no cross-session leak)");
  assert.equal(broker.pendingRequest("agent-a"), undefined, "the owner has no park");
  const bRequest = broker.pendingRequest("agent-b")!;
  assert.equal(broker.answer(bRequest.id, "reject_once", "agent-b"), true);
  assert.deepEqual(await foreign, { kind: "deny", code: "OPERATOR_REJECTED", reason: "rejected by operator" });

  // The owning session still auto-allows without a park.
  assert.deepEqual(await decisionOrPark(broker.intercept(action("run_commands", { sessionId: "agent-a" }), allowAll())), { kind: "allow" }, "the owner's grant still applies");
  assert.equal(broker.pendingRequest("agent-a"), undefined);

  const grant = broker.patterns().grants[0];
  assert.ok(grant !== undefined, "the grant record is visible");
  assert.equal(grant.sessionId, "agent-a", "the grant records the session scope that created it");
  assert.equal(grant.consumed, 1, "the foreign attempt consumed nothing; the owner's allow did");
});

test("W112 grants: each automatic-allow consumption increments the grant counter", async () => {
  const broker = new PermissionBroker();
  await grantAlways(broker, "run_commands", "session");

  const initial = broker.patterns().grants[0];
  assert.ok(initial !== undefined, "the grant record exists");
  assert.equal(initial.consumed, 0, "a fresh grant is unconsumed");

  assert.deepEqual(await decisionOrPark(broker.intercept(action("run_commands"), allowAll())), { kind: "allow" });
  assert.equal(broker.patterns().grants[0]?.consumed, 1, "the first automatic allow consumed once");
  assert.equal(broker.pendingRequest("session"), undefined, "consumption bypasses the prompt");

  // A policy denial beneath a live grant still consumed the grant-backed
  // bypass: the prompt was skipped; the policy decided beneath it.
  const denied = await decisionOrPark(broker.intercept(action("run_commands"), denyAll("workspace")));
  assert.deepEqual(denied, { kind: "deny", code: "TEST", reason: "workspace" });
  assert.equal(broker.patterns().grants[0]?.consumed, 2, "every grant-backed intercept is counted");

  // resetPatterns clears the lifecycle with the lists.
  broker.resetPatterns();
  assert.deepEqual(broker.patterns(), { alwaysAllow: [], alwaysReject: [], grants: [] });
  const reask = broker.intercept(action("run_commands"), allowAll());
  await settle();
  assert.ok(broker.pendingRequest("session") !== undefined, "after a reset the request re-asks");
  assert.equal(broker.answer(broker.pendingRequest("session")!.id, "reject_once", "session"), true);
  assert.deepEqual(await reask, { kind: "deny", code: "OPERATOR_REJECTED", reason: "rejected by operator" });
});

test("W112 grants: the un-expired same-session path stays behaviorally identical", async () => {
  const broker = new PermissionBroker();
  await grantAlways(broker, "run_commands", "session");

  // The remembered allow skips the prompt but never overrides the policy —
  // the legacy pin's semantics, unchanged.
  assert.deepEqual(await decisionOrPark(broker.intercept(action("run_commands"), allowAll())), { kind: "allow" });
  assert.equal(broker.pendingRequest("session"), undefined, "the remembered allow does not park");
  const denied = await decisionOrPark(broker.intercept(action("run_commands"), denyAll("workspace")));
  assert.deepEqual(denied, { kind: "deny", code: "TEST", reason: "workspace" }, "always-allow never overrides a policy denial");

  // alwaysReject still blocks without parking (the newest operator answer wins).
  const second = broker.intercept(action("web_search"), allowAll());
  await settle();
  assert.equal(broker.answer(broker.pendingRequest("session")!.id, "reject_always", "session"), true);
  assert.deepEqual(await second, { kind: "deny", code: "OPERATOR_REJECTED", reason: "rejected by operator (always)" });
  const rejected = await decisionOrPark(broker.intercept(action("web_search"), allowAll()));
  assert.ok(rejected !== "parked", "always-reject blocks the next request without parking");
  assert.equal(rejected.kind, "deny", "always-reject blocks the next request without parking");
  assert.equal(broker.pendingRequest("session"), undefined, "always-reject never parks");

  // The legacy tool lists stay tool-name strings; the grant rides additively.
  const patterns = broker.patterns();
  assert.ok(Array.isArray(patterns.grants), "the grant records ride patterns additively");
  assert.deepEqual(patterns.alwaysAllow, ["run_commands"]);
  assert.deepEqual(patterns.alwaysReject, ["web_search"]);
  assert.deepEqual(patterns.grants.map((grant) => grant.tool), ["run_commands"]);

  // Auto mode never consults grants (the pass-through is unchanged).
  broker.setMode("auto");
  assert.deepEqual(await decisionOrPark(broker.intercept(action("run_commands"), allowAll())), { kind: "allow" });
  assert.equal(broker.patterns().grants[0]?.consumed, 2, "auto mode consumed nothing new");
});

test("W112 grants: malformed grant state fails closed (re-asks, never auto-allows)", async () => {
  const broker = new PermissionBroker({
    grants: [
      { tool: "run_commands", sessionId: "session", expiresAt: "not-a-number", consumed: 0 },
      { tool: "run_commands", sessionId: "session", consumed: 0 },
      { tool: "", sessionId: "session", expiresAt: 9_007_199_254_740_991, consumed: 0 },
      { tool: "run_commands", sessionId: "  ", expiresAt: 9_007_199_254_740_991, consumed: 0 },
      { tool: "run_commands", sessionId: "session", expiresAt: Number.NaN, consumed: 0 },
      { tool: "run_commands", sessionId: "session", expiresAt: Number.POSITIVE_INFINITY, consumed: 0 },
      { tool: "run_commands", sessionId: "session", expiresAt: 9_007_199_254_740_991, consumed: -1 },
      { tool: "run_commands", sessionId: "session", expiresAt: 9_007_199_254_740_991, consumed: 1.5 },
      "not-even-an-object",
    ],
  });
  assert.deepEqual(broker.patterns().grants, [], "malformed seeded entries are dropped, never stored");
  broker.setMode("ask");
  assert.equal(await decisionOrPark(broker.intercept(action("run_commands"), allowAll())), "parked", "no malformed record auto-allows: the request re-asks");
  assert.ok(broker.pendingRequest("session") !== undefined);
  assert.equal(broker.answer(broker.pendingRequest("session")!.id, "reject_once", "session"), true);
});

test("W112 grants: an unscoped park's allow_always records no grant (the legacy edge, pinned)", async () => {
  // A park with no session scope could not be owned — the operator's "always"
  // resolves THIS request only and records nothing (fail closed; the review's
  // P3: the legacy edge is pinned so it cannot silently become a grant).
  const broker = new PermissionBroker();
  broker.setMode("ask");
  const pending = broker.intercept(action("run_commands", { sessionId: undefined as never }), allowAll());
  await settle();
  const request = broker.pendingRequest();
  assert.ok(request !== undefined, "the unscoped park still parks");
  assert.equal(broker.answer(request.id, "allow_always"), true, "the unscoped answer resolves");
  assert.deepEqual(await pending, { kind: "allow" }, "this request's allow rides the answer, not a grant");
  assert.deepEqual(broker.patterns().grants, [], "no grant record exists — nothing was ownable");
});

test("W112 grants: a well-formed seeded grant restores the lifecycle", async () => {
  const control = new PermissionBroker({
    grants: [{ tool: "run_commands", sessionId: "session", expiresAt: Number.MAX_SAFE_INTEGER, consumed: 7 }],
  });
  control.setMode("ask");
  assert.deepEqual(await decisionOrPark(control.intercept(action("run_commands"), allowAll())), { kind: "allow" }, "a well-formed seed grant auto-allows");
  assert.equal(control.pendingRequest("session"), undefined, "the seeded grant bypasses the prompt");
  assert.equal(control.patterns().grants[0]?.consumed, 8, "the seeded consumed count carries forward and increments");

  // A seed owned by another session stays inert for this session.
  const foreign = new PermissionBroker({
    grants: [{ tool: "run_commands", sessionId: "agent-a", expiresAt: Number.MAX_SAFE_INTEGER, consumed: 0 }],
  });
  foreign.setMode("ask");
  assert.equal(await decisionOrPark(foreign.intercept(action("run_commands"), allowAll())), "parked", "a seeded grant for another session re-asks");
  const parked = foreign.pendingRequest("session")!;
  assert.equal(foreign.answer(parked.id, "reject_once", "session"), true);
});
