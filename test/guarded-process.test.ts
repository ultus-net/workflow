import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkflowApplication } from "../src/application/workflow.js";
import { WorkflowContainedProcess } from "../src/containment/workflow-process.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import type { GuardCheckInput, GuardDecision } from "../src/integrations/mcp-toolbox-guard.js";
import type { WorkflowGuardProvider } from "../src/integrations/mcp-toolbox-guard.js";
import type { ContainedProcessRequest, ContainedProcessResult } from "../src/containment/contracts.js";

class FakeGuard {
  public readonly inputs: GuardCheckInput[] = [];
  constructor(private readonly decision: GuardDecision) {}
  async capabilities() { return []; }
  async invoke() { return undefined; }
  async guardCheck(input: GuardCheckInput): Promise<GuardDecision> {
    this.inputs.push(input);
    return this.decision;
  }
  async guardStatus() { return { mode: "policy-advisor", enforcement: "host-dependent", executesActions: false }; }
  async close() {}
}

const request: ContainedProcessRequest = {
  executable: "/bin/bash",
  args: ["-c", "ls"],
  cwd: process.cwd(),
};

function application() {
  const tasks: WorkflowTask[] = [{ id: taskId("W1"), title: "task", state: "READY", dependencies: [], requiredEvidence: [] }];
  const app = new WorkflowApplication(
    new TaskGraph(tasks),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "process"]),
    process.cwd(),
  );
  app.startInteractiveTask();
  return app;
}

test("WorkflowContainedProcess consults the guard before executing", async () => {
  const guard = new FakeGuard({ decision: "deny", policy: "shell.destructive.pattern", reason: "blocked" });
  const contained = new WorkflowContainedProcess(application(), { execute: async () => fakeResult() }, guard as unknown as WorkflowGuardProvider);
  await assert.rejects(
    () => contained.execute(fullAction(), request),
    /guard denied.*shell\.destructive\.pattern/,
  );
});

test("WorkflowContainedProcess proceeds on guard allow", async () => {
  const guard = new FakeGuard({ decision: "allow", policy: "shell.safe", reason: "ok" });
  const contained = new WorkflowContainedProcess(application(), { execute: async () => fakeResult() }, guard as unknown as WorkflowGuardProvider);
  const result = await contained.execute(fullAction(), request);
  assert.equal(result.exitCode, 0);
  assert.equal((guard.inputs.at(-1) as GuardCheckInput).command, "ls");
});

test("WorkflowContainedProcess fails closed when the guard throws", async () => {
  const guard = new FakeGuard({ decision: "allow", policy: "x", reason: "" });
  guard.guardCheck = () => { throw new Error("guard unavailable"); };
  const contained = new WorkflowContainedProcess(application(), { execute: async () => fakeResult() }, guard as unknown as WorkflowGuardProvider);
  await assert.rejects(() => contained.execute(fullAction(), request), /guard unavailable/);
});

function fullAction() {
  return { tool: "execute_command", input: {}, mutating: true, capability: "process" as const, requiredCapabilities: ["process"], subjects: [], taskId: taskId("W1"), sessionId: "s" } as const;
}
function fakeResult(): Promise<ContainedProcessResult> {
  return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", enforcement: "enforced", network: "isolated", credentials: "cleared" });
}
