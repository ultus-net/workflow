import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkflowCodingSession, type CodingSessionDriver, type CodingSessionEvent } from "../src/application/coding-session.js";
import { taskId } from "../src/kernel/contracts.js";
import type { WorkflowAcpRuntime } from "../src/integrations/acp-runtime.js";
import { PermissionBroker } from "../src/ui/permission-broker.js";
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
    factory: async (_agent, resumeFrom) => {
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
  assert.equal(spawned[0]?.disposed, false, "parallel sessions keep their runtimes alive");

  const sessions = manager.list();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.active, true);
  assert.equal(sessions[1]?.title, "inspect the repo");
  assert.equal(sessions[1]?.active, false);

  const back = await manager.activate(sessions[1]!.id);
  assert.equal(back.kind, "ok");
  assert.deepEqual(resumes, [undefined, undefined], "a still-live session re-focuses without respawning");

  await manager.dispose();
  assert.equal(spawned[1]?.disposed, true, "every live runtime is disposed with the manager");
});

test("session manager lists registry order first when updatedAt timestamps tie", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  // Freeze the clock so both records land on the same millisecond: the sort
  // must then fall back to the registry order (most-recent-first), never to
  // stale index order that would resurrect an older session at the top.
  const RealDate = Date;
  const fixedMs = RealDate.parse("2026-09-15T00:00:00.000Z");
  const FrozenDate = class extends RealDate {
    constructor(value?: number | string | Date) {
      super(value === undefined ? fixedMs : value);
    }
    static now(): number { return fixedMs; }
  };
  globalThis.Date = FrozenDate as unknown as typeof RealDate;
  try {
    const manager = new WebSessionManager({
      registryPath: join(dir, "registry.json"),
      factory: async () => fakeRuntime("agent-1").runtime,
    });
    const first = await manager.channel();
    first.submit("older titled turn", []);
    await settle(first);
    const created = await manager.create();
    assert.equal(created.kind, "ok");

    const sessions = manager.list();
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]?.updatedAt, sessions[1]?.updatedAt, "the test must actually create a timestamp tie");
    assert.equal(sessions[0]?.active, true, "the most recently created session leads on ties");
    assert.equal(sessions[1]?.title, "older titled turn");
    await manager.dispose();
  } finally {
    globalThis.Date = RealDate;
  }
});

test("parallel sessions run turns at the same time without interfering", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  // Two long-running drivers: each session's turn stays in flight until its
  // own release resolves.
  const gates = [0, 1].map(() => {
    let release: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release: release as () => void };
  });
  let spawnIndex = 0;
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async () => fakeRuntime(`agent-${++spawnIndex}`, async (_prompt, emit) => {
      const gate = gates[spawnIndex - 1];
      if (gate === undefined) throw new Error("test bug: unexpected spawn");
      await gate.promise;
      emit({ type: "completed", result: "done" });
    }).runtime,
  });

  const first = await manager.channel();
  first.submit("first long turn", []);
  const created = await manager.create();
  assert.equal(created.kind, "ok", "focusing a new session never waits for another session's turn");
  const second = await manager.channel();
  second.submit("second turn in parallel", []);

  // Both turns are in flight together; finishing one leaves the other running.
  gates[1]!.release();
  await settle(second);
  assert.equal(first.busy(), true, "the first session's turn keeps running in the background");
  gates[0]!.release();
  await settle(first);
  await manager.dispose();
});

test("concurrent creates each get their own live runtime without leaks", async (context) => {
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
  assert.equal(spawned.length, 3, "the boot runtime plus one per created record");
  assert.equal(spawned[0]?.disposed, false, "parallel sessions never dispose each other");
  assert.equal(spawned[1]?.disposed, false);
  assert.equal(spawned[2]?.disposed, false);
  assert.equal(manager.list().length, 3);
  assert.equal(manager.list().filter((session) => session.active).length, 1, "exactly one focused session");
  assert.equal(manager.list().every((session) => session.live), true, "every created session is live");
  await manager.dispose();
  assert.equal(spawned.filter((fake) => fake.disposed).length, spawned.length, "dispose() releases every runtime");
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
  const factory = async (_agent: string, resumeFrom: string | undefined) => {
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
  const resumes: (string | undefined)[] = [];
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async (_agent, resumeFrom) => {
      resumes.push(resumeFrom);
      return fakeRuntime("agent-1").runtime;
    },
  });

  await manager.channel();
  await manager.create();
  const [, previous] = manager.list();
  assert.equal((await manager.dismiss("missing")).kind, "unknown");
  assert.equal((await manager.dismiss(previous!.id)).kind, "ok");
  assert.equal(manager.list().length, 1);

  // With another record present, dismissing the focused one must move focus to
  // the existing next record — resumed by agent session id on the next
  // channel use, never a new record.
  const second = await manager.create();
  assert.equal(second.kind, "ok");
  const remaining = manager.list().find((session) => !session.active)!;
  assert.equal((await manager.dismiss(second.kind === "ok" ? second.meta.id : "")).kind, "ok");
  assert.equal(manager.list().length, 1);
  assert.equal(manager.list()[0]?.id, remaining.id);
  assert.equal(manager.list()[0]?.active, true, "focus falls to the next record");
  // Focus is metadata; the next record is still live from its create, so
  // focusing it needs no respawn.
  const resumesBeforeUse = resumes.length;
  await manager.channel();
  assert.equal(resumes.length, resumesBeforeUse, "a still-live session re-focuses without respawning");

  // With no records left, dismissing the active session creates a fresh one.
  assert.equal((await manager.dismiss(remaining.id)).kind, "ok");
  assert.equal(manager.list().length, 1);
  assert.equal(manager.list()[0]?.active, true);
  await manager.dispose();
});

