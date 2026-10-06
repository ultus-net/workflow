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

test("I-9 schema rung: an empty-subject postcondition is refused as malformed before any re-query IO", (context) => {
  const { application } = setup(context);
  // A vacuous claim (no subjects) confirms nothing, so the schema rung refuses
  // it by code rather than letting the state-diff gate pass an empty observation.
  const [step] = application.defineTaskSteps(T, [
    { content: "vacuous claim", requiredEvidence: [DONE], requiredPostcondition: { subjects: [] } },
  ]);
  assert.ok(step !== undefined);
  assert.equal(application.startTaskStep(step.id).kind, "accepted");
  recordDone(application, "vacuous");

  const result = application.completeStepWithRequery(step.id);
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.equal(result.code, "STEP_POSTCONDITION_MALFORMED");
    assert.match(result.reason, /at least one subject/);
  }
  assert.equal(application.taskSteps(T)[0]?.state, "IN_PROGRESS");
});

test("I-9 schema rung: a postcondition subject with an empty path/fingerprint is refused as malformed", (context) => {
  const { application } = setup(context);
  const [step] = application.defineTaskSteps(T, [
    { content: "blank subject", requiredEvidence: [DONE], requiredPostcondition: { subjects: [{ path: "  ", expectedFingerprint: "sha-declared" }] } },
  ]);
  assert.ok(step !== undefined);
  assert.equal(application.startTaskStep(step.id).kind, "accepted");
  recordDone(application, "blank");

  const result = application.completeStepWithRequery(step.id);
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.equal(result.code, "STEP_POSTCONDITION_MALFORMED");
    assert.match(result.reason, /non-empty path and expectedFingerprint/);
  }
  assert.equal(application.taskSteps(T)[0]?.state, "IN_PROGRESS");
});

test("I-9 tests rung: a wired evaluator runs after every cheaper rung passes and refuses on failure", (context) => {
  const { application, path } = setup(context);
  const step = defineAndStartPostconditionStep(application, path);
  recordDone(application, "tests-fail");
  let called = 0;
  application.setStepTestEvaluator(() => { called += 1; return { kind: "reject", reason: "suite red" }; });

  const result = application.completeStepWithRequery(step.id);
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.equal(result.code, "STEP_TESTS_FAILED");
    assert.match(result.reason, /suite red/);
  }
  assert.equal(called, 1);
  assert.equal(application.taskSteps(T)[0]?.state, "IN_PROGRESS");
});

test("I-9 tests rung: a passing evaluator admits the completion (all five rungs exercised)", (context) => {
  const { application, path } = setup(context);
  const step = defineAndStartPostconditionStep(application, path);
  recordDone(application, "tests-pass");
  application.setStepTestEvaluator(() => ({ kind: "pass" }));

  const result = application.completeStepWithRequery(step.id);
  assert.equal(result.kind, "accepted");
  assert.equal(application.taskSteps(T)[0]?.state, "COMPLETED");
});

test("I-9 tests rung: a cheaper reject short-circuits before the injected evaluator runs", (context) => {
  const { application, path } = setup(context);
  // A postcondition step with no recorded evidence: the codes rung rejects, so
  // the costliest rung must never be reached.
  const step = defineAndStartPostconditionStep(application, path);
  let called = 0;
  application.setStepTestEvaluator(() => { called += 1; return { kind: "pass" }; });

  const result = application.completeStepWithRequery(step.id);
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") assert.equal(result.code, "STEP_EVIDENCE_REQUIRED");
  assert.equal(called, 0);
});

test("I-9 tests rung: clearing the evaluator leaves the rung absent (behavior unchanged)", (context) => {
  const { application, path } = setup(context);
  const step = defineAndStartPostconditionStep(application, path);
  recordDone(application, "tests-clear");
  application.setStepTestEvaluator(() => ({ kind: "reject", reason: "would fail" }));
  application.setStepTestEvaluator(undefined);

  // With the evaluator cleared the step completes on the cheaper rungs alone.
  assert.equal(application.completeStepWithRequery(step.id).kind, "accepted");
  assert.equal(application.taskSteps(T)[0]?.state, "COMPLETED");
});

test("I-9 tests rung: a throwing evaluator propagates fail-loud (it is not swallowed into a pass)", (context) => {
  const { application, path } = setup(context);
  const step = defineAndStartPostconditionStep(application, path);
  recordDone(application, "tests-throws");
  application.setStepTestEvaluator(() => { throw new Error("runner crashed"); });

  // The seam does not catch: a crash is an environment failure, surfaced as an
  // exception exactly like the state-diff rung's non-ENOENT read errors — never
  // silently converted into a pass (fail closed by failing loud).
  assert.throws(() => application.completeStepWithRequery(step.id), /runner crashed/);
  assert.equal(application.taskSteps(T)[0]?.state, "IN_PROGRESS");
});

test("I-9 tests rung: the evaluator receives the live step and the recorded evidence", (context) => {
  const { application, path } = setup(context);
  const step = defineAndStartPostconditionStep(application, path);
  recordDone(application, "tests-input");
  let received: { id: string; state: string; evidenceSubjects: readonly string[] } | undefined;
  application.setStepTestEvaluator((input) => {
    received = { id: input.step.id, state: input.step.state, evidenceSubjects: input.evidence.map((record) => record.subject) };
    return { kind: "pass" };
  });

  assert.equal(application.completeStepWithRequery(step.id).kind, "accepted");
  assert.ok(received !== undefined);
  // The evaluator judges the LIVE (IN_PROGRESS) step and the same evidence the
  // cheaper rungs read, so a runner can key off the step and its done-marker.
  // The `state` pin is load-bearing: the id alone is snapshot-invariant, so a
  // regression that handed the evaluator the stale define-time (PENDING) step
  // would still match on id; asserting IN_PROGRESS rules that out.
  assert.equal(received.id, step.id);
  assert.equal(received.state, "IN_PROGRESS");
  assert.ok(received.evidenceSubjects.includes(DONE.subject));
});
