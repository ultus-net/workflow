import assert from "node:assert/strict";
import test from "node:test";

import {
  AcpHostAdapter,
  OpenCodeHostAdapter,
  TaskGraph,
  WorkflowApplication,
  hostCapabilities,
  taskId,
  type PolicyDecision,
  type ProposedToolAction,
  type WorkflowTask,
} from "../src/index.js";

interface ConformanceHarness {
  readonly name: string;
  proposal(kind: "mutation" | "process"): ProposedToolAction;
  control(decision: PolicyDecision): unknown;
}

const harnesses: readonly ConformanceHarness[] = [
  {
    name: "ACP",
    proposal(kind) {
      return new AcpHostAdapter({ authoritativePermissions: true }).proposalFromBeforeTool({
        sessionId: "conformance-session",
        taskId: taskId("A"),
        toolCall: {
          name: kind === "process" ? "execute" : "write",
          kind: kind === "process" ? "execute" : "edit",
          locations: [{ path: "src/example.ts" }],
        },
      });
    },
    control(decision) {
      return new AcpHostAdapter({ authoritativePermissions: true }).beforeToolControl(decision);
    },
  },
  {
    name: "OpenCode",
    proposal(kind) {
      const adapter = new OpenCodeHostAdapter({ taskId: taskId("A") });
      const event = kind === "process"
        ? { input: { tool: "bash", sessionID: "conformance-session", callID: "call-1" }, output: { args: { command: "npm test" } } }
        : { input: { tool: "edit", sessionID: "conformance-session", callID: "call-1" }, output: { args: { filePath: "src/example.ts", oldString: "a", newString: "b" } } };
      return adapter.proposalFromBeforeTool(event);
    },
    control(decision) {
      return new OpenCodeHostAdapter({ taskId: taskId("A") }).beforeToolControl(decision);
    },
  },
];

for (const harness of harnesses) {
  test(`${harness.name} passes the shared host adapter conformance trace`, () => {
    const task: WorkflowTask = {
      id: taskId("A"), title: "Conformance task", state: "BLOCKED", dependencies: [], requiredEvidence: [],
    };
    const application = new WorkflowApplication(
      new TaskGraph([task]),
      hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    );
    const mutation = harness.proposal("mutation");
    assert.equal(mutation.sessionId, "conformance-session");
    assert.equal(mutation.taskId, taskId("A"));
    assert.equal(mutation.mutating, true);
    assert.equal(mutation.capability, "mutation");
    assert.deepEqual(mutation.subjects, ["src/example.ts"]);
    const mutationDecision = application.authorize(mutation);
    assert.deepEqual(mutationDecision, {
      kind: "deny",
      code: "TASK_NOT_IN_PROGRESS",
      reason: "task A is READY, not IN_PROGRESS",
    });
    assert.ok(harness.control(mutationDecision), "a policy denial must become a native host control");

    const process = harness.proposal("process");
    assert.equal(process.capability, "process");
    assert.equal(process.requiredCapabilities?.includes("process"), true);
    const processDecision = application.authorize(process);
    assert.equal(processDecision.kind, "deny");
    assert.equal(processDecision.code, "CAPABILITY_WITHHELD");
    assert.ok(harness.control(processDecision), "a withheld capability must become a native host control");
  });
}
