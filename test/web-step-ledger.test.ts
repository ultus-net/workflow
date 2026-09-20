import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { TaskGraph } from "../src/kernel/task-graph.js";
import { evidenceId, observationId } from "../src/kernel/contracts.js";
import { hostCapabilities } from "../src/application/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { createWorkflowWebServer } from "../src/ui/web.js";

/** Starts the web server against a throwaway home + workspace, exactly like
 * the settings-endpoint harness, so the tests only exercise the HTTP surface
 * plus the one application call the ACP lane owns (environment evidence). */
async function startServer(context: TestContext): Promise<{ base: string; application: WorkflowApplication }> {
  const home = mkdtempSync(join(tmpdir(), "wf-web-steps-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "wf-web-steps-ws-"));
  context.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(application, undefined, undefined, { home, workspace });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, application };
}

const post = async (base: string, path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("step ledger: read starts empty, define appends with an evidence requirement, transitions map kernel rejections", async (context) => {
  const { base, application } = await startServer(context);

  const empty = await fetch(`${base}/api/steps`).then((response) => response.json()) as {
    activeTaskId: string | null; tasks: readonly unknown[];
  };
  assert.equal(empty.activeTaskId, null);
  assert.deepEqual(empty.tasks, []);

  const created = await post(base, "/api/tasks", { taskId: "t1", title: "Ledger task" });
  assert.equal(created.status, 201);
  assert.equal((await created.json() as { state: string }).state, "READY");

  const defined = await post(base, "/api/steps/define", { taskId: "t1", content: "write the tests" });
  assert.equal(defined.status, 201);
  const step = (await defined.json() as {
    steps: readonly { id: string; state: string; requiredEvidence: readonly { authority: string; subject: string }[] }[];
  }).steps[0];
  assert.ok(step, "define returns the appended step");
  assert.equal(step.id, "t1-step-1");
  assert.equal(step.state, "PENDING");
  assert.deepEqual(step.requiredEvidence, [{ authority: "environment", subject: "step:write the tests" }],
    "a web-defined step carries the bridge's environment-evidence contract, not an empty one");

  const read = await fetch(`${base}/api/steps`).then((response) => response.json()) as {
    activeTaskId: string | null;
    tasks: readonly { id: string; steps: readonly unknown[]; activeStepId: string | null }[];
  };
  assert.equal(read.tasks.length, 1);
  assert.equal(read.tasks[0]?.steps.length, 1);
  assert.equal(read.tasks[0]?.activeStepId, null);

  // Starting a step while its task is merely READY is a kernel refusal the
  // endpoint surfaces verbatim (409 + structured code), never a silent pass.
  const earlyStart = await post(base, "/api/steps/start", { id: "t1-step-1" });
  assert.equal(earlyStart.status, 409);
  assert.equal((await earlyStart.json() as { kind: string; code: string }).code, "STEP_TASK_NOT_IN_PROGRESS");

  const activate = await post(base, "/api/transition", { taskId: "t1", requested: "IN_PROGRESS" });
  assert.equal(activate.status, 200);

  const started = await post(base, "/api/steps/start", { id: "t1-step-1" });
  assert.equal(started.status, 200);
  assert.equal((await started.json() as { step: { state: string } }).step.state, "IN_PROGRESS");

  const active = await fetch(`${base}/api/steps`).then((response) => response.json()) as {
    activeTaskId: string | null;
    tasks: readonly { activeStepId: string | null }[];
  };
  assert.equal(active.activeTaskId, "t1");
  assert.equal(active.tasks[0]?.activeStepId, "t1-step-1");

  // Completion is evidence-bound (I-3): without fresh passing environment
  // evidence the kernel refuses, and the refusal reaches the operator verbatim.
  const evidenceless = await post(base, "/api/steps/complete", { id: "t1-step-1" });
  assert.equal(evidenceless.status, 409);
  assert.equal((await evidenceless.json() as { code: string }).code, "STEP_EVIDENCE_REQUIRED");

  // The ACP lane's equivalent: an authorized action produced environment
  // evidence with the step's subject. The test stamps it directly.
  application.recordEvidence({
    id: evidenceId(`evidence-${Date.now()}`),
    observationId: observationId(`observation-${Date.now()}`),
    authority: "environment",
    subject: "step:write the tests",
    result: "passed",
    freshness: "fresh",
    mutationEpoch: application.snapshot().mutationEpoch,
    observedAt: new Date().toISOString(),
  });
  const completed = await post(base, "/api/steps/complete", { id: "t1-step-1" });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json() as { step: { state: string } }).step.state, "COMPLETED");

  // A terminal step is locked: further transitions refuse with the kernel's
  // illegal-transition code.
  const locked = await post(base, "/api/steps/cancel", { id: "t1-step-1" });
  assert.equal(locked.status, 409);
  assert.equal((await locked.json() as { code: string }).code, "ILLEGAL_STEP_TRANSITION");

  // Appending to an existing ledger is the primary second+step usage: the
  // reconstruction must carry prior steps through unchanged (ids, contents,
  // evidence requirements) or the kernel's I-2/priority rules bite and the
  // operator sees a duplicate or a state-losing ledger.
  const appended = await post(base, "/api/steps/define", { taskId: "t1", content: "review the diff" });
  assert.equal(appended.status, 201);
  const afterAppend = (await appended.json() as {
    steps: readonly { id: string; content: string; state: string; requiredEvidence: readonly unknown[] }[];
  }).steps;
  assert.equal(afterAppend.length, 2);
  assert.deepEqual(afterAppend[0], {
    id: "t1-step-1",
    taskId: "t1",
    content: "write the tests",
    state: "COMPLETED",
    requiredEvidence: [{ authority: "environment", subject: "step:write the tests" }],
  }, "the prior step survives re-definition bit-for-bit (id, task, content, state, evidence)");
  assert.equal(afterAppend[1]?.id, "t1-step-2");
  assert.equal(afterAppend[1]?.state, "PENDING");
  assert.deepEqual(afterAppend[1]?.requiredEvidence, [{ authority: "environment", subject: "step:review the diff" }]);
});

