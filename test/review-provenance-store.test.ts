import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { createJsonReviewProvenanceStore, DEFAULT_REVIEW_PROVENANCE_MAX_RECORDS } from "../src/integrations/review-provenance-store.js";
import { isReviewProvenanceRecord, type ReviewProvenanceRecord } from "../src/review/provenance.js";

/**
 * W041 — the durable provenance journal. NDJSON append-only with a bounded
 * trim, fail-closed load validation, and durability across store instances.
 */

function sampleRecord(index: number): ReviewProvenanceRecord {
  return {
    version: 1,
    workspace: `/ws-${index}`,
    fingerprint: {
      commitHash: undefined,
      promptDigest: "a".repeat(64),
      manifestDigest: `${index}`.padEnd(64, "0"),
      partitionDigest: "b".repeat(64),
      ruleSetDigest: "c".repeat(64),
    },
    reviewer: `schedule:hub-reviewer-${index}`,
    inspectedUnits: ["src/kernel"],
    coveredPaths: ["src/kernel/a.ts"],
    findings: `findings ${index}`,
    verification: ["axes: 3/5"],
    disposition: "approved",
    recordedAt: new Date().toISOString(),
  };
}

function tempStore(t: TestContext, options?: { readonly maxRecords?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "wf-review-provenance-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "nested", "review-provenance.jsonl");
  return { path, store: createJsonReviewProvenanceStore(path, options) };
}

test("appended records persist and reload across store instances", async (t) => {
  const { path, store } = tempStore(t);
  await store.append(sampleRecord(1));
  await store.append(sampleRecord(2));

  const records = await store.records();
  assert.equal(records.length, 2);
  assert.equal(records[0]?.workspace, "/ws-1");
  assert.equal(records[1]?.workspace, "/ws-2");

  // Durability: a fresh store instance over the same file reads the history.
  const reopened = createJsonReviewProvenanceStore(path);
  const reread = await reopened.records();
  assert.deepEqual(reread.map((record) => record.findings), ["findings 1", "findings 2"]);
  assert.ok(reread.every(isReviewProvenanceRecord));
});

test("a missing journal reads as empty, a corrupt one fails closed", async (t) => {
  const { path, store } = tempStore(t);
  assert.deepEqual(await store.records(), []);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sampleRecord(1))}\n{ corrupt json\n`, "utf8");
  await assert.rejects(store.records(), /invalid review provenance record|corrupt|JSON/i);
});

test("the journal trims to the newest half when it grows past the cap", async (t) => {
  const { store } = tempStore(t, { maxRecords: 8 });
  for (let index = 0; index < 9; index += 1) {
    await store.append(sampleRecord(index));
  }
  const records = await store.records();
  // 9 > 8 triggers a rewrite keeping ceil(8/2) = 4 newest records.
  assert.equal(records.length, 4);
  assert.deepEqual(records.map((record) => record.workspace), ["/ws-5", "/ws-6", "/ws-7", "/ws-8"]);
});

test("the default cap keeps the journal bounded", () => {
  assert.equal(DEFAULT_REVIEW_PROVENANCE_MAX_RECORDS, 256);
});
