import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveReviewCoverageManifest } from "../src/review/manifest.js";
import { partitionReviewManifest } from "../src/review/partition.js";
import {
  isReviewProvenanceRecord,
  resumableUnitCoverage,
  reviewPromptDigest,
  reviewProvenanceFingerprintMatches,
  reviewRuleSetDigest,
  type ReviewProvenanceFingerprint,
  type ReviewProvenanceRecord,
} from "../src/review/provenance.js";

/**
 * W041 — review provenance and replay. Records bind the exact mutation
 * (commit, prompt, manifest, partition, rule set) to the reviewer identity,
 * inspected units, findings, verification, and disposition; any fingerprint
 * change invalidates replay, and resume requires an approval with complete
 * coverage under the exact current fingerprint.
 */

const STATUS = "M  src/kernel/a.ts\0?? src/ui/b.ts\0";

function fingerprint(overrides: Partial<ReviewProvenanceFingerprint> = {}): ReviewProvenanceFingerprint {
  const manifest = deriveReviewCoverageManifest({ statusOutput: STATUS });
  const partition = partitionReviewManifest(manifest);
  return {
    commitHash: undefined,
    promptDigest: reviewPromptDigest(undefined),
    manifestDigest: manifest.digest,
    partitionDigest: partition.digest,
    ruleSetDigest: reviewRuleSetDigest(),
    ...overrides,
  };
}

