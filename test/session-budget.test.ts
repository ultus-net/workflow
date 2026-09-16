import assert from "node:assert/strict";
import { test } from "node:test";

import type { CodingSessionDriver, CodingSessionEvent } from "../src/application/coding-session.js";
import { WorkflowCodingSession } from "../src/application/coding-session.js";
import type { ModelUsageMetrics, ModelUsageProxy } from "../src/integrations/model-usage-proxy.js";
import {
  createSessionBudgetGuard,
  sessionBudgetFromEnv,
  sessionBudgetMechanism,
} from "../src/integrations/session-budget.js";
import { composeSessionWithBudget } from "../src/integrations/acp-runtime.js";
import { formatUsageLine } from "../src/ui/usage.js";

const metrics = (totalTokens: number, costUsd: number): ModelUsageMetrics => ({
  requests: 1,
  usageEvents: 1,
  promptTokens: totalTokens,
  completionTokens: 0,
  totalTokens,
  costUsd,
  latestPromptTokens: undefined,
});

// ── Config parsing ──────────────────────────────────────────────────────────

test("sessionBudgetFromEnv parses every cap axis", () => {
  assert.equal(sessionBudgetFromEnv({}), undefined);
  assert.deepEqual(
    sessionBudgetFromEnv({
      WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: "10000",
      WORKFLOW_SESSION_BUDGET_INPUT_TOKENS: "8000",
      WORKFLOW_SESSION_BUDGET_OUTPUT_TOKENS: "2000",
      WORKFLOW_SESSION_BUDGET_COST_USD: "0.50",
    }),
    { maxInputTokens: 8000, maxOutputTokens: 2000, maxTotalTokens: 10000, maxCostUsd: 0.5 },
  );
  assert.deepEqual(sessionBudgetFromEnv({ WORKFLOW_SESSION_BUDGET_COST_USD: "0.25" }), { maxCostUsd: 0.25 });
});

test("a malformed session budget cap throws — a broken cap never degrades to an unenforced session", () => {
  assert.throws(() => sessionBudgetFromEnv({ WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: "-5" }), /WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS/);
  assert.throws(() => sessionBudgetFromEnv({ WORKFLOW_SESSION_BUDGET_COST_USD: "cheap" }), /WORKFLOW_SESSION_BUDGET_COST_USD/);
});

test("the budget mechanism record distinguishes local caps from the server-side backstop", () => {
  assert.match(sessionBudgetMechanism({}), /server-side: OpenRouter per-key credit limit/);
  assert.match(
    sessionBudgetMechanism({ WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS: "100", WORKFLOW_SESSION_BUDGET_COST_USD: "1" }),
    /local session-budget guard \(total≤100, cost≤\$1\)/,
  );
});

// ── The guard ──────────────────────────────────────────────────────────────

test("the session budget guard cancels once on the first violation and the violation is sticky", () => {
  let usage = metrics(500, 0.01);
  let cancels = 0;
  const listeners = new Set<(event: { readonly type: string }) => void>();
  const guard = createSessionBudgetGuard({
    budget: { maxTotalTokens: 1000 },
    usageSnapshot: () => usage,
    cancel: () => { cancels += 1; },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  });
  guard.attach();

  const emit = () => { for (const listener of [...listeners]) listener({ type: "tool" }); };
  usage = metrics(900, 0.01);
  emit();
  assert.equal(guard.violation(), undefined, "under the cap: no violation");
  assert.equal(cancels, 0);

  usage = metrics(1200, 0.01);
  emit();
  assert.match(guard.violation() ?? "", /budget exceeded: total tokens 1200 > cap 1000/);
  assert.equal(cancels, 1, "the in-flight turn is cancelled exactly once");

  usage = metrics(5000, 0.02);
  emit();
  assert.equal(cancels, 1, "the cancel never repeats for later events");
  assert.match(guard.violation() ?? "", /total tokens/);
});

// ── Session refusal gate ────────────────────────────────────────────────────

function fakeDriver(): { driver: CodingSessionDriver; started: string[]; cancelled: number; events: ((event: CodingSessionEvent) => void)[] } {
  const state = { started: [] as string[], cancelled: 0, events: [] as ((event: CodingSessionEvent) => void)[] };
  const driver: CodingSessionDriver = {
    async start(prompt, emit) {
      state.started.push(prompt);
      state.events.push(emit);
    },
    async cancel() { state.cancelled += 1; },
  };
  return { driver, ...state } as unknown as { driver: CodingSessionDriver; started: string[]; cancelled: number; events: ((event: CodingSessionEvent) => void)[] };
}

