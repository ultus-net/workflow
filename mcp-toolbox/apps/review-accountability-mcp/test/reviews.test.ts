import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ReviewStore } from "../src/reviews.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-workspace-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "review-data-"));
  return { root, dataRoot, store: new ReviewStore(dataRoot) };
}

const subjectA = { kind: "fingerprint" as const, algorithm: "sha256", version: "1", scope: "review-diff", value: "a".repeat(64) };
const subjectB = { ...subjectA, value: "b".repeat(64) };

test("records subject-bound review attestations and durable P2/P3 follow-ups", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  const review = await store.recordReview({
    workspaceRoot: root, reviewer: "secondary-agent", verdict: "approved", subject: subjectA,
    blockingSeverities: ["P0", "P1"], findings: [
      { severity: "P2", summary: "Cover provider retry edge case", paths: ["src/provider.ts"] },
      { severity: "P3", summary: "Consider clearer naming", paths: [] },
    ],
  });

  assert.equal(review.evidenceClass, "attestation");
  assert.equal(review.freshness, "unknown");
  assert.equal(review.followUps.length, 2);
  assert.ok(review.followUps.every((item) => item.status === "open" && item.reviewId === review.id));
  const reloaded = await new ReviewStore(dataRoot).listReviews({ workspaceRoot: root, currentSubject: subjectA });
  assert.equal(reloaded.reviews[0]?.freshness, "fresh");
  assert.equal(reloaded.openFollowUps.length, 2);
});

test("rejects approval when a finding has a configured blocking severity", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));

  await assert.rejects(store.recordReview({
    workspaceRoot: root, reviewer: "reviewer", verdict: "approved", subject: subjectA,
    blockingSeverities: ["P0", "P1", "P2"], findings: [{ severity: "P2", summary: "Must fix", paths: [] }],
  }), /blocking severity/i);
  assert.equal((await store.listReviews({ workspaceRoot: root })).reviews.length, 0);
});

test("reports stale and unknown review freshness without transferring approval", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  await store.recordReview({ workspaceRoot: root, reviewer: "reviewer", verdict: "approved", subject: subjectA, blockingSeverities: ["P0", "P1"], findings: [] });

  assert.equal((await store.listReviews({ workspaceRoot: root, currentSubject: subjectB })).reviews[0]?.freshness, "stale");
  const incompatible = { kind: "commit" as const, repository: root, commit: "c".repeat(40) };
  assert.equal((await store.listReviews({ workspaceRoot: root, currentSubject: incompatible })).reviews[0]?.freshness, "unknown");
});

test("resolves only P2/P3 follow-up debt and preserves the originating attestation", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  const review = await store.recordReview({
    workspaceRoot: root, reviewer: "reviewer", verdict: "changes_requested", subject: subjectA,
    blockingSeverities: ["P0", "P1"], findings: [{ severity: "P2", summary: "Add coverage", paths: [] }],
  });
  const followUp = review.followUps[0]!;
  const resolved = await store.resolveFollowUp({ workspaceRoot: root, followUpId: followUp.id, resolution: "Covered by regression test" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolution, "Covered by regression test");
  await assert.rejects(store.resolveFollowUp({ workspaceRoot: root, followUpId: followUp.id, resolution: "again" }), /open follow-up/i);
  const result = await store.listReviews({ workspaceRoot: root, currentSubject: subjectA });
  assert.equal(result.reviews[0]?.verdict, "changes_requested");
  assert.equal(result.openFollowUps.length, 0);
});

test("preserves conflicting attestations as separate subject-bound statements", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  await store.recordReview({ workspaceRoot: root, reviewer: "reviewer-a", verdict: "approved", subject: subjectA, blockingSeverities: ["P0", "P1"], findings: [] });
  await store.recordReview({ workspaceRoot: root, reviewer: "reviewer-b", verdict: "changes_requested", subject: subjectA, blockingSeverities: ["P0", "P1"], findings: [{ severity: "P1", summary: "Behavior is unsafe", paths: [] }] });
  const result = await store.listReviews({ workspaceRoot: root, currentSubject: subjectA });
  assert.deepEqual(new Set(result.reviews.map((review) => review.verdict)), new Set(["approved", "changes_requested"]));
  assert.ok(result.reviews.every((review) => review.freshness === "fresh"));
});

test("bounds review and open follow-up collections independently", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  for (let index = 0; index < 3; index += 1) {
    await store.recordReview({ workspaceRoot: root, reviewer: `reviewer-${index}`, verdict: "approved", subject: subjectA, blockingSeverities: ["P0", "P1"], findings: [{ severity: "P3", summary: `debt-${index}`, paths: [] }] });
  }
  const result = await store.listReviews({ workspaceRoot: root, currentSubject: subjectA, limit: 1, followUpLimit: 2 });
  assert.equal(result.reviews.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.openFollowUps.length, 2);
  assert.equal(result.followUpsTruncated, true);
});

test("rejects persisted P0/P1 records masquerading as resolvable follow-up debt", async (t) => {
  const { root, dataRoot, store } = await fixture();
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dataRoot, { recursive: true, force: true })]));
  await store.recordReview({ workspaceRoot: root, reviewer: "reviewer", verdict: "changes_requested", subject: subjectA, blockingSeverities: ["P0", "P1"], findings: [{ severity: "P2", summary: "lower priority", paths: [] }] });
  const [file] = await readdir(dataRoot);
  assert.ok(file);
  const path = join(dataRoot, file);
  const document = JSON.parse(await readFile(path, "utf8")) as { followUps: Array<{ severity: string }> };
  document.followUps[0]!.severity = "P1";
  await writeFile(path, JSON.stringify(document));
  await assert.rejects(new ReviewStore(dataRoot).listReviews({ workspaceRoot: root }), /malformed or unreadable/i);
});
