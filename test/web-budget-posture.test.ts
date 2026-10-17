import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkflowCodingSession, type CodingSessionDriver } from "../src/application/coding-session.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import type { WorkflowAcpRuntime } from "../src/integrations/acp-runtime.js";
import { operatorPosture, type OperatorPosture, type PostureBudgetIncident } from "../src/integrations/operator-posture.js";
import { describeBudgetMechanism, mergeSessionBudget, sessionBudgetTier } from "../src/integrations/session-budget.js";
import { createWorkflowHub } from "../src/integrations/workflow-hub.js";
import { createWorkflowWebServer } from "../src/ui/web.js";
import { WebSessionManager, parseSessionBudgetRaise, sessionBudgetIncidents, withSessionBudgetIncidents, type SessionBudgetPosture, type WebSessionMeta } from "../src/ui/web-sessions.js";

// W151 (Paperclip borrow wave 2): budget state as agent posture. Pins:
//   - the tier derives from the guard's OWN predicates (sessionBudgetTier —
//     budgetViolation for abort, budgetDowngradeActive for warn); the warn
//     tier exists only when the guard actually enforces a warn threshold
//     (the W118 downgrade is configured), never a UI-side threshold;
//   - the manager's list() carries the recorded posture per session;
//   - raise-and-resume fails closed with renderable reasons (criterion 2),
//     and the one success path respawns the runtime under the raised caps.
// HTTP-level route pins ride the same file (the 403/415/400/404/409/200 map).

const ENV_KEYS = [
  "WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS",
  "WORKFLOW_SESSION_BUDGET_INPUT_TOKENS",
  "WORKFLOW_SESSION_BUDGET_OUTPUT_TOKENS",
  "WORKFLOW_SESSION_BUDGET_COST_USD",
  "WORKFLOW_BUDGET_DOWNGRADE_MODEL",
  "WORKFLOW_BUDGET_DOWNGRADE_FRACTION",
] as const;

function withEnv(values: Record<string, string | undefined>, body: () => void | Promise<void>): Promise<void> | void {
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = (): void => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = body();
    if (result instanceof Promise) return result.finally(restore);
    restore();
    return;
  } catch (error) {
    restore();
    throw error;
  }
}

interface StubOptions {
  /** The sticky violation the runtime's guard reports (undefined = not paused). */
  readonly violation?: string | undefined;
}

function fakeRuntime(options: StubOptions = {}): WorkflowAcpRuntime {
  const driver = {
    start: async (_prompt: unknown, emit: (event: unknown) => void) => {
      emit({ type: "assistant", text: "done" });
      emit({ type: "completed", result: "done" });
    },
    cancel: async () => {},
    agentSessionId: () => undefined,
    connect: async () => {},
    subscribe: () => () => {},
  };
  return {
    driver: driver as unknown as WorkflowAcpRuntime["driver"],
    session: new WorkflowCodingSession(driver as unknown as CodingSessionDriver),
    budgetMechanism: options.violation === undefined
      ? "test: no local caps (fake runtime)"
      : "test: local session-budget guard (total≤100)",
    ...(options.violation === undefined ? {} : { budgetViolation: () => options.violation }),
    async dispose() {},
  };
}

function application(): WorkflowApplication {
  const tasks: WorkflowTask[] = [{ id: taskId("A"), title: "Task", state: "READY", dependencies: [], requiredEvidence: [] }];
  return new WorkflowApplication(new TaskGraph(tasks), hostCapabilities({ transport: "acp", authoritativePreMutation: false }));
}

/** The GET /api/posture wire shape, minus the fields these pins never read. */
interface PostureWire {
  readonly posture: {
    readonly counts: { readonly budgetIncidents: number | null };
    readonly degraded: readonly string[];
    readonly budgetIncidents?: readonly PostureBudgetIncident[];
  } | null;
  readonly reason?: string;
}

