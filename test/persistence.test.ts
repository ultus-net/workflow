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

  assert.equal(restored.application.retryFailedTask(taskId("A")).kind, "accepted");
  assert.equal(restored.application.snapshot().tasks[0]?.state, "READY");
  assert.equal(restored.application.authorize({ sessionId: "s", taskId: taskId("A"), tool: "write_file", mutating: true, subjects: [], input: {} }).kind, "deny");
  assert.equal(restored.application.transition(taskId("A"), "IN_PROGRESS").kind, "accepted");
  assert.equal(restored.application.authorize({ sessionId: "s", taskId: taskId("A"), tool: "write_file", mutating: true, subjects: [], input: {} }).kind, "allow");
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

test("restart restores workspace confinement and capability withholding", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "repo");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  const store = new JsonWorkflowStore(join(directory, "state.json"));
  const application = new WorkflowApplication(
    new TaskGraph([{ id: taskId("A"), title: "Scoped", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    host,
    [],
    new Set(["read"]),
    workspace,
  );
  await store.create(application);

  const restored = (await store.load(host)).application;
  assert.equal(restored.workspaceRoot, workspace);
  assert.deepEqual([...restored.allowedCapabilities], ["read"]);
  assert.equal(restored.authorize({ sessionId: "s", taskId: taskId("A"), tool: "shell", capability: "process", mutating: false, subjects: [], input: {} }).kind, "deny");
  assert.equal(restored.authorize({ sessionId: "s", taskId: taskId("A"), tool: "read", capability: "read", mutating: false, subjects: ["../escape"], input: {} }).kind, "deny");
});

test("pre-W029 persisted workflows load with their historical authority defaults", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const store = new JsonWorkflowStore(path);
  await writeFile(path, JSON.stringify({ version: 0, state: {
    mutationEpoch: 0,
    tasks: [{ id: "A", title: "Legacy", state: "READY", dependencies: [], requiredEvidence: [] }],
    evidence: [],
    history: [],
  } }));

  const restored = (await store.load(host)).application;
  assert.equal(restored.workspaceRoot, undefined);
  assert.deepEqual([...restored.allowedCapabilities], ["read", "mutation"]);
});

test("persisted Workflow state retains only opaque SDK session correlation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonWorkflowStore(join(directory, "state.json"));
  const application = new WorkflowApplication(new TaskGraph([
    { id: taskId("A"), title: "Resume", state: "BLOCKED", dependencies: [], requiredEvidence: [] },
  ]), host);
  application.setCodingSessionCorrelation("cline-session-42");
  await store.create(application);

  const restored = (await store.load(host)).application;
  assert.equal(restored.codingSessionCorrelation, "cline-session-42");
  assert.equal("messages" in restored.persistedState(), false);
});

