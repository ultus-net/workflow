import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkflowHubBridge } from "../src/integrations/hub-http.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { fingerprintFile } from "../src/application/file-claim-ledger.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { evidenceId, observationId, taskId, type WorkflowTask } from "../src/kernel/contracts.js";

// W072 I-9 (Stage 3 API half) — the hub admission lane drives the canonical step
// ledger. The application API already existed but only the web surface called
// it; these routes put define/start/complete/cancel on the hub loopback
// protocol. Pins: the ordinary-token class (a verifier credential is refused
// 401), the JSON-safe projection (no branded ids), kernel rejections surfaced
// verbatim as 409, boundary 400s, and that `/steps/complete` re-queries the
// real on-disk fingerprint.

interface Bridge {
  readonly url: string;
  readonly token: string;
  readonly verificationToken: string;
  close(): Promise<void>;
}

const seat = (context: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), "wf-hub-steps-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const seedTask: WorkflowTask = { id: taskId("W1"), title: "seed", state: "READY", dependencies: [], requiredEvidence: [] };

async function composeBridge(context: TestContext): Promise<{ bridge: Bridge; application: WorkflowApplication; graph: TaskGraph }> {
  const graph = new TaskGraph([{ ...seedTask }]);
  const application = new WorkflowApplication(graph, hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  const bridge = await createWorkflowHubBridge(application);
  context.after(() => bridge.close());
  return { bridge, application, graph };
}

const call = async (bridge: Bridge, path: string, token: string, body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> => {
  const response = await fetch(`${bridge.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
};

test("W072: /steps/* rides the operator-token class — the verifier credential is refused", async (context) => {
  const { bridge } = await composeBridge(context);
  for (const path of ["/steps/list", "/steps/define", "/steps/start", "/steps/complete", "/steps/cancel"]) {
    const denied = await call(bridge, path, bridge.verificationToken, {});
    assert.equal(denied.status, 401, path);
  }
});

test("W072: /steps/list projects a task's canonical steps as JSON-safe rows", async (context) => {
  const { bridge, application } = await composeBridge(context);
  application.defineTaskSteps(taskId("W1"), [
    { id: "s1", content: "first", requiredEvidence: [{ authority: "environment", subject: "step:first" }] },
  ]);
  const listed = await call(bridge, "/steps/list", bridge.token, { taskId: "W1" });
  assert.equal(listed.status, 200);
  const steps = listed.payload.steps as Record<string, unknown>[];
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0], {
    id: "s1",
    taskId: "W1",
    content: "first",
    state: "PENDING",
    requiredEvidence: [{ authority: "environment", subject: "step:first" }],
  });
});

test("W072: define → start → complete happy path on the hub lane", async (context) => {
  const { bridge, application, graph } = await composeBridge(context);
  assert.equal(graph.transition(taskId("W1"), "IN_PROGRESS").kind, "accepted");
  const defined = await call(bridge, "/steps/define", bridge.token, {
    taskId: "W1",
    steps: [{ content: "alpha", requiredEvidence: [{ authority: "environment", subject: "step:alpha" }] }],
  });
  assert.equal(defined.status, 200);
  const step = (defined.payload.steps as Record<string, unknown>[])[0]!;
  assert.equal(step.state, "PENDING");

  const started = await call(bridge, "/steps/start", bridge.token, { id: step.id });
  assert.equal(started.status, 200);
  assert.equal((started.payload.step as Record<string, unknown>).state, "IN_PROGRESS");

  application.recordEvidence({
    id: evidenceId("e-alpha"),
    observationId: observationId("o-alpha"),
    authority: "environment",
    subject: "step:alpha",
    result: "passed",
    freshness: "fresh",
    mutationEpoch: application.snapshot().mutationEpoch,
    observedAt: new Date().toISOString(),
  });
  const completed = await call(bridge, "/steps/complete", bridge.token, { id: step.id });
  assert.equal(completed.status, 200);
  assert.equal((completed.payload.step as Record<string, unknown>).state, "COMPLETED");
});

test("W072: a rejected kernel transition is a 409 with the structured code", async (context) => {
  const { bridge } = await composeBridge(context);
  // The seed task is READY, not IN_PROGRESS — starting a step over a READY task
  // is the kernel's STEP_TASK_NOT_IN_PROGRESS refusal, surfaced verbatim.
  const defined = await call(bridge, "/steps/define", bridge.token, {
    taskId: "W1",
    steps: [{ content: "gated", requiredEvidence: [{ authority: "environment", subject: "step:gated" }] }],
  });
  const step = (defined.payload.steps as Record<string, unknown>[])[0]!;
  const started = await call(bridge, "/steps/start", bridge.token, { id: step.id });
  assert.equal(started.status, 409);
  assert.equal(started.payload.kind, "rejected");
  assert.equal(started.payload.code, "STEP_TASK_NOT_IN_PROGRESS");
  assert.ok(typeof started.payload.reason === "string");
});

test("W072: a malformed define body is a 400 and never reaches the kernel", async (context) => {
  const { bridge } = await composeBridge(context);
  const noSteps = await call(bridge, "/steps/define", bridge.token, { taskId: "W1" });
  assert.equal(noSteps.status, 400);
  const badAuthority = await call(bridge, "/steps/define", bridge.token, {
    taskId: "W1",
    steps: [{ content: "x", requiredEvidence: [{ authority: "operator", subject: "step:x" }] }],
  });
  assert.equal(badAuthority.status, 400);
  const badPostcondition = await call(bridge, "/steps/define", bridge.token, {
    taskId: "W1",
    steps: [{ content: "x", requiredPostcondition: { subjects: [{ path: "" }] } }],
  });
  assert.equal(badPostcondition.status, 400);
});

test("W072: /steps/complete re-queries the real on-disk fingerprint and completes on a match", async (context) => {
  const { bridge, application, graph } = await composeBridge(context);
  const path = join(seat(context), "artifact.txt");
  writeFileSync(path, "first");
  assert.equal(graph.transition(taskId("W1"), "IN_PROGRESS").kind, "accepted");
  const defined = await call(bridge, "/steps/define", bridge.token, {
    taskId: "W1",
    steps: [{
      content: "guarded",
      requiredEvidence: [{ authority: "environment", subject: "step:guarded" }],
      requiredPostcondition: { subjects: [{ path, expectedFingerprint: fingerprintFile(path).digest }] },
    }],
  });
  assert.equal(defined.status, 200);
  const step = (defined.payload.steps as Record<string, unknown>[])[0]!;
  assert.deepEqual(step.requiredPostcondition, { subjects: [{ path, expectedFingerprint: fingerprintFile(path).digest }] });
  await call(bridge, "/steps/start", bridge.token, { id: step.id });
  application.recordEvidence({
    id: evidenceId("e-guarded"),
    observationId: observationId("o-guarded"),
    authority: "environment",
    subject: "step:guarded",
    result: "passed",
    freshness: "fresh",
    mutationEpoch: application.snapshot().mutationEpoch,
    observedAt: new Date().toISOString(),
  });
  const completed = await call(bridge, "/steps/complete", bridge.token, { id: step.id });
  assert.equal(completed.status, 200);
  assert.equal((completed.payload.step as Record<string, unknown>).state, "COMPLETED");
});

test("W072: /steps/complete refuses STEP_POSTCONDITION_UNMET when the file changed", async (context) => {
  const { bridge, application, graph } = await composeBridge(context);
  const path = join(seat(context), "artifact.txt");
  writeFileSync(path, "first");
  assert.equal(graph.transition(taskId("W1"), "IN_PROGRESS").kind, "accepted");
  const defined = await call(bridge, "/steps/define", bridge.token, {
    taskId: "W1",
    steps: [{
      content: "guarded",
      requiredEvidence: [{ authority: "environment", subject: "step:guarded" }],
      requiredPostcondition: { subjects: [{ path, expectedFingerprint: fingerprintFile(path).digest }] },
    }],
  });
  const step = (defined.payload.steps as Record<string, unknown>[])[0]!;
  await call(bridge, "/steps/start", bridge.token, { id: step.id });
  application.recordEvidence({
    id: evidenceId("e-guarded"),
    observationId: observationId("o-guarded"),
    authority: "environment",
    subject: "step:guarded",
    result: "passed",
    freshness: "fresh",
    mutationEpoch: application.snapshot().mutationEpoch,
    observedAt: new Date().toISOString(),
  });
  writeFileSync(path, "changed");
  const completed = await call(bridge, "/steps/complete", bridge.token, { id: step.id });
  assert.equal(completed.status, 409);
  assert.equal(completed.payload.code, "STEP_POSTCONDITION_UNMET");
});
