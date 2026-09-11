import assert from "node:assert/strict";
import test from "node:test";

import {
  hostCapabilities,
  taskId,
  type ProposedToolAction,
} from "../src/index.js";

test("host enforcement level is derived from authoritative pre-mutation capability", () => {
  assert.equal(
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }).enforcementLevel,
    "advisory",
  );
  assert.equal(
    hostCapabilities({ transport: "native", authoritativePreMutation: true }).enforcementLevel,
    "enforced",
  );
});

test("host transport metadata remains independent from generic proposals", () => {
  const capabilities = hostCapabilities({ transport: "acp", authoritativePreMutation: true });
  const action: ProposedToolAction = {
    sessionId: "session-1",
    taskId: taskId("A"),
    tool: "write_file",
    mutating: true,
    subjects: ["src/a.ts"],
    input: { path: "src/a.ts" },
  };

  assert.equal(capabilities.transport, "acp");
  assert.equal(action.mutating, true);
});
