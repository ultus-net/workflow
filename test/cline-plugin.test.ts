import assert from "node:assert/strict";
import test from "node:test";

import {
  ClineHostAdapter,
  TaskGraph,
  WorkflowApplication,
  WorkflowContainedProcess,
  createWorkflowClineShellExecutor,
  createWorkflowClinePlugin,
  taskId,
  type ContainedProcessRequest,
  type ProcessContainment,
  type WorkflowTask,
} from "../src/index.js";

test("Cline plugin beforeTool hook authoritatively returns Workflow denial", async () => {
  const task: WorkflowTask = {
    id: taskId("A"),
    title: "Blocked host mutation",
    state: "BLOCKED",
    dependencies: [],
    requiredEvidence: [],
  };
  const adapter = new ClineHostAdapter({
    sessionId: "cline-runtime",
    taskId: task.id,
    isMutatingTool: () => true,
    authoritativePreMutation: true,
  });
  const application = new WorkflowApplication(new TaskGraph([task]), adapter.capabilities);
  const denials: unknown[] = [];
  const plugin = createWorkflowClinePlugin(application, adapter, (...denial) => denials.push(denial));

  assert.deepEqual(await plugin.hooks.beforeTool({
    toolCall: { toolName: "write_file", toolCallId: "call-1" },
    input: { path: "src/protected.ts" },
  }), {
    stop: true,
    reason: "task A is READY, not IN_PROGRESS",
  });
  assert.deepEqual(denials, [["write_file", "task A is READY, not IN_PROGRESS", "call-1"]]);
  assert.deepEqual(plugin.manifest.capabilities, ["hooks"]);
});

test("Cline plugin refuses an adapter without authoritative host interception", () => {
  const task: WorkflowTask = {
    id: taskId("A"), title: "Task", state: "BLOCKED", dependencies: [], requiredEvidence: [],
  };
  const adapter = new ClineHostAdapter({ sessionId: "s", taskId: task.id, isMutatingTool: () => true });
  const application = new WorkflowApplication(new TaskGraph([task]), adapter.capabilities);
  assert.throws(() => createWorkflowClinePlugin(application, adapter), /authoritative pre-mutation interception/);
});

test("Cline shell executor binds the authorized structured command to containment", async () => {
  const task: WorkflowTask = {
    id: taskId("A"), title: "Run command", state: "BLOCKED", dependencies: [], requiredEvidence: [],
  };
  const adapter = new ClineHostAdapter({
    sessionId: "cline-runtime",
    taskId: task.id,
    isMutatingTool: () => true,
    authoritativePreMutation: true,
  });
  const application = new WorkflowApplication(
    new TaskGraph([task]),
    adapter.capabilities,
    [],
    new Set(["read", "mutation", "process"]),
  );
  assert.equal(application.transition(task.id, "IN_PROGRESS").kind, "accepted");
  let executed: ContainedProcessRequest | undefined;
  const containment: ProcessContainment = {
    async execute(request) {
      executed = request;
      return {
        exitCode: 0,
        stdout: "contained output\n",
        stderr: "",
        enforcement: "enforced",
        network: "isolated",
        credentials: "cleared",
      };
    },
  };
  const executor = createWorkflowClineShellExecutor(
    new WorkflowContainedProcess(application, containment),
    adapter,
  );

  const output = await executor({ command: "/usr/bin/printf", args: ["%s", "bound argv"] }, "/workspace", {});

  assert.equal(output, "contained output\n");
  assert.deepEqual(executed, {
    executable: "/usr/bin/printf",
    args: ["%s", "bound argv"],
    cwd: "/workspace",
    writablePaths: ["/workspace"],
  });
});

test("Cline shell executor denies a working directory outside the authorized workspace", async () => {
  const task: WorkflowTask = {
    id: taskId("A"), title: "Run command", state: "BLOCKED", dependencies: [], requiredEvidence: [],
  };
  const adapter = new ClineHostAdapter({
    sessionId: "cline-runtime",
    taskId: task.id,
    isMutatingTool: () => true,
    authoritativePreMutation: true,
  });
  const application = new WorkflowApplication(
    new TaskGraph([task]), adapter.capabilities, [], new Set(["read", "mutation", "process"]), "/workspace/repository",
  );
  assert.equal(application.transition(task.id, "IN_PROGRESS").kind, "accepted");
  let executions = 0;
  const process = new WorkflowContainedProcess(application, {
    async execute() {
      executions += 1;
      throw new Error("must not execute");
    },
  });
  const executor = createWorkflowClineShellExecutor(process, adapter);

  await assert.rejects(() => executor("touch escaped", "/workspace/outside", {}), /WORKSPACE_PATH_DENIED/);
  assert.equal(executions, 0);
});
