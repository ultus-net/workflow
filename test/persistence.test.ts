import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  JsonWorkflowStore,
  TaskGraph,
  WorkflowApplication,
  WorkflowVersionConflict,
  evidenceId,
  hostCapabilities,
  observationId,
  taskId,
  type WorkflowTask,
} from "../src/index.js";

const host = hostCapabilities({ transport: "native", authoritativePreMutation: true });

test("persisted workflow restores tasks, evidence, epoch, and history after restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonWorkflowStore(join(directory, "state.json"));
  const tasks: WorkflowTask[] = [{ id: taskId("A"), title: "Persist", state: "BLOCKED", dependencies: [], requiredEvidence: [{ authority: "environment", subject: "build" }] }];
  const application = new WorkflowApplication(new TaskGraph(tasks), host);
  await store.create(application);
  application.transition(taskId("A"), "IN_PROGRESS");
  application.transition(taskId("A"), "VERIFYING");
  application.recordEvidence({ id: evidenceId("e1"), observationId: observationId("o1"), authority: "environment", subject: "build", result: "passed", freshness: "fresh", mutationEpoch: 0, observedAt: "2026-09-11T00:00:00Z" });
  await store.save(application, 0);

  const restored = await store.load(host);
  assert.equal(restored.version, 1);
  assert.equal(restored.application.snapshot().tasks[0]?.state, "VERIFYING");
  assert.equal(restored.application.snapshot().evidence[0]?.subject, "build");
  assert.equal(restored.application.snapshot().history.length, 2);
});

test("restart preserves verified work across unrelated later mutations", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonWorkflowStore(join(directory, "state.json"));
  const application = new WorkflowApplication(new TaskGraph([{ id: taskId("A"), title: "Stable", state: "BLOCKED", dependencies: [], requiredEvidence: [{ authority: "environment", subject: "build" }] }]), host);
  await store.create(application);
  application.transition(taskId("A"), "IN_PROGRESS");
  application.transition(taskId("A"), "VERIFYING");
  application.recordEvidence({ id: evidenceId("e-stable"), observationId: observationId("o-stable"), authority: "environment", subject: "build", result: "passed", freshness: "fresh", mutationEpoch: 0, observedAt: "2026-09-11T00:00:00Z" });
  application.transition(taskId("A"), "VERIFIED");
  application.recordMutation(["unrelated"]);
  await store.save(application, 0);
  assert.equal((await store.load(host)).application.snapshot().tasks[0]?.state, "VERIFIED");
});

test("mutation invalidation is journaled so repeated verification survives restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonWorkflowStore(join(directory, "state.json"));
  const application = new WorkflowApplication(new TaskGraph([{ id: taskId("A"), title: "Repeat", state: "BLOCKED", dependencies: [], requiredEvidence: [{ authority: "environment", subject: "build" }] }]), host);
  await store.create(application);
  application.transition(taskId("A"), "IN_PROGRESS");
  application.transition(taskId("A"), "VERIFYING");
  application.recordEvidence({ id: evidenceId("e-old"), observationId: observationId("o-old"), authority: "environment", subject: "build", result: "passed", freshness: "fresh", mutationEpoch: 0, observedAt: "2026-09-11T00:00:00Z" });
  application.transition(taskId("A"), "VERIFIED");
  application.recordMutation(["build"]);
  application.recordEvidence({ id: evidenceId("e-new"), observationId: observationId("o-new"), authority: "environment", subject: "build", result: "passed", freshness: "fresh", mutationEpoch: 1, observedAt: "2026-09-11T00:01:00Z" });
  application.transition(taskId("A"), "VERIFIED");
  await store.save(application, 0);
  const restored = await store.load(host);
  assert.equal(restored.application.snapshot().tasks[0]?.state, "VERIFIED");
  assert.deepEqual(restored.application.snapshot().history.map(({ from, to }) => [from, to]), [
    ["READY", "IN_PROGRESS"], ["IN_PROGRESS", "VERIFYING"], ["VERIFYING", "VERIFIED"],
    ["VERIFIED", "VERIFYING"], ["VERIFYING", "VERIFIED"],
  ]);
});

test("restart fails orphaned in-progress work instead of guessing mutation outcome", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonWorkflowStore(join(directory, "state.json"));
  const tasks: WorkflowTask[] = [{ id: taskId("A"), title: "Orphan", state: "BLOCKED", dependencies: [], requiredEvidence: [] }];
  const application = new WorkflowApplication(new TaskGraph(tasks), host);
  await store.create(application);
  application.transition(taskId("A"), "IN_PROGRESS");
  await store.save(application, 0);

  const restored = await store.load(host);
  assert.equal(restored.application.snapshot().tasks[0]?.state, "FAILED");
  assert.deepEqual(restored.application.snapshot().history.at(-1), { taskId: "A", from: "IN_PROGRESS", to: "FAILED" });
});

test("restart preserves verifying work for repeat verification", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonWorkflowStore(join(directory, "state.json"));
  const application = new WorkflowApplication(new TaskGraph([{ id: taskId("A"), title: "Verify", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]), host);
  await store.create(application);
  application.transition(taskId("A"), "IN_PROGRESS");
  application.transition(taskId("A"), "VERIFYING");
  await store.save(application, 0);

  const restored = await store.load(host);
  assert.equal(restored.application.snapshot().tasks[0]?.state, "VERIFYING");
});

test("leftover writer lock fails closed", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const store = new JsonWorkflowStore(path);
  const application = new WorkflowApplication(new TaskGraph([{ id: taskId("A"), title: "Lock", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]), host);
  await writeFile(`${path}.lock`, "orphaned", { mode: 0o600 });
  await assert.rejects(() => store.create(application), /locked by another writer/);
});

