import assert from "node:assert/strict";
import test from "node:test";

import { createRemoteAcpAgent, type RemoteAcpConnection } from "../src/integrations/remote-acp/agent.js";
import type { RemoteEngine, RemoteEngineEvent, RemoteEngineReply } from "../src/integrations/remote-acp/engine.js";

class FakeEngine implements RemoteEngine {
  readonly creates: { cwd: string; title?: string }[] = [];
  readonly prompts: { sessionId: string; cwd: string; text: string }[] = [];
  readonly aborts: { sessionId: string; cwd: string }[] = [];
  readonly replies: { sessionId: string; requestId: string; reply: RemoteEngineReply; cwd: string }[] = [];
  #queue: RemoteEngineEvent[] = [];
  #waiters: ((event: RemoteEngineEvent | undefined) => void)[] = [];
  #closed = false;

  push(event: RemoteEngineEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter(event);
    else this.#queue.push(event);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters) waiter(undefined);
    this.#waiters = [];
  }

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }

  async createSession(input: { cwd: string; title?: string }): Promise<{ id: string }> {
    this.creates.push(input);
    return { id: "ses_1" };
  }

  async prompt(input: { sessionId: string; cwd: string; text: string }): Promise<void> {
    this.prompts.push(input);
  }

  async abort(input: { sessionId: string; cwd: string }): Promise<void> {
    this.aborts.push(input);
  }

  async replyPermission(input: { sessionId: string; requestId: string; reply: RemoteEngineReply; cwd: string }): Promise<void> {
    this.replies.push(input);
  }

  async *events(input: { cwd: string; signal: AbortSignal }): AsyncIterable<RemoteEngineEvent> {
    while (true) {
      const event = await this.#next(input.signal);
      if (event === undefined) return;
      yield event;
    }
  }

  #next(signal: AbortSignal): Promise<RemoteEngineEvent | undefined> {
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift());
    if (this.#closed || signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

class FakeConnection implements RemoteAcpConnection {
  readonly updates: Record<string, unknown>[] = [];
  readonly requests: Record<string, unknown>[] = [];
  outcome: unknown = { outcome: "selected", optionId: "once" };
  throwOnPermission = false;

  async sessionUpdate(params: Record<string, unknown>): Promise<void> {
    this.updates.push(params);
  }

  async requestPermission(params: Record<string, unknown>): Promise<unknown> {
    this.requests.push(params);
    if (this.throwOnPermission) throw new Error("permission transport failed");
    return { outcome: this.outcome };
  }
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !condition()) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), `timed out waiting for: ${what}`);
}

test("newSession and prompt drive the engine with the joined prompt text", async () => {
  const engine = new FakeEngine();
  const connection = new FakeConnection();
  const agent = createRemoteAcpAgent({ engine, cwd: "/w", connection });
  const session = await agent.newSession({ cwd: "/w" });
  assert.equal(session.sessionId, "ses_1");
  assert.deepEqual(engine.creates, [{ cwd: "/w" }]);

  const response = await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
  assert.equal(response.stopReason, "end_turn");
  assert.deepEqual(engine.prompts, [{ sessionId: "ses_1", cwd: "/w", text: "ab" }]);
  agent.dispose();
});

test("a selected permission option is relayed as the matching engine reply", async () => {
  const engine = new FakeEngine();
  const connection = new FakeConnection();
  connection.outcome = { outcome: "selected", optionId: "always" };
  const agent = createRemoteAcpAgent({ engine, cwd: "/w", connection });
  await agent.newSession({ cwd: "/w" });

  engine.push({
    type: "permission.asked",
    properties: { id: "per_1", sessionID: "ses_1", action: "edit", resources: ["src/a.ts"], metadata: { filepath: "src/a.ts" } },
  });
  await waitFor(() => engine.replies.length === 1, "permission reply");
  assert.deepEqual(engine.replies[0], { sessionId: "ses_1", requestId: "per_1", reply: "always", cwd: "/w" });
  assert.equal(connection.requests.length, 1);
  assert.deepEqual((connection.requests[0] as { options: unknown }).options, [
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    { optionId: "always", kind: "allow_always", name: "Always allow" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ]);
  agent.dispose();
});

test("a rejected permission option and a permission transport failure both relay reject", async () => {
  const engine = new FakeEngine();
  const connection = new FakeConnection();
  connection.outcome = { outcome: "selected", optionId: "reject" };
  const agent = createRemoteAcpAgent({ engine, cwd: "/w", connection });
  await agent.newSession({ cwd: "/w" });
  engine.push({ type: "permission.asked", properties: { id: "per_1", sessionID: "ses_1", action: "edit", resources: [] } });
  await waitFor(() => engine.replies.length === 1, "reject reply");
  assert.equal(engine.replies[0]!.reply, "reject");

  const failing = new FakeConnection();
  failing.throwOnPermission = true;
  const errors: unknown[] = [];
  const failingEngine = new FakeEngine();
  const agent2 = createRemoteAcpAgent({ engine: failingEngine, cwd: "/w", connection: failing, onError: (error) => errors.push(error) });
  await agent2.newSession({ cwd: "/w" });
  failingEngine.push({ type: "permission.asked", properties: { id: "per_2", sessionID: "ses_1", action: "edit", resources: [] } });
  await waitFor(() => failingEngine.replies.length === 1, "fail-closed reply");
  assert.equal(failingEngine.replies[0]!.reply, "reject");
  assert.equal(errors.length, 1);
  agent.dispose();
  agent2.dispose();
});

test("session updates from the engine stream project to the ACP connection", async () => {
  const engine = new FakeEngine();
  const connection = new FakeConnection();
  const agent = createRemoteAcpAgent({ engine, cwd: "/w", connection });
  await agent.newSession({ cwd: "/w" });
  engine.push({ type: "message.part.delta", properties: { sessionID: "ses_1", field: "text", delta: "hi" } });
  await waitFor(() => connection.updates.length === 1, "session update");
  assert.deepEqual(connection.updates[0], {
    sessionId: "ses_1",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
  });
  agent.dispose();
});

test("cancel aborts the engine session", async () => {
  const engine = new FakeEngine();
  const agent = createRemoteAcpAgent({ engine, cwd: "/w", connection: new FakeConnection() });
  await agent.newSession({ cwd: "/w" });
  await agent.cancel({ sessionId: "ses_1" });
  assert.deepEqual(engine.aborts, [{ sessionId: "ses_1", cwd: "/w" }]);
  agent.dispose();
});