function record(overrides: Partial<ReviewProvenanceRecord> = {}): ReviewProvenanceRecord {
  return {
    version: 1,
    workspace: "/ws",
    fingerprint: fingerprint(),
    reviewer: "schedule:hub-reviewer-x",
    inspectedUnits: ["src/kernel"],
    coveredPaths: ["src/kernel/a.ts"],
    findings: "approved with findings",
    verification: ["axes: 3/5", "coverage: complete"],
    disposition: "approved",
    recordedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("the rule-set digest is stable and binds every rule table plus the unit cap", () => {
  assert.equal(reviewRuleSetDigest(), reviewRuleSetDigest());
  assert.match(reviewRuleSetDigest(), /^[0-9a-f]{64}$/);
  // The digest is content-derived: it is not the trivial constant.
  assert.notEqual(reviewRuleSetDigest(), "0".repeat(64));
});

test("the prompt digest distinguishes the same diff under a different ask", () => {
  const none = reviewPromptDigest(undefined);
  assert.equal(none, reviewPromptDigest(undefined));
  assert.match(none, /^[0-9a-f]{64}$/);
  assert.notEqual(none, reviewPromptDigest("fix the bug"));
  assert.notEqual(reviewPromptDigest("fix the bug"), reviewPromptDigest("fix the bug now"));
});

test("fingerprint matching fails closed on every component", () => {
  const current = fingerprint();
  assert.ok(reviewProvenanceFingerprintMatches(record(), current));
  assert.equal(reviewProvenanceFingerprintMatches(record({ fingerprint: fingerprint({ commitHash: "abc" }) }), current), false);
  assert.equal(reviewProvenanceFingerprintMatches(record({ fingerprint: fingerprint({ promptDigest: "x" }) }), current), false);
  assert.equal(reviewProvenanceFingerprintMatches(record({ fingerprint: fingerprint({ manifestDigest: "x" }) }), current), false);
  assert.equal(reviewProvenanceFingerprintMatches(record({ fingerprint: fingerprint({ partitionDigest: "x" }) }), current), false);
  assert.equal(reviewProvenanceFingerprintMatches(record({ fingerprint: fingerprint({ ruleSetDigest: "x" }) }), current), false);
  // commitHash undefined vs defined never matches, in either direction.
  const withCommit = fingerprint({ commitHash: "abc123" });
  assert.equal(reviewProvenanceFingerprintMatches(record({ fingerprint: current }), withCommit), false);
  assert.ok(reviewProvenanceFingerprintMatches(record({ fingerprint: withCommit }), withCommit));
});

test("isReviewProvenanceRecord rejects malformed records", () => {
  assert.ok(isReviewProvenanceRecord(record()));
  assert.equal(isReviewProvenanceRecord({ ...record(), version: 2 }), false);
  assert.equal(isReviewProvenanceRecord({ ...record(), workspace: "" }), false);
  assert.equal(isReviewProvenanceRecord({ ...record(), disposition: "nope" }), false);
  assert.equal(isReviewProvenanceRecord({ ...record(), inspectedUnits: [] }), false);
  assert.equal(isReviewProvenanceRecord({ ...record(), findings: "" }), false);
  assert.equal(isReviewProvenanceRecord({ ...record(), recordedAt: "not a date" }), false);
  assert.equal(isReviewProvenanceRecord({ ...record(), verification: ["ok", ""] }), false);
  assert.equal(isReviewProvenanceRecord({ ...record(), fingerprint: { ...fingerprint(), manifestDigest: "" } }), false);
  assert.equal(isReviewProvenanceRecord({ ...record(), fingerprint: { ...fingerprint(), promptDigest: 7 } }), false);
  assert.equal(isReviewProvenanceRecord("not a record"), false);
  assert.equal(isReviewProvenanceRecord(null), false);
});

test("resume requires approval with complete coverage under the exact fingerprint", () => {
  const current = fingerprint();
  const units = [
    { id: "src/kernel", requiredCoverage: ["src/kernel/a.ts"] },
    { id: "src/ui", requiredCoverage: ["src/ui/b.ts"] },
    { id: "integration", requiredCoverage: ["src/kernel", "src/ui"] },
  ];

  // Exact match with complete coverage resumes.
  const kernelApproved = record({ inspectedUnits: ["src/kernel"], coveredPaths: ["src/kernel/a.ts"] });
  const resumable = resumableUnitCoverage({ records: [kernelApproved], fingerprint: current, units });
  assert.deepEqual(resumable.get("src/kernel"), ["src/kernel/a.ts"]);
  assert.equal(resumable.has("src/ui"), false);

  // Every fingerprint component change kills resume — stale evidence is history.
  for (const stale of [
    record({ fingerprint: fingerprint({ commitHash: "abc" }) }),
    record({ fingerprint: fingerprint({ manifestDigest: "changed" }) }),
    record({ fingerprint: fingerprint({ partitionDigest: "changed" }) }),
    record({ fingerprint: fingerprint({ ruleSetDigest: "changed" }) }),
    record({ fingerprint: fingerprint({ promptDigest: "changed" }) }),
  ]) {
    const none = resumableUnitCoverage({ records: [stale], fingerprint: current, units });
    assert.equal(none.size, 0);
  }

  // Rejections and interruptions never resume, even at matching fingerprints.
  assert.equal(resumableUnitCoverage({
    records: [record({ disposition: "changes_requested" })],
    fingerprint: current,
    units,
  }).size, 0);
  assert.equal(resumableUnitCoverage({
    records: [record({ disposition: "interrupted" })],
    fingerprint: current,
    units,
  }).size, 0);

  // Incomplete coverage never resumes.
  assert.equal(resumableUnitCoverage({
    records: [record({ coveredPaths: [] })],
    fingerprint: current,
    units,
  }).size, 0);

  // The newest matching record wins: a later rejection after an approval
  // keeps the unit non-resumable (records are scanned newest-first).
  assert.equal(resumableUnitCoverage({
    records: [kernelApproved, record({ inspectedUnits: ["src/kernel"], disposition: "changes_requested" })],
    fingerprint: current,
    units,
  }).size, 0);

  // The integration unit resumes on covered unit ids, not paths.
  const integration = record({ inspectedUnits: ["integration"], coveredPaths: ["src/kernel", "src/ui"] });
  assert.deepEqual(
    resumableUnitCoverage({ records: [integration], fingerprint: current, units }).get("integration"),
    ["src/kernel", "src/ui"],
  );
});
