import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { AcpSubprocessClient, type AcpSessionUpdate } from "../src/adapters/acp-subprocess.js";

function fakeAgent(mode: "happy" | "malformed" | "exit" | "invalid-update" | "invalid-jsonrpc" | "no-agent-info" | "require-boolean-capability" | "usage-update" = "happy") {
  return spawn(process.execPath, ["test/fixtures/fake-acp-agent.mjs", mode], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

test("hub-side ACP subprocess spike initializes, creates a session, prompts, and streams live updates", async () => {
  const client = new AcpSubprocessClient({ child: fakeAgent() });
  const updates: AcpSessionUpdate[] = [];
  client.onSessionUpdate((update) => updates.push(update));

  const initialized = await client.initialize();
  assert.equal(initialized.protocolVersion, 1);
  assert.equal(initialized.agentInfo?.name, "fake-acp-agent");

  const session = await client.newSession({ cwd: "/repo" });
  assert.equal(session.sessionId, "fake-session-1");

  const prompt = client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "inspect repo" }] });
  await client.waitForUpdates(2);
  const result = await prompt;

  assert.deepEqual(updates.map((update) => update.update.sessionUpdate), ["agent_message_chunk", "tool_call"]);
  assert.deepEqual(result, { stopReason: "end_turn" });
  await client.close();
});

test("hub-side ACP subprocess spike loads a session and observes the replayed history", async () => {
  const client = new AcpSubprocessClient({ child: fakeAgent() });
  const updates: AcpSessionUpdate[] = [];
  client.onSessionUpdate((update) => updates.push(update));

  await client.initialize();
  await client.loadSession({ sessionId: "fake-session-1", cwd: "/repo" });

  assert.deepEqual(updates.map((update) => update.update.sessionUpdate), ["user_message_chunk", "agent_message_chunk"]);
  assert.deepEqual(updates.map((update) => update.sessionId), ["fake-session-1", "fake-session-1"]);
  await client.close();
});

test("hub-side ACP subprocess spike updates a session config option and returns complete config state", async () => {
  const client = new AcpSubprocessClient({ child: fakeAgent() });
  await client.initialize();
  const session = await client.newSession({ cwd: "/repo" });

  const config = await client.setConfigOption({
    sessionId: session.sessionId,
    configId: "model",
    value: "moonshot-v1",
  });

  assert.equal((config.configOptions as { currentValue?: string }[])[0]?.currentValue, "moonshot-v1");
  await client.close();
});

test("hub-side ACP subprocess spike sends boolean config values with the ACP type discriminator", async () => {
  const client = new AcpSubprocessClient({ child: fakeAgent() });
  await client.initialize();
  const session = await client.newSession({ cwd: "/repo" });

  const config = await client.setConfigOption({
    sessionId: session.sessionId,
    configId: "model",
    value: true,
  });

  assert.equal((config.configOptions as { currentValue?: unknown }[])[0]?.currentValue, true);
  await client.close();
});

test("hub-side ACP subprocess spike cancels an active prompt explicitly", async () => {
  const client = new AcpSubprocessClient({ child: fakeAgent() });
  await client.initialize();
  const session = await client.newSession({ cwd: "/repo" });

  const prompt = client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "long work" }] });
  await client.waitForUpdates(1);
  await client.cancel({ sessionId: session.sessionId });
  const result = await prompt;

  assert.deepEqual(result, { stopReason: "cancelled" });
  await client.close();
});

test("hub-side ACP subprocess spike rejects malformed agent output fail-closed", async () => {
  const client = new AcpSubprocessClient({ child: fakeAgent("malformed") });

  await assert.rejects(() => client.initialize(), /invalid ACP NDJSON/);
  await assert.rejects(() => client.initialize(), /ACP client is closed/);
  await client.close();
});

test("hub-side ACP subprocess spike accepts initialize without optional agentInfo", async () => {
  const client = new AcpSubprocessClient({ child: fakeAgent("no-agent-info") });
  const initialized = await client.initialize();
  assert.equal(initialized.agentInfo, undefined);
  await client.close();
});

test("hub-side ACP subprocess spike advertises boolean config option support", async () => {
  const client = new AcpSubprocessClient({ child: fakeAgent("require-boolean-capability") });
  const initialized = await client.initialize();
  assert.equal(initialized.protocolVersion, 1);
  await client.close();
});

test("hub-side ACP subprocess spike closes on an invalid JSON-RPC envelope", async () => {
  const client = new AcpSubprocessClient({ child: fakeAgent("invalid-jsonrpc") });
  await assert.rejects(() => client.initialize(), /invalid ACP JSON-RPC version/);
  await assert.rejects(() => client.initialize(), /ACP client is closed/);
  await client.close();
});

test("hub-side ACP subprocess spike closes on a structurally invalid session update", async () => {
  const client = new AcpSubprocessClient({ child: fakeAgent("invalid-update") });
  await client.initialize();
  const session = await client.newSession({ cwd: "/repo" });
  await assert.rejects(
    client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "inspect repo" }] }),
    /invalid ACP session update/,
  );
  await assert.rejects(() => client.initialize(), /ACP client is closed/);
  await client.close();
});

test("hub-side ACP subprocess spike turns process exit during initialize into terminal failure", async () => {
  const client = new AcpSubprocessClient({ child: fakeAgent("exit") });

  await assert.rejects(() => client.initialize(), /ACP agent exited/);
  await client.close();
});

// ── E2 hardening: usage_update passes through the client untouched ───────

test("unknown update kinds like usage_update reach listeners untouched (E2 forward-compat)", async (t) => {
  const child = fakeAgent("usage-update");
  const client = new AcpSubprocessClient({ child });
  t.after(() => {
    void client.close();
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  });
  const updates: unknown[] = [];
  client.onSessionUpdate((update) => updates.push(update));
  await client.initialize();
  const session = await client.newSession({ cwd: "/repo" });
  await client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "go" }] });
  const usage = updates.find(
    (update) => (update as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === "usage_update",
  );
  assert.ok(usage !== undefined, "usage_update must reach onSessionUpdate listeners (forwarded untouched)");
  const payload = (usage as { update: Record<string, unknown> }).update;
  assert.equal(payload.totalTokens, 100);
  assert.equal(payload.costUsd, 0.01);
});
