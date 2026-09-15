import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";

import {
  TaskGraph,
  WorkflowApplication,
  WorkflowCodingSession,
  createWorkflowWebServer,
  hostCapabilities,
  taskId,
  type WorkflowTask,
} from "../src/index.js";
import type { CodingSessionDriver } from "../src/application/coding-session.js";

test("web UI reads snapshots and submits commands through the application API", async (context) => {
  const tasks: WorkflowTask[] = [{
    id: taskId("A"), title: "Web task", state: "BLOCKED", dependencies: [], requiredEvidence: [],
  }];
  const application = new WorkflowApplication(
    new TaskGraph(tasks),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(application);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Workflow Control/);

  const before = await fetch(`http://127.0.0.1:${port}/api/snapshot`).then((response) => response.json()) as { tasks: { state: string }[] };
  assert.equal(before.tasks[0]?.state, "READY");

  const transition = await fetch(`http://127.0.0.1:${port}/api/transition`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "A", requested: "IN_PROGRESS" }),
  });
  assert.equal(transition.status, 200);
  const after = await fetch(`http://127.0.0.1:${port}/api/snapshot`).then((response) => response.json()) as { tasks: { state: string }[] };
  assert.equal(after.tasks[0]?.state, "IN_PROGRESS");
});

test("web UI submits prompts through the authoritative coding session and exposes projected events", async (context) => {
  let submitted = "";
  const driver: CodingSessionDriver = {
    async start(prompt, emit) {
      submitted = prompt;
      emit({ type: "assistant", text: "Inspecting the workspace" });
      emit({ type: "log", level: "debug", message: "transport noise" });
      emit({ type: "completed", result: "Inspection complete" });
    },
    async cancel() {},
  };
  const application = new WorkflowApplication(
    new TaskGraph([{ id: taskId("A"), title: "Web task", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(application, new WorkflowCodingSession(driver));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const prompt = await fetch(`http://127.0.0.1:${port}/api/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Inspect this project" }),
  });
  assert.equal(prompt.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitted, "Inspect this project");

  const session = await fetch(`http://127.0.0.1:${port}/api/session`).then((response) => response.json()) as {
    state: { state: string };
    items: { kind: string; title?: string; text?: string }[];
  };
  assert.equal(session.state.state, "completed");
  assert.deepEqual(session.items, [
    { kind: "assistant", text: "Inspecting the workspace" },
    { kind: "completion", outcome: "completed", text: "Inspection complete" },
  ]);
});

test("web UI denies cross-origin browser mutations", async (context) => {
  const driver: CodingSessionDriver = { async start() {}, async cancel() {} };
  const application = new WorkflowApplication(
    new TaskGraph([{ id: taskId("A"), title: "Web task", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(application, new WorkflowCodingSession(driver));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const prompt = await fetch(`http://127.0.0.1:${port}/api/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ prompt: "run this" }),
  });
  assert.equal(prompt.status, 403);
  const cancel = await fetch(`http://127.0.0.1:${port}/api/cancel`, {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(cancel.status, 403);
  const transition = await fetch(`http://127.0.0.1:${port}/api/transition`, {
    method: "POST",
    headers: { "content-type": "text/plain", origin: "https://attacker.example" },
    body: JSON.stringify({ taskId: "A", requested: "IN_PROGRESS" }),
  });
  assert.equal(transition.status, 403);
  const fetchMetadata = await fetch(`http://127.0.0.1:${port}/api/cancel`, {
    method: "POST",
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(fetchMetadata.status, 403);
  const nonJsonPrompt = await fetch(`http://127.0.0.1:${port}/api/prompt`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ prompt: "run this" }),
  });
  assert.equal(nonJsonPrompt.status, 415);
  const nonJsonTransition = await fetch(`http://127.0.0.1:${port}/api/transition`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ taskId: "A", requested: "IN_PROGRESS" }),
  });
  assert.equal(nonJsonTransition.status, 415);
});

test("web UI does not admit a new turn until a cancelled ACP turn settles", async (context) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const driver: CodingSessionDriver = { async start() { await pending; }, async cancel() {} };
  const application = new WorkflowApplication(
    new TaskGraph([{ id: taskId("A"), title: "Web task", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(application, new WorkflowCodingSession(driver));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const postPrompt = (prompt: string) => fetch(`http://127.0.0.1:${port}/api/prompt`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }),
  });

  assert.equal((await postPrompt("first")).status, 202);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/cancel`, { method: "POST" })).status, 200);
  assert.equal((await postPrompt("second")).status, 409);
  release();
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await postPrompt("second")).status, 202);
});
