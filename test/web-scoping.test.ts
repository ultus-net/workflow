import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import type { TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TaskGraph,
  WorkflowApplication,
  WorkflowCodingSession,
  createWorkflowWebServer,
  hostCapabilities,
  taskId,
} from "../src/index.js";
import type { CodingSessionDriver } from "../src/application/coding-session.js";
import type { WorkflowAcpRuntime } from "../src/integrations/acp-runtime.js";
import type { PolicyDecision } from "../src/kernel/contracts.js";
import { PermissionBroker } from "../src/ui/permission-broker.js";
import { WebSessionManager } from "../src/ui/web-sessions.js";

// Multi-session isolation on the web control-plane surface (W140, the
// second report-only wave of the operator's e2e-coverage direction): TWO
// parallel fake-runtime sessions behind one createWorkflowWebServer, and
// every pin below observes a request scoped with ?session= against the
// OTHER session.
//
// FINDING (recorded 2026-09-25, not fixed — the wave's report-only mandate):
// the permission poll is session-scoped but the ANSWER path is not —
// PermissionBroker.answer matches the parked id alone (permission-broker.ts:
// 83-106) and the answer route never checks ownership, so POST
// /api/permission?session=<B> with A's parked id returns 200, resolves A's
// park (OPERATOR_REJECTED), and A's poll afterwards shows pending: null.
// Pinned as-found in the FINDING test below; the fix shape is a
// session-scoped refusal in the answer route (which would flip that pin
// deliberately). Mitigating posture: the same-origin trusted-mutation guard
// still applies and the UI never surfaces another session's id.
//
// Manager under test: src/ui/web-sessions.ts — per-session live runtimes
// (#live map, web-sessions.ts:88), cancel scoping at the three dispose sites
// (relaunch web-sessions.ts:515, live-cap eviction web-sessions.ts:538,
// dismiss/dispose web-sessions.ts:628), and the focus rule "focusing never
// disposes another" (web-sessions.ts:78-80, activate at web-sessions.ts:300).
// Channel: src/ui/web-session-channel.ts — per-driver permission key
// (web-session-channel.ts:137 + driverPermissionKey:117-120), turn serialization
// (submit busy:334, cancel's keyed park denial:351-357).
// Broker: src/ui/permission-broker.ts — parking keyed per action session
// (intercept:157-182), PROMPT_BUSY (:160), cancelPending's sessionKey filter
// (:110-125).
//
// The unknown-id 404 shape is pinned at unit level against ONE session in
// test/web.test.ts:688 ("session-scoped routes accept ?session=<id>"); here it
// is pinned AGAINST TWO REAL SESSIONS — B exists and live while A's id is a
// near-miss lookalike.
//
// SAFETY CONTRACT (LESS-0051, non-negotiable): in-process only — no agent or
// PTY spawns, fake drivers only (the test/web.test.ts harness pattern), an
// ephemeral mkdtemp registry path, port 0 loopback, t.after cleanup for every
// server, manager, and temp dir. No dist build; the compiled seat is W128's
// lane.

interface Gate {
  readonly promise: Promise<void>;
  release(): void;
}

interface FakeRuntime {
  readonly runtime: WorkflowAcpRuntime;
  readonly agentId: string;
  disposed: boolean;
  readonly gate?: Gate;
}

interface SessionItem {
  readonly kind: string;
  readonly text?: string;
  readonly outcome?: string;
}

interface SessionView {
  readonly available: boolean;
  readonly id?: string;
  readonly title?: string;
  readonly state: { readonly state: string };
  readonly items: readonly SessionItem[];
  readonly commands?: readonly unknown[];
}

interface PermissionView {
  readonly available: boolean;
  readonly mode: string;
  readonly pending: { readonly id: string; readonly tool: string } | null;
  readonly patterns: { readonly alwaysAllow: readonly string[]; readonly alwaysReject: readonly string[] };
}

interface SessionMeta {
  readonly id: string;
  readonly title: string;
  readonly active: boolean;
  readonly agent: string;
  readonly live: boolean;
  readonly busy: boolean;
}

function openGate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** The test/web.test.ts harness pattern, factored for two parallel sessions:
 * an mkdtemp registry, a fake runtime factory (distinct agent session id and
 * per-session transcript marker per spawn, optional held-open turn gates), an
 * optional ask-mode broker, and a loopback ephemeral server. */
