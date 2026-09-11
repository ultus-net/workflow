import assert from "node:assert/strict";
import test from "node:test";

import {
  ClineHostAdapter,
  ClineSessionDriver,
  taskId,
  type ClineCoreSessionClient,
  type CodingSessionEvent,
} from "../src/index.js";

class FakeClineCore implements ClineCoreSessionClient {
  readonly listeners = new Set<(event: { readonly type: string; readonly payload?: unknown }) => void>();
  readonly starts: unknown[] = [];
  readonly stops: string[] = [];
  readonly reads: string[] = [];
  result = { sessionId: "cline-1", result: { text: "Stopped" } };

  subscribe(listener: (event: { readonly type: string; readonly payload?: unknown }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(input: unknown) {
    this.starts.push(input);
    this.emit({ type: "status", payload: { sessionId: "cline-1", status: "running" } });
    this.emitAgent({ type: "content_start", contentType: "text", text: "Working" });
    this.emitAgent({ type: "content_start", contentType: "tool", toolName: "write_file", input: { path: "src/a.ts" } });
    this.emitAgent({ type: "content_end", contentType: "tool", toolName: "write_file", output: "written" });
    this.emitAgent({ type: "content_start", contentType: "tool", toolName: "read_file", input: { path: "missing.txt" } });
    this.emitAgent({ type: "content_end", contentType: "tool", toolName: "read_file", error: "ENOENT" });
    return this.result;
  }

  async stop(sessionId: string): Promise<void> {
    this.stops.push(sessionId);
  }

  async readMessages(sessionId: string): Promise<unknown[]> {
    this.reads.push(sessionId);
    return [{ role: "user", content: "prior context" }];
  }

  emitAgent(event: unknown): void {
    this.emit({ type: "agent_event", payload: { sessionId: "cline-1", event } });
  }

  emit(event: { readonly type: string; readonly payload?: unknown }): void {
    for (const listener of this.listeners) listener(event);
  }
}

function driver(core: ClineCoreSessionClient): ClineSessionDriver {
  return new ClineSessionDriver({
    core,
    startInput: (prompt, _initialMessages, userImages) => ({ prompt, interactive: false, ...(userImages === undefined ? {} : { userImages }) }),
    hostAdapter: new ClineHostAdapter({
      sessionId: "workflow-session",
      taskId: taskId("task"),
      isMutatingTool: (tool) => tool === "write_file",
      authoritativePreMutation: true,
    }),
  });
}

test("Cline session translation emits host-neutral assistant, normalized tool, and completion activity", async () => {
  const core = new FakeClineCore();
  const events: CodingSessionEvent[] = [];

  await driver(core).start("Implement change", (event) => events.push(event));

  assert.deepEqual(core.starts, [{ prompt: "Implement change", interactive: false }]);
  assert.deepEqual(events, [
    { type: "status", status: "running" },
    { type: "assistant", text: "Working" },
    { type: "tool-proposal", tool: "write_file", subjects: ["src/a.ts"] },
    { type: "tool-outcome", tool: "write_file", outcome: "succeeded" },
    { type: "tool-proposal", tool: "read_file", subjects: ["missing.txt"] },
    { type: "tool-outcome", tool: "read_file", outcome: "failed", detail: "ENOENT" },
    { type: "completed", result: "Stopped" },
  ]);
  assert.equal(core.listeners.size, 0);
});

test("Cline session translation maps host-neutral images to Cline userImages", async () => {
  const core = new FakeClineCore();

  await driver(core).start(
    "Inspect image",
    () => undefined,
    [{ mediaType: "image/png", data: "aW1hZ2U=" }],
  );

  assert.deepEqual(core.starts, [{
    prompt: "Inspect image",
    interactive: false,
    userImages: ["data:image/png;base64,aW1hZ2U="],
  }]);
});

test("Cline session translation treats a non-recoverable agent error as terminal", async () => {
  const core = new FakeClineCore();
  core.start = async () => {
    core.emitAgent({ type: "error", error: new Error("agent failed"), recoverable: false, iteration: 1 });
    return core.result;
  };
  const events: CodingSessionEvent[] = [];

  await driver(core).start("Implement change", (event) => events.push(event));

  assert.deepEqual(events, [{ type: "failed", reason: "agent failed" }]);
});

test("Cline session translation stops the SDK session when cancelled", async () => {
  const core = new FakeClineCore();
  let release!: () => void;
  core.start = async (input) => {
    core.starts.push(input);
    core.emitAgent({ type: "content_start", contentType: "text", text: "Working" });
    await new Promise<void>((resolve) => { release = resolve; });
    return core.result;
  };
  const sessionDriver = driver(core);
  const events: CodingSessionEvent[] = [];
  const running = sessionDriver.start("Implement change", (event) => events.push(event));

  await sessionDriver.cancel();
  release();
  await running;

  assert.deepEqual(core.stops, ["cline-1"]);
  assert.deepEqual(events, [{ type: "assistant", text: "Working" }]);
});

test("Cline session translation normalizes malformed proposals and SDK failures", async () => {
  const core = new FakeClineCore();
  core.start = async () => {
    core.emitAgent({ type: "content_start", contentType: "tool", toolName: "write_file", input: {} });
    throw new Error("provider failed");
  };
  const events: CodingSessionEvent[] = [];

  await driver(core).start("Implement change", (event) => events.push(event));

  assert.deepEqual(events, [
    { type: "tool-outcome", tool: "write_file", outcome: "failed", detail: "invalid Cline tool subject" },
    { type: "failed", reason: "provider failed" },
  ]);
});

test("Cline session translation preserves authoritative Workflow tool denial", async () => {
  const core = new FakeClineCore();
  let release!: () => void;
  core.start = async () => {
    core.emitAgent({ type: "content_start", contentType: "tool", toolName: "write_file", toolCallId: "call-1", input: { path: "src/a.ts" } });
    await new Promise<void>((resolve) => { release = resolve; });
    core.emitAgent({ type: "content_end", contentType: "tool", toolName: "write_file", toolCallId: "call-1", error: "hook stopped tool" });
    return core.result;
  };
  const sessionDriver = driver(core);
  const events: CodingSessionEvent[] = [];
  const running = sessionDriver.start("Implement change", (event) => events.push(event));

  sessionDriver.recordToolDenial("write_file", "task is BLOCKED", "call-1");
  release();
  await running;

  assert.deepEqual(events, [
    { type: "tool-proposal", tool: "write_file", subjects: ["src/a.ts"] },
    { type: "tool-outcome", tool: "write_file", outcome: "denied", detail: "task is BLOCKED" },
    { type: "completed", result: "Stopped" },
  ]);
});

test("Cline session resume seeds a new SDK session from SDK-native persisted messages", async () => {
  const core = new FakeClineCore();
  const correlations: string[] = [];
  const sessionDriver = new ClineSessionDriver({
    core,
    resumeSessionId: "cline-prior",
    onSessionId: (sessionId: string) => correlations.push(sessionId),
    startInput: (prompt: string, initialMessages?: readonly unknown[]) => ({ prompt, interactive: false, initialMessages }),
    hostAdapter: new ClineHostAdapter({
      sessionId: "workflow-session",
      taskId: taskId("task"),
      isMutatingTool: () => false,
      authoritativePreMutation: true,
    }),
  });

  await sessionDriver.start("Continue", () => undefined);

  assert.deepEqual(core.reads, ["cline-prior"]);
  assert.deepEqual(core.starts, [{ prompt: "Continue", interactive: false, initialMessages: [{ role: "user", content: "prior context" }] }]);
  assert.deepEqual(correlations, ["cline-1"]);
});

test("Cline session resume fails closed when correlated SDK history is unavailable", async () => {
  const core = new FakeClineCore();
  core.readMessages = async () => { throw new Error("history missing"); };
  const events: CodingSessionEvent[] = [];
  const sessionDriver = new ClineSessionDriver({
    core,
    resumeSessionId: "cline-missing",
    startInput: (prompt: string, initialMessages?: readonly unknown[]) => ({ prompt, initialMessages }),
    hostAdapter: new ClineHostAdapter({ sessionId: "workflow-session", taskId: taskId("task"), isMutatingTool: () => false, authoritativePreMutation: true }),
  });

  await sessionDriver.start("Continue", (event) => events.push(event));

  assert.deepEqual(core.starts, []);
  assert.deepEqual(events, [{ type: "failed", reason: "unable to restore Cline session cline-missing: history missing" }]);
});
