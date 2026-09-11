import assert from "node:assert/strict";
import test from "node:test";

import {
  ClineHostAdapter,
  TaskGraph,
  WorkflowApplication,
  createWorkflowClinePlugin,
  taskId,
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
  const plugin = createWorkflowClinePlugin(application, adapter);

  assert.deepEqual(await plugin.hooks.beforeTool({
    toolCall: { toolName: "write_file" },
    input: { path: "src/protected.ts" },
  }), {
    stop: true,
    reason: "task A is READY, not IN_PROGRESS",
  });
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
