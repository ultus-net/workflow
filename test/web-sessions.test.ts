import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkflowCodingSession, type CodingSessionDriver, type CodingSessionEvent } from "../src/application/coding-session.js";
import type { WorkflowAcpRuntime } from "../src/integrations/acp-runtime.js";
import { WebSessionManager } from "../src/ui/web-sessions.js";

interface FakeRuntime {
  readonly runtime: WorkflowAcpRuntime;
  disposed: boolean;
  readonly agentId: string;
}

function fakeRuntime(agentId: string, start: CodingSessionDriver["start"] = async (_prompt, emit) => {
  emit({ type: "assistant", text: "done" });
  emit({ type: "completed", result: "done" });
}): FakeRuntime {
  const driver = {
    start,
    cancel: async () => {},
    agentSessionId: () => agentId,
    connect: async () => {},
    subscribe: () => () => {},
  };
  const fake: FakeRuntime = {
    agentId,
    disposed: false,
    runtime: {
      driver: driver as unknown as WorkflowAcpRuntime["driver"],
      session: new WorkflowCodingSession(driver),
      async dispose() { fake.disposed = true; },
    },
  };
  return fake;
}

function registryDir(): string {
  return mkdtempSync(join(tmpdir(), "web-sessions-test-"));
}

/** Waits until the channel's turn flag clears (the completed event fires before the settle finally). */
async function settle(channel: { busy(): boolean }): Promise<void> {
  for (let i = 0; i < 200 && channel.busy(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(channel.busy(), false, "turn did not settle in time");
}

test("session manager creates, lists, and activates sessions with resume ids", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const spawned: FakeRuntime[] = [];
  const resumes: (string | undefined)[] = [];
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async (resumeFrom) => {
      resumes.push(resumeFrom);
      const fake = fakeRuntime(`agent-${spawned.length + 1}`);
      spawned.push(fake);
      return fake.runtime;
    },
  });

  const first = await manager.channel();
  assert.equal(spawned.length, 1);
  first.submit("inspect the repo", []);
  await settle(first);

  const created = await manager.create();
  assert.equal(created.kind, "ok");
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0]?.disposed, true, "switching disposes the previous runtime");

  const sessions = manager.list();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.active, true);
  assert.equal(sessions[1]?.title, "inspect the repo");
  assert.equal(sessions[1]?.active, false);

  const back = await manager.activate(sessions[1]!.id);
  assert.equal(back.kind, "ok");
  assert.deepEqual(resumes, [undefined, undefined, "agent-1"], "history resumes via the captured agent session id");

  await manager.dispose();
  assert.equal(spawned[2]?.disposed, true);
});

test("session manager refuses to switch while a turn is running", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async () => fakeRuntime("agent-1", async () => pending).runtime,
  });

  const channel = await manager.channel();
  channel.submit("long work", []);
  assert.equal((await manager.create()).kind, "busy");
  release();
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await manager.create()).kind, "ok");
  await manager.dispose();
});

test("session manager serializes concurrent switches without leaking runtimes", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const spawned: FakeRuntime[] = [];
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async () => {
      const fake = fakeRuntime(`agent-${spawned.length + 1}`);
      spawned.push(fake);
      return fake.runtime;
    },
  });

  await manager.channel();
  const [first, second] = await Promise.all([manager.create(), manager.create()]);
  assert.equal(first.kind, "ok");
  assert.equal(second.kind, "ok");
  assert.equal(spawned.length, 3, "initial runtime plus one per switch");
  assert.equal(spawned[0]?.disposed, true, "the initial runtime is disposed by the first switch");
  assert.equal(spawned[1]?.disposed, true, "the outgoing runtime is always disposed");
  assert.equal(spawned[2]?.disposed, false);
  assert.equal(manager.list().length, 3);
  await manager.dispose();
});

test("session manager surfaces factory failure without a stuck active session", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async () => { throw new Error("agent cannot launch"); },
  });

  await assert.rejects(manager.channel(), /agent cannot launch/);
  assert.equal((await manager.create()).kind, "failed");
  await manager.dispose();
});

