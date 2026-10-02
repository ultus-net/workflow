import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  createEgressPolicyRevisionStore,
  isApprovableEgressDenial,
  loadRevisionsTable,
} from "../src/integrations/egress-policy-revisions.js";
import type { EgressPolicyFingerprint } from "../src/integrations/egress-policy-revisions.js";

/**
 * W182 (NVIDIA adoption wave A7): the hub-scoped durable egress policy
 * revision store. These pins cover the issue's acceptance:
 *
 * - park/answer fails closed on timeout (tighten-never-loosen);
 * - a durable revision persists a restart but resets when the backing
 *   session/sandbox generation changes (reset-on-recreate);
 * - a policy or provider change between ask and answer invalidates the park
 *   (no stale approvals);
 * - parked payloads are redacted (query string stripped; no secret or
 *   placeholder fields exist in the shape).
 *
 * This is approval machinery, NOT an enforcement claim: the store never
 * loosens an explicit enforce deny, and merging a revision is a record, not a
 * proxy enforcement guarantee.
 */

const baseline = { version: 0, rules: [{ id: "baseline", host: "api.example.com", port: 443, mode: "enforce" as const }] };
const proposal = {
  policy: "egress_policy",
  reason: "no_matching_rule",
  host: "api.example.com",
  port: 443,
  method: "POST",
  pathname: "/v1/chat",
};

function fingerprint(policyVersion = 7, providerFingerprint = "api.example.com:443|upstream:https://openrouter.ai"): EgressPolicyFingerprint {
  return { policyVersion, providerFingerprint };
}

function store(path: string, overrides: { generation?: string; fingerprint?: () => EgressPolicyFingerprint; timeoutMs?: number } = {}) {
  return createEgressPolicyRevisionStore({
    path,
    baseline,
    generation: overrides.generation ?? "gen-1",
    fingerprint: overrides.fingerprint ?? (() => fingerprint()),
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
  });
}

test("W182: an approval merges a durable revision and is visible on the composed policy", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-egress-rev-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "revisions.json");
  const revisions = store(path);

  const parked = revisions.park(proposal);
  assert.equal(revisions.pendingCount, 1);
  const [pending] = revisions.pending();
  assert.ok(pending, "the redacted proposal is pending");
  assert.equal(revisions.answer(pending.requestId, "allow").status, "merged");
  assert.equal(await parked, "once");

  assert.equal(revisions.pendingCount, 0);
  assert.equal(revisions.revisions().length, 1);
  const policy = revisions.currentPolicy();
  assert.equal(policy.rules.length, 2, "baseline is preserved and one revision rule is added");
  assert.equal(policy.rules[1]?.host, "api.example.com");
  assert.deepEqual(policy.rules[1]?.methods, ["POST"]);
  assert.deepEqual(policy.rules[1]?.paths, ["/v1/chat"]);
  assert.equal(policy.rules[1]?.mode, "enforce");
});

test("W182: a deny resolves the hold reject and merges nothing (tighten-never-loosen)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-egress-rev-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const revisions = store(join(dir, "revisions.json"));

  const parked = revisions.park(proposal);
  const [pending] = revisions.pending();
  assert.ok(pending);
  assert.equal(revisions.answer(pending.requestId, "deny").status, "denied");
  assert.equal(await parked, "reject");
  assert.equal(revisions.revisions().length, 0);
});

test("W182: an unanswered park fails closed on timeout", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-egress-rev-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const revisions = store(join(dir, "revisions.json"), { timeoutMs: 5 });

  const parked = revisions.park(proposal);
  assert.equal(await parked, "reject", "an unanswered approval must never merge");
  // The park continuation drops the pending entry after the timeout fires.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(revisions.revisions().length, 0);
});

test("W182: a policy or provider change between ask and answer invalidates the park (no stale approval)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-egress-rev-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // The live fingerprint changes after the park: the approval is stale.
  let current = fingerprint(7, "api.example.com:443");
  const revisions = store(join(dir, "revisions.json"), { fingerprint: () => current });
  const parked = revisions.park(proposal);
  const [pending] = revisions.pending();
  assert.ok(pending);

  current = fingerprint(8, "api.example.com:443");
  assert.equal(revisions.answer(pending.requestId, "allow").status, "invalidated");
  assert.equal(await parked, "reject", "an invalidated approval never allows");
  assert.equal(revisions.revisions().length, 0);

  // The provider-binding axis invalidates independently of the policy version.
  const revisions2 = store(join(dir, "revisions-2.json"), { fingerprint: () => current });
  const parked2 = revisions2.park(proposal);
  const [pending2] = revisions2.pending();
  assert.ok(pending2);
  current = fingerprint(8, "api.example.com:443|credential:other");
  assert.equal(revisions2.answer(pending2.requestId, "allow").status, "invalidated");
  assert.equal(await parked2, "reject");
});

test("W182: a durable revision survives a restart with the same generation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-egress-rev-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "revisions.json");

  const first = store(path, { generation: "gen-1" });
  const parked = first.park(proposal);
  const [pending] = first.pending();
  assert.ok(pending);
  first.answer(pending.requestId, "allow");
  await parked;

  // Restart: a fresh store over the same path and generation reloads it.
  const restarted = store(path, { generation: "gen-1" });
  assert.equal(restarted.revisions().length, 1, "the revision persists across restart");
  assert.equal(restarted.generation, "gen-1");
});