async function harness(
  t: TestContext,
  options: { readonly askMode?: boolean; readonly holdSpawns?: ReadonlySet<number> } = {},
): Promise<{ readonly base: string; readonly broker: PermissionBroker; readonly spawned: readonly FakeRuntime[] }> {
  const dir = mkdtempSync(join(tmpdir(), "web-scoping-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const broker = new PermissionBroker();
  if (options.askMode === true) broker.setMode("ask");
  const spawned: FakeRuntime[] = [];
  const manager = new WebSessionManager({
    registryPath: join(dir, "registry.json"),
    permissionBroker: broker,
    factory: async () => {
      const index = spawned.length + 1;
      const agentId = `agent-${index}`;
      const gate: Gate | undefined = options.holdSpawns?.has(index) === true ? openGate() : undefined;
      const driver: CodingSessionDriver = {
        async start(_prompt, emit) {
          if (gate !== undefined) await gate.promise;
          emit({ type: "assistant", text: `${agentId} transcript marker` });
          emit({ type: "completed", result: "done" });
        },
        async cancel() {},
      };
      let config: { configOptions: { id: string; name: string; category: string; type: string; currentValue: string; options: { value: string }[] }[] } = {
        configOptions: [
          { id: "model", name: "Model", category: "model", type: "select", currentValue: agentId, options: [{ value: "a" }, { value: "b" }] },
        ],
      };
      const fake: FakeRuntime = {
        agentId,
        disposed: false,
        ...(gate === undefined ? {} : { gate }),
        runtime: {
          driver: {
            ...driver,
            agentSessionId: () => agentId,
            connect: async () => {},
            subscribe: () => () => {},
            config: () => config,
            setConfigOption: async (id: string, value: string | boolean) => {
              config = {
                configOptions: config.configOptions.map((option) =>
                  option.id === id ? { ...option, currentValue: String(value) } : option,
                ),
              };
              return config;
            },
          } as unknown as WorkflowAcpRuntime["driver"],
          session: new WorkflowCodingSession(driver),
          budgetMechanism: "test: no local caps (fake runtime)",
          async dispose() {
            fake.disposed = true;
          },
        },
      };
      spawned.push(fake);
      return fake.runtime;
    },
  });
  t.after(() => manager.dispose());
  const application = new WorkflowApplication(
    new TaskGraph([]),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
  );
  const server = createWorkflowWebServer(application, manager);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, broker, spawned };
}

async function createSession(base: string): Promise<string> {
  const response = await fetch(`${base}/api/sessions`, { method: "POST" });
  assert.equal(response.status, 201);
  const meta = (await response.json()) as SessionMeta;
  return meta.id;
}

async function postJson(base: string, path: string, body: unknown, suffix = ""): Promise<Response> {
  return await fetch(`${base}${path}${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postPrompt(base: string, id: string, prompt: string): Promise<Response> {
  return await postJson(base, "/api/prompt", { prompt }, `?session=${encodeURIComponent(id)}`);
}

async function sessionView(base: string, id?: string): Promise<SessionView> {
  const suffix = id === undefined ? "" : `?session=${encodeURIComponent(id)}`;
  const response = await fetch(`${base}/api/session${suffix}`);
  assert.equal(response.status, 200);
  return (await response.json()) as SessionView;
}

async function texts(base: string, id: string): Promise<readonly string[]> {
  return (await sessionView(base, id)).items.map((item) => item.text ?? "");
}

async function permissionView(base: string, id: string): Promise<PermissionView> {
  const response = await fetch(`${base}/api/permission?session=${encodeURIComponent(id)}`);
  assert.equal(response.status, 200);
  return (await response.json()) as PermissionView;
}

/** Parks one permission prompt the way the runtime's resolver would: the
 * broker intercepts in ask mode with the action's sessionId carrying the
 * driver's permission key (driverPermissionKey — the channel's lookup key). */
function park(broker: PermissionBroker, sessionKey: string): Promise<PolicyDecision> {
  const decision = broker.intercept(
    {
      sessionId: sessionKey,
      taskId: taskId("SCOPING"),
      tool: "run_commands",
      mutating: true,
      subjects: [],
      input: { command: `ls ${sessionKey}` },
    },
    () => ({ kind: "allow" }),
  );
  return Promise.resolve(decision);
}

async function pollUntil(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out: ${label}`);
}

async function waitState(base: string, id: string, state: string): Promise<void> {
  await pollUntil(async () => (await sessionView(base, id)).state.state === state, `session ${id} to reach ${state}`);
}

// ── 1. ?session= routing: transcript isolation ─────────────────────────────

test("?session= routing keeps two live sessions' transcripts disjoint", async (t) => {
  const h = await harness(t);
  const a = await createSession(h.base);
  const b = await createSession(h.base);

  // Two creates: the second is focused, so the UNSCOPED route answers B.
  assert.equal((await sessionView(h.base)).id, b, "without ?session= the focused session answers");

  await postPrompt(h.base, a, "alpha-prompt-A-one");
  await waitState(h.base, a, "completed");

  const viewA = await sessionView(h.base, a);
  assert.equal(viewA.id, a, "the scoped meta answers for the requested session");
  assert.deepEqual(viewA.items, [
    { kind: "user", text: "alpha-prompt-A-one" },
    { kind: "assistant", text: "agent-1 transcript marker" },
    { kind: "completion", outcome: "completed", text: "done" },
  ], "A's transcript carries exactly A's turn");

  const viewB = await sessionView(h.base, b);
  assert.deepEqual(viewB.items, [], "A's turn never appears in B's transcript");
  assert.equal(viewB.state.state, "idle", "B's channel never left idle while A ran");

  await postPrompt(h.base, b, "beta-prompt-B-one");
  await waitState(h.base, b, "completed");

  const afterB = await texts(h.base, b);
  assert.deepEqual(afterB, ["beta-prompt-B-one", "agent-2 transcript marker", "done"], "B's transcript carries only B's turn");
  const afterA = await texts(h.base, a);
  assert.equal(afterA.some((text) => text.includes("beta-prompt")), false, "B's prompt never appears in A's transcript");
  assert.equal(afterA.some((text) => text.includes("agent-2")), false, "B's driver output never appears in A's transcript");
  assert.equal((await sessionView(h.base, a)).items.length, 3, "A's transcript is unchanged by B's turn");
});

// Config options are per-session driver state (setConfigOption mutates the
// live runtime's session config) — a scoped request must never cross sessions.

test("config options read and mutate only their own session's driver state", async (t) => {
  const h = await harness(t);
  const a = await createSession(h.base);
  const b = await createSession(h.base);

  const optionsFor = async (id: string): Promise<string | undefined> => {
    const response = await fetch(`${h.base}/api/config-options?session=${encodeURIComponent(id)}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { options: { id: string; currentValue: string }[] };
    return body.options.find((option) => option.id === "model")?.currentValue;
  };

  assert.equal(await optionsFor(a), "agent-1", "A's poll reads A's driver config");
  assert.equal(await optionsFor(b), "agent-2", "B's poll reads B's driver config");

  const set = await postJson(h.base, "/api/config-options", { id: "model", value: "changed-on-A" }, `?session=${encodeURIComponent(a)}`);
  assert.equal(set.status, 200);
  assert.equal(await optionsFor(a), "changed-on-A");
  assert.equal(await optionsFor(b), "agent-2", "A's config mutation never reaches B's driver");
});

// The unknown-id 404 (unit-pinned in test/web.test.ts:688 against one
// session) against TWO REAL SESSIONS: B exists and is live, and the requested
// id is a near-miss lookalike of A. The 404 must come from the id not matching
// ANY session — never a silent answer as another session.

test("unknown-id 404 holds while another real session exists", async (t) => {
  const h = await harness(t);
  const a = await createSession(h.base);
  const b = await createSession(h.base);
  // Session ids end in hex; 'x' is never a real id's last char, so the
  // lookalike differs from both records by construction.
  const lookalike = `${a.slice(0, -1)}x`;
  assert.notEqual(lookalike, a);
  assert.notEqual(lookalike, b);

  const scoped404: readonly (readonly [string, () => Promise<Response>])[] = [
    ["GET /api/session", () => fetch(`${h.base}/api/session?session=${encodeURIComponent(lookalike)}`)],
    ["GET /api/config-options", () => fetch(`${h.base}/api/config-options?session=${encodeURIComponent(lookalike)}`)],
    ["GET /api/permission", () => fetch(`${h.base}/api/permission?session=${encodeURIComponent(lookalike)}`)],
    ["GET /api/image/x", () => fetch(`${h.base}/api/image/x?session=${encodeURIComponent(lookalike)}`)],
    ["POST /api/prompt", () => postJson(h.base, "/api/prompt", { prompt: "leak?" }, `?session=${encodeURIComponent(lookalike)}`)],
    ["POST /api/cancel", () => fetch(`${h.base}/api/cancel?session=${encodeURIComponent(lookalike)}`, { method: "POST" })],
  ];
  for (const [label, request] of scoped404) {
    const response = await request();
    assert.equal(response.status, 404, `${label}?session=<lookalike> must 404`);
    assert.deepEqual(await response.json(), { error: "unknown session" }, `${label} 404 shape`);
  }

  const control = await fetch(`${h.base}/api/session?session=${encodeURIComponent(b)}`);
  assert.equal(control.status, 200, "B's real id still answers while the lookalike 404s");
  assert.equal(((await control.json()) as SessionView).id, b);
});

// ── 2. Permission scoping ───────────────────────────────────────────────────

test("a park in A shows only on A's poll; B's poll is null while B is idle", async (t) => {
  const h = await harness(t, { askMode: true });
  const a = await createSession(h.base);
  const b = await createSession(h.base);
  const keyA = h.spawned[0]!.agentId;

  const parkedA = park(h.broker, keyA);
  await tick();
  const viewA = await permissionView(h.base, a);
  assert.equal(viewA.available, true);
  assert.equal(viewA.mode, "ask");
  assert.ok(viewA.pending !== null, "A's park shows on A's scoped poll");
  assert.equal(viewA.pending.tool, "run_commands");
  assert.equal(viewA.pending.id, h.broker.pendingRequest(keyA)!.id, "the poll surfaces the broker's parked request");

  const viewB = await permissionView(h.base, b);
  assert.equal(viewB.available, true, "B still reports asking available");
  assert.equal(viewB.mode, "ask");
  assert.equal(viewB.pending, null, "B's scoped poll shows no pending while only A parks");

  // The parked request is live: A's own route answers it.
  const pendingA = viewA.pending!;
  const answered = await postJson(h.base, "/api/permission", { id: pendingA.id, decision: "allow_once" }, `?session=${encodeURIComponent(a)}`);
  assert.equal(answered.status, 200);
  assert.deepEqual(await parkedA, { kind: "allow" });
});

// FINDING (recorded, not fixed): the permission ANSWER route is not
// session-scoped. GET /api/permission filters the parked set by the session's
// permission key (web-session-channel.ts:285-287 -> permission-broker.ts:77-80),
// but POST /api/permission resolves by parked id alone (active.answerPermission
// -> permission-broker.ts:83-106 — no sessionKey filter), so a request scoped
// to B with A's parked id consumes A's prompt. The observed shape below is
// pinned as-found; a session-scoped refusal is the fix shape and would flip
// this pin deliberately.

test("FINDING: answering through B's route consumes A's parked prompt (answer path is not session-scoped)", async (t) => {
  const h = await harness(t, { askMode: true });
  const a = await createSession(h.base);
  const b = await createSession(h.base);
  const keyA = h.spawned[0]!.agentId;

  const parkedA = park(h.broker, keyA);
  await tick();
  const pendingA = (await permissionView(h.base, a)).pending;
  assert.ok(pendingA !== null);

  // The exact reproducing request: B's route, A's parked id.
  const cross = await postJson(h.base, "/api/permission", { id: pendingA.id, decision: "reject_once" }, `?session=${encodeURIComponent(b)}`);
  assert.equal(cross.status, 200, "OBSERVED: the answer route resolves another session's parked prompt");
  assert.deepEqual(await parkedA, { kind: "deny", code: "OPERATOR_REJECTED", reason: "rejected by operator" },
    "A's parked promise was resolved by the request scoped to B");
  assert.equal((await permissionView(h.base, b)).pending, null);
  assert.equal((await permissionView(h.base, a)).pending, null, "A's park is gone — consumed cross-session");

  // Positive control: the same answer through A's OWN route resolves normally.
  const parkedA2 = park(h.broker, keyA);
  await tick();
  const pendingA2 = (await permissionView(h.base, a)).pending;
  assert.ok(pendingA2 !== null);
  const own = await postJson(h.base, "/api/permission", { id: pendingA2.id, decision: "allow_once" }, `?session=${encodeURIComponent(a)}`);
  assert.equal(own.status, 200);
  assert.deepEqual(await parkedA2, { kind: "allow" });
  assert.equal((await permissionView(h.base, a)).pending, null);
});

test("cancelling A's turn resolves only A's parked prompt; B's park is untouched", async (t) => {
  const h = await harness(t, { askMode: true, holdSpawns: new Set([1]) });
  const a = await createSession(h.base);
  const b = await createSession(h.base);
  const keyA = h.spawned[0]!.agentId;
  const keyB = h.spawned[1]!.agentId;

  const submitted = await postPrompt(h.base, a, "long turn on A");
  assert.equal(submitted.status, 202);
  await waitState(h.base, a, "running");

  const parkedA = park(h.broker, keyA);
  const parkedB = park(h.broker, keyB);
  await tick();
  assert.ok((await permissionView(h.base, a)).pending !== null);
  assert.ok((await permissionView(h.base, b)).pending !== null, "B parks independently while A's turn runs");

  const cancel = await fetch(`${h.base}/api/cancel?session=${encodeURIComponent(a)}`, { method: "POST" });
  assert.equal(cancel.status, 200);
  assert.deepEqual(await parkedA, { kind: "deny", code: "PROMPT_CANCELLED", reason: "turn cancelled by operator" },
    "A's cancel resolves A's parked prompt (channel cancel -> keyed cancelPending, web-session-channel.ts:345-351)");

  const stillB = (await permissionView(h.base, b)).pending;
  assert.ok(stillB !== null, "B's parked prompt survives A's cancel");
  const answerB = await postJson(h.base, "/api/permission", { id: stillB.id, decision: "reject_once" }, `?session=${encodeURIComponent(b)}`);
  assert.equal(answerB.status, 200, "B's park is still answerable from B's route");
  assert.deepEqual(await parkedB, { kind: "deny", code: "OPERATOR_REJECTED", reason: "rejected by operator" });

  await waitState(h.base, a, "cancelled");
  h.spawned[0]!.gate?.release();
});

test("PROMPT_BUSY is per session: A's second park denies; B's first park is accepted", async (t) => {
  const h = await harness(t, { askMode: true });
  const a = await createSession(h.base);
  const b = await createSession(h.base);
  const keyA = h.spawned[0]!.agentId;
  const keyB = h.spawned[1]!.agentId;

  const parkedA1 = park(h.broker, keyA);
  await tick();
  assert.ok((await permissionView(h.base, a)).pending !== null);

  const busy = await park(h.broker, keyA);
  assert.deepEqual(await busy, { kind: "deny", code: "PROMPT_BUSY", reason: "a permission prompt from this session is already waiting for the operator" },
    "a concurrent second park from the SAME session fails closed (permission-broker.ts:157-163)");

  const parkedB = park(h.broker, keyB);
  await tick();
  const pendingB = (await permissionView(h.base, b)).pending;
  assert.ok(pendingB !== null, "B's park is accepted while A's waits — the busy contract is per session, never global");
  assert.notEqual((await permissionView(h.base, a)).pending!.id, pendingB.id);

  // A's busy clears once its prompt is answered; a third A park lands.
  const pendingA = (await permissionView(h.base, a)).pending!;
  const answer = await postJson(h.base, "/api/permission", { id: pendingA.id, decision: "allow_once" }, `?session=${encodeURIComponent(a)}`);
  assert.equal(answer.status, 200);
  assert.deepEqual(await parkedA1, { kind: "allow" });
  const parkedA3 = park(h.broker, keyA);
  await tick();
  assert.ok((await permissionView(h.base, a)).pending !== null, "A parks again after its prompt was answered");

  // Cleanup within the test: resolve both leftovers through their own routes.
  const cleanupA = (await permissionView(h.base, a)).pending!;
  assert.equal((await postJson(h.base, "/api/permission", { id: cleanupA.id, decision: "reject_once" }, `?session=${encodeURIComponent(a)}`)).status, 200);
  assert.deepEqual(await parkedA3, { kind: "deny", code: "OPERATOR_REJECTED", reason: "rejected by operator" });
  const cleanupB = (await permissionView(h.base, b)).pending!;
  assert.equal(cleanupB.id, pendingB.id, "B's park was never disturbed by A's cycle");
  assert.equal((await postJson(h.base, "/api/permission", { id: cleanupB.id, decision: "reject_once" }, `?session=${encodeURIComponent(b)}`)).status, 200);
  assert.deepEqual(await parkedB, { kind: "deny", code: "OPERATOR_REJECTED", reason: "rejected by operator" });
});

// ── 3. Session lifecycle isolation ──────────────────────────────────────────

test("rename is scoped to its target id; the guard set holds per session", async (t) => {
  const h = await harness(t);
  const a = await createSession(h.base);
  const b = await createSession(h.base);
  const titles = async (): Promise<Map<string, string>> => {
    const response = await fetch(`${h.base}/api/sessions`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { sessions: SessionMeta[] };
    return new Map(body.sessions.map((meta) => [meta.id, meta.title]));
  };

  const renameA = await postJson(h.base, "/api/sessions/rename", { id: a, title: "Renamed A" });
  assert.equal(renameA.status, 200);
  assert.equal((await titles()).get(a), "Renamed A");
  assert.equal((await titles()).get(b), "New session", "A's rename never touches B");

  const renameB = await postJson(h.base, "/api/sessions/rename", { id: b, title: "Renamed B" });
  assert.equal(renameB.status, 200);
  assert.equal((await titles()).get(a), "Renamed A", "B's rename never touches A");
  assert.equal((await titles()).get(b), "Renamed B");

  const hostile = await fetch(`${h.base}/api/sessions/rename`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ id: a, title: "hostile" }),
  });
  assert.equal(hostile.status, 403, "the cross-origin guard holds per session");
  const nonJson = await fetch(`${h.base}/api/sessions/rename`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ id: a, title: "nonjson" }),
  });
  assert.equal(nonJson.status, 415);
  const unknownId = await postJson(h.base, "/api/sessions/rename", { id: "web-does-not-exist", title: "x" });
  assert.equal(unknownId.status, 404);
  assert.deepEqual(await unknownId.json(), { error: "unknown session" });
  const blank = await postJson(h.base, "/api/sessions/rename", { id: a, title: "   " });
  assert.equal(blank.status, 502);
  assert.deepEqual(await blank.json(), { error: "title must not be empty" }, "the empty-title refusal surfaces verbatim");
  assert.equal((await titles()).get(a), "Renamed A", "a failed rename leaves the target untouched");
  assert.equal((await titles()).get(b), "Renamed B");
});

test("retry and add are application-scoped: the guard set holds and ?session= is inert", async (t) => {
  const h = await harness(t);
  const a = await createSession(h.base);
  const b = await createSession(h.base);

  // POST /api/tasks is application-scoped (no ?session handling); the suffix
  // is inert — observed scope boundary, not a finding.
  const added = await postJson(h.base, "/api/tasks", { taskId: "scoping-task", title: "Scoping task" }, `?session=${encodeURIComponent(a)}`);
  assert.equal(added.status, 201);
  assert.deepEqual(await added.json(), { taskId: "scoping-task", state: "READY" });

  const retry = await postJson(h.base, "/api/tasks/retry", { taskId: "scoping-task" });
  assert.equal(retry.status, 409, "retry refuses a task that is not FAILED");
  const refused = (await retry.json()) as { kind: string; from?: string };
  assert.equal(refused.kind, "rejected");
  assert.equal(refused.from, "READY");

  const hostile = await fetch(`${h.base}/api/tasks/retry`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ taskId: "scoping-task" }),
  });
  assert.equal(hostile.status, 403);
  const nonJson = await fetch(`${h.base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ taskId: "x", title: "y" }),
  });
  assert.equal(nonJson.status, 415);
  const missing = await postJson(h.base, "/api/tasks", { taskId: "only-id" });
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "taskId and title are required" });

  // Neither route ever touched a session: both channels are still idle.
  assert.equal((await sessionView(h.base, a)).state.state, "idle");
  assert.equal((await sessionView(h.base, b)).state.state, "idle");
});

