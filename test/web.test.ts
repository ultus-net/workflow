import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
import { PermissionBroker } from "../src/ui/permission-broker.js";
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

test("web UI exposes repository branch, changed paths, and constrained diffs", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "workflow-web-git-"));
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "feature/ui"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: workspace });
  writeFileSync(join(workspace, "tracked.txt"), "before\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });
  writeFileSync(join(workspace, "tracked.txt"), "after\n");
  writeFileSync(join(workspace, "new.txt"), "new file\n");
  execFileSync("git", ["mv", "tracked.txt", "renamed.txt"], { cwd: workspace });
  writeFileSync(join(workspace, "renamed.txt"), "after\n");

  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
    [],
    new Set(["read"]),
    workspace,
  );
  const server = createWorkflowWebServer(application);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const status = await fetch(`http://127.0.0.1:${port}/api/git`);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    branch: "feature/ui",
    changes: [
      { path: "new.txt", status: "untracked" },
      { path: "renamed.txt", status: "renamed" },
    ],
  });

  const diff = await fetch(`http://127.0.0.1:${port}/api/git/diff?path=renamed.txt`);
  assert.equal(diff.status, 200);
  const renamedDiff = (await diff.json() as { diff: string }).diff;
  assert.match(renamedDiff, /-before/);
  assert.match(renamedDiff, /\+after/);

  const untracked = await fetch(`http://127.0.0.1:${port}/api/git/diff?path=new.txt`);
  assert.equal(untracked.status, 200);
  assert.match((await untracked.json() as { diff: string }).diff, /\+new file/);

  const outside = await fetch(`http://127.0.0.1:${port}/api/git/diff?path=..%2Fsecret.txt`);
  assert.equal(outside.status, 404);
});

test('web UI lists git worktrees with the current one marked', async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), 'workflow-web-worktree-'));
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-b', 'trunk'], { cwd: workspace });
  execFileSync('git', ['config', 'user.email', 'test@workflow.local'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'Workflow Test'], { cwd: workspace });
  writeFileSync(join(workspace, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', 'seed.txt'], { cwd: workspace });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: workspace });
  // A second worktree on a feature branch — the shape the left rail lists.
  const linked = join(workspace, 'linked');
  execFileSync('git', ['worktree', 'add', '-b', 'feature/linked', linked], { cwd: workspace });

  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: 'acp', authoritativePreMutation: false }),
    [],
    new Set(['read']),
    workspace,
  );
  const server = createWorkflowWebServer(application);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${port}` + '/api/worktrees');
  assert.equal(response.status, 200);
  const { worktrees } = await response.json() as { worktrees: { path: string; branch: string | null; head?: string; bare: boolean; detached: boolean; current: boolean }[] };
  assert.equal(worktrees.length, 2);
  const main = worktrees.find((entry) => entry.current);
  const other = worktrees.find((entry) => !entry.current);
  assert.ok(main !== undefined && other !== undefined, 'exactly one current worktree');
  assert.equal(main.branch, 'trunk');
  assert.equal(main.detached, false);
  assert.ok(main.head !== undefined, 'the current worktree reports its HEAD');
  assert.equal(other.branch, 'feature/linked');
  assert.equal(other.current, false);
  assert.ok(other.path.endsWith('linked'), 'the linked worktree path is reported');
});

test("web UI diffs staged changes before a repository has HEAD", async (context) => {
  const workspace = mkdtempSync(join(tmpdir(), "workflow-web-git-unborn-"));
  context.after(() => rmSync(workspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "feature/new"], { cwd: workspace });
  writeFileSync(join(workspace, "first.txt"), "first\n");
  execFileSync("git", ["add", "first.txt"], { cwd: workspace });

  const application = new WorkflowApplication(new TaskGraph([]), hostCapabilities({ transport: "acp", authoritativePreMutation: false }), [], new Set(["read"]), workspace);
  const server = createWorkflowWebServer(application);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const diff = await fetch(`http://127.0.0.1:${port}/api/git/diff?path=first.txt`);
  assert.equal(diff.status, 200);
  assert.match((await diff.json() as { diff: string }).diff, /\+first/);
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