test("W182: a revision resets when the backing session/sandbox is recreated (new generation)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-egress-rev-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "revisions.json");

  const first = store(path, { generation: "gen-1" });
  const parked = first.park(proposal);
  const [pending] = first.pending();
  assert.ok(pending);
  first.answer(pending.requestId, "allow");
  await parked;
  assert.equal(first.revisions().length, 1);

  // Recreate: the backing session/sandbox gets a new generation. A restarting
  // store at that generation filters the old revisions out — reset to baseline.
  const recreated = store(path, { generation: "gen-2" });
  assert.equal(recreated.revisions().length, 0, "a recreate resets the durable revisions");
  assert.deepEqual(recreated.currentPolicy().rules, baseline.rules);

  // The reset is persisted too: the journal no longer names the old generation.
  assert.equal(loadRevisionsTable(path).generation, "gen-2");
});

test("W182: resetForRecreate abandons pending asks and persists the reset", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-egress-rev-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "revisions.json");
  const revisions = store(path, { generation: "gen-1" });

  const parked = revisions.park(proposal);
  const [pending] = revisions.pending();
  assert.ok(pending);
  revisions.answer(pending.requestId, "allow");

  const before = revisions.park(proposal);
  revisions.resetForRecreate("gen-2");
  assert.equal(await before, "reject", "a recreate abandons a pending ask, fail closed");
  assert.equal(revisions.revisions().length, 0);
  assert.equal(revisions.generation, "gen-2");
  assert.equal(loadRevisionsTable(path).generation, "gen-2");
  assert.equal(await parked, "once");
});

test("W182: resetForRecreate gates on the current generation, not the construction-time one", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-egress-rev-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "revisions.json");
  const revisions = store(path, { generation: "gen-1" });

  const parked = revisions.park(proposal);
  const [pending] = revisions.pending();
  assert.ok(pending);
  revisions.answer(pending.requestId, "allow");
  await parked;

  // Reset forward (persists gen-2), then BACK to the construction-time
  // generation. Gating on `loaded.generation` (gen-1) would see "same
  // generation, no revisions" and skip the write, leaving the journal naming
  // gen-2. Gating on the CURRENT generation (gen-2) writes gen-1 as it must.
  revisions.resetForRecreate("gen-2");
  assert.equal(loadRevisionsTable(path).generation, "gen-2");
  revisions.resetForRecreate("gen-1");
  assert.equal(revisions.generation, "gen-1");
  assert.equal(loadRevisionsTable(path).generation, "gen-1", "the reset back to the construction-time generation is persisted");
  assert.equal(loadRevisionsTable(path).revisions.length, 0);
});

test("W182: parked payloads are redacted (query string stripped)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-egress-rev-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const revisions = store(join(dir, "revisions.json"));

  revisions.park({ ...proposal, pathname: "/v1/chat?key=SECRET&token=abc" });
  const [pending] = revisions.pending();
  assert.ok(pending);
  assert.equal(pending.proposal.pathname, "/v1/chat", "the query string is never parked");
  assert.equal(JSON.stringify(pending).includes("SECRET"), false);
  assert.equal(JSON.stringify(pending).includes("token"), false);
  revisions.cancelAll();
});

test("W182: credential-custody denials park for visibility but are never operator-approvable by an egress rule", () => {
  assert.equal(isApprovableEgressDenial({ ...proposal }), true);
  assert.equal(isApprovableEgressDenial({ ...proposal, policy: "egress-credential", reason: "foreign-credential" }), false);
  assert.equal(isApprovableEgressDenial({ ...proposal, policy: "credential_endpoint_mismatch", reason: "destination-outside-credential-binding" }), false);

  const dir = mkdtempSync(join(tmpdir(), "wf-egress-rev-"));
  try {
    const revisions = store(join(dir, "revisions.json"));
    const result = revisions.recordDenial({ ...proposal, policy: "egress-credential", reason: "foreign-credential" });
    assert.equal(result.parked, true, "the refusal is visible to the operator");
    assert.equal(result.approvable, false, "but a custody refusal is never approvable");
    assert.equal(revisions.pendingCount, 1);

    // Approving it fails closed: no revision merges.
    const [pending] = revisions.pending();
    assert.ok(pending);
    assert.equal(pending.approvable, false);
    assert.equal(revisions.answer(pending.requestId, "allow").status, "not-approvable");
    assert.equal(revisions.revisions().length, 0);
    revisions.cancelAll();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W182: a corrupt revision journal is refused, never silently emptied", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-egress-rev-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "revisions.json");
  writeFileSync(path, JSON.stringify({ version: 1, generation: "gen-1", revisions: [{ revision: -1 }] }));
  assert.throws(() => loadRevisionsTable(path), /invalid egress revision journal/);

  writeFileSync(path, "not json");
  assert.throws(() => loadRevisionsTable(path), /invalid egress revision journal/);

  const emptyPath = join(dir, "absent.json");
  assert.deepEqual(loadRevisionsTable(emptyPath), { generation: "", revisions: [] });

  // The atomic 0600 write is the persistence convention.
  const revisions = store(path.replace("revisions.json", "ok.json"), { generation: "gen-1" });
  const parked = revisions.park(proposal);
  const [pending] = revisions.pending();
  assert.ok(pending);
  revisions.answer(pending.requestId, "allow");
  void parked;
  const raw = readFileSync(path.replace("revisions.json", "ok.json"), "utf8");
  assert.equal(JSON.parse(raw).generation, "gen-1");
});