test("focusing B disposes nothing in A and leaves A's parked prompt live", async (t) => {
  const h = await harness(t, { askMode: true });
  const a = await createSession(h.base);
  const b = await createSession(h.base);
  const backToA = await postJson(h.base, "/api/sessions/activate", { id: a });
  assert.equal(backToA.status, 200);
  assert.equal(((await backToA.json()) as SessionMeta).active, true);
  assert.equal(h.spawned.length, 2, "re-focusing a live session never respawns (web-sessions.ts:304)");

  const keyA = h.spawned[0]!.agentId;
  const parkedA = park(h.broker, keyA);
  await tick();
  assert.ok((await permissionView(h.base, a)).pending !== null);

  const focusB = await postJson(h.base, "/api/sessions/activate", { id: b });
  assert.equal(focusB.status, 200);
  assert.equal(((await focusB.json()) as SessionMeta).active, true);

  assert.equal(h.spawned.length, 2, "focusing B spawns nothing new");
  assert.equal(h.spawned[0]!.disposed, false, "A's runtime survives B's focus — focusing never disposes another (web-sessions.ts:78-80, 298-316)");
  assert.ok((await permissionView(h.base, a)).pending !== null, "A's parked prompt is not denied by the focus switch");

  // The unscoped routes now follow B; A's scoped routes still answer A live.
  assert.equal((await sessionView(h.base)).id, b);
  const viewA = await sessionView(h.base, a);
  assert.equal(viewA.id, a);
  assert.equal(viewA.available, true, "A is still live and controllable after losing focus");
  const listed = await fetch(`${h.base}/api/sessions`).then((response) => response.json()) as { sessions: SessionMeta[] };
  assert.equal(listed.sessions.find((meta) => meta.id === a)?.live, true);
  assert.equal(listed.sessions.find((meta) => meta.id === b)?.active, true);

  // And A's park still answers from A's own route.
  const pendingA = (await permissionView(h.base, a)).pending;
  assert.ok(pendingA !== null);
  const answered = await postJson(h.base, "/api/permission", { id: pendingA.id, decision: "allow_once" }, `?session=${encodeURIComponent(a)}`);
  assert.equal(answered.status, 200);
  assert.deepEqual(await parkedA, { kind: "allow" });
});

