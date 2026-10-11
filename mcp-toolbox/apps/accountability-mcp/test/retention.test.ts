import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ReviewStore, retentionWindowMs as reviewRetentionWindowMs } from "../src/reviews.js";
import { VerificationStore, retentionWindowMs as verificationRetentionWindowMs, type VerificationAuthorities } from "../src/verification.js";

/**
 * The age dimension of the retention policy. Both subsystems keep the entry
 * (500) and byte (5 MiB) bounds they always had; these tests pin the added
 * age bound: a documented, configurable window, default 90 days, overridable
 * with ACCOUNTABILITY_RETENTION_DAYS, pruned on every write.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const subject = { kind: "fingerprint" as const, algorithm: "sha256", version: "1", scope: "review-diff", value: "a".repeat(64) };

function authorities(): VerificationAuthorities {
  return {
    runTests: async () => ({ outcome: "completed", exitCode: 0, tests: [{ status: "passed" }], testsTruncated: false, failures: [], failuresTruncated: false, diagnosticsTruncated: false }),
    listCiRuns: async ({ revision }) => ({ runs: [{ id: "github:123", revision: revision ?? "a".repeat(40), state: "completed", conclusion: "success" }], truncated: false }),
    runBrowserVerification: async ({ url }) => ({ outcome: "passed", url, origin: new URL(url).origin, pageHash: "e".repeat(64), passed: 1, failed: 0, truncated: false, evidenceId: "0f9c1f3a-1111-4222-8333-444455556666", evidenceHash: "f".repeat(64), observedAt: 1_700_000_000_000 }),
    ciRepository: () => "owner/repo",
  };
}

async function reviewStorePath(dataRoot: string): Promise<string> {
  const [file] = await readdir(dataRoot);
  assert.ok(file, "expected a review store file");
  return join(dataRoot, file);
}

test("the retention window defaults to 90 days and is ACCOUNTABILITY_RETENTION_DAYS-overridable", () => {
  // Default (unset) window.
  assert.equal(reviewRetentionWindowMs({}), 90 * DAY_MS);
  assert.equal(verificationRetentionWindowMs({}), 90 * DAY_MS);
  // An explicit, valid window.
  assert.equal(reviewRetentionWindowMs({ ACCOUNTABILITY_RETENTION_DAYS: "7" }), 7 * DAY_MS);
  assert.equal(verificationRetentionWindowMs({ ACCOUNTABILITY_RETENTION_DAYS: "1" }), DAY_MS);
  // Unset, blank, non-integer, and non-positive values all fall back to the
  // documented default rather than disabling retention.
  for (const invalid of ["", "   ", "abc", "0", "-3", "1.5", "NaN"]) {
    assert.equal(reviewRetentionWindowMs({ ACCOUNTABILITY_RETENTION_DAYS: invalid }), 90 * DAY_MS, `reviews: ${invalid}`);
    assert.equal(verificationRetentionWindowMs({ ACCOUNTABILITY_RETENTION_DAYS: invalid }), 90 * DAY_MS, `verification: ${invalid}`);
  }
});

test("review records past the retention window are pruned on the next write, with their follow-ups", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "accountability-review-workspace-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "accountability-review-data-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  const store = new ReviewStore(dataRoot, 1000);
  await store.recordReview({ workspaceRoot: root, reviewer: "old-reviewer", verdict: "changes_requested", subject, blockingSeverities: ["P0", "P1"], findings: [{ severity: "P2", summary: "stale debt", paths: [] }] });

  // Age the persisted record well past the tiny test window.
  const path = await reviewStorePath(dataRoot);
  const aged = JSON.parse(await readFile(path, "utf8")) as { reviews: Array<{ createdAt: number }>; followUps: Array<{ createdAt: number }> };
  const stale = Date.now() - 10_000;
  aged.reviews[0]!.createdAt = stale;
  aged.followUps[0]!.createdAt = stale;
  await writeFile(path, JSON.stringify(aged));

  // A fresh write prunes the aged review and its follow-up.
  await store.recordReview({ workspaceRoot: root, reviewer: "new-reviewer", verdict: "approved", subject, blockingSeverities: ["P0", "P1"], findings: [] });
  const listed = await store.listReviews({ workspaceRoot: root, currentSubject: subject });
  assert.deepEqual(listed.reviews.map((review) => review.reviewer), ["new-reviewer"]);
  assert.equal(listed.openFollowUps.length, 0, "the aged review's follow-up is pruned with it");
});

test("review records inside the retention window survive a write", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "accountability-review-workspace-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "accountability-review-data-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  const store = new ReviewStore(dataRoot, 90 * DAY_MS);
  await store.recordReview({ workspaceRoot: root, reviewer: "first", verdict: "approved", subject, blockingSeverities: ["P0"], findings: [] });
  await store.recordReview({ workspaceRoot: root, reviewer: "second", verdict: "approved", subject, blockingSeverities: ["P0"], findings: [] });
  const listed = await store.listReviews({ workspaceRoot: root });
  assert.equal(listed.reviews.length, 2, "records inside the window are not dropped");
});

test("verification observations past the retention window are pruned on the next write", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "accountability-verification-workspace-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "accountability-verification-data-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  const store = new VerificationStore(dataRoot, authorities(), 1000);
  await store.recordVerification({ workspaceRoot: root, request: { kind: "local_test", testIds: ["node:test/a.test.ts"] } });

  const [file] = await readdir(dataRoot);
  assert.ok(file);
  const path = join(dataRoot, file);
  const aged = JSON.parse(await readFile(path, "utf8")) as { observations: Array<{ recordedAt: number }> };
  aged.observations[0]!.recordedAt = Date.now() - 10_000;
  await writeFile(path, JSON.stringify(aged));

  await store.recordVerification({ workspaceRoot: root, request: { kind: "local_test", testIds: ["node:test/b.test.ts"] } });
  const listed = await store.listVerifications({ workspaceRoot: root });
  assert.equal(listed.observations.length, 1, "the aged observation was pruned on write");
  assert.deepEqual((listed.observations[0] as { source: { testIds: string[] } }).source.testIds, ["node:test/b.test.ts"]);
});