async function listen(server: ReturnType<typeof createWorkflowWebServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** A REAL hub composed the production way, so the posture pin drives the true
 * composition path (the W212 P0 lesson), never a hand-built posture. */
async function realHub(context: { after(fn: () => unknown): void }, dir: string): Promise<string> {
  const graph = new TaskGraph([{ id: taskId("A"), title: "Task", state: "READY", dependencies: [], requiredEvidence: [] }]);
  const app = new WorkflowApplication(graph, hostCapabilities({ transport: "native", authoritativePreMutation: true }));
  const hub = await createWorkflowHub(app, { discoveryDir: dir, graph });
  context.after(() => hub.close());
  return dir;
}

async function postureFrom(port: number): Promise<PostureWire> {
  const response = await fetch(`http://127.0.0.1:${port}/api/posture`);
  assert.equal(response.status, 200);
  return (await response.json()) as PostureWire;
}

/** A registry file preloaded with one session whose usage is fully recorded. */
function registryWith(usage: Record<string, number> | undefined, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const registryPath = join(dir, "registry.json");
  writeFileSync(registryPath, JSON.stringify({
    version: 1,
    sessions: [{
      id: "s1",
      title: "capped session",
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      ...(usage === undefined ? {} : { usage }),
    }],
  }, null, 2), "utf8");
  return registryPath;
}

test("W151: the tier derives from the guard's own predicates — abort by budgetViolation, warn by the downgrade fraction, under otherwise", () => {
  const budget = { maxTotalTokens: 100 };
  const usage = (totalTokens: number) => ({ promptTokens: 0, completionTokens: 0, totalTokens, costUsd: 0 });
  assert.equal(sessionBudgetTier(usage(50), budget, 0.8), "under");
  assert.equal(sessionBudgetTier(usage(80), budget, 0.8), "warn", "the warn tier is exactly budgetDowngradeActive at the guard's fraction");
  assert.equal(sessionBudgetTier(usage(101), budget, 0.8), "abort", "the abort tier is exactly budgetViolation (usage strictly over the cap)");
  // With the downgrade OFF there is no warn threshold the guard enforces —
  // the honest tier stays "under" until the abort tier is crossed.
  assert.equal(sessionBudgetTier(usage(80), budget, undefined), "under");
  assert.equal(sessionBudgetTier(usage(99), budget, undefined), "under");
  assert.equal(sessionBudgetTier(usage(101), budget, undefined), "abort");
  // A cap-less budget on any axis: no violation, no warn.
  assert.equal(sessionBudgetTier(usage(9999), { maxCostUsd: 1 }, 0.8), "under");
});

test("W151: mergeSessionBudget applies the raise per axis over env; describeBudgetMechanism names the effective caps", () => {
  assert.deepEqual(mergeSessionBudget({ maxTotalTokens: 100, maxInputTokens: 10 }, { maxTotalTokens: 200 }), { maxTotalTokens: 200, maxInputTokens: 10 });
  assert.deepEqual(mergeSessionBudget(undefined, { maxCostUsd: 5 }), { maxCostUsd: 5 });
  assert.deepEqual(mergeSessionBudget({ maxTotalTokens: 100 }, undefined), { maxTotalTokens: 100 }, "no override returns the env budget unchanged");
  assert.match(describeBudgetMechanism({ maxTotalTokens: 200 }), /total≤200/, "the mechanism names the EFFECTIVE cap, not the env's");
  assert.match(describeBudgetMechanism(undefined), /no local interactive caps/, "no caps states the provider-side backstop honestly");
});

test("W151: parseSessionBudgetRaise admits only positive finite numbers on the known axes, at least one", () => {
  assert.deepEqual(parseSessionBudgetRaise({ maxTotalTokens: 200 }), { maxTotalTokens: 200 });
  assert.deepEqual(parseSessionBudgetRaise({ maxTotalTokens: 200, maxCostUsd: 5 }), { maxTotalTokens: 200, maxCostUsd: 5 });
  assert.equal(parseSessionBudgetRaise({}), undefined, "an empty raise is malformed, not a no-op");
  assert.equal(parseSessionBudgetRaise({ maxTotalTokens: 0 }), undefined);
  assert.equal(parseSessionBudgetRaise({ maxCostUsd: -1 }), undefined);
  assert.equal(parseSessionBudgetRaise({ maxTotalTokens: "200" }), undefined, "a string is not a number");
  assert.equal(parseSessionBudgetRaise(null), undefined);
  assert.equal(parseSessionBudgetRaise(undefined), undefined);
});

test("W151: the manager's list carries the recorded budget posture — warn from persisted usage, abort from the live violation, honest absences", async () => {
  await withEnv({
    WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: "100",
    WORKFLOW_BUDGET_DOWNGRADE_MODEL: "m2",
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-budget-posture-"));
    try {
      // A session with complete persisted usage at 0.9 of the cap: warn.
      const warnPath = registryWith({ promptTokens: 40, completionTokens: 50, totalTokens: 90, costUsd: 0.5 }, dir);
      const warnManager = new WebSessionManager({ registryPath: warnPath, factory: async () => fakeRuntime() });
      const warnMeta = warnManager.list()[0]!;
      assert.deepEqual(warnMeta.budget.caps, { maxTotalTokens: 100 });
      assert.equal(warnMeta.budget.tier, "warn");
      assert.equal(warnMeta.budget.violation, undefined, "no live runtime, no violation — the badge does not render");
      assert.equal(warnMeta.budget.mechanism.includes("total≤100"), true);
      await warnManager.dispose();

      // A session whose persisted usage is incomplete: tier "unknown", never a guess.
      const unknownPath = registryWith({ totalTokens: 90 }, join(dir, "u2"));
      const unknownManager = new WebSessionManager({ registryPath: unknownPath, factory: async () => fakeRuntime() });
      assert.equal(unknownManager.list()[0]!.budget.tier, "unknown");
      await unknownManager.dispose();

      // No env caps: no tier at all — the honest "no local cap" state.
      await withEnv({ WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: undefined, WORKFLOW_BUDGET_DOWNGRADE_MODEL: undefined }, async () => {
        const manager = new WebSessionManager({ registryPath: warnPath, factory: async () => fakeRuntime() });
        const meta = manager.list()[0]!;
        assert.equal(meta.budget.caps, undefined, "no configured caps is ABSENT, not zero");
        assert.equal(meta.budget.tier, undefined);
        assert.match(meta.budget.mechanism, /no local interactive caps/);
        await manager.dispose();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("W151: raise-and-resume fails closed when the authority withholds the capability, and respawns under raised caps when it does not", async () => {
  await withEnv({ WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: "100", WORKFLOW_BUDGET_DOWNGRADE_MODEL: "m2" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-budget-raise-"));
    try {
      const registryPath = registryWith({ promptTokens: 40, completionTokens: 50, totalTokens: 90, costUsd: 0.5 }, dir);
      const launched: Array<string | undefined> = [];
      const liveViolation = "budget exceeded: total tokens 101 > cap 100";
      const manager = new WebSessionManager({
        registryPath,
        factory: async (_agent, _resumeFrom, budgetOverride) => {
          launched.push(budgetOverride === undefined ? undefined : JSON.stringify(budgetOverride));
          // The respawned runtime runs under the raised caps: no violation.
          return fakeRuntime({ violation: budgetOverride === undefined ? liveViolation : undefined });
        },
      });
      // Unknown session.
      assert.deepEqual(await manager.raiseBudgetAndResume("nope", { maxTotalTokens: 200 }), { kind: "unknown" });
      // Not live, nothing paused: the raise is refused — there is no violation
      // to resume from.
      const notLive = await manager.raiseBudgetAndResume("s1", { maxTotalTokens: 200 });
      assert.equal(notLive.kind, "denied");
      assert.match(notLive.kind === "denied" ? notLive.reason : "", /not paused by budget/);
      // Live but a malformed raise: denied with the axis named.
      await manager.channel("s1");
      const empty = await manager.raiseBudgetAndResume("s1", {});
      assert.match(empty.kind === "denied" ? empty.reason : "", /at least one cap axis/);
      const negative = await manager.raiseBudgetAndResume("s1", { maxTotalTokens: -5 });
      assert.match(negative.kind === "denied" ? negative.reason : "", /positive number/);
      // The real raise: the respawn runs under the raised caps.
      const ok = await manager.raiseBudgetAndResume("s1", { maxTotalTokens: 400 });
      assert.equal(ok.kind, "ok");
      if (ok.kind !== "ok") return;
      assert.equal(ok.meta.budget.violation, undefined, "the fresh guard under raised caps has no violation");
      assert.deepEqual(ok.meta.budget.caps, { maxTotalTokens: 400 });
      assert.equal(ok.meta.budget.tier, "under", "90 tokens against a 400 cap, 0.8 fraction");
      assert.equal(launched[launched.length - 1], JSON.stringify({ maxTotalTokens: 400 }), "the respawn's factory call carried the raised caps");
      // The raise persists on the record: a later spawn keeps the raised caps.
      const reloaded = new WebSessionManager({ registryPath, factory: async (_agent, _resumeFrom, budgetOverride) => {
        launched.push(budgetOverride === undefined ? undefined : JSON.stringify(budgetOverride));
        return fakeRuntime();
      } });
      await reloaded.channel("s1");
      assert.equal(launched[launched.length - 1], JSON.stringify({ maxTotalTokens: 400 }), "the persisted override rides every later spawn");
      await reloaded.dispose();
      await manager.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("W151: raise is denied when no local guard is configured — the provider-side backstop cannot be raised from here", async () => {
  await withEnv({
    WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: undefined,
    WORKFLOW_SESSION_BUDGET_COST_USD: undefined,
    WORKFLOW_SESSION_BUDGET_INPUT_TOKENS: undefined,
    WORKFLOW_SESSION_BUDGET_OUTPUT_TOKENS: undefined,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-budget-raise-uncapped-"));
    try {
      const registryPath = registryWith(undefined, dir);
      const manager = new WebSessionManager({ registryPath, factory: async () => fakeRuntime() });
      const denied = await manager.raiseBudgetAndResume("s1", { maxTotalTokens: 200 });
      assert.equal(denied.kind, "denied");
      assert.match(denied.kind === "denied" ? denied.reason : "", /no local session-budget guard/);
      await manager.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("W151: POST /api/sessions/budget-raise maps the authority's outcomes onto honest statuses", async (context) => {
  await withEnv({ WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: "100", WORKFLOW_BUDGET_DOWNGRADE_MODEL: "m2" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-budget-raise-route-"));
    try {
      const registryPath = registryWith({ promptTokens: 40, completionTokens: 50, totalTokens: 90, costUsd: 0.5 }, dir);
      const manager = new WebSessionManager({
        registryPath,
        factory: async (_agent, _resumeFrom, budgetOverride) => fakeRuntime({ violation: budgetOverride === undefined ? "budget exceeded: total tokens 101 > cap 100" : undefined }),
      });
      const server = createWorkflowWebServer(application(), manager);
      context.after(() => { void server.close(); void manager.dispose(); });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${port}/api/sessions/budget-raise`;
      const post = (body: string, origin?: string, contentType = "application/json"): Promise<Response> =>
        fetch(url, { method: "POST", headers: { ...(contentType === undefined ? {} : { "content-type": contentType }), ...(origin === undefined ? {} : { origin }) }, ...(body === undefined ? {} : { body }) });

      assert.equal((await post("{\"id\":\"s1\",\"budget\":{\"maxTotalTokens\":200}}", "http://evil.example")).status, 403, "cross-origin mutation denied");
      assert.equal((await post("{\"id\":\"s1\",\"budget\":{\"maxTotalTokens\":200}}", undefined, "text/plain")).status, 415, "non-JSON content type");
      assert.equal((await post("{\"id\":\"s1\",\"budget\":{\"maxTotalTokens\":0}}")).status, 400, "a non-positive cap is malformed");
      assert.equal((await post("{\"id\":\"unknown\",\"budget\":{\"maxTotalTokens\":200}}")).status, 404, "unknown session");
      const notPaused = await post("{\"id\":\"s1\",\"budget\":{\"maxTotalTokens\":200}}");
      assert.equal(notPaused.status, 409, "the session is not paused (the violation needs a live runtime)");
      assert.match((await notPaused.json() as { error: string }).error, /not paused by budget/, "the denial's reason rides the body so the card can render it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// W215: the budgetIncidents PRODUCER. The AgentsView incident panel reads the
// posture block's `budgetIncidents` verbatim, and the hub composes no session
// registry (src/cli/web-service.ts), so the records derive HERE — from the
// web's session registry — and merge into the posture GET /api/posture
// relays. Red-first: the relay pins drive the REAL composition (real hub,
// real WebSessionManager, real web route), so a regression to the W176-era
// declared-but-never-forwarded seam fails here, never at typecheck.

test("W215: GET /api/posture merges the session-derived warn incident record into the posture the real hub serves (production path)", async (context) => {
  await withEnv({ WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: "100", WORKFLOW_BUDGET_DOWNGRADE_MODEL: "m2" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-posture-incidents-"));
    try {
      const hubDir = join(dir, "hub");
      await realHub(context, hubDir);
      // Persisted usage at 0.9 of the cap: the recorded tier is warn.
      const registryPath = registryWith({ promptTokens: 40, completionTokens: 50, totalTokens: 90, costUsd: 0.5 }, join(dir, "sessions"));
      const manager = new WebSessionManager({ registryPath, factory: async () => fakeRuntime() });
      const server = createWorkflowWebServer(application(), manager, undefined, { hubDiscoveryDir: hubDir });
      context.after(() => { void server.close(); void manager.dispose(); });
      const port = await listen(server);

      const answer = await postureFrom(port);
      assert.ok(answer.posture !== null, "the hub posture relays");
      assert.deepEqual(answer.posture.budgetIncidents, [{
        sessionId: "s1",
        title: "capped session",
        tier: "warn",
        mechanism: describeBudgetMechanism({ maxTotalTokens: 100 }),
      }], "the recorded warn tier rides the posture block as a real incident record");
      assert.equal(answer.posture.counts.budgetIncidents, 1, "the count composes from the merged records");
      assert.equal(answer.posture.degraded.includes("per-session budget state"), false, "the served registry answer lifts the named degradation");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("W215: a live session's sticky budget refusal rides as an abort-tier incident record with its recorded reason (production path)", async (context) => {
  await withEnv({ WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: "100", WORKFLOW_BUDGET_DOWNGRADE_MODEL: "m2" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-posture-incidents-abort-"));
    try {
      const hubDir = join(dir, "hub");
      await realHub(context, hubDir);
      const violation = "budget exceeded: total tokens 101 > cap 100";
      const registryPath = registryWith({ promptTokens: 40, completionTokens: 50, totalTokens: 90, costUsd: 0.5 }, join(dir, "sessions"));
      const manager = new WebSessionManager({ registryPath, factory: async () => fakeRuntime({ violation }) });
      const server = createWorkflowWebServer(application(), manager, undefined, { hubDiscoveryDir: hubDir });
      context.after(() => { void server.close(); void manager.dispose(); });
      const port = await listen(server);
      // Spawn the live runtime so its guard's sticky refusal is recorded.
      await manager.channel("s1");

      const answer = await postureFrom(port);
      assert.ok(answer.posture !== null, "the hub posture relays");
      assert.deepEqual(answer.posture.budgetIncidents, [{
        sessionId: "s1",
        title: "capped session",
        tier: "abort",
        mechanism: "test: local session-budget guard (total≤100)",
        reason: violation,
      }], "the recorded sticky refusal rides as the abort record's reason, the live mechanism verbatim");
      assert.equal(answer.posture.counts.budgetIncidents, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("W215: sessions under every tier keep the named absence — the wire never fabricates an empty record set (production path)", async (context) => {
  await withEnv({ WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: "100", WORKFLOW_BUDGET_DOWNGRADE_MODEL: "m2" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-posture-incidents-under-"));
    try {
      const hubDir = join(dir, "hub");
      await realHub(context, hubDir);
      // Persisted usage at 0.5 of the cap: under the warn threshold.
      const registryPath = registryWith({ promptTokens: 20, completionTokens: 20, totalTokens: 50, costUsd: 0.2 }, join(dir, "sessions"));
      const manager = new WebSessionManager({ registryPath, factory: async () => fakeRuntime() });
      const server = createWorkflowWebServer(application(), manager, undefined, { hubDiscoveryDir: hubDir });
      context.after(() => { void server.close(); void manager.dispose(); });
      const port = await listen(server);

      const answer = await postureFrom(port);
      assert.ok(answer.posture !== null, "the hub posture relays");
      assert.equal("budgetIncidents" in answer.posture, false, "no tier crossed: the field stays ABSENT — never a fabricated []");
      assert.equal(answer.posture.counts.budgetIncidents, null, "the count keeps its honest null");
      assert.equal(answer.posture.degraded.includes("per-session budget state"), true, "the panel renders the named absence, not an empty success");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("W215: the derivation gates on the recorded tier — under/unknown/no-caps never emit a row", () => {
  const meta = (budget: SessionBudgetPosture): WebSessionMeta => ({
    id: "s1",
    title: "capped session",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    active: false,
    agent: "opencode",
    live: false,
    busy: false,
    budget,
  });
  const mechanism = "local session-budget guard (total≤100)";
  assert.deepEqual(sessionBudgetIncidents([
    meta({ tier: "under", mechanism }),
    meta({ tier: "unknown", mechanism }),
    meta({ mechanism }),
  ]), [], "under / unknown / no-local-cap emit no record");
  assert.deepEqual(sessionBudgetIncidents([meta({ tier: "warn", mechanism })]), [{
    sessionId: "s1",
    title: "capped session",
    tier: "warn",
    mechanism,
  }], "the warn record carries the recorded mechanism and no fabricated reason");
  assert.deepEqual(sessionBudgetIncidents([meta({ tier: "abort", violation: "over cap", mechanism })]), [{
    sessionId: "s1",
    title: "capped session",
    tier: "abort",
    mechanism,
    reason: "over cap",
  }], "the abort record carries the recorded sticky refusal verbatim");
});

test("W215: the merge never fabricates an empty set, never mutates the hub block, and passes the hub answer through with no registry", () => {
  const posture: OperatorPosture = operatorPosture({ runTasks: [], reviewOutcomes: new Map(), blockingReasons: new Map() });
  assert.equal("budgetIncidents" in posture, false, "the hub projection emits nothing for a source it never had");
  assert.equal(withSessionBudgetIncidents(posture, undefined), posture, "no session registry: the hub's own answer passes through untouched");
  const absent = withSessionBudgetIncidents(posture, []);
  assert.equal(absent, posture, "an empty registry answer keeps the block untouched — never a fabricated []");
  assert.equal("budgetIncidents" in absent, false);

  const merged = withSessionBudgetIncidents(posture, [{
    id: "s1",
    title: "capped session",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    active: false,
    agent: "opencode",
    live: false,
    busy: false,
    budget: { tier: "warn", mechanism: "local session-budget guard (total≤100)" },
  }]);
  assert.equal("budgetIncidents" in posture, false, "the hub block is never mutated in place");
  assert.equal(merged.counts.budgetIncidents, 1, "the count recomposes exactly as the projection would compose it");
  assert.equal(merged.degraded.includes("per-session budget state"), false, "the named degradation lifts with the served answer");
  assert.deepEqual(merged.budgetIncidents, [{ sessionId: "s1", title: "capped session", tier: "warn", mechanism: "local session-budget guard (total≤100)" }]);
});