test("step ledger: define guards fail closed (unknown task, empty content, blocked task)", async (context) => {
  const { base } = await startServer(context);

  const missing = await post(base, "/api/steps/define", { taskId: "ghost", content: "x" });
  assert.equal(missing.status, 404);
  assert.match((await missing.json() as { error: string }).error, /unknown task/);

  const blank = await post(base, "/api/steps/define", { taskId: "t1", content: "   " });
  assert.equal(blank.status, 400);
  assert.match((await blank.json() as { error: string }).error, /taskId and content/);

  // A task that depends on unverified work is BLOCKED: the kernel refuses to
  // define a ledger for it and the endpoint surfaces the kernel's message.
  const unverified = await post(base, "/api/tasks", { taskId: "t1", title: "verify me" });
  assert.equal(unverified.status, 201);
  const blockedTask = await post(base, "/api/tasks", { taskId: "t2", title: "later", dependencies: ["t1"] });
  assert.equal((await blockedTask.json() as { state: string }).state, "BLOCKED");

  const onBlocked = await post(base, "/api/steps/define", { taskId: "t2", content: "too early" });
  assert.equal(onBlocked.status, 409);
  assert.match((await onBlocked.json() as { error: string }).error, /cannot define steps for task in BLOCKED/);
});

test("step ledger: transitions reject a malformed body and unknown step ids stay kernel-rejected", async (context) => {
  const { base } = await startServer(context);

  const malformed = await post(base, "/api/steps/start", { nope: true });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json() as { error: string }).error, /step id is required/);

  const unknownStep = await post(base, "/api/steps/cancel", { id: "nobody" });
  // The kernel's step() lookup throws for an unknown id — the endpoint's
  // catch-all maps it to 400; a fabricated id never mutates anything.
  assert.equal(unknownStep.status, 400);
});