test('the usage route reports its setup state without a management key and serves analytics with one', async (context) => {
  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: 'acp', authoritativePreMutation: false }),
  );

  // Without a management key the page gets an honest setup state, not a 503.
  const bare = createWorkflowWebServer(application, undefined, undefined, { analytics: () => undefined });
  await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
  context.after(() => bare.close());
  const barePort = (bare.address() as AddressInfo).port;
  const setup = await fetch(`http://127.0.0.1:${barePort}/api/usage`);
  assert.equal(setup.status, 200);
  const setupBody = await setup.json() as { available: boolean; reason?: string };
  assert.equal(setupBody.available, false);
  assert.match(setupBody.reason ?? '', /management key/i);

  // With an analytics client the route composes the three calls.
  const row = { model: 'deepseek/deepseek-v4.1-flash', provider: 'Together', request_count: 12, prompt_tokens: 310352, completion_tokens: 206, cost: 0.00217 };
  const calls: string[] = [];
  const fakeAnalytics = {
    async meta() { return { metrics: [], dimensions: [], granularities: [] }; },
    async queryByModel() { calls.push('byModel'); return { rows: [row], truncated: false }; },
    async queryDaily() { calls.push('byDay'); return { rows: [{ date__day: '2026-09-18T00:00:00.000Z', cost: 0.00217 }], truncated: false }; },
    async credits() { calls.push('credits'); return { totalCredits: 100, totalUsage: 12.5 }; },
  };
  const server = createWorkflowWebServer(application, undefined, undefined, { analytics: () => fakeAnalytics });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const usage = await fetch(`http://127.0.0.1:${port}/api/usage` + '?days=30');
  assert.equal(usage.status, 200);
  const body = await usage.json() as { available: boolean; days: number; credits?: { totalCredits: number }; byModel?: { rows: unknown[] }; byDay?: { rows: unknown[] } };
  assert.equal(body.available, true);
  assert.equal(body.days, 30);
  assert.equal(body.credits?.totalCredits, 100);
  assert.equal(body.byModel?.rows.length, 1);
  assert.equal(body.byDay?.rows.length, 1);
  assert.deepEqual(calls.sort(), ['byDay', 'byModel', 'credits']);

  // An upstream failure surfaces as a 503 with the upstream message.
  const failing = createWorkflowWebServer(application, undefined, undefined, {
    analytics: () => ({
      async meta() { return { metrics: [], dimensions: [], granularities: [] }; },
      async queryByModel() { throw new Error('Only management keys can perform this operation'); },
      async queryDaily() { return { rows: [], truncated: false }; },
      async credits() { return undefined; },
    }),
  });
  await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
  context.after(() => failing.close());
  const failingPort = (failing.address() as AddressInfo).port;
  const failed = await fetch(`http://127.0.0.1:${failingPort}/api/usage`);
  assert.equal(failed.status, 503);
  assert.match((await failed.json() as { error: string }).error, /management key/i);
});

