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

test("operator projection maps plan, thought, and tool events to their card items", () => {
  assert.deepEqual(
    projectOperatorSessionEvent({
      type: "plan",
      entries: [{ id: "p1", content: "Inspect", status: "in_progress" }],
    }),
    { kind: "plan", entries: [{ id: "p1", content: "Inspect", status: "in_progress" }] },
  );
  assert.deepEqual(
    projectOperatorSessionEvent({ type: "thought", text: "considering" }),
    { kind: "thinking", text: "considering" },
  );
  assert.deepEqual(
    projectOperatorSessionEvent({
      type: "tool",
      callId: "t1",
      title: "Read workspace",
      toolKind: "read",
      status: "pending",
      subjects: ["a.ts"],
    }),
    { kind: "tool", callId: "t1", title: "Read workspace", toolKind: "read", status: "pending", subjects: ["a.ts"] },
  );
});

test("operator projection suppresses callId-carrying proposal/outcome pairs already shown as tool cards", () => {
  assert.equal(
    projectOperatorSessionEvent({ type: "tool-proposal", tool: "read_file", subjects: [], callId: "t1" }),
    undefined,
  );
  assert.equal(
    projectOperatorSessionEvent({ type: "tool-outcome", tool: "read_file", outcome: "succeeded", callId: "t1" }),
    undefined,
  );
  // Legacy callId-less events keep the action/outcome lines (other drivers).
  assert.deepEqual(
    projectOperatorSessionEvent({ type: "tool-proposal", tool: "read_file", subjects: [] }),
    { kind: "action", action: "read_file", subjects: [] },
  );
});

test("operator transcript merges tool-card updates by callId and accumulates thinking", () => {
  let items: OperatorSessionItem[] = [];
  items = appendOperatorItem(items, {
    kind: "tool", callId: "t1", title: "Read workspace", toolKind: "read", status: "pending", subjects: ["a.ts"],
  });
  items = appendOperatorItem(items, { kind: "thinking", text: "reasoning " });
  items = appendOperatorItem(items, { kind: "thinking", text: "about the file" });
  items = appendOperatorItem(items, {
    kind: "tool", callId: "t1", title: "ignored", toolKind: "ignored", status: "completed", subjects: [], rawOutput: "ok",
  });

  assert.equal(items.length, 2, "the completed update merges into the original card");
  const card = items[0];
  if (card?.kind !== "tool") throw new Error("expected a tool card");
  assert.equal(card.title, "Read workspace", "card identity survives the merge");
  assert.equal(card.toolKind, "read");
  assert.equal(card.status, "completed");
  assert.deepEqual(card.subjects, ["a.ts"]);
  assert.equal(card.rawOutput, "ok");
  assert.deepEqual(items[1], { kind: "thinking", text: "reasoning about the file" });

  // A same-callId update after interleaved items still merges into its card:
  // agents stream assistant text between tool_call and tool_call_update.
  items = appendOperatorItem(items, { kind: "assistant", text: "next" });
  items = appendOperatorItem(items, {
    kind: "tool", callId: "t1", title: "Read workspace", toolKind: "read", status: "error", subjects: [],
  });
  assert.equal(items.length, 3, "the update merges into the original card across interleaved text");
  const reopened = items[0];
  if (reopened?.kind !== "tool") throw new Error("expected a tool card");
  assert.equal(reopened.status, "error");
});

test("operator transcript replaces the trailing plan snapshot and keeps it after interleaved items", () => {
  let items: OperatorSessionItem[] = [];
  items = appendOperatorItem(items, { kind: "plan", entries: [{ id: "p1", content: "Step", status: "pending" }] });
  items = appendOperatorItem(items, { kind: "plan", entries: [{ id: "p1", content: "Step", status: "completed" }] });
  assert.equal(items.length, 1, "back-to-back plan snapshots coalesce");

  items = appendOperatorItem(items, { kind: "assistant", text: "update" });
  items = appendOperatorItem(items, { kind: "plan", entries: [{ id: "p1", content: "New plan", status: "pending" }] });
  assert.equal(items.length, 3, "an interleaved item breaks the plan run");
  const plan = items[2];
  if (plan?.kind !== "plan") throw new Error("expected a plan item");
  assert.equal(plan.entries[0]?.content, "New plan");
});