test("retrying recovered work with unfinished prerequisites remains persistently blocked", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonWorkflowStore(join(directory, "state.json"));
  const application = new WorkflowApplication(new TaskGraph([
    { id: taskId("A"), title: "Dependency", state: "BLOCKED", dependencies: [], requiredEvidence: [{ authority: "environment", subject: "build" }] },
    { id: taskId("B"), title: "Dependent", state: "BLOCKED", dependencies: [taskId("A")], requiredEvidence: [] },
  ]), host);
  application.transition(taskId("A"), "IN_PROGRESS");
  application.transition(taskId("A"), "VERIFYING");
  application.recordEvidence({ id: evidenceId("retry-e"), observationId: observationId("retry-o"), authority: "environment", subject: "build", result: "passed", freshness: "fresh", mutationEpoch: 0, observedAt: "2026-09-11T00:00:00Z" });
  application.transition(taskId("A"), "VERIFIED");
  application.transition(taskId("B"), "IN_PROGRESS");
  application.transition(taskId("B"), "FAILED");
  application.recordMutation(["build"]);
  await store.create(application);

  const retry = application.retryFailedTask(taskId("B"));
  assert.equal(retry.kind, "accepted");
  assert.equal(application.snapshot().tasks.find((task) => task.id === "B")?.state, "BLOCKED");
  await store.save(application, 0);
  assert.equal((await store.load(host)).application.snapshot().tasks.find((task) => task.id === "B")?.state, "BLOCKED");
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
      allowedCapabilities: ["read", "mutation"],
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
    allowedCapabilities: ["read", "mutation"],
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

test("W072 I-10: the application history preserves transition attribution verbatim across restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonWorkflowStore(join(directory, "state.json"));
  const application = new WorkflowApplication(new TaskGraph([
    { id: taskId("A"), title: "Attributed", state: "BLOCKED", dependencies: [], requiredEvidence: [] },
  ]), host);
  await store.create(application);
  // W157: the caller supplies the attribution; the kernel fabricates none.
  application.transition(taskId("A"), "IN_PROGRESS", {
    actor: "operator",
    authority: "interactive approval",
    observedAt: "2026-10-02T00:00:00.000Z",
  });
  // An unattributed transition stays legal and carries no fabricated block.
  application.transition(taskId("A"), "FAILED");
  await store.save(application, 0);

  const live = application.snapshot().history;
  assert.deepEqual(live[0]?.attribution, {
    actor: "operator",
    authority: "interactive approval",
    observedAt: "2026-10-02T00:00:00.000Z",
  }, "the live snapshot history carries the caller attribution, not a stripped {taskId,from,to}");
  assert.equal("attribution" in (live[1] ?? {}), false, "absence stays legal — the unattributed state is a contract citizen");

  const restored = await store.load(host);
  assert.deepEqual(restored.application.snapshot().history[0]?.attribution, {
    actor: "operator",
    authority: "interactive approval",
    observedAt: "2026-10-02T00:00:00.000Z",
  }, "replay preserves attribution (I-10: identity survives restart)");
});

