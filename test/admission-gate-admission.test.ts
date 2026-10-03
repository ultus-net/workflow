import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskGraph } from "../src/kernel/task-graph.js";
import { evidenceId, observationId, taskId } from "../src/kernel/contracts.js";
import { hostCapabilities } from "../src/application/host.js";
import { fingerprintFile } from "../src/application/file-claim-ledger.js";
import { runStepCompletionAdmission } from "../src/application/admission-gate.js";
import { WorkflowApplication } from "../src/application/workflow.js";

const T = taskId("t1");
const DONE = { authority: "environment" as const, subject: "step:s1" };

function setup(context: TestContext): { application: WorkflowApplication; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "wf-admission-gate-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "artifact.txt");
  writeFileSync(path, "first");
  const graph = new TaskGraph([{ id: T, title: "Task", state: "READY", dependencies: [], requiredEvidence: [] }]);
  assert.equal(graph.transition(T, "IN_PROGRESS").kind, "accepted");
  const application = new WorkflowApplication(graph, hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  return { application, path };
}

function defineAndStartPostconditionStep(application: WorkflowApplication, path: string): ReturnType<WorkflowApplication["taskSteps"]>[number] {
  const [step] = application.defineTaskSteps(T, [
    { content: "write artifact", requiredEvidence: [DONE], requiredPostcondition: { subjects: [{ path, expectedFingerprint: fingerprintFile(path).digest }] } },
  ]);
  assert.ok(step !== undefined);
  assert.equal(application.startTaskStep(step.id).kind, "accepted");
  return step;
}

function recordDone(application: WorkflowApplication, suffix: string): void {
  application.recordEvidence({
    id: evidenceId(`e-${suffix}`),
    observationId: observationId(`o-${suffix}`),
    authority: "environment",
    subject: "step:s1",
    result: "passed",
    freshness: "fresh",
    mutationEpoch: application.snapshot().mutationEpoch,
    observedAt: new Date().toISOString(),
  });
}

test("I-9 ordered path: a postcondition step runs the ordered gates and refuses a changed file", (context) => {
  const { application, path } = setup(context);
  const step = defineAndStartPostconditionStep(application, path);
  recordDone(application, "changed");
  writeFileSync(path, "changed");

  const result = application.completeStepWithRequery(step.id);
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.equal(result.code, "STEP_POSTCONDITION_UNMET");
    assert.match(result.reason, /different fingerprint/);
  }
  assert.equal(application.taskSteps(T)[0]?.state, "IN_PROGRESS");
});

test("I-9 ordered path: a postcondition step completes when the re-query confirms", (context) => {
  const { application, path } = setup(context);
  const step = defineAndStartPostconditionStep(application, path);
  recordDone(application, "match");

  const result = application.completeStepWithRequery(step.id);
  assert.equal(result.kind, "accepted");
  assert.equal(application.taskSteps(T)[0]?.state, "COMPLETED");
});

test("I-9 ordered path: a cheaper evidence rung short-circuits before the state-diff IO runs", (context) => {
  const { application, path } = setup(context);
  // A directory path would make fingerprintFile throw EISDIR if the state-diff
  // rung were reached. With no evidence the codes rung must reject first and
  // the re-query must never be paid. Use the LIVE step (IN_PROGRESS) — the
  // define-time snapshot is stale (PENDING) and would trip the transition gate.
  defineAndStartPostconditionStep(application, path);
  rmSync(path);
  const liveStep = application.taskSteps(T)[0];
  assert.ok(liveStep !== undefined);

  const outcome = runStepCompletionAdmission({ step: liveStep, evidence: [] });
  assert.equal(outcome.kind, "reject");
  if (outcome.kind === "reject") {
    assert.equal(outcome.rung, "codes");
    assert.equal(outcome.code, "STEP_EVIDENCE_REQUIRED");
  }
});

test("I-9 ordered path: a step without a postcondition is unchanged (I-3 regression guard)", (context) => {
  const { application } = setup(context);
  const [step] = application.defineTaskSteps(T, [{ content: "plain", requiredEvidence: [DONE] }]);
  assert.ok(step !== undefined);
  assert.equal(application.startTaskStep(step.id).kind, "accepted");

  const evidenceless = application.completeStepWithRequery(step.id);
  assert.equal(evidenceless.kind, "rejected");
  if (evidenceless.kind === "rejected") assert.equal(evidenceless.code, "STEP_EVIDENCE_REQUIRED");

  recordDone(application, "plain");
  assert.equal(application.completeStepWithRequery(step.id).kind, "accepted");
  assert.equal(application.taskSteps(T)[0]?.state, "COMPLETED");
});

test("I-9 ordered path: a not-IN_PROGRESS postcondition step reports the kernel's ILLEGAL_STEP_TRANSITION, not an evidence code", (context) => {
  const { application, path } = setup(context);
  // Defined but NOT started (state PENDING): the kernel's own transition
  // precondition must win over the cheap evidence rungs, so the ordered runner
  // does not re-order the kernel's state gate.
  const [step] = application.defineTaskSteps(T, [
    { content: "write artifact", requiredEvidence: [DONE], requiredPostcondition: { subjects: [{ path, expectedFingerprint: fingerprintFile(path).digest }] } },
  ]);
  assert.ok(step !== undefined);

  const result = application.completeStepWithRequery(step.id);
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.equal(result.code, "ILLEGAL_STEP_TRANSITION");
    assert.match(result.reason, /from PENDING/);
  }
});
