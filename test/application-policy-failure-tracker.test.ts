import assert from "node:assert/strict";
import test from "node:test";

import { PolicyFailureTracker } from "../src/application/policy-failure-tracker.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { hostCapabilities } from "../src/application/host.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";

const task: WorkflowTask = { id: taskId("t"), title: "t", state: "IN_PROGRESS", dependencies: [], requiredEvidence: [] };
const action = { sessionId: "s", taskId: task.id, tool: "bash", mutating: true, subjects: ["x"], input: {} };

test("PolicyFailureTracker matches the plugin's repeated-failure threshold", () => {
  const tracker = new PolicyFailureTracker();
  assert.equal(tracker.recordFailure({ sessionId: "s", tool: "bash", reason: "denied" }), 1);
  assert.equal(tracker.recordFailure({ sessionId: "s", tool: "bash", reason: "denied" }), 2);
  assert.equal(tracker.isOpen("s"), true);
  tracker.recordSuccess("s");
  assert.equal(tracker.isOpen("s"), false);
});

test("WorkflowApplication exposes circuit-breaker outcomes for the authority layer", () => {
  const application = new WorkflowApplication(new TaskGraph([task]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  assert.equal(application.authorize(action).kind, "allow");
  application.recordToolOutcome("s", "denied", "bash", "policy denied");
  application.recordToolOutcome("s", "denied", "bash", "policy denied");
  const blocked = application.authorize(action);
  assert.equal(blocked.kind, "deny");
  if (blocked.kind === "deny") assert.equal(blocked.code, "POLICY_CIRCUIT_BREAKER");
  application.recordToolOutcome("s", "succeeded");
  assert.equal(application.authorize(action).kind, "allow");
});

test("WorkflowApplication enforces a parent-owned mutation budget for descendants", () => {
  const application = new WorkflowApplication(new TaskGraph([task]), hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  application.registerSubagentSession("child", "parent");
  for (let index = 0; index < 100; index += 1) {
    assert.equal(application.authorize({ ...action, sessionId: "child" }).kind, "allow");
  }
  const blocked = application.authorize({ ...action, sessionId: "parent" });
  assert.equal(blocked.kind, "deny");
  if (blocked.kind === "deny") assert.equal(blocked.code, "MUTATION_BUDGET_EXHAUSTED");
});