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
