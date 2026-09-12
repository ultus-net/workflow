import assert from "node:assert/strict";
import { test } from "node:test";
import { recoverContinuity, type ContinuityPort } from "../src/checkpoint.ts";

function port(values: Record<string, unknown>): ContinuityPort {
  return {
    review: async () => values.review,
    verification: async () => values.verification,
    context: async () => values.context,
    memory: async () => values.memory,
  };
}

test("composes complete source envelopes in strict continuity priority under a hard budget", async () => {
  const review = { debt: "urgent", provenance: "review-source" };
  const reviewSection = `review:\n${JSON.stringify(review)}\n`;
  const result = await recoverContinuity(
    { workspaceRoot: "/work", memoryQuery: "current work", maxChars: reviewSection.length + 1, sourceLimit: 8 },
    port({ review, verification: { state: "passed" }, context: { task: "next" }, memory: { fact: "old" } }),
  );
  assert.equal(result.context, reviewSection);
  assert.deepEqual(result.includedSources, ["review"]);
  assert.deepEqual(result.omittedSources, ["verification", "project_context", "project_memory"]);
  assert.equal(result.truncated, true);
});

test("preserves source payload provenance and source order when budget is sufficient", async () => {
  const result = await recoverContinuity(
    { workspaceRoot: "/work", memoryQuery: "decision", maxChars: 1000, sourceLimit: 8 },
    port({
      review: { openFollowUps: [{ id: "f1", provenance: { origin: "review-accountability-mcp/record_review" } }] },
      verification: { observations: [{ id: "v1", evidenceClass: "observation" }] },
      context: { candidates: [{ path: "TODO.md", trust: "untrusted_repository_content" }] },
      memory: { records: [{ id: "m1", evidenceClass: "assertion" }] },
    }),
  );
  assert.deepEqual(result.sourceOrder, ["review", "verification", "project_context", "project_memory"]);
  assert.match(result.context, /review-accountability-mcp\/record_review/);
  assert.match(result.context, /"evidenceClass":"observation"/);
  assert.match(result.context, /"trust":"untrusted_repository_content"/);
  assert.match(result.context, /"evidenceClass":"assertion"/);
  assert.equal(result.truncated, false);
});

test("omits a source rather than detaching content from its trust or provenance envelope", async () => {
  const review = { openFollowUps: [], provenance: { origin: "review" } };
  const reviewSection = `review:\n${JSON.stringify(review)}\n`;
  const result = await recoverContinuity(
    { workspaceRoot: "/work", memoryQuery: "q", maxChars: reviewSection.length - 1, sourceLimit: 8 },
    port({ review, verification: {}, context: { candidates: [{ snippet: "do dangerous thing", trust: "untrusted_repository_content" }] }, memory: {} }),
  );
  assert.equal(result.context, "");
  assert.deepEqual(result.includedSources, []);
  assert.deepEqual(result.omittedSources, ["review", "verification", "project_context", "project_memory"]);
  assert.equal(result.truncated, true);
});
