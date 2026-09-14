import assert from "node:assert/strict";
import test from "node:test";

import { AcpHostAdapter, taskId } from "../src/index.js";

test("ACP adapter is advisory unless the bridge guarantees mutation permission interception", () => {
  assert.equal(new AcpHostAdapter({ authoritativePermissions: false }).capabilities.enforcementLevel, "advisory");
  assert.equal(new AcpHostAdapter({ authoritativePermissions: true }).capabilities.enforcementLevel, "enforced");
});

test("ACP correlated permission request maps to the same generic proposal contract", () => {
  const adapter = new AcpHostAdapter({ authoritativePermissions: true });
  const action = adapter.proposalFromBeforeTool({
    sessionId: "session-1",
    taskId: taskId("A"),
    toolCall: {
      name: "write_file",
      kind: "edit",
      rawInput: { path: "src/a.ts" },
      locations: [{ path: "src/a.ts" }],
    },
  });

  assert.equal(action.tool, "write_file");
  assert.equal(action.mutating, true);
  assert.deepEqual(action.subjects, ["src/a.ts"]);
  assert.deepEqual(adapter.beforeToolControl({ kind: "deny", code: "BLOCKED", reason: "blocked" }), {
    outcome: "reject_once",
    reason: "blocked",
  });
});

test("enforced ACP adapter rejects malformed location metadata", () => {
  const adapter = new AcpHostAdapter({ authoritativePermissions: true });

  assert.throws(
    () => adapter.proposalFromBeforeTool({
      sessionId: "session-1",
      taskId: taskId("A"),
      toolCall: {
        name: "write_file",
        kind: "edit",
        rawInput: { path: "src/a.ts" },
        locations: [{}],
      },
    }),
    /invalid ACP tool location/,
  );
});

test("ACP rejects malformed permission events with the typed error", () => {
  const adapter = new AcpHostAdapter({ authoritativePermissions: true });
  const valid = { sessionId: "s", taskId: taskId("A"), toolCall: { name: "read_file", kind: "read", rawInput: { path: "x" } } };

  for (const bad of [
    null,
    {},
    { ...valid, sessionId: "" },
    { ...valid, taskId: "" },
    { ...valid, toolCall: {} },
    { ...valid, toolCall: { name: "" } },
  ]) {
    assert.throws(() => adapter.proposalFromBeforeTool(bad as never), /invalid ACP permission event/);
  }
});

test("ACP host metadata cannot downgrade a write into a non-mutating read", () => {
  const adapter = new AcpHostAdapter({ authoritativePermissions: true });
  const action = adapter.proposalFromBeforeTool({
    sessionId: "s",
    taskId: taskId("A"),
    toolCall: { name: "write_file", kind: "read", rawInput: { path: "src/a.ts" } },
  });

  assert.equal(action.mutating, true, "kind claims read but the tool name is not a known read tool");
  assert.equal(action.capability, "read", "capability follows the kind table, but the mutation gate still applies");
});

test("ACP non-mutating requires kind and tool name to agree on read", () => {
  const adapter = new AcpHostAdapter({ authoritativePermissions: true });
  const action = adapter.proposalFromBeforeTool({
    sessionId: "s",
    taskId: taskId("A"),
    toolCall: { name: "read_file", kind: "read", rawInput: { path: "src/a.ts" } },
  });

  assert.equal(action.mutating, false);
  assert.deepEqual(action.subjects, ["src/a.ts"], "rawInput path fields stand in when locations are absent");
});

test("ACP event-supplied capability cannot downgrade built-in classification", () => {
  const adapter = new AcpHostAdapter({ authoritativePermissions: true });
  const mutation = adapter.proposalFromBeforeTool({
    sessionId: "s",
    taskId: taskId("A"),
    toolCall: { name: "write_file", kind: "edit", capability: "read", rawInput: { path: "src/a.ts" } },
  });
  assert.equal(mutation.capability, "mutation");

  const process = adapter.proposalFromBeforeTool({
    sessionId: "s",
    taskId: taskId("A"),
    toolCall: { name: "shell", kind: "execute", capability: "read" },
  });
  assert.equal(process.capability, "process");
});

test("ACP mutating proposals without checkable subjects fail closed", () => {
  const adapter = new AcpHostAdapter({ authoritativePermissions: true });
  assert.throws(
    () => adapter.proposalFromBeforeTool({
      sessionId: "s",
      taskId: taskId("A"),
      toolCall: { name: "write_file", kind: "edit" },
    }),
    /invalid ACP tool subject/,
  );
  assert.throws(
    () => adapter.proposalFromBeforeTool({
      sessionId: "s",
      taskId: taskId("A"),
      toolCall: { name: "write_file", kind: "edit", rawInput: { path: "" } },
    }),
    /invalid ACP tool subject/,
  );
});
