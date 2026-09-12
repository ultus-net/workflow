import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskGraph,
  WorkflowApplication,
  hostCapabilities,
  taskId,
  type ProposedToolAction,
  type WorkflowTask,
} from "../src/index.js";
import {
  approveCheckpoint,
  createCheckpointLedger,
  openCheckpoint,
} from "../src/pedagogy/checkpoints.js";

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

const application = (graph: TaskGraph): WorkflowApplication =>
  new WorkflowApplication(graph, hostCapabilities({ transport: "native", authoritativePreMutation: true }));

test("without a pedagogy gate configured, authorization behavior is unchanged", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const app = application(graph);
  assert.equal(app.authorize(mutation("A")).kind, "allow");
});

test("learn-to-code: authorize denies mutation while a learning checkpoint is pending", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const app = application(graph);
  const ledger = createCheckpointLedger("learn-to-code");
  app.setPedagogyGate(ledger);

  assert.equal(app.authorize(mutation("A")).kind, "allow");

  openCheckpoint(ledger, { id: "cp-1", taskId: "A", kind: "learning", summary: "explain narrowing" });
  const decision = app.authorize(mutation("A"));
  assert.equal(decision.kind, "deny");
  assert.equal(decision.kind === "deny" && decision.code, "CHECKPOINT_PENDING");

  approveCheckpoint(ledger, "cp-1");
  assert.equal(app.authorize(mutation("A")).kind, "allow");
});

test("co-architect: authorize denies consequential mutation until decision checkpoint approved", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const app = application(graph);
  const ledger = createCheckpointLedger("co-architect");
  app.setPedagogyGate(ledger);

  openCheckpoint(ledger, { id: "cp-1", taskId: "A", kind: "decision", summary: "ADR: event sourcing vs CRUD" });
  assert.equal(app.authorize(mutation("A")).kind, "deny");

  approveCheckpoint(ledger, "cp-1");
  assert.equal(app.authorize(mutation("A")).kind, "allow");
});

test("socratic-tutor: gate suppresses after the intervention budget is spent", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const app = application(graph);
  const ledger = createCheckpointLedger("socratic-tutor");
  app.setPedagogyGate(ledger);

  for (let index = 0; index < 3; index += 1) {
    openCheckpoint(ledger, { id: `cp-${index}`, taskId: "A", kind: "learning", summary: `q${index}` });
    assert.equal(app.authorize(mutation("A")).kind, "deny");
    approveCheckpoint(ledger, `cp-${index}`);
    assert.equal(app.authorize(mutation("A")).kind, "allow");
  }
  openCheckpoint(ledger, { id: "cp-3", taskId: "A", kind: "learning", summary: "q3" });
  assert.equal(app.authorize(mutation("A")).kind, "allow");
});

test("walkthrough: transition to VERIFYING is refused while inspection is pending", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const app = application(graph);
  const ledger = createCheckpointLedger("walkthrough");
  app.setPedagogyGate(ledger);

  openCheckpoint(ledger, { id: "cp-1", taskId: "A", kind: "inspection", summary: "inspect the diff" });

  // Mutation itself is not gated in walkthrough mode.
  assert.equal(app.authorize(mutation("A")).kind, "allow");

  const refused = app.transition(taskId("A"), "VERIFYING");
  assert.equal(refused.kind, "rejected");
  assert.equal(refused.kind === "rejected" && refused.code, "CHECKPOINT_PENDING");

  approveCheckpoint(ledger, "cp-1");
  const accepted = app.transition(taskId("A"), "VERIFYING");
  assert.equal(accepted.kind, "accepted");
});

test("autonomous: pedagogy gate never blocks authorization or transitions", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const app = application(graph);
  const ledger = createCheckpointLedger("autonomous");
  app.setPedagogyGate(ledger);

  openCheckpoint(ledger, { id: "cp-1", taskId: "A", kind: "learning", summary: "ignored" });
  openCheckpoint(ledger, { id: "cp-2", taskId: "A", kind: "inspection", summary: "ignored" });

  assert.equal(app.authorize(mutation("A")).kind, "allow");
  assert.equal(app.transition(taskId("A"), "VERIFYING").kind, "accepted");
});

test("non-mutating reads are never gated by pedagogy checkpoints", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const app = application(graph);
  const ledger = createCheckpointLedger("learn-to-code");
  app.setPedagogyGate(ledger);

  openCheckpoint(ledger, { id: "cp-1", taskId: "A", kind: "learning", summary: "explain" });
  assert.equal(app.authorize({ ...mutation("A"), mutating: false, tool: "read_file" }).kind, "allow");
});

test("setPedagogyGate can be cleared to restore default behavior", () => {
  const graph = new TaskGraph([task("A")]);
  graph.transition(taskId("A"), "IN_PROGRESS");
  const app = application(graph);
  const ledger = createCheckpointLedger("learn-to-code");
  app.setPedagogyGate(ledger);

  openCheckpoint(ledger, { id: "cp-1", taskId: "A", kind: "learning", summary: "explain" });
  assert.equal(app.authorize(mutation("A")).kind, "deny");

  app.setPedagogyGate(undefined);
  assert.equal(app.authorize(mutation("A")).kind, "allow");
});
