import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { AcpSubprocessClient, type AcpSessionUpdate } from "../src/adapters/acp-subprocess.js";

function fakeAgent(mode: "happy" | "malformed" | "exit" = "happy") {
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
  assert.equal(initialized.agentInfo.name, "fake-acp-agent");

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
  await client.close();
});

test("hub-side ACP subprocess spike turns process exit during initialize into terminal failure", async () => {
  const client = new AcpSubprocessClient({ child: fakeAgent("exit") });

  await assert.rejects(() => client.initialize(), /ACP agent exited/);
  await client.close();
});
