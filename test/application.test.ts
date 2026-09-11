import assert from "node:assert/strict";
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
