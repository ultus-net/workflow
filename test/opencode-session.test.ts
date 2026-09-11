import assert from "node:assert/strict";
import test from "node:test";

import { OpenCodeSessionDriver, WorkflowCodingSession } from "../src/index.js";

test("OpenCode session driver translates SDK events and image input through the host-neutral port", async () => {
  let promptParts: readonly unknown[] = [];
  const driver = new OpenCodeSessionDriver({
    async create() { return { data: { id: "session-1" } }; },
    async prompt(input) {
      promptParts = input.body.parts;
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { data: { parts: [{ type: "text", text: "Finished" }] } };
    },
    async abort() { return { data: true }; },
    event: {
      async subscribe() {
        return { stream: (async function* () {
          yield { type: "session.status", properties: { sessionID: "session-1", status: { type: "busy" } } };
          yield { type: "message.part.updated", properties: { part: { type: "text", sessionID: "session-1", text: "Hello" }, delta: "Hello" } };
          yield { type: "message.part.updated", properties: { part: { type: "tool", sessionID: "session-1", tool: "edit", state: { status: "running", input: { filePath: "src/a.ts" } } } } };
          yield { type: "message.part.updated", properties: { part: { type: "tool", sessionID: "session-1", tool: "edit", state: { status: "completed", input: { filePath: "src/a.ts" } } } } };
        })() };
      },
    },
  });
  const session = new WorkflowCodingSession(driver);
  const events: unknown[] = [];
  session.subscribe((event) => events.push(event));

  await session.submit("Do work", [{ mediaType: "image/png", data: "YWJj" }]);

  assert.deepEqual(promptParts, [
    { type: "text", text: "Do work" },
    { type: "file", mime: "image/png", url: "data:image/png;base64,YWJj" },
  ]);
  assert.ok(events.some((event) => (event as { type: string }).type === "assistant"));
  assert.ok(events.some((event) => (event as { type: string; tool?: string; subjects?: readonly string[] }).type === "tool-proposal"
    && (event as { tool?: string }).tool === "edit"
    && (event as { subjects?: readonly string[] }).subjects?.length === 0));
  assert.equal(session.snapshot().state, "completed");
});

test("OpenCode session cancellation aborts the active SDK session", async () => {
  let aborted: string | undefined;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const driver = new OpenCodeSessionDriver({
    async create() { return { data: { id: "session-cancel" } }; },
    async prompt() { await waiting; return { data: { parts: [] } }; },
    async abort(input) { aborted = input.path.id; release(); return { data: true }; },
    event: { async subscribe() { return { stream: (async function* () {})() }; } },
  });
  const session = new WorkflowCodingSession(driver);
  const running = session.submit("Wait");
  await new Promise((resolve) => setTimeout(resolve, 0));

  await session.cancel();
  await running;

  assert.equal(aborted, "session-cancel");
  assert.equal(session.snapshot().state, "cancelled");
});

test("OpenCode session cancellation propagates an SDK abort error", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const driver = new OpenCodeSessionDriver({
    async create() { return { data: { id: "session-error" } }; },
    async prompt() { await waiting; return { data: { parts: [] } }; },
    async abort() { release(); return { error: { data: { message: "abort rejected" } } }; },
    event: { async subscribe() { return { stream: (async function* () {})() }; } },
  });
  const session = new WorkflowCodingSession(driver);
  const running = session.submit("Wait");
  await new Promise((resolve) => setTimeout(resolve, 0));

  await session.cancel();
  await running;

  assert.equal(session.snapshot().state, "failed");
  assert.match((session.snapshot() as { reason: string }).reason, /OpenCode abort failed: abort rejected/);
});
