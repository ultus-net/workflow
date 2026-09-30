import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { CodingSessionDriver, CodingSessionEvent } from "../src/application/coding-session.js";
import { WorkflowCodingSession } from "../src/application/coding-session.js";
import { createOpenModelMeteringPool } from "../src/integrations/open-model-proxy.js";
import { DEFAULT_OPEN_SOURCE_POOL } from "../src/integrations/open-source-pool.js";
import { METERED_PLACEHOLDER_KEY, type ModelUsageMetrics, type ModelUsageProxy } from "../src/integrations/model-usage-proxy.js";
import {
  budgetDowngradeActive,
  budgetDowngradeFromEnv,
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
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
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
    messagesLaneLabels: () => ({ models: [], malformedBodies: 0 }),
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
  const proxy: ModelUsageProxy = { url: "http://127.0.0.1:0", metrics: () => usage, messagesLaneLabels: () => ({ models: [], malformedBodies: 0 }), close: async () => undefined };
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

// ── W119: the abort tier sees every lane (the W118-era blindness closed) ───

// The W118-era recorded residual (park P15 (c), the fresh-eyes round-1 P2):
// composeSessionWithBudget wired the guard with the OpenRouter proxy's
// metrics only — the open-source lane's traffic was INVISIBLE to the abort
// tier while the W118 downgrade activates on exactly that traffic. The fix:
// the guard's usage snapshot AGGREGATES the pool's metrics with the
// OpenRouter proxy's, so one budget sees all lanes (the abort tier and the
// W118 warn tier now cover the same usage). The violation reason echoes the
// AGGREGATED number — the discriminating observable.
test("W119: the guard's usage aggregates the open-source lane's pool metrics", async () => {
  const { driver, started, events } = fakeDriver();
  // The primary (OpenRouter) proxy stays under the cap; the open lane's
  // usage crosses it — without the aggregation the abort tier never fires.
  const proxy: ModelUsageProxy = {
    url: "http://127.0.0.1:0",
    metrics: () => metrics(100, 0.001),
    messagesLaneLabels: () => ({ models: [], malformedBodies: 0 }),
    close: async () => undefined,
  };
  const openPoolUsage = metrics(2000, 0.01);
  process.env.WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS = "1000";
  try {
    const composed = composeSessionWithBudget(driver, proxy, () => openPoolUsage);
    assert.equal(composed.budgetViolation?.(), undefined, "nothing recorded yet: no violation");
    const submit = composed.session.submit("long turn");
    // A session event triggers the check over the AGGREGATED usage
    // (100 + 2000 = 2100 tokens ≥ the 1000 cap) — the open lane counts, and
    // the in-flight turn is cancelled through session/cancel semantics.
    events[0]!({ type: "status", status: "working" });
    await submit;
    assert.match(
      composed.budgetViolation?.() ?? "",
      /total tokens 2100 > cap 1000/,
      "the violation reason echoes the AGGREGATED total (the open lane is visible to the abort tier)",
    );
    // And the next prompt is refused (the sticky violation).
    await composed.session.submit("one more");
    assert.deepEqual(started, ["long turn"], "the post-violation prompt is refused");
  } finally {
    delete process.env.WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS;
  }
});

test("W119: absent additional usage the guard's snapshot is the OpenRouter proxy alone", async () => {
  const { driver, events } = fakeDriver();
  const proxy: ModelUsageProxy = {
    url: "http://127.0.0.1:0",
    metrics: () => metrics(900, 0.001),
    messagesLaneLabels: () => ({ models: [], malformedBodies: 0 }),
    close: async () => undefined,
  };
  process.env.WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS = "1000";
  try {
    const composed = composeSessionWithBudget(driver, proxy);
    const submit = composed.session.submit("turn one");
    events[0]!({ type: "status", status: "working" });
    await submit;
    assert.equal(composed.budgetViolation?.(), undefined, "no additional usage wired: the snapshot is the OpenRouter proxy's alone (under the cap)");
  } finally {
    delete process.env.WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS;
  }
});

// P15 (b): the additive per-family view does not move what the abort tier
// reads. The pool's metrics() stays the cross-family aggregate and the guard
// snapshot consumes exactly that (`() => pool.metrics()`); two families each
// UNDER the cap must still fire the abort when their SUM crosses it — a
// per-family view can never leak into the snapshot.
test("P15 (b): the abort tier sees the cross-family aggregate, not a per-family view", async () => {
  const makeUpstream = async (usage: Record<string, number>): Promise<{ url: string; close: () => Promise<void> }> => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [], usage }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))) };
  };
  const deepseek = await makeUpstream({ prompt_tokens: 600, completion_tokens: 0, total_tokens: 600, cost: 0.001 });
  const glm = await makeUpstream({ prompt_tokens: 600, completion_tokens: 0, total_tokens: 600, cost: 0.001 });
  const pool = await createOpenModelMeteringPool({
    pool: DEFAULT_OPEN_SOURCE_POOL,
    keys: { deepseek: "DEEPSEEK_KEY", glm: "GLM_KEY" },
    upstreamOverride: (def) => (def.family === "deepseek" ? deepseek.url : glm.url),
  });
  const { driver, events } = fakeDriver();
  const openRouter: ModelUsageProxy = { url: "http://127.0.0.1:0", metrics: () => metrics(0, 0), messagesLaneLabels: () => ({ models: [], malformedBodies: 0 }), close: async () => undefined };
  process.env.WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS = "1000";
  try {
    // Record 600 tokens on each family: each is under the 1000 cap; the
    // aggregate is 1200, over it.
    for (const family of ["deepseek", "glm"] as const) {
      const provider = pool.byFamily.get(family)!;
      await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${METERED_PLACEHOLDER_KEY}` },
        body: JSON.stringify({ model: provider.models[0], messages: [] }),
      });
    }
    assert.equal(pool.perFamilyMetrics().get("deepseek")!.totalTokens, 600, "each family is under the cap on its own");
    assert.equal(pool.perFamilyMetrics().get("glm")!.totalTokens, 600);
    const composed = composeSessionWithBudget(driver, openRouter, () => pool.metrics());
    const submit = composed.session.submit("turn");
    events[0]!({ type: "status", status: "working" });
    await submit;
    assert.match(
      composed.budgetViolation?.() ?? "",
      /total tokens 1200 > cap 1000/,
      "the abort tier sums the families through the aggregate (the per-family split is observability, not enforcement)",
    );
  } finally {
    delete process.env.WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS;
    await pool.close();
    await deepseek.close();
    await glm.close();
  }
});

// ── Operator-visible formatting ────────────────────────────────────────────

test("the usage line renders a crossed budget", () => {
  assert.equal(
    formatUsageLine({ totalTokens: 1500, costUsd: 0.002, budgetViolation: "budget exceeded: total tokens 1500 > cap 1000" }),
    "1500 tokens · $0.0020 · ! budget exceeded: total tokens 1500 > cap 1000",
  );
});

// W118 (the W095 budget-downgrade consumer, part 1): the env axes. The
// downgrade TARGET is required (a fraction without a target downgrades to
// nothing); the warn FRACTION defaults to 0.8 and must parse to (0,1) —
// an invalid axis fails CLOSED to no downgrade (the pass-through posture
// is the default; a downgrade is an opt-in behavior). The threshold
// source stays design-open (the routing note's key-2: "env axis or cap
// fraction") — both axes are env for v1, recorded as such.
test("W118: the budget-downgrade env axes parse fail-closed", () => {
  const model = { WORKFLOW_BUDGET_DOWNGRADE_MODEL: "glm-5.3-flash" };
  assert.deepEqual(budgetDowngradeFromEnv(model), { targetModel: "glm-5.3-flash", fraction: 0.8 }, "the fraction defaults to 0.8");
  assert.deepEqual(
    budgetDowngradeFromEnv({ ...model, WORKFLOW_BUDGET_DOWNGRADE_FRACTION: "0.5" }),
    { targetModel: "glm-5.3-flash", fraction: 0.5 },
  );
  assert.equal(budgetDowngradeFromEnv({}), undefined, "no target model = no downgrade (silence is honest)");
  assert.equal(budgetDowngradeFromEnv({ WORKFLOW_BUDGET_DOWNGRADE_MODEL: "   " }), undefined, "a blank target is absent");
  assert.equal(budgetDowngradeFromEnv({ ...model, WORKFLOW_BUDGET_DOWNGRADE_FRACTION: "1.5" }), undefined, "a fraction ≥ 1 fails closed");
  assert.equal(budgetDowngradeFromEnv({ ...model, WORKFLOW_BUDGET_DOWNGRADE_FRACTION: "0" }), undefined, "a fraction ≤ 0 fails closed");
  assert.equal(budgetDowngradeFromEnv({ ...model, WORKFLOW_BUDGET_DOWNGRADE_FRACTION: "abc" }), undefined, "a non-numeric fraction fails closed");
});

// W118: the warn-tier predicate mirrors the abort-tier comparison
// (budgetViolation's semantics) at the warn fraction — ANY cap dimension
// crossed at ≥ fraction × cap activates the downgrade; no cap configured
// means nothing to warn about. The abort tier itself is untouched: the
// guard still cancels at the full cap (one implementation, two tiers).
test("W118: the downgrade activates at the warn fraction of any cap dimension", () => {
  const budget = { maxTotalTokens: 1000, maxCostUsd: 1 };
  assert.equal(budgetDowngradeActive({ promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 }, budget, 0.5), false, "no usage, no downgrade");
  assert.equal(
    budgetDowngradeActive({ promptTokens: 0, completionTokens: 0, totalTokens: 600, costUsd: 0.1 }, budget, 0.5),
    true,
    "total tokens at ≥ 0.5× the cap activates",
  );
  assert.equal(
    budgetDowngradeActive({ promptTokens: 0, completionTokens: 0, totalTokens: 100, costUsd: 0.9 }, budget, 0.5),
    true,
    "cost at ≥ 0.5× its cap activates (any dimension)",
  );
  assert.equal(
    budgetDowngradeActive({ promptTokens: 0, completionTokens: 0, totalTokens: 499, costUsd: 0.4 }, budget, 0.5),
    false,
    "below the fraction on every dimension stays inactive",
  );
  assert.equal(budgetDowngradeActive({ promptTokens: 0, completionTokens: 0, totalTokens: 600, costUsd: 0 }, {}, 0.5), false, "no caps configured = nothing to warn about");
  // The FIELD MAPPING matches budgetViolation's exactly (the four
  // dimensions, mirrored — the fresh-eyes round-1 P3: the mirror claim is
  // pinned, not asserted): input tokens vs maxInputTokens, output tokens
  // vs maxOutputTokens.
  assert.equal(
    budgetDowngradeActive({ promptTokens: 300, completionTokens: 0, totalTokens: 300, costUsd: 0 }, { maxInputTokens: 500 }, 0.5),
    true,
    "input tokens map to maxInputTokens (promptTokens ≥ 0.5× the cap)",
  );
  assert.equal(
    budgetDowngradeActive({ promptTokens: 0, completionTokens: 300, totalTokens: 300, costUsd: 0 }, { maxOutputTokens: 400 }, 0.5),
    true,
    "output tokens map to maxOutputTokens (completionTokens ≥ 0.5× the cap)",
  );
});

// ── W122: the fail-closed silence gets operator-facing logging ──────────────

// Injectable-warn collector (the containment platform.ts pattern): the parse
// warns through the injected sink so the pins assert on CONTENT, not on
// intercepted globals; the default-warn pin below exercises the real
// console.warn path separately.
function recordingWarn(): { readonly messages: string[]; readonly warn: (message: string) => void } {
  const messages: string[] = [];
  return { messages, warn: (message) => { messages.push(message); } };
}

// The W118-era recorded residual (park P15 (d); the W118 item's residual
// (f)): a malformed downgrade axis fails CLOSED to undefined — the safe
// direction — but SILENTLY: the operator set an axis and never learns the
// downgrade is disabled. The fix: budgetDowngradeFromEnv takes an injectable
// warn (the containment platform.ts pattern) defaulting to a `[budget]`
// console.warn, fired ONLY when the operator ASKED (an axis is set) but the
// config fails closed. Honest absence stays silent (nothing set = nothing to
// say; a blank target with no fraction is absence).
test("W122: a malformed fraction warns once and still fails closed", () => {
  const { messages, warn } = recordingWarn();
  const model = { WORKFLOW_BUDGET_DOWNGRADE_MODEL: "glm-5.3-flash" };
  for (const raw of ["1.5", "0", "abc"]) {
    messages.length = 0;
    assert.equal(
      budgetDowngradeFromEnv({ ...model, WORKFLOW_BUDGET_DOWNGRADE_FRACTION: raw }, warn),
      undefined,
      `the fail-closed return is unchanged for ${JSON.stringify(raw)} (logging must not soften it)`,
    );
    assert.equal(messages.length, 1, "exactly one warning per parse");
    assert.ok(messages[0]!.includes("WORKFLOW_BUDGET_DOWNGRADE_FRACTION"), "the warning names the offending axis");
    assert.ok(messages[0]!.includes(raw), "the warning echoes the raw value");
    assert.ok(messages[0]!.includes("glm-5.3-flash"), "the warning names the configured target");
  }
});

test("W122: a fraction without a target model warns (the operator asked for a downgrade)", () => {
  const { messages, warn } = recordingWarn();
  assert.equal(budgetDowngradeFromEnv({ WORKFLOW_BUDGET_DOWNGRADE_FRACTION: "0.5" }, warn), undefined);
  assert.equal(messages.length, 1, "exactly one warning");
  assert.ok(messages[0]!.includes("WORKFLOW_BUDGET_DOWNGRADE_MODEL"), "the warning names the missing axis");
  assert.ok(messages[0]!.includes("0.5"), "the warning echoes the set fraction");
});

// Regression hold-outs (green before AND after by design): the paths where
// the operator asked for NOTHING must not start warning — the fix closes the
// operator-asked silence, it does not add noise to honest absence.
test("W122: valid configs and honest absence stay silent (hold-out)", () => {
  const { messages, warn } = recordingWarn();
  assert.deepEqual(
    budgetDowngradeFromEnv({ WORKFLOW_BUDGET_DOWNGRADE_MODEL: "glm-5.3-flash" }, warn),
    { targetModel: "glm-5.3-flash", fraction: 0.8 },
    "a target with the default fraction parses unchanged",
  );
  assert.deepEqual(
    budgetDowngradeFromEnv({ WORKFLOW_BUDGET_DOWNGRADE_MODEL: "glm-5.3-flash", WORKFLOW_BUDGET_DOWNGRADE_FRACTION: "   " }, warn),
    { targetModel: "glm-5.3-flash", fraction: 0.8 },
    "a whitespace-only fraction is unset (parseCap's convention), not malformed",
  );
  assert.equal(budgetDowngradeFromEnv({}, warn), undefined, "nothing set = nothing to say");
  assert.equal(budgetDowngradeFromEnv({ WORKFLOW_BUDGET_DOWNGRADE_MODEL: "   " }, warn), undefined, "a blank target with no fraction is honest absence");
  assert.equal(
    budgetDowngradeFromEnv({ WORKFLOW_BUDGET_DOWNGRADE_MODEL: "   ", WORKFLOW_BUDGET_DOWNGRADE_FRACTION: "   " }, warn),
    undefined,
    "both axes blank is honest absence (the both-absent branch), not a warning case",
  );
  assert.deepEqual(messages, [], "no warnings on any non-operator-asked path");
});

test("W122: the default warn reaches the operator console with the [budget] prefix", () => {
  const seen: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown, ...rest: unknown[]) => { seen.push([String(message), ...rest.map(String)].join(" ")); };
  try {
    assert.equal(
      budgetDowngradeFromEnv({ WORKFLOW_BUDGET_DOWNGRADE_MODEL: "glm-5.3-flash", WORKFLOW_BUDGET_DOWNGRADE_FRACTION: "1.5" }),
      undefined,
      "no injection: the production default path",
    );
  } finally {
    console.warn = original;
  }
  assert.equal(seen.length, 1, "the default warn fired through the real console");
  assert.ok(seen[0]!.startsWith("[budget]"), "the prefix matches the hub's budget-log convention");
});
