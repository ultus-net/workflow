import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TaskGraph,
  WorkflowApplication,
  ClineHostAdapter,
  AcpHostAdapter,
  nextInteractiveState,
  hostCapabilities,
  evidenceId,
  observationId,
  taskId,
  type ProposedToolAction,
  type WorkflowTask,
} from "../src/index.js";

const task = (id: string, dependencies: readonly string[] = []): WorkflowTask => ({
  id: taskId(id),
  title: id,
  state: "BLOCKED",
  dependencies: dependencies.map(taskId),
  requiredEvidence: [],
});

const mutation = (id: string): ProposedToolAction => ({
  sessionId: "session",
  taskId: taskId(id),
  tool: "write_file",
  mutating: true,
  subjects: ["src/a.ts"],
  input: {},
});

test("application is the policy authority for host proposals", () => {
  const graph = new TaskGraph([task("A"), task("B", ["A"])]);
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );

  assert.equal(application.authorize(mutation("A")).kind, "deny");
  graph.transition(taskId("A"), "IN_PROGRESS");
  assert.equal(application.authorize(mutation("A")).kind, "allow");
  assert.equal(application.authorize(mutation("B")).kind, "deny");
});

test("application confines file subjects to its authorized workspace", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation"]),
    "/workspace/repository",
  );

  assert.equal(application.authorize({ ...mutation("A"), subjects: ["src/a.ts"] }).kind, "allow");
  assert.deepEqual(application.authorize({ ...mutation("A"), subjects: ["../outside.txt"] }), {
    kind: "deny",
    code: "WORKSPACE_PATH_DENIED",
    reason: "path ../outside.txt is outside authorized workspace /workspace/repository",
  });
  assert.equal(application.authorize({ ...mutation("A"), subjects: ["/workspace/repository/src/a.ts"] }).kind, "allow");
  assert.equal(application.authorize({ ...mutation("A"), subjects: ["/workspace/other/a.ts"] }).kind, "deny");
});

