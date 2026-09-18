import assert from "node:assert/strict";
import test from "node:test";

import { createRemoteAcpAgent, type RemoteAcpConnection } from "../src/integrations/remote-acp/agent.js";
import type { RemoteAgent, RemoteCommand, RemoteEngine, RemoteEngineEvent, RemoteEngineReply, RemoteMessage, RemoteProvider, RemoteSession } from "../src/integrations/remote-acp/engine.js";

class FakeEngine implements RemoteEngine {
  readonly creates: { cwd: string; title?: string }[] = [];
  readonly prompts: { sessionId: string; cwd: string; text: string; agent?: string; model?: { providerID: string; modelID: string } }[] = [];
  readonly aborts: { sessionId: string; cwd: string }[] = [];
  readonly replies: { sessionId: string; requestId: string; reply: RemoteEngineReply; cwd: string }[] = [];
  readonly deleted: string[] = [];
  agentsResult: readonly RemoteAgent[] = [
    { id: "build", name: "Build", mode: "primary" },
    { id: "plan", name: "Plan", mode: "primary" },
    { id: "explore", mode: "subagent" },
  ];
  providersResult: readonly RemoteProvider[] = [
    { id: "anthropic", name: "Anthropic", models: [{ id: "claude", name: "Claude", variants: [{ id: "high", name: "High" }, { id: "low" }] }] },
  ];
  messagesResult: readonly RemoteMessage[] = [];
  sessionsResult: readonly RemoteSession[] = [];
  commandsResult: readonly RemoteCommand[] = [];
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

  async getSession(): Promise<RemoteSession | undefined> {
    return undefined;
  }

  async listSessions(): Promise<readonly RemoteSession[]> {
    return this.sessionsResult;
  }

  async deleteSession(input: { sessionId: string }): Promise<void> {
    this.deleted.push(input.sessionId);
  }

  async messages(): Promise<readonly RemoteMessage[]> {
    return this.messagesResult;
  }

  async agents(): Promise<readonly RemoteAgent[]> {
    return this.agentsResult;
  }

  async providers(): Promise<readonly RemoteProvider[]> {
    return this.providersResult;
  }

  async commands(): Promise<readonly RemoteCommand[]> {
    return this.commandsResult;
  }

