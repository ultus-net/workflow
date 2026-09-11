import assert from "node:assert/strict";
import test from "node:test";

import { OpenCodeHostAdapter, TaskGraph, WorkflowApplication, createWorkflowOpenCodePlugin, taskId } from "../src/index.js";

function fixture(state: "BLOCKED" | "IN_PROGRESS" = "IN_PROGRESS") {
  const id = taskId("opencode-plugin");
  const adapter = new OpenCodeHostAdapter({ taskId: id, capabilityForTool: () => "read" });
  const application = new WorkflowApplication(
    new TaskGraph([{ id, title: "OpenCode hook", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    adapter.capabilities,
    [],
    new Set(["read", "mutation", "process"]),
  );
  if (state === "IN_PROGRESS") assert.equal(application.transition(id, "IN_PROGRESS").kind, "accepted");
  return { application, adapter, plugin: createWorkflowOpenCodePlugin(application, adapter) };
}

test("OpenCode before-tool hook authorizes a mutation before execution", async () => {
  const { adapter, plugin } = fixture();
  const input = { tool: "edit", sessionID: "session-1", callID: "call-1" };
  const output = { args: { filePath: "src/index.ts", oldString: "old", newString: "new" } };

  const proposal = adapter.proposalFromBeforeTool({ input, output });
  assert.equal(proposal.capability, "mutation", "built-in mutation capability cannot be downgraded by extension metadata");
  assert.deepEqual(proposal.subjects, ["src/index.ts"]);
  await assert.doesNotReject(plugin["tool.execute.before"](input, output));
});

test("OpenCode before-tool denial throws before the host can execute", async () => {
  const { adapter, plugin } = fixture("BLOCKED");
  const input = { tool: "bash", sessionID: "session-2", callID: "call-2" };
  const output = { args: { command: "touch denied.txt" } };

  const proposal = adapter.proposalFromBeforeTool({ input, output });
  assert.equal(proposal.capability, "process", "built-in process capability cannot be downgraded by extension metadata");
  await assert.rejects(plugin["tool.execute.before"](input, output), /Workflow denied bash/);
});

test("OpenCode patch proposals expose every patch target to Workflow", async () => {
  const { adapter, plugin } = fixture();
  const input = { tool: "apply_patch", sessionID: "session-3", callID: "call-3" };
  const output = { args: { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+new\n*** End Patch" } };

  assert.deepEqual(adapter.proposalFromBeforeTool({ input, output }).subjects, ["src/a.ts", "src/b.ts"]);
  await assert.doesNotReject(plugin["tool.execute.before"](input, output));
});

test("OpenCode path-bearing tools fail closed when their subject is missing", () => {
  const adapter = new OpenCodeHostAdapter({ taskId: taskId("task-1") });
  assert.throws(() => adapter.proposalFromBeforeTool({
    input: { tool: "edit", sessionID: "session-1", callID: "call-1" },
    output: { args: { oldString: "a", newString: "b" } },
  }), /invalid OpenCode tool subject/);
});
