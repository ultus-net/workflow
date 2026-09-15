import assert from "node:assert/strict";
import test from "node:test";

import { projectOperatorSessionEvent } from "../src/ui/operator-session.js";

test("operator session projection keeps meaningful actions and outcomes", () => {
  assert.deepEqual(
    projectOperatorSessionEvent({ type: "tool-proposal", tool: "read_file", subjects: ["README.md"] }),
    { kind: "action", action: "read_file", subjects: ["README.md"] },
  );
  assert.deepEqual(
    projectOperatorSessionEvent({ type: "tool-outcome", tool: "write_file", outcome: "denied", detail: "task is BLOCKED" }),
    { kind: "outcome", action: "write_file", outcome: "denied", detail: "task is BLOCKED" },
  );
});

test("operator session projection omits routine telemetry", () => {
  assert.equal(projectOperatorSessionEvent({ type: "status", status: "thinking" }), undefined);
  assert.equal(projectOperatorSessionEvent({ type: "log", level: "info", message: "request 42 started" }), undefined);
  assert.equal(projectOperatorSessionEvent({
    type: "decision-brief",
    brief: {
      title: "Choose implementation",
      context: "test",
      chosenOption: { name: "Adapter", rationale: "Keeps authority in Workflow", blastRadius: "low" },
      rejectedAlternatives: [],
      tradeoffs: { benefits: ["shared semantics"], liabilities: [] },
    },
  }), undefined);
});

test("operator session projection preserves assistant, attention, and completion content", () => {
  assert.deepEqual(projectOperatorSessionEvent({ type: "assistant", text: "I will inspect the session boundary." }), {
    kind: "assistant",
    text: "I will inspect the session boundary.",
  });
  assert.deepEqual(projectOperatorSessionEvent({ type: "completed", result: "Verified" }), {
    kind: "completion",
    outcome: "completed",
    text: "Verified",
  });
  assert.deepEqual(projectOperatorSessionEvent({ type: "failed", reason: "authority unavailable" }), {
    kind: "completion",
    outcome: "failed",
    text: "authority unavailable",
  });
});