// ── 4. Prompt handling per session ──────────────────────────────────────────

test("the turn-busy contract is per session: concurrent submits — A busy, B accepted", async (t) => {
  const h = await harness(t, { holdSpawns: new Set([1]) });
  const a = await createSession(h.base);
  const b = await createSession(h.base);

  const first = await postPrompt(h.base, a, "A turn one");
  assert.equal(first.status, 202);
  await waitState(h.base, a, "running");

  // Two concurrent submits while A's gate is held: A refuses, B accepts.
  const [refusedA, acceptedB] = await Promise.all([
    postPrompt(h.base, a, "A turn two"),
    postPrompt(h.base, b, "B concurrent turn"),
  ]);
  assert.equal(refusedA.status, 409, "A's own in-flight turn gates A (web-session-channel.ts:334-343, web.ts:1000-1002)");
  assert.deepEqual(await refusedA.json(), { error: "coding session is already running" });
  assert.equal(acceptedB.status, 202, "B's submit lands in the same window — the busy flag is per channel, never global");
  await waitState(h.base, b, "completed");

  // B's completion did not unbusy A: A still refuses until ITS turn settles.
  const stillBusy = await postPrompt(h.base, a, "A turn three");
  assert.equal(stillBusy.status, 409);

  h.spawned[0]!.gate?.release();
  await waitState(h.base, a, "completed");

  // A accepts again only once its own turn ended.
  await pollUntil(async () => (await postPrompt(h.base, a, "A turn three")).status === 202, "A to accept its next turn");
  await waitState(h.base, a, "completed");

  // Transcripts stay disjoint on the busy path.
  const textsA = await texts(h.base, a);
  assert.equal(textsA.some((text) => text.includes("B ")), false, "B's prompts never appear in A's transcript");
  assert.deepEqual((await sessionView(h.base, a)).items.filter((item) => item.kind === "user").map((item) => item.text), [
    "A turn one",
    "A turn three",
  ], "A's transcript carries exactly A's accepted turns");
  const textsB = await texts(h.base, b);
  assert.deepEqual(textsB, ["B concurrent turn", "agent-2 transcript marker", "done"]);
  assert.equal(textsB.some((text) => text.includes("A turn")), false, "A's prompts never appear in B's transcript");
});