test("the ACP handshake version rides /api/session and /api/agents, never fabricated", async (context) => {
  const dir = mkdtempSync(join(tmpdir(), "web-version-test-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async () => {
      const driver: CodingSessionDriver = {
        async start(_prompt, emit) { emit({ type: "completed", result: "done" }); },
        async cancel() {},
      };
      return {
        driver: {
          ...driver,
          agentSessionId: () => "agent-x",
          connect: async () => {},
          subscribe: () => () => {},
          // The real AcpSessionDriver surfaces this from the initialize handshake.
          agentInfo: () => ({ name: "OpenCode", version: "1.42.0" }),
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

  const session = await fetch(`http://127.0.0.1:${port}/api/session`).then((response) => response.json()) as { agentVersion?: string };
  assert.equal(session.agentVersion, "1.42.0", "the focused session's handshake version rides /api/session");

  const agents = await fetch(`http://127.0.0.1:${port}/api/agents`).then((response) => response.json()) as { agents: { id: string; version?: string }[] };
  assert.equal(agents.agents.find((agent) => agent.id === "opencode")?.version, "1.42.0", "the live runtime's version annotates its agent entry");
  assert.equal(agents.agents.find((agent) => agent.id === "cline")?.version, undefined, "agents with no live handshake report no version");
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
  // The registry record survives a failed launch; the runtime does not. The
// payload states both facts honestly: the record meta plus availability.
const failure = await session.json() as { available: boolean; title: string; agent: string; items: unknown[]; state: { state: string } };
assert.equal(failure.available, false);
assert.equal(failure.title, "New session");
assert.equal(failure.agent, "opencode");
assert.deepEqual(failure.state, { state: "unavailable" });
assert.deepEqual(failure.items, []);
  const prompt = await fetch(`http://127.0.0.1:${port}/api/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hello" }),
  });
  assert.equal(prompt.status, 503);
  const cancel = await fetch(`http://127.0.0.1:${port}/api/cancel`, { method: "POST" });
  assert.equal(cancel.status, 503);
});

test("web UI serves cumulative usage metrics for metered runtimes only", async (context) => {
  const dir = mkdtempSync(join(tmpdir(), "web-usage-test-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const metrics = { requests: 1, usageEvents: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.001, latestPromptTokens: 10 };
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async () => {
      const driver: CodingSessionDriver = {
        async start(_prompt, emit) { emit({ type: "completed", result: "done" }); },
        async cancel() {},
      };
      return {
        driver: {
          ...driver,
          agentSessionId: () => "agent-x",
          connect: async () => {},
          subscribe: () => () => {},
        } as never,
        session: new WorkflowCodingSession(driver),
        usage: () => metrics,
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

  const metered = await fetch(`http://127.0.0.1:${port}/api/session`).then((response) => response.json()) as {
    usage?: typeof metrics;
  };
  assert.deepEqual(metered.usage, metrics);

  // Single-session mode has no metering proxy: the field must stay absent,
  // not default to zeroed metrics that would mislead the operator.
  const singleDriver: CodingSessionDriver = {
    async start(_prompt, emit) { emit({ type: "completed", result: "done" }); },
    async cancel() {},
  };
  const singleServer = createWorkflowWebServer(application, new WorkflowCodingSession(singleDriver));
  await new Promise<void>((resolve) => singleServer.listen(0, "127.0.0.1", resolve));
  context.after(() => singleServer.close());
  const singlePort = (singleServer.address() as AddressInfo).port;
  const unmetered = await fetch(`http://127.0.0.1:${singlePort}/api/session`).then((response) => response.json()) as {
    usage?: unknown;
  };
  assert.equal(unmetered.usage, undefined);
});

test("web UI guards permission answers, ask mode, and capability toggles", async (context) => {
  const dir = mkdtempSync(join(tmpdir(), "web-permission-test-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const broker = new PermissionBroker();
  const fakeRuntimeFactory = async () => {
    const driver: CodingSessionDriver = {
      async start(_prompt, emit) { emit({ type: "completed", result: "done" }); },
      async cancel() {},
    };
    return {
      driver: {
        ...driver,
        agentSessionId: () => "agent-x",
        connect: async () => {},
        subscribe: () => () => {},
      } as never,
      session: new WorkflowCodingSession(driver),
      async dispose() {},
    };
  };
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: fakeRuntimeFactory,
    permissionBroker: broker,
  });
  context.after(() => manager.dispose());
  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
    [],
    new Set(["read", "mutation"]),
    "/repo",
  );
  const server = createWorkflowWebServer(application, manager);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const initial = await fetch(`${base}/api/permission`).then((response) => response.json()) as {
    available: boolean;
    mode: string;
    pending: unknown;
  };
  assert.equal(initial.available, true);
  assert.equal(initial.mode, "auto");
  assert.equal(initial.pending, null);

  const hostile = await fetch(`${base}/api/permission`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ id: "x", decision: "allow_once" }),
  });
  assert.equal(hostile.status, 403);
  const nonJson = await fetch(`${base}/api/permission`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ id: "x", decision: "allow_once" }),
  });
  assert.equal(nonJson.status, 415);
  const invalidDecision = await fetch(`${base}/api/permission`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "x", decision: "maybe" }),
  });
  assert.equal(invalidDecision.status, 400);
  const stale = await fetch(`${base}/api/permission`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "does-not-exist", decision: "allow_once" }),
  });
  assert.equal(stale.status, 404);

  const modeHostile = await fetch(`${base}/api/permission-mode`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ mode: "ask" }),
  });
  assert.equal(modeHostile.status, 403);
  const modeInvalid = await fetch(`${base}/api/permission-mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "yolo" }),
  });
  assert.equal(modeInvalid.status, 400);
  const modeSet = await fetch(`${base}/api/permission-mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "ask" }),
  });
  assert.equal(modeSet.status, 200);
  assert.equal((await modeSet.json() as { mode: string }).mode, "ask");
  const modeReset = await fetch(`${base}/api/permission-mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reset: true }),
  });
  assert.equal(modeReset.status, 200);

  const caps = await fetch(`${base}/api/capabilities`).then((response) => response.json()) as {
    capabilities: string[];
    workspaceConfinement: boolean;
  };
  assert.deepEqual([...caps.capabilities].sort(), ["mutation", "read"]);
  assert.equal(caps.workspaceConfinement, true);

  const capsHostile = await fetch(`${base}/api/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ capability: "process", enabled: true }),
  });
  assert.equal(capsHostile.status, 403);
  const capsNotToggleable = await fetch(`${base}/api/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability: "read", enabled: false }),
  });
  assert.equal(capsNotToggleable.status, 400);
  const capsEnabled = await fetch(`${base}/api/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability: "process", enabled: true }),
  });
  assert.equal(capsEnabled.status, 200);
  const afterEnable = await fetch(`${base}/api/capabilities`).then((response) => response.json()) as {
    capabilities: string[];
  };
  assert.equal(afterEnable.capabilities.includes("process"), true);
  const capsDisable = await fetch(`${base}/api/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability: "process", enabled: false }),
  });
  assert.equal(capsDisable.status, 200);

  // Without workspace confinement, enabling process/network must fail closed.
  const unconfinedApplication = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const unconfinedServer = createWorkflowWebServer(unconfinedApplication, manager);
  await new Promise<void>((resolve) => unconfinedServer.listen(0, "127.0.0.1", resolve));
  context.after(() => unconfinedServer.close());
  const unconfinedPort = (unconfinedServer.address() as AddressInfo).port;
  const forbidden = await fetch(`http://127.0.0.1:${unconfinedPort}/api/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability: "network", enabled: true }),
  });
  assert.equal(forbidden.status, 409);
  const unconfinedView = await fetch(`http://127.0.0.1:${unconfinedPort}/api/capabilities`).then((response) => response.json()) as {
    workspaceConfinement: boolean;
  };
  assert.equal(unconfinedView.workspaceConfinement, false);
});