test("persisted history rejects a malformed transition attribution", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const store = new JsonWorkflowStore(path);
  const task = { id: "A", title: "Attributed", state: "IN_PROGRESS", dependencies: [], requiredEvidence: [] };
  const base = { taskId: "A", from: "READY", to: "IN_PROGRESS" };

  for (const attribution of [
    { actor: "impostor", authority: "x", observedAt: "2026-10-02T00:00:00.000Z" },
    { actor: "operator", authority: "", observedAt: "2026-10-02T00:00:00.000Z" },
    { actor: "operator", authority: "x", observedAt: "not-a-date" },
    { actor: "operator", authority: "x" },
  ]) {
    await writeFile(path, JSON.stringify({ version: 0, state: {
      mutationEpoch: 0,
      tasks: [task],
      evidence: [],
      history: [{ ...base, attribution }],
    } }));
    await assert.rejects(() => store.load(host), /invalid persisted workflow/, `malformed attribution must be rejected: ${JSON.stringify(attribution)}`);
  }

  // A well-formed attribution is accepted (the positive control).
  await writeFile(path, JSON.stringify({ version: 0, state: {
    mutationEpoch: 0,
    tasks: [task],
    evidence: [],
    history: [{ ...base, attribution: { actor: "operator", authority: "interactive approval", observedAt: "2026-10-02T00:00:00.000Z" } }],
  } }));
  const restored = await store.load(host);
  assert.equal(restored.application.snapshot().history[0]?.attribution?.actor, "operator");
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

test("W072 I-6: accepted transitions and mutations append execution-log entries", () => {
  const application = new WorkflowApplication(
    new TaskGraph([{ id: taskId("A"), title: "Log", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    host,
  );
  application.transition(taskId("A"), "IN_PROGRESS", { actor: "agent", authority: "test", observedAt: "2026-10-02T00:00:00Z" });
  application.recordMutation(["src/a.ts"]);

  const log = application.executionLog();
  const transitions = log.filter((entry) => entry.kind === "transition");
  // IN_PROGRESS is one accepted transition; recordMutation appends its own
  // transition entries (the kernel's invalidation demotions) when it demotes.
  assert.ok(transitions.length >= 1);
  const first = transitions[0];
  assert.equal(first?.taskId, taskId("A"));
  assert.equal(first?.from, "READY");
  assert.equal(first?.to, "IN_PROGRESS");
  assert.equal(first?.actor, "agent");
  assert.deepEqual(log.map((entry) => entry.seq), log.map((_, index) => index));
});

test("W072 I-6: evidence appends only when a task is resolvable", () => {
  const application = new WorkflowApplication(
    new TaskGraph([{ id: taskId("A"), title: "Ev", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    host,
  );
  const evidence = {
    id: evidenceId("e1"),
    observationId: observationId("o1"),
    authority: "environment" as const,
    subject: "build",
    result: "passed" as const,
    freshness: "fresh" as const,
    mutationEpoch: 0,
    observedAt: "2026-10-02T00:00:00Z",
  };
  // No active task and no explicit correlation: honestly omitted, not invented.
  application.recordEvidence(evidence);
  assert.equal(application.executionLog().filter((entry) => entry.kind === "evidence").length, 0);
  // Explicit correlation records it.
  application.recordEvidence(evidence, taskId("A"));
  const evidenceEntries = application.executionLog().filter((entry) => entry.kind === "evidence");
  assert.equal(evidenceEntries.length, 1);
  assert.equal(evidenceEntries[0]?.taskId, taskId("A"));
  assert.equal(evidenceEntries[0]?.summary, "environment:build:passed");
});

test("W072 I-6: the execution log round-trips and continues its sequence after restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonWorkflowStore(join(directory, "state.json"));
  const application = new WorkflowApplication(
    new TaskGraph([{ id: taskId("A"), title: "Round", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    host,
  );
  await store.create(application);
  application.transition(taskId("A"), "IN_PROGRESS", { actor: "agent", authority: "test", observedAt: "2026-10-02T00:00:00Z" });
  const before = application.executionLog();
  assert.ok(before.length > 0);
  await store.save(application, 0);

  const restored = await store.load(host);
  const after = restored.application.executionLog();
  // The IN_PROGRESS task is demoted to FAILED on restore; that synthetic
  // recovery transition is appended to the log as well as to the history, so
  // the two stay coherent across the restart.
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.slice(0, before.length), before);
  const recovery = after[after.length - 1];
  assert.equal(recovery?.kind, "transition");
  assert.equal(recovery?.taskId, taskId("A"));
  assert.equal(recovery?.from, "IN_PROGRESS");
  assert.equal(recovery?.to, "FAILED");
  assert.equal(recovery?.actor, "system");
  // A new append after restore continues the monotonic sequence.
  restored.application.transition(taskId("A"), "READY", { actor: "operator", authority: "test", observedAt: "2026-10-02T00:01:00Z" });
  const extended = restored.application.executionLog();
  assert.equal(extended.length, after.length + 1);
  assert.equal(extended[extended.length - 1]?.seq, after.length);
  assert.deepEqual(
    extended.map((entry) => entry.seq),
    extended.map((_, index) => index),
  );
});

test("W072 I-6: an absent execution log loads (backward compat)", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const store = new JsonWorkflowStore(path);
  await writeFile(path, JSON.stringify({ version: 0, state: {
    mutationEpoch: 0,
    tasks: [{ id: "A", title: "Old", state: "READY", dependencies: [], requiredEvidence: [] }],
    evidence: [],
    history: [],
  } }));
  const restored = await store.load(host);
  assert.deepEqual(restored.application.executionLog(), []);
});

test("W072 I-6: a malformed persisted execution-log entry is rejected, not dropped", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const store = new JsonWorkflowStore(path);
  const base = {
    mutationEpoch: 0,
    tasks: [{ id: "A", title: "Bad", state: "READY", dependencies: [], requiredEvidence: [] }],
    evidence: [],
    history: [],
  };
  await writeFile(path, JSON.stringify({ version: 0, state: { ...base, executionLog: [{ seq: 5, at: "2026-10-02T00:00:00Z", taskId: "A", kind: "transition", from: "READY", to: "IN_PROGRESS" }] } }));
  await assert.rejects(() => store.load(host), /invalid persisted workflow/);

  await writeFile(path, JSON.stringify({ version: 0, state: { ...base, executionLog: [{ seq: 0, at: "not-a-date", taskId: "A", kind: "transition", from: "READY", to: "IN_PROGRESS" }] } }));
  await assert.rejects(() => store.load(host), /invalid persisted workflow/);

  await writeFile(path, JSON.stringify({ version: 0, state: { ...base, executionLog: [{ seq: 0, at: "2026-10-02T00:00:00Z", taskId: "A", kind: "nonsense" }] } }));
  await assert.rejects(() => store.load(host), /invalid persisted workflow/);
});

test("W072 I-10: execution-log entries pin the active step and coding session, or omit them honestly", () => {
  const application = new WorkflowApplication(
    new TaskGraph([{ id: taskId("A"), title: "Identity", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    host,
    [],
    undefined,
    undefined,
    "session-42",
  );
  application.transition(taskId("A"), "IN_PROGRESS");
  application.defineTaskSteps(taskId("A"), [{ content: "Edit", requiredEvidence: [{ authority: "environment", subject: "build" }] }]);
  const step = application.taskSteps(taskId("A"))[0];
  assert.ok(step !== undefined);
  application.startTaskStep(step.id);
  application.recordEvidence({
    id: evidenceId("e-ident"), observationId: observationId("o-ident"),
    authority: "environment", subject: "build", result: "passed", freshness: "fresh",
    mutationEpoch: 0, observedAt: "2026-10-02T00:00:00Z",
  }, taskId("A"));

  const evidenceEntry = application.executionLog().find((entry) => entry.kind === "evidence");
  assert.equal(evidenceEntry?.stepId, step.id, "the active step at append time is pinned on the entry");
  assert.equal(evidenceEntry?.sessionId, "session-42", "the coding-session correlation is pinned on the entry");

  // The IN_PROGRESS transition was appended before any step existed: it carries
  // the session but honestly omits the step it could not know, rather than
  // emitting `stepId: undefined`.
  const startEntry = application.executionLog().find((entry) => entry.kind === "transition" && entry.to === "IN_PROGRESS");
  assert.equal(startEntry?.stepId, undefined, "no active step at that append -> omitted, not invented");
  assert.equal(startEntry?.sessionId, "session-42");
  assert.equal("stepId" in (startEntry ?? {}), false, "absent identity is omitted from the artifact");

  // Neither identity resolvable: both fields are absent, never fabricated.
  const bare = new WorkflowApplication(
    new TaskGraph([{ id: taskId("B"), title: "Bare", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    host,
  );
  bare.transition(taskId("B"), "IN_PROGRESS");
  const bareEntry = bare.executionLog()[0];
  assert.equal(bareEntry?.stepId, undefined);
  assert.equal(bareEntry?.sessionId, undefined);
  assert.equal("stepId" in (bareEntry ?? {}), false);
  assert.equal("sessionId" in (bareEntry ?? {}), false);
});

test("W072 I-10: step and session identity survive a persistence round-trip", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonWorkflowStore(join(directory, "state.json"));
  const application = new WorkflowApplication(
    new TaskGraph([{ id: taskId("A"), title: "Round", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    host,
    [],
    undefined,
    undefined,
    "session-rt",
  );
  application.transition(taskId("A"), "IN_PROGRESS");
  application.defineTaskSteps(taskId("A"), [{ content: "Edit", requiredEvidence: [{ authority: "environment", subject: "build" }] }]);
  const step = application.taskSteps(taskId("A"))[0];
  assert.ok(step !== undefined);
  application.startTaskStep(step.id);
  application.recordEvidence({
    id: evidenceId("e-rt"), observationId: observationId("o-rt"),
    authority: "environment", subject: "build", result: "passed", freshness: "fresh",
    mutationEpoch: 0, observedAt: "2026-10-02T00:00:00Z",
  }, taskId("A"));
  await store.create(application);
  await store.save(application, 0);

  const restored = await store.load(host);
  const evidenceEntry = restored.application.executionLog().find((entry) => entry.kind === "evidence");
  assert.equal(evidenceEntry?.stepId, step.id, "replay preserves the entry's step identity");
  assert.equal(evidenceEntry?.sessionId, "session-rt", "replay preserves the entry's session identity");
  assert.equal(restored.application.codingSessionCorrelation, "session-rt");
});

test("W072 I-10: malformed persisted step/session identity is rejected, not dropped", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const store = new JsonWorkflowStore(path);
  const base = {
    mutationEpoch: 0,
    tasks: [{ id: "A", title: "Bad", state: "READY", dependencies: [], requiredEvidence: [] }],
    evidence: [],
    history: [],
  };
  const entry = (identity: Record<string, unknown>) => ({
    seq: 0, at: "2026-10-02T00:00:00Z", taskId: "A", kind: "evidence", summary: "x", ...identity,
  });
  for (const identity of [{ stepId: "" }, { stepId: 7 }, { sessionId: "" }, { sessionId: 7 }]) {
    await writeFile(path, JSON.stringify({ version: 0, state: { ...base, executionLog: [entry(identity)] } }));
    await assert.rejects(() => store.load(host), /invalid persisted workflow/, `malformed identity must be rejected: ${JSON.stringify(identity)}`);
  }

  // Positive control: a well-formed identity round-trips verbatim.
  await writeFile(path, JSON.stringify({ version: 0, state: { ...base, executionLog: [entry({ stepId: "s1", sessionId: "sess" })] } }));
  const restored = await store.load(host);
  assert.deepEqual(restored.application.executionLog()[0], {
    seq: 0, at: "2026-10-02T00:00:00Z", taskId: "A", kind: "evidence", summary: "x", stepId: "s1", sessionId: "sess",
  });
});

test("W072 I-9: a persisted step postcondition is validated on load", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const store = new JsonWorkflowStore(path);
  const step = (postcondition: unknown) => ({
    id: "s1",
    taskId: "A",
    content: "Edit the file",
    state: "PENDING",
    requiredEvidence: [{ authority: "environment", subject: "diff" }],
    requiredPostcondition: postcondition,
  });
  const base = {
    mutationEpoch: 0,
    tasks: [{ id: "A", title: "Post", state: "READY", dependencies: [], requiredEvidence: [] }],
    evidence: [],
    history: [],
  };
  // A malformed claim must be rejected at load rather than throwing inside
  // completeStep (or silently disabling the I-9 gate).
  await writeFile(path, JSON.stringify({ version: 0, state: { ...base, steps: [step("garbage")] } }));
  await assert.rejects(() => store.load(host), /invalid persisted workflow/);
  await writeFile(path, JSON.stringify({ version: 0, state: { ...base, steps: [step({ subjects: "not-an-array" })] } }));
  await assert.rejects(() => store.load(host), /invalid persisted workflow/);
  await writeFile(path, JSON.stringify({ version: 0, state: { ...base, steps: [step({ subjects: [{ path: "a.ts" }] })] } }));
  await assert.rejects(() => store.load(host), /invalid persisted workflow/);

  // A well-formed claim round-trips.
  await writeFile(path, JSON.stringify({ version: 0, state: {
    ...base,
    steps: [step({ subjects: [{ path: "a.ts", expectedFingerprint: "sha256:abc" }] })],
  } }));
  const restored = await store.load(host);
  assert.deepEqual(
    restored.application.taskSteps(taskId("A"))[0]?.requiredPostcondition,
    { subjects: [{ path: "a.ts", expectedFingerprint: "sha256:abc" }] },
  );
});