test("application denies an in-workspace path that escapes through a symlink", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workflow-workspace-policy-"));
  const workspace = join(parent, "repository");
  const outside = join(parent, "outside");
  try {
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    await writeFile(join(outside, "secret.txt"), "outside\n");
    await symlink(outside, join(workspace, "linked-outside"));
    const graph = new TaskGraph([task("A")]);
    graph.transition(taskId("A"), "IN_PROGRESS");
    const application = new WorkflowApplication(
      graph,
      hostCapabilities({ transport: "native", authoritativePreMutation: true }),
      [],
      new Set(["read", "mutation"]),
      workspace,
    );

    assert.equal(application.authorize({ ...mutation("A"), subjects: ["linked-outside/secret.txt"] }).kind, "deny");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("application denies a dangling in-workspace symlink whose missing target is outside", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workflow-workspace-dangling-policy-"));
  const workspace = join(parent, "repository");
  const outsideTarget = join(parent, "outside-created-by-write.txt");
  try {
    await mkdir(workspace);
    await symlink(outsideTarget, join(workspace, "escaped.txt"));
    const graph = new TaskGraph([task("A")]);
    graph.transition(taskId("A"), "IN_PROGRESS");
    const application = new WorkflowApplication(
      graph,
      hostCapabilities({ transport: "native", authoritativePreMutation: true }),
      [],
      new Set(["read", "mutation"]),
      workspace,
    );

    assert.equal(application.authorize({ ...mutation("A"), subjects: ["escaped.txt"] }).kind, "deny");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("application resolves symlinks before validating workspace confinement", async () => {
  const parent = await mkdtemp(join(tmpdir(), "workflow-workspace-order-"));
  const workspace = join(parent, "repository");
  const inside = join(workspace, "sub");
  const outside = join(parent, "outside");
  try {
    await Promise.all([mkdir(inside, { recursive: true }), mkdir(outside)]);
    await writeFile(join(outside, "secret.txt"), "outside\n");
    // Target carries `..` yet canonicalizes back inside the workspace: a
    // lexical-only validator would wrongly deny it, so allowing it pins
    // resolution as the input to the decision.
    await symlink(join("..", "repository", "sub"), join(workspace, "roundtrip"));
    // The name is inside the workspace but the resolved target escapes: only
    // a validator that resolves before deciding can deny it.
    await symlink(outside, join(workspace, "escape"));
    const graph = new TaskGraph([task("A")]);
    graph.transition(taskId("A"), "IN_PROGRESS");
    const application = new WorkflowApplication(
      graph,
      hostCapabilities({ transport: "native", authoritativePreMutation: true }),
      [],
      new Set(["read", "mutation"]),
      workspace,
    );

    assert.equal(application.authorize({ ...mutation("A"), subjects: ["roundtrip"] }).kind, "allow");
    assert.equal(application.authorize({ ...mutation("A"), subjects: ["escape/secret.txt"] }).kind, "deny");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("high-blast-radius capabilities are withheld independently of task state and prompts", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const host = hostCapabilities({ transport: "native", authoritativePreMutation: true });
  const application = new WorkflowApplication(graph, host);

  assert.equal(application.authorize({ ...mutation("A"), capability: "process", input: { command: "status" } }).kind, "deny");
  assert.equal(application.authorize({ ...mutation("A"), capability: "credentials", mutating: false }).kind, "deny");
  assert.equal(application.authorize({ ...mutation("A"), capability: "mutation" }).kind, "allow");

  const privileged = new WorkflowApplication(graph, host, [], new Set(["read", "mutation", "process"]));
  assert.equal(privileged.authorize({ ...mutation("A"), capability: "process" }).kind, "allow");
});

test("real host adapters cannot disguise process execution as ordinary mutation", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const cline = new ClineHostAdapter({ sessionId: "session", taskId: taskId("A"), isMutatingTool: () => true });
  const clineApplication = new WorkflowApplication(graph, cline.capabilities);
  const clineProposal = cline.proposalFromBeforeTool({ tool: { name: "run_commands" }, input: { command: "status" } });
  assert.equal(clineProposal.capability, "process");
  assert.equal(clineApplication.authorize(clineProposal).kind, "deny");

  const acp = new AcpHostAdapter({ authoritativePermissions: true });
  const acpApplication = new WorkflowApplication(graph, acp.capabilities);
  const acpProposal = acp.proposalFromBeforeTool({
    sessionId: "session",
    taskId: taskId("A"),
    toolCall: { name: "terminal", kind: "execute", rawInput: { command: "status" } },
  });
  assert.equal(acpProposal.capability, "process");
  assert.equal(acpApplication.authorize(acpProposal).kind, "deny");
});

test("real host adapters can classify and withhold credential access", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const cline = new ClineHostAdapter({
    sessionId: "session",
    taskId: taskId("A"),
    isMutatingTool: () => false,
    capabilityForTool: (tool) => (tool === "secret_store" ? "credentials" : "read"),
  });
  const clineApplication = new WorkflowApplication(graph, cline.capabilities);
  const clineProposal = cline.proposalFromBeforeTool({ tool: { name: "secret_store" }, input: {} });
  assert.equal(clineProposal.capability, "credentials");
  assert.equal(clineApplication.authorize(clineProposal).kind, "deny");

  const acp = new AcpHostAdapter({ authoritativePermissions: true });
  const acpApplication = new WorkflowApplication(graph, acp.capabilities);
  const acpProposal = acp.proposalFromBeforeTool({
    sessionId: "session",
    taskId: taskId("A"),
    toolCall: { name: "secret-store", capability: "credentials" },
  });
  assert.equal(acpProposal.capability, "credentials");
  assert.equal(acpApplication.authorize(acpProposal).kind, "deny");
});

test("host metadata cannot downgrade known process tools", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const cline = new ClineHostAdapter({
    sessionId: "session",
    taskId: taskId("A"),
    isMutatingTool: () => true,
    capabilityForTool: () => "read",
  });
  const clineProposal = cline.proposalFromBeforeTool({ tool: { name: "run_commands" }, input: {} });
  assert.equal(clineProposal.capability, "process");
  assert.equal(new WorkflowApplication(graph, cline.capabilities).authorize(clineProposal).kind, "deny");

  const acp = new AcpHostAdapter({ authoritativePermissions: true });
  const acpProposal = acp.proposalFromBeforeTool({
    sessionId: "session",
    taskId: taskId("A"),
    toolCall: { name: "shell", kind: "execute", capability: "read" },
  });
  assert.equal(acpProposal.capability, "process");
  assert.equal(new WorkflowApplication(graph, acp.capabilities).authorize(acpProposal).kind, "deny");
});

test("actions requiring process and credentials must be granted both capabilities", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const cline = new ClineHostAdapter({
    sessionId: "session",
    taskId: taskId("A"),
    isMutatingTool: () => true,
    capabilityForTool: () => "credentials",
  });
  const proposal = cline.proposalFromBeforeTool({ tool: { name: "run_command" }, input: {} });
  assert.deepEqual(proposal.requiredCapabilities, ["process", "credentials"]);
  assert.equal(new WorkflowApplication(graph, cline.capabilities, [], new Set(["read", "mutation", "process"])).authorize(proposal).kind, "deny");
  assert.equal(new WorkflowApplication(graph, cline.capabilities, [], new Set(["read", "mutation", "credentials"])).authorize(proposal).kind, "deny");
  assert.equal(new WorkflowApplication(graph, cline.capabilities, [], new Set(["read", "mutation", "process", "credentials"])).authorize(proposal).kind, "allow");

  const acp = new AcpHostAdapter({ authoritativePermissions: true });
  const acpProposal = acp.proposalFromBeforeTool({
    sessionId: "session",
    taskId: taskId("A"),
    toolCall: { name: "credential-shell", kind: "execute", capability: "credentials" },
  });
  assert.deepEqual(acpProposal.requiredCapabilities, ["process", "credentials"]);
  assert.equal(new WorkflowApplication(graph, acp.capabilities, [], new Set(["read", "mutation", "process"])).authorize(acpProposal).kind, "deny");
});

test("required capability metadata cannot omit the primary capability", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const application = new WorkflowApplication(graph, hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  assert.equal(application.authorize({
    sessionId: "session", taskId: taskId("A"), tool: "secret", capability: "credentials",
    requiredCapabilities: [], mutating: false, subjects: [], input: {},
  }).kind, "deny");
});

test("application snapshot exposes blockers and enforcement without writable state", () => {
  const graph = new TaskGraph([task("A"), task("B", ["A"])]);
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );

  const snapshot = application.snapshot();
  assert.equal(snapshot.enforcementLevel, "advisory");
  assert.deepEqual(snapshot.tasks.find((item) => item.id === taskId("B"))?.blockers, [taskId("A")]);
});

test("application commands project transition history and evidence state", () => {
  const graph = new TaskGraph([
    {
      ...task("A"),
      requiredEvidence: [{ authority: "environment", subject: "typecheck" }],
    },
  ]);
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );

  application.transition(taskId("A"), "IN_PROGRESS");
  application.transition(taskId("A"), "VERIFYING");
  application.recordEvidence({
    id: evidenceId("ev-1"),
    observationId: observationId("obs-1"),
    authority: "environment",
    subject: "typecheck",
    result: "passed",
    freshness: "fresh",
    mutationEpoch: 0,
    observedAt: "2026-09-11T00:00:00.000Z",
  });
  application.transition(taskId("A"), "VERIFIED");

  let snapshot = application.snapshot();
  assert.equal(snapshot.history.length, 3);
  assert.equal(snapshot.evidence[0]?.freshness, "fresh");

  application.recordMutation(["typecheck"]);
  snapshot = application.snapshot();
  assert.equal(snapshot.tasks[0]?.state, "VERIFYING");
  assert.equal(snapshot.evidence[0]?.freshness, "stale");
});