  async prompt(input: { sessionId: string; cwd: string; text: string; agent?: string; model?: { providerID: string; modelID: string } }): Promise<void> {
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
  assert.deepEqual(engine.prompts, [{ sessionId: "ses_1", cwd: "/w", text: "ab", agent: "build", model: { providerID: "anthropic", modelID: "claude" } }]);
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

test("newSession exposes selectable modes (subagents excluded) and models as config options", async () => {
  const engine = new FakeEngine();
  const agent = createRemoteAcpAgent({ engine, cwd: "/w", connection: new FakeConnection() });
  const session = await agent.newSession({ cwd: "/w" });
  assert.deepEqual(session.availableModes.map((mode) => mode.id), ["build", "plan"]);
  assert.deepEqual(session.availableModels.map((model) => model.modelId), ["anthropic/claude"]);
  assert.deepEqual(session.configOptions.map((option) => [option.id, option.currentValue]), [["mode", "build"], ["model", "anthropic/claude"], ["effort", "high"]]);
  agent.dispose();
});

test("setSessionConfigOption validates and emits a config_option_update", async () => {
  const engine = new FakeEngine();
  const connection = new FakeConnection();
  const agent = createRemoteAcpAgent({ engine, cwd: "/w", connection });
  await agent.newSession({ cwd: "/w" });
  const result = await agent.setSessionConfigOption({ sessionId: "ses_1", configId: "model", value: "anthropic/claude" });
  assert.equal(result.configOptions.find((option) => option.id === "model")?.currentValue, "anthropic/claude");
  assert.deepEqual(connection.updates.at(-1), {
    sessionId: "ses_1",
    update: { sessionUpdate: "config_option_update", configOptions: result.configOptions },
  });
  await assert.rejects(() => agent.setSessionConfigOption({ sessionId: "ses_1", configId: "model", value: "nope/nope" }), /unknown model/);
  await assert.rejects(() => agent.setSessionConfigOption({ sessionId: "ses_1", configId: "mode", value: "explore" }), /unknown mode/);
  agent.dispose();
});

test("setSessionMode validates against the remote catalog", async () => {
  const engine = new FakeEngine();
  const agent = createRemoteAcpAgent({ engine, cwd: "/w", connection: new FakeConnection() });
  await agent.newSession({ cwd: "/w" });
  await agent.setSessionMode({ sessionId: "ses_1", modeId: "plan" });
  await assert.rejects(() => agent.setSessionMode({ sessionId: "ses_1", modeId: "ghost" }), /unknown mode/);
  agent.dispose();
});

test("prompt forwards the selected mode and parsed model to the engine", async () => {
  const engine = new FakeEngine();
  const agent = createRemoteAcpAgent({ engine, cwd: "/w", connection: new FakeConnection() });
  await agent.newSession({ cwd: "/w" });
  await agent.setSessionMode({ sessionId: "ses_1", modeId: "plan" });
  await agent.prompt({ sessionId: "ses_1", prompt: [{ type: "text", text: "go" }] });
  assert.deepEqual(engine.prompts[0], {
    sessionId: "ses_1",
    cwd: "/w",
    text: "go",
    agent: "plan",
    model: { providerID: "anthropic", modelID: "claude" },
  });
  agent.dispose();
});

test("loadSession replays assistant messages as session updates", async () => {
  const engine = new FakeEngine();
  engine.messagesResult = [
    { info: { role: "user" }, parts: [{ type: "text", text: "ignore me" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", sessionID: "ses_1", text: "recalled" }] },
  ];
  const connection = new FakeConnection();
  const agent = createRemoteAcpAgent({ engine, cwd: "/w", connection });
  await agent.loadSession({ sessionId: "ses_1", cwd: "/w" });
  await waitFor(() => connection.updates.length === 1, "replay update");
  assert.deepEqual(connection.updates[0], {
    sessionId: "ses_1",
    update: { sessionUpdate: "agent_message_chunk", messageId: undefined, content: { type: "text", text: "recalled" } },
  });
  agent.dispose();
});

test("listSessions maps remote sessions and closeSession deletes", async () => {
  const engine = new FakeEngine();
  engine.sessionsResult = [{ id: "ses_9", title: "Old", time: { updated: 42 } }];
  const agent = createRemoteAcpAgent({ engine, cwd: "/w", connection: new FakeConnection() });
  const listed = await agent.listSessions({ cwd: "/w" });
  assert.deepEqual(listed.sessions, [{ sessionId: "ses_9", cwd: "/w", title: "Old", updatedAt: 42 }]);
  await agent.closeSession({ sessionId: "ses_9" });
  assert.deepEqual(engine.deleted, ["ses_9"]);
  agent.dispose();
});

test("newSession advertises remote slash commands", async () => {
  const engine = new FakeEngine();
  engine.commandsResult = [{ name: "test", description: "Run tests" }];
  const connection = new FakeConnection();
  const agent = createRemoteAcpAgent({ engine, cwd: "/w", connection });
  await agent.newSession({ cwd: "/w" });
  assert.deepEqual(connection.updates.at(-1), {
    sessionId: "ses_1",
    update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "test", description: "Run tests" }] },
  });
  agent.dispose();
});

test("setSessionMode emits a current_mode_update", async () => {
  const engine = new FakeEngine();
  const connection = new FakeConnection();
  const agent = createRemoteAcpAgent({ engine, cwd: "/w", connection });
  await agent.newSession({ cwd: "/w" });
  await agent.setSessionMode({ sessionId: "ses_1", modeId: "plan" });
  assert.deepEqual(connection.updates.at(-1), {
    sessionId: "ses_1",
    update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
  });
  agent.dispose();
});

test("effort config option validates against the model variants and threads into the prompt", async () => {
  const engine = new FakeEngine();
  const connection = new FakeConnection();
  const agent = createRemoteAcpAgent({ engine, cwd: "/w", connection });
  const session = await agent.newSession({ cwd: "/w" });
  assert.equal(session.configOptions.find((option) => option.id === "effort")?.currentValue, "high");

  const result = await agent.setSessionConfigOption({ sessionId: "ses_1", configId: "effort", value: "low" });
  assert.equal(result.configOptions.find((option) => option.id === "effort")?.currentValue, "low");
  await assert.rejects(() => agent.setSessionConfigOption({ sessionId: "ses_1", configId: "effort", value: "nope" }), /unknown effort/);

  await agent.prompt({ sessionId: "ses_1", prompt: [{ type: "text", text: "go" }] });
  assert.deepEqual(engine.prompts[0]?.model, { providerID: "anthropic", modelID: "claude", variant: "low" });
  agent.dispose();
});
