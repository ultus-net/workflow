import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

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
import { WebSessionManager } from "../src/ui/web-sessions.js";
import { buildWebappBundle } from "../src/ui/webapp/bundle.js";

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

test("web UI serves the built /app.js bundle as syntactically valid JavaScript", async (context) => {
  const webapp = await buildWebappBundle();
  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(application, undefined, webapp);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${port}/app.js`);
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.doesNotThrow(() => new vm.Script(source));
  const styles = await fetch(`http://127.0.0.1:${port}/app.css`);
  assert.equal(styles.status, 200);
  assert.match(styles.headers.get("content-type") ?? "", /text\/css/);
});

test("web UI serves PWA install assets", async (context) => {
  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(application);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const manifest = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`).then((response) => response.json()) as {
    name: string;
    display: string;
    icons: { sizes: string }[];
  };
  assert.equal(manifest.name, "Workflow Control");
  assert.equal(manifest.display, "standalone");
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ["192x192", "512x512"]);

  const worker = await fetch(`http://127.0.0.1:${port}/sw.js`);
  assert.equal(worker.status, 200);
  const workerSource = await worker.text();
  assert.doesNotThrow(() => new vm.Script(workerSource));

  for (const size of [192, 512]) {
    const icon = await fetch(`http://127.0.0.1:${port}/icon-${size}.png`);
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type") ?? "", /image\/png/);
    const bytes = Buffer.from(await icon.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(bytes.readUInt32BE(16), size); // IHDR width
    assert.equal(bytes.readUInt32BE(20), size); // IHDR height
  }
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
    { kind: "user", text: "Inspect this project" },
    { kind: "assistant", text: "Inspecting the workspace" },
    { kind: "completion", outcome: "completed", text: "Inspection complete" },
  ]);
});