test("malformed persisted domain values fail closed", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const store = new JsonWorkflowStore(path);
  await writeFile(path, JSON.stringify({
    version: 0,
    state: {
      mutationEpoch: 0,
      tasks: [{ id: "A", title: "Bad", state: "READY", dependencies: [], requiredEvidence: [] }],
      evidence: [{ id: "e", observationId: "o", authority: "mcp", subject: "build", result: "passed", freshness: "fresh", mutationEpoch: 0, observedAt: "not-a-date" }],
      history: [],
    },
  }));
  await assert.rejects(() => store.load(host), /invalid persisted workflow/);
});

test("persisted verified state cannot self-certify without required evidence", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const store = new JsonWorkflowStore(path);
  await writeFile(path, JSON.stringify({
    version: 0,
    state: {
      mutationEpoch: 0,
      tasks: [{ id: "A", title: "Forged", state: "VERIFIED", dependencies: [], requiredEvidence: [{ authority: "environment", subject: "build" }] }],
      evidence: [],
      history: [],
    },
  }));
  await assert.rejects(() => store.load(host), /persisted verified task A does not have fresh passing evidence/);
});

test("persisted history rejects unknown tasks and impossible transitions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const store = new JsonWorkflowStore(path);
  const state = {
    mutationEpoch: 0,
    tasks: [{ id: "A", title: "History", state: "READY", dependencies: [], requiredEvidence: [] }],
    evidence: [],
    history: [{ taskId: "missing", from: "READY", to: "IN_PROGRESS" }],
  };
  await writeFile(path, JSON.stringify({ version: 0, state }));
  await assert.rejects(() => store.load(host), /invalid persisted workflow/);

  await writeFile(path, JSON.stringify({ version: 0, state: { ...state, history: [{ taskId: "A", from: "READY", to: "VERIFIED" }] } }));
  await assert.rejects(() => store.load(host), /invalid persisted workflow/);

  await writeFile(path, JSON.stringify({ version: 0, state: { ...state, tasks: [{ ...state.tasks[0], state: "IN_PROGRESS" }], history: [
    { taskId: "A", from: "READY", to: "IN_PROGRESS" },
    { taskId: "A", from: "READY", to: "IN_PROGRESS" },
  ] } }));
  await assert.rejects(() => store.load(host), /invalid persisted workflow/);

  await writeFile(path, JSON.stringify({ version: 0, state: { ...state, tasks: [{ ...state.tasks[0], state: "FAILED" }], history: [
    { taskId: "A", from: "READY", to: "IN_PROGRESS" },
  ] } }));
  await assert.rejects(() => store.load(host), /invalid persisted workflow/);
});

test("persisted history rejects work started before its dependency was verified", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const store = new JsonWorkflowStore(path);
  await writeFile(path, JSON.stringify({ version: 0, state: {
    mutationEpoch: 0,
    tasks: [
      { id: "A", title: "Dependency", state: "VERIFIED", dependencies: [], requiredEvidence: [] },
      { id: "B", title: "Dependent", state: "IN_PROGRESS", dependencies: ["A"], requiredEvidence: [] },
    ],
    evidence: [],
    history: [
      { taskId: "B", from: "READY", to: "IN_PROGRESS" },
      { taskId: "A", from: "READY", to: "IN_PROGRESS" },
      { taskId: "A", from: "IN_PROGRESS", to: "VERIFYING" },
      { taskId: "A", from: "VERIFYING", to: "VERIFIED" },
    ],
  } }));
  await assert.rejects(() => store.load(host), /invalid persisted workflow/);
});

test("persisted readiness must match dependency state", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const store = new JsonWorkflowStore(path);
  await writeFile(path, JSON.stringify({ version: 0, state: {
    mutationEpoch: 0,
    tasks: [
      { id: "A", title: "Dependency", state: "READY", dependencies: [], requiredEvidence: [] },
      { id: "B", title: "Forged ready", state: "READY", dependencies: ["A"], requiredEvidence: [] },
    ],
    evidence: [],
    history: [],
  } }));
  await assert.rejects(() => store.load(host), /persisted task B has inconsistent dependency readiness/);
});

test("stale writer is rejected by optimistic version check", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonWorkflowStore(join(directory, "state.json"));
  const tasks: WorkflowTask[] = [{ id: taskId("A"), title: "Conflict", state: "BLOCKED", dependencies: [], requiredEvidence: [] }];
  const application = new WorkflowApplication(new TaskGraph(tasks), host);
  await store.create(application);
  const first = await store.load(host);
  const stale = await store.load(host);
  first.application.transition(taskId("A"), "IN_PROGRESS");
  assert.equal(await store.save(first.application, first.version), 1);

  await assert.rejects(() => store.save(stale.application, stale.version), WorkflowVersionConflict);
});

test("concurrent writers cannot both commit the same version", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonWorkflowStore(join(directory, "state.json"));
  const tasks: WorkflowTask[] = [{ id: taskId("A"), title: "Race", state: "BLOCKED", dependencies: [], requiredEvidence: [] }];
  const application = new WorkflowApplication(new TaskGraph(tasks), host);
  await store.create(application);
  const first = await store.load(host);
  const second = await store.load(host);
  first.application.transition(taskId("A"), "IN_PROGRESS");
  second.application.transition(taskId("A"), "IN_PROGRESS");

  const results = await Promise.allSettled([
    store.save(first.application, 0),
    store.save(second.application, 0),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});