test("web UI guards session rename, task retry/add, and evidence recording", async (context) => {
  const dir = mkdtempSync(join(tmpdir(), "web-batch5-test-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async () => {
      const driver: CodingSessionDriver = {
        async start(_prompt, emit) { emit({ type: "completed", result: "done" }); },
        async cancel() {},
      };
      return {
        driver: {
          ...driver,
          agentSessionId: () => "agent-x",
          connect: async () => {},
          subscribe: () => () => {},
        } as never,
        session: new WorkflowCodingSession(driver),
        async dispose() {},
      };
    },
  });
  context.after(() => manager.dispose());
  const tasks: WorkflowTask[] = [
    { id: taskId("T1"), title: "Retriable", state: "IN_PROGRESS", dependencies: [], requiredEvidence: [] },
    { id: taskId("T2"), title: "Second", state: "BLOCKED", dependencies: [taskId("T1")], requiredEvidence: [] },
  ];
  const application = new WorkflowApplication(
    new TaskGraph(tasks),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  application.transition(taskId("T1"), "FAILED");
  const server = createWorkflowWebServer(application, manager);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  // Rename: guards first, then the happy path.
  const renameHostile = await fetch(`${base}/api/sessions/rename`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ id: "x", title: "y" }),
  });
  assert.equal(renameHostile.status, 403);
  const renameNonJson = await fetch(`${base}/api/sessions/rename`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ id: "x", title: "y" }),
  });
  assert.equal(renameNonJson.status, 415);
  await fetch(`${base}/api/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "seed a session" }),
  });
  const listed = await fetch(`${base}/api/sessions`).then((response) => response.json()) as { sessions: { id: string }[] };
  const sessionId = listed.sessions[0]!.id;
  const renamed = await fetch(`${base}/api/sessions/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: sessionId, title: "Renamed from test" }),
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json() as { title: string }).title, "Renamed from test");
  const renameUnknown = await fetch(`${base}/api/sessions/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "nope", title: "x" }),
  });
  assert.equal(renameUnknown.status, 404);
  const renameBlank = await fetch(`${base}/api/sessions/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: sessionId, title: "   " }),
  });
  assert.equal(renameBlank.status, 502);

  // Retry: guards, a real FAILED task round-trip, and a non-FAILED rejection.
  const retryHostile = await fetch(`${base}/api/tasks/retry`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ taskId: "T1" }),
  });
  assert.equal(retryHostile.status, 403);
  const retryInvalid = await fetch(`${base}/api/tasks/retry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "" }),
  });
  assert.equal(retryInvalid.status, 400);
  const retried = await fetch(`${base}/api/tasks/retry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "T1" }),
  });
  assert.equal(retried.status, 200);
  assert.equal((await retried.json() as { transition: { to: string } }).transition.to, "READY");
  const retryNotFailed = await fetch(`${base}/api/tasks/retry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "T1" }),
  });
  assert.equal(retryNotFailed.status, 409, "retrying a non-FAILED task is rejected, not silently accepted");

  // Add task: guards, happy path, and duplicate/snapshot visibility.
  const addHostile = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ taskId: "T3", title: "Added" }),
  });
  assert.equal(addHostile.status, 403);
  const addInvalid = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "T3", title: "" }),
  });
  assert.equal(addInvalid.status, 400);
  const added = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "T3", title: "Added from test", dependencies: ["T1"] }),
  });
  assert.equal(added.status, 201);
  const addedBody = await added.json() as { taskId: string; state: string };
  // A dependency-free task recomputes to READY immediately: the response must
  // echo the post-add graph state, never a hard-coded BLOCKED.
  const ready = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "T4", title: "Dependency-free" }),
  });
  assert.equal(ready.status, 201);
  assert.equal((await ready.json() as { state: string }).state, "READY");
  const snapshot = await fetch(`${base}/api/snapshot`).then((response) => response.json()) as {
    tasks: { id: string; state: string; title: string }[];
  };
  const newTask = snapshot.tasks.find((task) => task.id === "T3");
  assert.equal(newTask?.state, "BLOCKED");
  assert.equal(addedBody.state, "BLOCKED");
  assert.equal(newTask?.title, "Added from test");

  // Evidence: guards, validation, and recording visibility.
  const evidenceHostile = await fetch(`${base}/api/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ subject: "s", result: "passed" }),
  });
  assert.equal(evidenceHostile.status, 403);
  const evidenceInvalid = await fetch(`${base}/api/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: "s", result: "maybe" }),
  });
  assert.equal(evidenceInvalid.status, 400);
  const recorded = await fetch(`${base}/api/evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: "test-subject", result: "passed" }),
  });
  assert.equal(recorded.status, 201);
  const evidence = await fetch(`${base}/api/snapshot`).then((response) => response.json()) as {
    evidence: { subject: string; result: string; freshness: string }[];
  };
  const entry = evidence.evidence.find((item) => item.subject === "test-subject");
  assert.deepEqual(
    entry !== undefined && { result: entry.result, freshness: entry.freshness },
    { result: "passed", freshness: "fresh" },
  );
});
