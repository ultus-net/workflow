import assert from "node:assert/strict";
import test from "node:test";

import { ClineHostAdapter, taskId, type PolicyDecision } from "../src/index.js";

const adapter = new ClineHostAdapter({
  sessionId: "cline-session",
  taskId: taskId("A"),
  isMutatingTool: (tool) => tool === "write_to_file" || tool === "run_commands",
  authoritativePreMutation: true,
});

test("Cline adapter unwraps lazy MCP call_tool arguments for subject extraction", () => {
  const action = adapter.proposalFromBeforeTool({
    tool: { name: "workflow-guard__call_tool" },
    input: { toolName: "guard_check", arguments: { action: "file_write", path: "/outside/secret.txt" } },
  });

  assert.equal(action.tool, "guard_check");
  assert.deepEqual(action.subjects, ["/outside/secret.txt"]);
  assert.equal(action.mutating, true); // unknown nested tools gate as mutation
  assert.deepEqual(action.input, { action: "file_write", path: "/outside/secret.txt" });
});

test("Cline adapter treats nested workspaceRoot arguments as authorization subjects", () => {
  const action = adapter.proposalFromBeforeTool({
    tool: { name: "learning__call_tool" },
    input: { toolName: "learning_checkpoint", arguments: { workspaceRoot: "/repo", concept: "x" } },
  });

  assert.equal(action.tool, "learning_checkpoint");
  assert.deepEqual(action.subjects, ["/repo"]);
});

test("Cline adapter fails closed on a malformed lazy call_tool payload", () => {
  assert.throws(
    () => adapter.proposalFromBeforeTool({ tool: { name: "memory__call_tool" }, input: { arguments: {} } }),
    /toolName/,
  );
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

test("Cline adapter exposes every batched read path to Workflow policy", () => {
  const action = adapter.proposalFromBeforeTool({
    tool: { name: "read_files" },
    input: { files: [{ path: "/workspace/a.ts" }, { path: "/outside/secret" }] },
  });

  assert.deepEqual(action.subjects, ["/workspace/a.ts", "/outside/secret"]);
});

test("Cline adapter exposes apply_patch target paths to Workflow policy", () => {
  const action = adapter.proposalFromBeforeTool({
    tool: { name: "apply_patch" },
    input: { input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: ../escaped.ts\n*** End Patch" },
  });

  assert.deepEqual(action.subjects, ["src/a.ts", "../escaped.ts"]);
});

test("Cline adapter resolves the active canonical task for every proposal", () => {
  let activeTaskId = taskId("A");
  const dynamic = new ClineHostAdapter({
    sessionId: "dynamic-session",
    taskId: () => activeTaskId,
    isMutatingTool: () => true,
  });

  assert.equal(dynamic.proposalFromBeforeTool({ tool: { name: "write_file" }, input: { path: "a.txt" } }).taskId, taskId("A"));
  activeTaskId = taskId("B");
  assert.equal(dynamic.proposalFromBeforeTool({ tool: { name: "write_file" }, input: { path: "b.txt" } }).taskId, taskId("B"));
});

test("Cline adapter conservatively classifies editor, patch, and shell tools as mutating", () => {
  const conservative = new ClineHostAdapter({
    sessionId: "matrix",
    taskId: taskId("A"),
    isMutatingTool: () => false,
  });

  assert.equal(conservative.proposalFromBeforeTool({ tool: { name: "write_file" }, input: { path: "a.ts" } }).mutating, true);
  assert.equal(conservative.proposalFromBeforeTool({ tool: { name: "apply_patch" }, input: "*** Begin Patch\n*** Update File: a.ts\n*** End Patch" }).mutating, true);
  assert.equal(conservative.proposalFromBeforeTool({ tool: { name: "run_commands" }, input: { commands: ["npm test"] } }).mutating, true);
  assert.equal(conservative.proposalFromBeforeTool({ tool: { name: "read_file" }, input: { path: "a.ts" } }).mutating, false);
});

test("Cline adapter permits explicit least-privilege classification for extension tools only", () => {
  const extension = new ClineHostAdapter({
    sessionId: "s", taskId: taskId("A"), isMutatingTool: () => false,
    capabilityForTool: (tool) => tool === "mcp_fixture_lookup" ? "read" : "mutation",
  });
  const readOnlyMcp = extension.proposalFromBeforeTool({ tool: { name: "mcp_fixture_lookup" }, input: { query: "x" } });
  assert.equal(readOnlyMcp.capability, "read");
  assert.equal(readOnlyMcp.mutating, false);

  const editor = extension.proposalFromBeforeTool({ tool: { name: "write_file" }, input: { path: "a.ts" } });
  assert.equal(editor.capability, "mutation", "host metadata cannot downgrade a built-in mutation tool");
  assert.equal(editor.mutating, true);
});

test("Cline adapter cannot downgrade built-in network authority", () => {
  const network = new ClineHostAdapter({
    sessionId: "s", taskId: taskId("A"), isMutatingTool: () => false,
    capabilityForTool: () => "read",
  }).proposalFromBeforeTool({ tool: { name: "fetch_web_content" }, input: { url: "https://example.invalid" } });

  assert.equal(network.capability, "network");
  assert.deepEqual(network.requiredCapabilities, ["network", "read"]);
});