test("session manager resumes the most recent session on restart instead of accumulating empties", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const registryPath = join(dir, "registry.json");
  const resumes: (string | undefined)[] = [];
  const factory = async (resumeFrom: string | undefined) => {
    resumes.push(resumeFrom);
    return fakeRuntime("agent-1").runtime;
  };

  const first = new WebSessionManager({ registryPath, factory });
  await first.channel();
  await first.dispose();
  assert.equal(first.list().length, 1);

  const second = new WebSessionManager({ registryPath, factory });
  await second.channel();
  assert.equal(second.list().length, 1, "restart reuses the existing session instead of creating a new record");
  assert.deepEqual(resumes, [undefined, "agent-1"], "the reused session resumes through its captured agent id");
  await second.dispose();
});

test("session manager persists the registry and activates unknown ids fail safely", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const registryPath = join(dir, "registry.json");
  const manager = new WebSessionManager({
    registryPath,
    factory: async () => fakeRuntime("agent-1").runtime,
  });
  await manager.channel();
  await manager.create();
  await manager.dispose();

  const persisted = JSON.parse(readFileSync(registryPath, "utf8")) as { sessions: { id: string }[] };
  assert.equal(persisted.sessions.length, 2);

  const reloaded = new WebSessionManager({ registryPath, factory: async () => fakeRuntime("agent-2").runtime });
  assert.equal(reloaded.list().length, 2);
  assert.equal((await reloaded.activate("does-not-exist")).kind, "unknown");
  await reloaded.dispose();
});

test("session manager dismisses sessions and keeps the next one active", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async () => fakeRuntime("agent-1").runtime,
  });

  await manager.channel();
  await manager.create();
  const [fresh, previous] = manager.list();
  assert.equal((await manager.dismiss("missing")).kind, "unknown");
  assert.equal((await manager.dismiss(previous!.id)).kind, "ok");
  assert.equal(manager.list().length, 1);

  // Dismissing the active session moves to the next one (or creates fresh).
  assert.equal((await manager.dismiss(fresh!.id)).kind, "ok");
  assert.equal(manager.list().length, 1);
  assert.equal(manager.list()[0]?.active, true);
  await manager.dispose();
});

test("session manager clears only unused (untitled) non-active records", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const manager = new WebSessionManager({ registryPath: join(dir, "registry.json"), factory: async () => fakeRuntime("agent-1").runtime });

  const channel = await manager.channel();
  channel.submit("real work", []);
  await settle(channel);
  await manager.create();
  await manager.create();
  // Now: one untitled active, one titled non-active, one untitled non-active.
  assert.equal(manager.list().some((session) => !session.active && session.title === "real work"), true);

  const before = manager.list().length;
  const removed = manager.clearUnused();
  assert.equal(removed, 1, "only the untitled non-active record was removed");
  assert.equal(manager.list().length, before - 1);
  assert.deepEqual(manager.list().map((session) => session.title), ["New session", "real work"]);
  await manager.dispose();
});

test("session manager ingests replayed history when resuming a session", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  type Listener = (event: CodingSessionEvent) => void;
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async (resumeFrom) => {
      const listeners = new Set<Listener>();
      const driver: CodingSessionDriver & { agentSessionId(): string; connect(): Promise<void>; subscribe(listener: Listener): () => void } = {
        async start(_prompt, emit) {
          emit({ type: "completed", result: "done" });
        },
        async cancel() {},
        agentSessionId: () => "agent-1",
        connect: async () => {
          if (resumeFrom === undefined) return;
          for (const listener of listeners) {
            listener({ type: "user", text: "first question" });
            listener({ type: "assistant", text: "first answer" });
          }
        },
        subscribe: (listener: Listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      return {
        driver: driver as never,
        session: new WorkflowCodingSession(driver),
        async dispose() {},
      };
    },
  });

  const channel = await manager.channel();
  channel.submit("first question", []);
  await settle(channel);
  const created = await manager.create();
  assert.equal(created.kind, "ok");
  const first = manager.list().find((session) => !session.active);
  const resumed = await manager.activate(first!.id);
  assert.equal(resumed.kind, "ok");

  const items = (await manager.channel()).items();
  assert.deepEqual(items, [
    { kind: "user", text: "first question" },
    { kind: "assistant", text: "first answer" },
  ]);
  await manager.dispose();
});
