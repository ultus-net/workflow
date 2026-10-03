import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskGraph } from "../src/kernel/task-graph.js";
import { evidenceId, observationId, taskId } from "../src/kernel/contracts.js";
import { hostCapabilities } from "../src/application/host.js";
import { fingerprintFile } from "../src/application/file-claim-ledger.js";
import { WorkflowApplication } from "../src/application/workflow.js";

const T = taskId("t1");
const DONE = { authority: "environment" as const, subject: "step:s1" };

/**
 * W072 I-9 production path: `completeStepWithRequery` re-observes the claimed
 * subject on disk. The path handed to `fingerprintFile` is process-relative to
 * this test, so the temp directory is resolved to an absolute path.
 */
function setup(context: TestContext): { application: WorkflowApplication; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "wf-state-diff-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "artifact.txt");
  writeFileSync(path, "first");
  const graph = new TaskGraph([{ id: T, title: "Task", state: "READY", dependencies: [], requiredEvidence: [] }]);
  assert.equal(graph.transition(T, "IN_PROGRESS").kind, "accepted");
  const application = new WorkflowApplication(graph, hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  return { application, path };
}

function declareGuardedStep(application: WorkflowApplication, path: string): void {
  const [step] = application.defineTaskSteps(T, [
    { content: "write artifact", requiredEvidence: [DONE], requiredPostcondition: { subjects: [{ path, expectedFingerprint: fingerprintFile(path).digest }] } },
  ]);
  assert.ok(step !== undefined);
  assert.equal(application.startTaskStep(step.id).kind, "accepted");
  application.recordEvidence({
    id: evidenceId("e-admission"),
    observationId: observationId("o-admission"),
    authority: "environment",
    subject: "step:s1",
    result: "passed",
    freshness: "fresh",
    mutationEpoch: application.snapshot().mutationEpoch,
    observedAt: new Date().toISOString(),
  });
}

test("I-9 admission: a step completes when the on-disk fingerprint matches the claim", (context) => {
  const { application, path } = setup(context);
  declareGuardedStep(application, path);
  const stepId = application.taskSteps(T)[0]!.id;

  const result = application.completeStepWithRequery(stepId);
  assert.equal(result.kind, "accepted");
  assert.equal(application.taskSteps(T)[0]?.state, "COMPLETED");
});

test("I-9 admission: a changed file refuses completion with STEP_POSTCONDITION_UNMET", (context) => {
  const { application, path } = setup(context);
  const observed = fingerprintFile(path).digest;
  declareGuardedStep(application, path);
  const stepId = application.taskSteps(T)[0]!.id;
  writeFileSync(path, "changed");

  const result = application.completeStepWithRequery(stepId);
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.equal(result.code, "STEP_POSTCONDITION_UNMET");
    assert.match(result.reason, /different fingerprint/);
  }
  assert.equal(application.taskSteps(T)[0]?.state, "IN_PROGRESS");
  assert.notEqual(fingerprintFile(path).digest, observed);
});

test("I-9 admission: an absent file refuses completion as an absent observation", (context) => {
  const { application, path } = setup(context);
  declareGuardedStep(application, path);
  const stepId = application.taskSteps(T)[0]!.id;
  rmSync(path);

  const result = application.completeStepWithRequery(stepId);
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.equal(result.code, "STEP_POSTCONDITION_UNMET");
    assert.match(result.reason, /was not re-observed/);
  }
  assert.equal(application.taskSteps(T)[0]?.state, "IN_PROGRESS");
});

test("I-9 admission: a step without a postcondition behaves exactly as before", (context) => {
  const { application } = setup(context);
  const [step] = application.defineTaskSteps(T, [{ content: "plain", requiredEvidence: [DONE] }]);
  assert.ok(step !== undefined);
  assert.equal(application.startTaskStep(step.id).kind, "accepted");

  // No evidence yet: the existing I-3 refusal, not a state-diff refusal.
  const evidenceless = application.completeStepWithRequery(step.id);
  assert.equal(evidenceless.kind, "rejected");
  if (evidenceless.kind === "rejected") assert.equal(evidenceless.code, "STEP_EVIDENCE_REQUIRED");

  application.recordEvidence({
    id: evidenceId("e-plain"),
    observationId: observationId("o-plain"),
    authority: "environment",
    subject: "step:s1",
    result: "passed",
    freshness: "fresh",
    mutationEpoch: application.snapshot().mutationEpoch,
    observedAt: new Date().toISOString(),
  });
  assert.equal(application.completeStepWithRequery(step.id).kind, "accepted");
});
