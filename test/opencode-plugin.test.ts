import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenCodeHostAdapter,
  TaskGraph,
  WorkflowApplication,
  createWorkflowOpenCodePlugin,
  taskId,
  type GuardDecision,
  type WorkflowGuardProvider,
} from "../src/index.js";
import { createOperatorAskHold, type OperatorAskHold } from "../src/integrations/operator-ask-hold.js";

function fixture(state: "BLOCKED" | "IN_PROGRESS" = "IN_PROGRESS", guard?: WorkflowGuardProvider, hold?: OperatorAskHold) {
  const id = taskId("opencode-plugin");
  const adapter = new OpenCodeHostAdapter({ taskId: id, capabilityForTool: () => "read" });
  const application = new WorkflowApplication(
    new TaskGraph([{ id, title: "OpenCode hook", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    adapter.capabilities,
    [],
    new Set(["read", "mutation", "process"]),
  );
  if (state === "IN_PROGRESS") assert.equal(application.transition(id, "IN_PROGRESS").kind, "accepted");
  return { application, adapter, plugin: createWorkflowOpenCodePlugin(application, adapter, guard, hold) };
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

// ── P6 second seat: the OpenCode plugin's ASK HOLD (issue #285) ──────────────
//
// The plugin runs in the agent host process and its contract is throw-or-not:
// a guard `ask` parks the tool call on an injected operator hold, then proceeds
// (returns) on approval and throws on reject/timeout. The hold is a fourth
// composition argument; `trustedRole` stays unsupplied (§5).

function stubGuard(decision: { decision: "allow" | "deny" | "ask"; policy: string; reason: string }): WorkflowGuardProvider {
  return {
    async capabilities() {
      return [{ name: "guard_check" }];
    },
    async invoke() {
      throw new Error("unused");
    },
    async guardCheck(): Promise<GuardDecision> {
      return decision;
    },
    async guardStatus() {
      throw new Error("unused");
    },
    close: async () => undefined,
  };
}

function askGuard(): WorkflowGuardProvider {
  return stubGuard({ decision: "ask", policy: "promotion-gate", reason: "promotion requires operator approval" });
}

const heldShellInput = { tool: "bash", sessionID: "session-ask", callID: "call-ask" };
const heldShellOutput = { args: { command: "workflow install fleet" } };

/** Polls the hold until the plugin has parked the ask (microtask/timer driven). */
async function waitForParked(hold: OperatorAskHold): Promise<void> {
  for (let i = 0; i < 500 && hold.pendingCount === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("OpenCode plugin parks a guard ask on the operator hold and the operator's allow proceeds", async () => {
  const hold = createOperatorAskHold({ timeoutMs: 60_000 });
  const { plugin } = fixture("IN_PROGRESS", askGuard(), hold);

  const pending = plugin["tool.execute.before"](heldShellInput, heldShellOutput);
  await waitForParked(hold);
  assert.equal(hold.pendingCount, 1, "an ask must park on the operator hold");
  assert.deepEqual(hold.pending, [{ requestId: "call-ask", policy: "promotion-gate", reason: "promotion requires operator approval" }]);

  hold.answer("call-ask", "once");
  await assert.doesNotReject(pending);
  assert.equal(hold.pendingCount, 0);
});

test("OpenCode plugin resolves an operator reject on a held ask as a thrown denial", async () => {
  const hold = createOperatorAskHold({ timeoutMs: 60_000 });
  const { plugin } = fixture("IN_PROGRESS", askGuard(), hold);

  const pending = plugin["tool.execute.before"](heldShellInput, heldShellOutput);
  await waitForParked(hold);
  hold.answer("call-ask", "reject");

  await assert.rejects(pending, /promotion-gate/);
  await assert.rejects(pending, /operator reject or hold timeout/);
});

test("OpenCode plugin fails a held ask closed when the operator hold times out", async () => {
  const hold = createOperatorAskHold({ timeoutMs: 5 });
  const { plugin } = fixture("IN_PROGRESS", askGuard(), hold);

  await assert.rejects(plugin["tool.execute.before"](heldShellInput, heldShellOutput), /operator reject or hold timeout/);
});

test("OpenCode plugin fails a guard ask closed when no operator hold is attached", async () => {
  const { plugin } = fixture("IN_PROGRESS", askGuard());

  await assert.rejects(plugin["tool.execute.before"](heldShellInput, heldShellOutput), /Workflow denied bash/);
});
