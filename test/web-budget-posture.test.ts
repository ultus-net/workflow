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
import { describeBudgetMechanism, mergeSessionBudget, sessionBudgetTier } from "../src/integrations/session-budget.js";
import { createWorkflowWebServer } from "../src/ui/web.js";
import { WebSessionManager, parseSessionBudgetRaise } from "../src/ui/web-sessions.js";

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