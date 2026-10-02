import assert from "node:assert/strict";
import test from "node:test";

import { buildReviewRubric, countReferencedAxes, REVIEW_AXES } from "../src/review/rubric.js";
import { renderReviewLedgerText } from "../src/review/ledger-audit.js";
import { stepId, taskId } from "../src/kernel/contracts.js";

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

// W072 I-5: the reviewer's ledger audit. When the kernel-authoritative step
// ledger is supplied, the rubric must embed it ahead of the diff and instruct
// the reviewer that a COMPLETED step with no corresponding diff change/evidence
// is a P0/P1 finding requiring [REQUEST_CHANGES]. Absent, the section must not
// render (byte-identical to before for existing callers).
const LEDGER_STEPS = [
  {
    id: stepId("s-1"),
    taskId: taskId("t-1"),
    content: "add the ledger renderer",
    state: "COMPLETED" as const,
    requiredEvidence: [{ authority: "environment" as const, subject: "test:review-rubric" }],
  },
  {
    id: stepId("s-2"),
    taskId: taskId("t-1"),
    content: "wire the hub route",
    state: "PENDING" as const,
    requiredEvidence: [],
  },
];

test("W072 I-5: the rubric embeds the ledger and its audit instruction when given", () => {
  const ledgerText = renderReviewLedgerText(LEDGER_STEPS);
  const rubric = buildReviewRubric({ diffText: "+ the diff", ledgerText });
  const section = rubric.indexOf("### Step Ledger Under Audit (deterministic kernel state):");
  const diff = rubric.indexOf("### Code Diff Under Review:");
  assert.ok(section !== -1 && diff !== -1, "ledger section and diff render");
  assert.ok(section < diff, "the ledger audit section precedes the diff");
  assert.match(rubric, /add the ledger renderer/);
  assert.match(rubric, /environment:test:review-rubric/);
  assert.match(rubric, /COMPLETED/);
  assert.match(rubric, /P0\/P1 finding/);
  assert.match(rubric, /\[REQUEST_CHANGES\]/);
});

test("W072 I-5: ledger audit section is absent when ledgerText is not passed", () => {
  const rubric = buildReviewRubric({ diffText: "+ the diff" });
  assert.ok(!rubric.includes("### Step Ledger Under Audit"));
  assert.ok(!rubric.includes("P0/P1 finding"));
});

test("W072 I-5: renderReviewLedgerText renders kernel state and evidence subjects only", () => {
  const text = renderReviewLedgerText(LEDGER_STEPS);
  assert.match(text, /2 steps/);
  assert.match(text, /step s-1 \[COMPLETED\] task t-1: add the ledger renderer/);
  assert.match(text, /required evidence: environment:test:review-rubric/);
  assert.match(text, /step s-2 \[PENDING\] task t-1: wire the hub route/);
  assert.match(text, /required evidence: \(none\)/);
  assert.equal(renderReviewLedgerText([]), "No step ledger is attached to the active task.");
});

test("countReferencedAxes counts exact axis references (anti-rubber-stamp gate)", () => {
  assert.equal(countReferencedAxes(""), 0);
  // Generic praise without axis names does not count.
  assert.equal(countReferencedAxes("tests are real and coverage is good"), 0);
  assert.equal(countReferencedAxes("test integrity verified; task completeness confirmed; cleanliness ok"), 3);
  assert.equal(countReferencedAxes("test integrity; task completeness; cleanliness; security; platform"), 5);
});