test("TUI interactive advancement only proposes legal forward states", () => {
  assert.equal(nextInteractiveState("READY"), "IN_PROGRESS");
  assert.equal(nextInteractiveState("IN_PROGRESS"), "VERIFYING");
  assert.equal(nextInteractiveState("VERIFYING"), "VERIFIED");
  assert.equal(nextInteractiveState("BLOCKED"), undefined);
  assert.equal(nextInteractiveState("VERIFIED"), undefined);
});

test("application commands add discovered tasks and dependencies without exposing graph mutation", () => {
  const application = new WorkflowApplication(
    new TaskGraph([task("A")]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );

  application.addTask({
    id: taskId("B"),
    title: "Discovered prerequisite",
    dependencies: [],
    requiredEvidence: [{ authority: "environment", subject: "B:test" }],
  });
  application.addDependency(taskId("A"), taskId("B"));

  const snapshot = application.snapshot();
  assert.deepEqual(snapshot.tasks.map(({ id, state, blockers }) => ({ id, state, blockers })), [
    { id: taskId("A"), state: "BLOCKED", blockers: [taskId("B")] },
    { id: taskId("B"), state: "READY", blockers: [] },
  ]);
  assert.throws(() => application.addDependency(taskId("B"), taskId("A")), /dependency cycle/);
});

test("blocked canonical task cannot mutate while its eligible dependency can", () => {
  const application = new WorkflowApplication(
    new TaskGraph([
      { ...task("A"), dependencies: [taskId("B")] },
      task("B"),
    ]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );

  assert.deepEqual(application.authorize(mutation("A")), {
    kind: "deny",
    code: "TASK_NOT_IN_PROGRESS",
    reason: "task A is BLOCKED, not IN_PROGRESS",
  });
  assert.equal(application.transition(taskId("B"), "IN_PROGRESS").kind, "accepted");
  assert.equal(application.authorize(mutation("B")).kind, "allow");
});

test("application selects only an in-progress canonical task for SDK proposal correlation", () => {
  const application = new WorkflowApplication(
    new TaskGraph([{ ...task("A"), dependencies: [taskId("B")] }, task("B")]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );

  assert.throws(() => application.selectActiveTask(taskId("A")), /BLOCKED/);
  assert.equal(application.transition(taskId("B"), "IN_PROGRESS").kind, "accepted");
  application.selectActiveTask(taskId("B"));
  assert.equal(application.activeTaskId(), taskId("B"));
});

test("application starts a uniquely ready task for an interactive coding session", () => {
  const application = new WorkflowApplication(
    new TaskGraph([{ ...task("A"), dependencies: [taskId("B")] }, task("B")]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );

  application.startInteractiveTask();

  assert.equal(application.activeTaskId(), taskId("B"));
  assert.equal(application.snapshot().tasks.find(({ id }) => id === taskId("B"))?.state, "IN_PROGRESS");
});

test("application refuses to guess between multiple ready interactive tasks", () => {
  const application = new WorkflowApplication(
    new TaskGraph([task("A"), task("B")]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );

  assert.throws(() => application.startInteractiveTask(), /multiple READY tasks/);
  assert.equal(application.snapshot().tasks.every(({ state }) => state === "READY"), true);
});

test("multi-step coding lifecycle unlocks work only after focused verification evidence", () => {
  const application = new WorkflowApplication(
    new TaskGraph([
      { ...task("implementation", ["prerequisite"]), requiredEvidence: [{ authority: "environment", subject: "implementation:test" }] },
      { ...task("prerequisite"), requiredEvidence: [{ authority: "environment", subject: "prerequisite:test" }] },
    ]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );

  assert.equal(application.authorize(mutation("implementation")).kind, "deny");
  assert.equal(application.transition(taskId("prerequisite"), "IN_PROGRESS").kind, "accepted");
  assert.equal(application.authorize(mutation("prerequisite")).kind, "allow");
  application.recordMutation(["prerequisite:test"]);
  assert.equal(application.transition(taskId("prerequisite"), "VERIFYING").kind, "accepted");
  assert.equal(application.transition(taskId("prerequisite"), "VERIFIED").kind, "rejected");
  application.recordEvidence({
    id: evidenceId("prerequisite-evidence"), observationId: observationId("prerequisite-observation"),
    authority: "environment", subject: "prerequisite:test", result: "passed", freshness: "fresh",
    mutationEpoch: application.snapshot().mutationEpoch, observedAt: "2026-09-11T00:00:00.000Z",
  });
  assert.equal(application.transition(taskId("prerequisite"), "VERIFIED").kind, "accepted");
  assert.equal(application.snapshot().tasks.find(({ id }) => id === taskId("implementation"))?.state, "READY");

  assert.equal(application.transition(taskId("implementation"), "IN_PROGRESS").kind, "accepted");
  application.recordMutation(["implementation:test"]);
  assert.equal(application.transition(taskId("implementation"), "VERIFYING").kind, "accepted");
  assert.equal(application.transition(taskId("implementation"), "VERIFIED").kind, "rejected");
  application.recordEvidence({
    id: evidenceId("implementation-evidence"), observationId: observationId("implementation-observation"),
    authority: "environment", subject: "implementation:test", result: "passed", freshness: "fresh",
    mutationEpoch: application.snapshot().mutationEpoch, observedAt: "2026-09-11T00:00:01.000Z",
  });
  assert.equal(application.transition(taskId("implementation"), "VERIFIED").kind, "accepted");
  assert.equal(application.snapshot().tasks.every(({ state }) => state === "VERIFIED"), true);
});
