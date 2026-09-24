import assert from "node:assert/strict";
import test from "node:test";

import { buildReviewRubric, countReferencedAxes, REVIEW_AXES } from "../src/review/rubric.js";

test("rubric covers all five axes with severity tiers and verdict format", () => {
  const rubric = buildReviewRubric({ diffText: "diff --git a/x b/x\n+change" });
  for (const axis of REVIEW_AXES) assert.ok(rubric.includes(axis.name), `missing axis ${axis.name}`);
  assert.match(rubric, /P0.*[Bb]lock/);
  assert.match(rubric, /P1.*[Bb]lock/);
  assert.match(rubric, /\[APPROVE\]/);
  assert.match(rubric, /\[REQUEST_CHANGES\]/);
  assert.match(rubric, /independently with fresh context/);
  assert.match(rubric, /```diff\n/);
});

// W098 c1 part 2 (the reviewer-rubric slice of the cache-bust audit): the
// rubric's STABLE preamble (the five-axis quality gate) must precede the
// per-run content (task context, manifest, diff) — provider prompt caches
// reward the longest shared token prefix, so the static gate text is the
// cacheable prefix and per-run material must never ride ahead of it. The
// verdict instructions trail after the per-run content (a stable tail).
// A characterization pin: green on first run is the EXPECTED outcome; a red
// means the rubric's section order moved and the cache discipline with it.
test("W098: the review rubric keeps the stable preamble ahead of the per-run content", () => {
  const rubric = buildReviewRubric({
    taskPrompt: "implement hub feature",
    manifestText: "src/a.ts",
    diffText: "+ the change under review",
  });
  const gate = rubric.indexOf("# Secondary Review Agent Quality Gate");
  const task = rubric.indexOf("### User Request / Context:", gate);
  const manifest = rubric.indexOf("### Review Coverage Manifest", gate);
  const diff = rubric.indexOf("### Code Diff Under Review:", gate);
  const verdict = rubric.indexOf("Provide your verdict:", diff);
  assert.ok(gate !== -1 && task !== -1 && manifest !== -1 && diff !== -1 && verdict !== -1, "every section renders");
  assert.ok(gate < task && gate < manifest && gate < diff, "the stable gate preamble precedes every per-run section");
  assert.ok(task < manifest && manifest < diff, "the per-run sections hold their own order (task, manifest, diff)");
  assert.ok(diff < verdict, "the verdict instructions trail the per-run content");
});

test("rubric caps the embedded diff and includes task context when given", () => {
  const big = "y".repeat(100_000);
  const rubric = buildReviewRubric({ diffText: big, taskPrompt: "implement hub" });
  assert.ok(rubric.length < 40_000);
  assert.match(rubric, /implement hub/);
});

test("countReferencedAxes counts exact axis references (anti-rubber-stamp gate)", () => {
  assert.equal(countReferencedAxes(""), 0);
  // Generic praise without axis names does not count.
  assert.equal(countReferencedAxes("tests are real and coverage is good"), 0);
  assert.equal(countReferencedAxes("test integrity verified; task completeness confirmed; cleanliness ok"), 3);
  assert.equal(countReferencedAxes("test integrity; task completeness; cleanliness; security; platform"), 5);
});
