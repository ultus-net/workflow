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