test("a refused prompt never reaches the driver and the refusal is surfaced, not silent", async () => {
  const { driver, started } = fakeDriver();
  let refusal: string | undefined = "budget exceeded: total tokens 12000 > cap 10000";
  const seen: CodingSessionEvent[] = [];
  const session = new WorkflowCodingSession(driver, { refusalGate: () => refusal });
  session.subscribe((event) => seen.push(event));

  await session.submit("do more work");
  assert.deepEqual(started, [], "a refused prompt never starts a turn");
  assert.deepEqual(session.queuedPrompts(), [], "a refused prompt never enters the queue");
  const failure = seen.find((event) => event.type === "failed");
  assert.ok(failure !== undefined && failure.type === "failed", "the refusal surfaces as a failed event");
  if (failure.type === "failed") assert.match(failure.reason, /budget exceeded/);

  // Gate clears → prompts run again (the refusal is not a permanent lock).
  refusal = undefined;
  await session.submit("after the cap is lifted");
  assert.deepEqual(started, ["after the cap is lifted"]);
});

test("a session without a gate runs prompts normally", async () => {
  const { driver, started } = fakeDriver();
  const session = new WorkflowCodingSession(driver);
  await session.submit("hello");
  assert.deepEqual(started, ["hello"]);
});

// ── Runtime wiring (composeSessionWithBudget) ──────────────────────────────

test("the composed session records the mechanism and enforces nothing while usage stays under the cap", async () => {
  const { driver, started, events } = fakeDriver();
  const proxy: ModelUsageProxy = {
    url: "http://127.0.0.1:0",
    metrics: () => metrics(900, 0.001),
    close: async () => undefined,
  };
  process.env.WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS = "1000";
  try {
    const composed = composeSessionWithBudget(driver, proxy);
    assert.equal(composed.budgetMechanism, sessionBudgetMechanism());
    assert.equal(composed.budgetViolation?.(), undefined, "no violation before any usage crosses");

    await composed.session.submit("turn one");
    assert.deepEqual(started, ["turn one"]);
    // A session event under the cap triggers a check that finds nothing.
    events[0]!({ type: "status", status: "working" });
    assert.equal(composed.budgetViolation?.(), undefined, "under the cap: no violation");
  } finally {
    delete process.env.WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS;
  }
});

test("an in-flight turn is cancelled the moment a session event crosses the cap", async () => {
  const state = { started: [] as string[], cancelled: 0, emits: [] as ((event: CodingSessionEvent) => void)[] };
  const driver: CodingSessionDriver = {
    async start(prompt, emit) {
      state.started.push(prompt);
      state.emits.push(emit);
    },
    async cancel() { state.cancelled += 1; },
  };
  let usage = metrics(100, 0.001);
  const proxy: ModelUsageProxy = { url: "http://127.0.0.1:0", metrics: () => usage, close: async () => undefined };
  process.env.WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS = "1000";
  try {
    const composed = composeSessionWithBudget(driver, proxy);
    const submit = composed.session.submit("long turn");
    // Mid-turn the usage crosses the cap; the next session event must cancel.
    usage = metrics(2000, 0.01);
    state.emits[0]!({ type: "status", status: "working" });
    await submit;
    assert.ok(state.cancelled >= 1, "the in-flight turn is cancelled through session/cancel semantics");
    assert.match(composed.budgetViolation?.() ?? "", /budget exceeded/);
    // And the next prompt is refused.
    await composed.session.submit("one more");
    assert.deepEqual(state.started, ["long turn"], "the post-violation prompt is refused");
  } finally {
    delete process.env.WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS;
  }
});

// ── Operator-visible formatting ────────────────────────────────────────────

test("the usage line renders a crossed budget", () => {
  assert.equal(
    formatUsageLine({ totalTokens: 1500, costUsd: 0.002, budgetViolation: "budget exceeded: total tokens 1500 > cap 1000" }),
    "1500 tokens · $0.0020 · ! budget exceeded: total tokens 1500 > cap 1000",
  );
});
