import assert from "node:assert/strict";
import test from "node:test";

import { stepId, taskId, type WorkflowStep } from "../src/kernel/contracts.js";
import {
  auditLedgerAgainstDiff,
  changedPathsFromDiff,
  renderLedgerAuditFindings,
} from "../src/review/ledger-audit.js";

// W072 I-5: the deterministic ledger-vs-diff audit. The pure function is the
// non-model check the prior slice lacked — a COMPLETED step whose content
// shares no token with the changed paths is flagged.

function step(content: string, state: WorkflowStep["state"]): WorkflowStep {
  return { id: stepId("s-audit"), taskId: taskId("t-1"), content, state, requiredEvidence: [] };
}

test("W072 I-5: a COMPLETED step backed by a changed path produces no finding", () => {
  const findings = auditLedgerAgainstDiff(
    [step("add src/review/ledger-audit.ts", "COMPLETED")],
    ["src/review/ledger-audit.ts"],
  );
  assert.deepEqual(findings, []);
});

test("W072 I-5: a COMPLETED step backed only by a changed path's basename produces no finding", () => {
  const findings = auditLedgerAgainstDiff(
    [step("wire review-rubric.ts into the runner", "COMPLETED")],
    ["src/review/review-rubric.ts"],
  );
  assert.deepEqual(findings, []);
});

test("W072 I-5: a COMPLETED step with no changed-path token produces a finding", () => {
  const findings = auditLedgerAgainstDiff(
    [step("ship the parser", "COMPLETED")],
    ["src/review/ledger-audit.ts"],
  );
  assert.deepEqual(findings, [
    { stepId: stepId("s-audit"), content: "ship the parser", code: "LEDGER_STEP_WITHOUT_DIFF" },
  ]);
});

test("W072 I-5: non-COMPLETED steps never produce a finding", () => {
  const findings = auditLedgerAgainstDiff(
    [step("ship the parser", "PENDING"), step("do work", "IN_PROGRESS"), step("cancel me", "CANCELLED")],
    ["src/review/ledger-audit.ts"],
  );
  assert.deepEqual(findings, []);
});

test("W072 I-5: empty changedPaths flags every COMPLETED step", () => {
  const findings = auditLedgerAgainstDiff(
    [step("one", "COMPLETED"), step("two", "COMPLETED"), step("open", "PENDING")],
    [],
  );
  assert.deepEqual(findings.map((finding) => finding.stepId), [stepId("s-audit"), stepId("s-audit")]);
  assert.ok(findings.every((finding) => finding.code === "LEDGER_STEP_WITHOUT_DIFF"));
});

test("W072 I-5: changedPathsFromDiff reads diff --git and +++ headers, skipping /dev/null", () => {
  const paths = changedPathsFromDiff([
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
  ].join("\n"));
  assert.deepEqual(paths, ["src/a.ts", "src/new.ts"]);
});

test("W072 I-5: renderLedgerAuditFindings states the backed result when empty and names each finding", () => {
  assert.match(renderLedgerAuditFindings([]), /every COMPLETED step is backed/);
  const text = renderLedgerAuditFindings([
    { stepId: "s-1", content: "ship the parser", code: "LEDGER_STEP_WITHOUT_DIFF" },
  ]);
  assert.match(text, /1 COMPLETED step\(s\) have no token matching a changed path/);
  assert.match(text, /step s-1 \[LEDGER_STEP_WITHOUT_DIFF\]: ship the parser/);
});