test("session manager refuses to dismiss the active session while a turn is running", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  let finish: (() => void) | undefined;
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async () => fakeRuntime("agent-1", async (_prompt, emit) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      emit({ type: "completed", result: "done" });
    }).runtime,
  });

  const channel = await manager.channel();
  channel.submit("long turn", []);
  for (let i = 0; i < 200 && !channel.busy(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(channel.busy(), true, "turn should be in flight");
  const activeId = manager.list().find((session) => session.active)!.id;
  assert.equal((await manager.dismiss(activeId)).kind, "busy");
  assert.equal(manager.list().length, 1, "the running session stays registered");
  finish!();
  await settle(channel);
  assert.equal((await manager.dismiss(activeId)).kind, "ok", "dismiss succeeds once the turn completes");
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
  const removed = await manager.clearUnused();
  assert.equal(removed, 1, "only the untitled non-active record was removed");
  assert.equal(manager.list().length, before - 1);
  assert.deepEqual(manager.list().map((session) => session.title), ["New session", "real work"]);
  await manager.dispose();
});

test("session manager ingests replayed history when resuming a session", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  type Listener = (event: CodingSessionEvent) => void;
  const registryPath = join(dir, "registry.json");
  const factory = async (_agent: string, resumeFrom: string | undefined) => {
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
  };

  const first = new WebSessionManager({ registryPath, factory });
  const channel = await first.channel();
  channel.submit("first question", []);
  await settle(channel);
  await first.dispose();

  // Restart: the reused record resumes through its captured agent session id,
  // and session/load replays the history into the fresh channel.
  const second = new WebSessionManager({ registryPath, factory });
  const resumed = await second.channel();
  assert.deepEqual(resumed.items(), [
    { kind: "user", text: "first question" },
    { kind: "assistant", text: "first answer" },
  ]);
  await second.dispose();
});

test("session manager syncs agent-provided titles and serves runtime usage", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const metrics = { requests: 2, usageEvents: 1, promptTokens: 120, completionTokens: 45, totalTokens: 165, costUsd: 0.012, latestPromptTokens: 120 };
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async () => {
      const fake = fakeRuntime("agent-1");
      return { ...fake.runtime, usage: () => metrics };
    },
  });

  const channel = await manager.channel();
  assert.deepEqual(channel.usage(), metrics, "the channel exposes the runtime's metering metrics");
  channel.ingest({ type: "session-info", title: "Agent-titled work" });
  const created = await manager.create();
  assert.equal(created.kind, "ok");

  const titled = manager.list().find((session) => !session.active);
  assert.equal(titled?.title, "Agent-titled work", "session_info_update titles win over the derived title");
  const active = await manager.channel();
  assert.deepEqual(active.usage(), metrics, "the next runtime's metrics flow through its own channel");
  await manager.dispose();
});

test("session manager renames records without switching runtimes", async (context) => {
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
  assert.equal(spawned.length, 1);
  const created = await manager.create();
  assert.equal(created.kind, "ok");

  const record = manager.list().find((session) => !session.active)!;
  assert.equal(manager.rename("does-not-exist", "nope").kind, "unknown");
  assert.equal(manager.rename(record.id, "   ").kind, "failed", "blank titles are rejected");
  const renamed = manager.rename(record.id, "Operator-titled session");
  assert.equal(renamed.kind, "ok");
  assert.equal(manager.list().find((session) => session.id === record.id)?.title, "Operator-titled session");
  assert.equal(spawned.length, 2, "renaming must not spawn or dispose runtimes");
  const long = manager.rename(record.id, "x".repeat(120));
  assert.equal(long.kind, "ok");
  assert.ok(long.kind === "ok" && long.meta.title.length <= 61, "titles are capped with an ellipsis");

  // Renames persist across restarts.
  await manager.dispose();
  const reloaded = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async () => fakeRuntime("agent-1").runtime,
  });
  assert.equal(
    reloaded.list().find((session) => session.id === record.id)?.title.startsWith("x".repeat(60)),
    true,
    "the operator rename survives a restart",
  );
  await reloaded.dispose();
});

