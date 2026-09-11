import assert from "node:assert/strict";
import test from "node:test";

import { ClineHostAdapter, taskId, type PolicyDecision } from "../src/index.js";

const adapter = new ClineHostAdapter({
  sessionId: "cline-session",
  taskId: taskId("A"),
  isMutatingTool: (tool) => tool === "write_to_file" || tool === "run_commands",
  authoritativePreMutation: true,
});

test("Cline adapter reports authoritative native pre-tool interception", () => {
  assert.equal(adapter.capabilities.transport, "native");
  assert.equal(adapter.capabilities.enforcementLevel, "enforced");
});

test("Cline beforeTool input normalizes into the generic host proposal", () => {
  const action = adapter.proposalFromBeforeTool({
    tool: { name: "write_to_file" },
    input: { path: "src/a.ts", content: "x" },
  });

  assert.equal(action.tool, "write_to_file");
  assert.equal(action.mutating, true);
  assert.deepEqual(action.subjects, ["src/a.ts"]);
});

test("Cline adapter maps Workflow denial to beforeTool stop control", () => {
  const denial: PolicyDecision = { kind: "deny", code: "TASK_BLOCKED", reason: "task is blocked" };
  assert.deepEqual(adapter.beforeToolControl(denial), { stop: true, reason: "task is blocked" });
  assert.equal(adapter.beforeToolControl({ kind: "allow" }), undefined);
});

test("Cline adapter is advisory unless authoritative interception is supplied by its host", () => {
  const advisory = new ClineHostAdapter({
    sessionId: "session-1",
    taskId: taskId("A"),
    isMutatingTool: () => true,
  });
  assert.equal(advisory.capabilities.enforcementLevel, "advisory");
});

test("Cline adapter fails closed on malformed pre-tool input", () => {
  assert.throws(() => adapter.proposalFromBeforeTool({ tool: {}, input: {} }), /invalid Cline beforeTool event/);
});

test("Cline adapter rejects malformed recognized mutation subjects", () => {
  const adapter = new ClineHostAdapter({
    sessionId: "session-1",
    taskId: taskId("A"),
    isMutatingTool: () => true,
  });

  assert.throws(
    () => adapter.proposalFromBeforeTool({ tool: { name: "write_file" }, input: { path: 42 } }),
    /invalid Cline tool subject/,
  );
});
