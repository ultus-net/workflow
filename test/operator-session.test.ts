import assert from "node:assert/strict";
import test from "node:test";

import { appendOperatorItem, projectOperatorSessionEvent, type OperatorSessionItem } from "../src/ui/operator-session.js";

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

test("operator transcript coalesces streamed assistant chunks into one message", () => {
  let items: OperatorSessionItem[] = [];
  for (const text of ["I", "\nnotice your message", " just says \"testing\""]) {
    items = appendOperatorItem(items, { kind: "assistant", text });
  }
  assert.deepEqual(items, [{ kind: "assistant", text: "I\nnotice your message just says \"testing\"" }]);

  // A non-assistant item breaks the run: later chunks start a fresh message.
  items = appendOperatorItem(items, { kind: "action", action: "read_file", subjects: ["a.ts"] });
  items = appendOperatorItem(items, { kind: "assistant", text: "Reading it now" });
  assert.equal(items.length, 3);
  assert.deepEqual(items[2], { kind: "assistant", text: "Reading it now" });
});

test("operator transcript suppresses completion text that duplicates the assistant stream", () => {
  let items: OperatorSessionItem[] = [];
  items = appendOperatorItem(items, { kind: "assistant", text: "All" });
  items = appendOperatorItem(items, { kind: "assistant", text: " done\n" });
  // Final result string differs only by chunk-boundary whitespace.
  items = appendOperatorItem(items, { kind: "completion", outcome: "completed", text: "All  done" });
  assert.deepEqual(items, [
    { kind: "assistant", text: "All done\n" },
    { kind: "completion", outcome: "completed", text: "" },
  ]);
});

test("operator transcript keeps distinct completion results and failure reasons", () => {
  let items: OperatorSessionItem[] = [];
  items = appendOperatorItem(items, { kind: "assistant", text: "Working" });
  items = appendOperatorItem(items, { kind: "completion", outcome: "completed", text: "Wrote 3 files" });
  assert.deepEqual(items[1], { kind: "completion", outcome: "completed", text: "Wrote 3 files" });

  items = appendOperatorItem(items, { kind: "assistant", text: "Retrying" });
  items = appendOperatorItem(items, { kind: "completion", outcome: "failed", text: "Retrying" });
  assert.deepEqual(items[3], { kind: "completion", outcome: "failed", text: "Retrying" });
});
