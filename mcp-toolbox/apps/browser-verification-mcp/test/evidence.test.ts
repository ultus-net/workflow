import assert from "node:assert/strict";
import test from "node:test";

import {
  browserEvidenceSummary,
  buildEvidence,
  pageHash,
  sha256,
  stableStringify,
  validateEvidenceShape,
  verifyEvidenceHash,
  type BrowserEvidenceRecord,
} from "../src/evidence.js";

function sample(overrides: Partial<Parameters<typeof buildEvidence>[0]> = {}): BrowserEvidenceRecord {
  return buildEvidence({
    capability: "browser-verification-mcp/run_verification",
    profile: "verification",
    actionKind: "verify_flow",
    detail: { requestedUrl: "https://app.test/" },
    subject: { kind: "browser_page", url: "https://app.test/", origin: "https://app.test", pageHash: pageHash("https://app.test/", "Fixture") },
    result: { outcome: "passed", summary: "all good", assertions: { passed: 1, failed: 0 }, truncated: false },
    urlBefore: "about:blank",
    urlAfter: "https://app.test/",
    provenance: { tool: "run_verification", targetId: "T1", sessionId: "S1" },
    previousHash: null,
    ...overrides,
  });
}

test("stamps a canonical hash that verifies and chains to the previous record", () => {
  const first = sample();
  assert.equal(validateEvidenceShape(first), true);
  assert.equal(verifyEvidenceHash(first), true);
  const second = sample({ previousHash: first.hash });
  assert.equal(second.previousHash, first.hash);
  assert.notEqual(second.hash, first.hash);
  assert.equal(verifyEvidenceHash(second), true);
});

test("detects tampering with the stamped body", () => {
  const record = sample();
  const tampered: BrowserEvidenceRecord = { ...record, result: { ...record.result, outcome: "failed" } };
  assert.equal(verifyEvidenceHash(tampered), false);
});

test("stableStringify is order-independent so the stamp is reproducible", () => {
  assert.equal(stableStringify({ b: 1, a: [{ y: 2, x: 1 }] }), stableStringify({ a: [{ x: 1, y: 2 }], b: 1 }));
  assert.equal(sha256("abc"), sha256("abc"));
  assert.notEqual(sha256("abc"), sha256("abd"));
});

test("rejects records that do not match the admitted shape", () => {
  const record = sample();
  assert.equal(validateEvidenceShape(null), false);
  assert.equal(validateEvidenceShape({ ...record, evidenceClass: "assertion" }), false);
  assert.equal(validateEvidenceShape({ ...record, hash: "not-hex" }), false);
  assert.equal(validateEvidenceShape({ ...record, subject: { kind: "browser_page", url: "x", origin: "y" } }), false);
  assert.equal(validateEvidenceShape({ ...record, source: { kind: "other", capability: "x", profile: "verification" } }), false);
});

test("summarizes the record for verification-accountability admission", () => {
  const record = sample();
  const summary = browserEvidenceSummary(record);
  assert.equal(summary.capability, "browser-verification-mcp/run_verification");
  assert.equal(summary.evidenceId, record.id);
  assert.equal(summary.evidenceHash, record.hash);
  assert.equal(summary.outcome, "passed");
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.url, "https://app.test/");
});