test("session manager wires the permission broker: cancel and switch deny parked prompts", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const broker = new PermissionBroker();
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    permissionBroker: broker,
    factory: async () => fakeRuntime("agent-1").runtime,
  });

  const channel = await manager.channel();
  assert.equal(channel.permissionAskingAvailable(), true);
  assert.equal(channel.permissionMode(), "auto");
  channel.setPermissionMode("ask");
  assert.equal(channel.permissionMode(), "ask");
  assert.deepEqual(channel.permissionPatterns(), { alwaysAllow: [], alwaysReject: [] });

  const action = {
    // Real ACP permission requests carry the driver's ACP session id.
    sessionId: "agent-1",
    taskId: taskId("HEADLINE-TASK"),
    tool: "run_commands",
    mutating: true,
    subjects: [],
    input: { command: "ls" },
  };
  const parked = broker.intercept(action, () => ({ kind: "allow" }));
  await new Promise((resolve) => setImmediate(resolve));
  const request = channel.pendingPermission();
  assert.ok(request !== undefined, "the channel surfaces the parked request");
  assert.equal(request.tool, "run_commands");
  assert.equal(channel.answerPermission("bogus", "allow_once"), false, "stale ids fail closed");
  assert.equal(channel.answerPermission(request.id, "allow_once"), true);
  assert.deepEqual(await parked, { kind: "allow" });
  assert.equal(channel.pendingPermission(), undefined);

  // Cancelling a turn denies any still-parked prompt instead of leaving it dangling.
  broker.setMode("ask");
  const parkedAgain = broker.intercept(action, () => ({ kind: "allow" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(channel.pendingPermission() !== undefined);
  await channel.cancel();
  const cancelled = await parkedAgain;
  assert.equal(cancelled.kind, "deny", "cancel resolves the parked prompt as a denial");

  // Focusing another session must NOT deny this session's parked prompt —
  // parallel sessions keep their turns and prompts alive.
  broker.setMode("ask");
  const parkedOnSwitch = broker.intercept(action, () => ({ kind: "allow" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(channel.pendingPermission() !== undefined);
  const created = await manager.create();
  assert.equal(created.kind, "ok");
  assert.equal(channel.pendingPermission() !== undefined, true, "the parked prompt survives a focus switch");
  assert.equal((await manager.channel()).permissionMode(), "ask", "broker state survives switches");
  await manager.dispose();
  // Shutdown denies everything parked: the agent processes are going away.
  assert.equal((await parkedOnSwitch).kind, "deny", "shutdown denies still-parked prompts");
});

test("parked permission prompts are scoped per parallel session", async () => {
  const broker = new PermissionBroker();
  broker.setMode("ask");
  const actionFor = (sessionId: string) => ({
    sessionId,
    taskId: taskId("HEADLINE-TASK"),
    tool: "run_commands",
    mutating: true,
    subjects: [],
    input: { command: `ls ${sessionId}` },
  });

  const parkedA = broker.intercept(actionFor("acp-a"), () => ({ kind: "allow" }));
  const parkedB = broker.intercept(actionFor("acp-b"), () => ({ kind: "allow" }));
  await new Promise((resolve) => setImmediate(resolve));

  const requestA = broker.pendingRequest("acp-a");
  const requestB = broker.pendingRequest("acp-b");
  assert.ok(requestA !== undefined && requestB !== undefined, "each session surfaces its own parked prompt");
  assert.notEqual(requestA!.id, requestB!.id, "the two sessions park independent prompts");

  // Answering A leaves B parked.
  assert.equal(broker.answer(requestA!.id, "allow_once"), true);
  await parkedA;
  assert.ok(broker.pendingRequest("acp-a") === undefined);
  assert.ok(broker.pendingRequest("acp-b") !== undefined, "B's parked prompt is untouched by A's answer");

  // Cancelling B's session denies only B's prompt.
  broker.cancelPending("session b disposed", "acp-b");
  const cancelledB = await parkedB;
  assert.equal(cancelledB.kind, "deny");
  assert.equal(broker.pendingRequest("acp-b"), undefined);
});

test("switching the active agent re-launches the session on the new agent", async (context) => {
  const dir = registryDir();
  context.after(() => rmSync(dir, { recursive: true, force: true }));

  const launches: { agent: string; resumeFrom: string | undefined }[] = [];
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    factory: async (agent, resumeFrom) => {
      launches.push({ agent, resumeFrom });
      return fakeRuntime(`${agent}-session`).runtime;
    },
  });

  // First launch targets the default agent (OpenCode, the documented lead).
  const first = await manager.channel();
  first.submit("inspect the repo", []);
  await settle(first);
  assert.deepEqual(launches.map((launch) => launch.agent), ["opencode"]);
  assert.equal(manager.list().find((session) => session.active)?.agent, "opencode");

  // Switching agents re-launches the active session on the new agent and the
  // session record reflects it.
  await manager.setActiveAgent("cline");
  assert.deepEqual(launches.map((launch) => launch.agent), ["opencode", "cline"]);
  assert.equal(manager.list().find((session) => session.active)?.agent, "cline");

  // The switched session still works end to end.
  const channel = await manager.channel();
  channel.submit("follow up", []);
  await settle(channel);
  await manager.dispose();
});