test("web UI forwards prompt images to the session and serves them back", async (context) => {
  let received: readonly { mediaType: string; data: string }[] | undefined;
  const driver: CodingSessionDriver = {
    async start(_prompt, emit, images) {
      received = images as { mediaType: string; data: string }[] | undefined;
      emit({ type: "completed", result: "seen" });
    },
    async cancel() {},
  };
  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(application, new WorkflowCodingSession(driver));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
  const prompt = await fetch(`http://127.0.0.1:${port}/api/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "What is in this image?", images: [{ mediaType: "image/png", data: png }] }),
  });
  assert.equal(prompt.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [{ mediaType: "image/png", data: png }]);

  const session = await fetch(`http://127.0.0.1:${port}/api/session`).then((response) => response.json()) as {
    items: { kind: string; images?: { id: string; mediaType: string }[] }[];
  };
  const stored = session.items[0]?.images?.[0];
  assert.equal(stored?.mediaType, "image/png");
  assert.ok(stored !== undefined && stored.id.length > 0);

  const image = await fetch(`http://127.0.0.1:${port}/api/image/${stored!.id}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(png, "base64"));

  const missing = await fetch(`http://127.0.0.1:${port}/api/image/999`);
  assert.equal(missing.status, 404);
});

test("web UI rejects invalid prompt images before touching the session", async (context) => {
  let submitted = false;
  const driver: CodingSessionDriver = { async start() { submitted = true; }, async cancel() {} };
  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(application, new WorkflowCodingSession(driver));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const post = (images: unknown) => fetch(`http://127.0.0.1:${port}/api/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "look", images }),
  });

  assert.equal((await post([{ mediaType: "text/html", data: "aGVsbG8=" }])).status, 400);
  assert.equal((await post([{ mediaType: "image/png", data: "not base64!" }])).status, 400);
  assert.equal((await post([1, 2, 3, 4, 5].map(() => ({ mediaType: "image/png", data: "aGVsbG8=" })))).status, 400);
  assert.equal(submitted, false);
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

test("web UI manages sessions through guarded routes", async (context) => {
  const dir = mkdtempSync(join(tmpdir(), "web-routes-test-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async () => {
      const driver: CodingSessionDriver = {
        async start(_prompt, emit) { emit({ type: "completed", result: "done" }); },
        async cancel() {},
      };
      type FakeOption = { id: string; name: string; category?: string; type: string; currentValue: string | boolean; options?: { value: string }[] };
      let config: { configOptions: FakeOption[] } = {
        configOptions: [
          { id: "model", name: "Model", category: "model", type: "select", currentValue: "kimi-k2", options: [{ value: "kimi-k2" }, { value: "moonshot-v1" }] },
          { id: "web-search", name: "Web search", type: "boolean", currentValue: false },
        ],
      };
      return {
        driver: {
          ...driver,
          agentSessionId: () => "agent-x",
          connect: async () => {},
          subscribe: () => () => {},
          config: () => config,
          setConfigOption: async (id: string, value: string | boolean) => {
            config = {
              configOptions: config.configOptions.map((option) => option.id === id ? { ...option, currentValue: value } : option),
            };
            return config;
          },
        } as never,
        session: new WorkflowCodingSession(driver),
        async dispose() {},
      };
    },
  });
  context.after(() => manager.dispose());
  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(application, manager);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const empty = await fetch(`http://127.0.0.1:${port}/api/sessions`).then((response) => response.json()) as { sessions: unknown[] };
  assert.deepEqual(empty.sessions, []);

  const created = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST" });
  assert.equal(created.status, 201);
  const meta = await created.json() as { id: string; active: boolean };
  assert.equal(meta.active, true);

  const hostile = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST", headers: { origin: "https://attacker.example" } });
  assert.equal(hostile.status, 403);

  const activated = await fetch(`http://127.0.0.1:${port}/api/sessions/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: meta.id }),
  });
  assert.equal(activated.status, 200);

  const unknown = await fetch(`http://127.0.0.1:${port}/api/sessions/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "nope" }),
  });
  assert.equal(unknown.status, 404);

  const nonJson = await fetch(`http://127.0.0.1:${port}/api/sessions/activate`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ id: meta.id }),
  });
  assert.equal(nonJson.status, 415);

  const listed = await fetch(`http://127.0.0.1:${port}/api/sessions`).then((response) => response.json()) as { sessions: { id: string; active: boolean }[] };
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0]?.active, true);

  const dismissHostile = await fetch(`http://127.0.0.1:${port}/api/sessions/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ id: meta.id }),
  });
  assert.equal(dismissHostile.status, 403);

  const dismissNonJson = await fetch(`http://127.0.0.1:${port}/api/sessions/dismiss`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ id: meta.id }),
  });
  assert.equal(dismissNonJson.status, 415);

  const dismissUnknown = await fetch(`http://127.0.0.1:${port}/api/sessions/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "nope" }),
  });
  assert.equal(dismissUnknown.status, 404);

  // After a second create: two untitled records, one non-active → clearUnused
  // removes exactly that one and preserves the active record.
  const second = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST" });
  const secondMeta = await second.json() as { id: string };
  const cleared = await fetch(`http://127.0.0.1:${port}/api/sessions/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clearUnused: true }),
  });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json() as { removed: number }).removed, 1, "the untitled non-active record was cleared");

  // The original record is gone; dismissing the remaining active record works.
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/sessions/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: meta.id }),
  })).status, 404);
  const dismissed = await fetch(`http://127.0.0.1:${port}/api/sessions/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: secondMeta.id }),
  });
  assert.equal(dismissed.status, 200);
  const remaining = await fetch(`http://127.0.0.1:${port}/api/sessions`).then((response) => response.json()) as { sessions: { active: boolean }[] };
  assert.equal(remaining.sessions.length, 1);
  assert.equal(remaining.sessions[0]?.active, true);

  // Config options: listed, mutated through guards, unknown ids rejected.
  const listedOptions = await fetch(`http://127.0.0.1:${port}/api/config-options`).then((response) => response.json()) as { options: { id: string; currentValue: unknown }[] };
  assert.deepEqual(listedOptions.options.map((option) => option.id), ["model", "web-search"]);

  const configHostile = await fetch(`http://127.0.0.1:${port}/api/config-options`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ id: "model", value: "moonshot-v1" }),
  });
  assert.equal(configHostile.status, 403);

  const configNonJson = await fetch(`http://127.0.0.1:${port}/api/config-options`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ id: "model", value: "moonshot-v1" }),
  });
  assert.equal(configNonJson.status, 415);

  const configUnknown = await fetch(`http://127.0.0.1:${port}/api/config-options`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "nope", value: "x" }),
  });
  assert.equal(configUnknown.status, 404);

  const configBadValue = await fetch(`http://127.0.0.1:${port}/api/config-options`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "model", value: 42 }),
  });
  assert.equal(configBadValue.status, 400);

  const configUpdated = await fetch(`http://127.0.0.1:${port}/api/config-options`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "model", value: "moonshot-v1" }),
  });
  assert.equal(configUpdated.status, 200);
  const updatedOptions = await configUpdated.json() as { options: { id: string; currentValue: unknown }[] };
  assert.equal(updatedOptions.options.find((option) => option.id === "model")?.currentValue, "moonshot-v1");

  const toggleUpdated = await fetch(`http://127.0.0.1:${port}/api/config-options`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "web-search", value: true }),
  });
  assert.equal(toggleUpdated.status, 200);
  assert.equal((await toggleUpdated.json() as { options: { id: string; currentValue: unknown }[] }).options.find((option) => option.id === "web-search")?.currentValue, true);
});

test("web UI returns 503 instead of crashing when the runtime factory fails", async (context) => {
  const dir = mkdtempSync(join(tmpdir(), "web-failure-test-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async () => { throw new Error("agent cannot launch"); },
  });
  context.after(() => manager.dispose());
  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(application, manager);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const session = await fetch(`http://127.0.0.1:${port}/api/session`);
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { available: false, state: { state: "unavailable" }, items: [] });
  const prompt = await fetch(`http://127.0.0.1:${port}/api/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hello" }),
  });
  assert.equal(prompt.status, 503);
  const cancel = await fetch(`http://127.0.0.1:${port}/api/cancel`, { method: "POST" });
  assert.equal(cancel.status, 503);
});
