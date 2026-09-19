import assert from "node:assert/strict";
import { test } from "node:test";

import { createOpencodeServerBudget } from "../src/integrations/opencode-server-budget.js";
import type { ModelUsageMetrics } from "../src/integrations/model-usage-proxy.js";

/**
 * W071 M4 — the session-budget watcher for the server path: crossing a cap is
 * sticky, aborts active sessions once, and never fires twice.
 */

const usage = (overrides: Partial<Pick<ModelUsageMetrics, "promptTokens" | "completionTokens" | "totalTokens" | "costUsd">> = {}): ModelUsageMetrics => ({
  requests: 1, usageEvents: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.001, latestPromptTokens: undefined, ...overrides,
});

test("W071 budget: no caps crossed leaves the watcher clean", () => {
  const aborted: string[] = [];
  const watcher = createOpencodeServerBudget({
    budget: { maxTotalTokens: 1000 },
    usage: () => usage({ totalTokens: 500 }),
    abort: async (sessionId) => { aborted.push(sessionId); },
    knownSessions: () => ["s1"],
  });
  assert.equal(watcher.check(), undefined);
  assert.equal(watcher.violation(), undefined);
  assert.deepEqual(aborted, []);
  watcher.stop();
});

test("W071 budget: total tokens crossing the cap aborts known sessions and is sticky", () => {
  const aborted: string[] = [];
  const violations: string[] = [];
  // Usage crosses between checks: first clean, then over.
  let total = 100;
  const watcher = createOpencodeServerBudget({
    budget: { maxTotalTokens: 1000 },
    usage: () => usage({ totalTokens: total }),
    abort: async (sessionId) => { aborted.push(sessionId); },
    knownSessions: () => ["s1", "s2"],
    onViolation: (reason) => violations.push(reason),
  });
  assert.equal(watcher.check(), undefined);
  total = 5000;
  const reason = watcher.check();
  assert.match(reason ?? "", /exceeded the session budget cap 1000/);
  assert.deepEqual([...aborted].sort(), ["s1", "s2"]);
  assert.equal(violations.length, 1);
  // Sticky: a second check returns the same reason and does not re-abort.
  assert.equal(watcher.check(), reason);
  assert.equal(aborted.length, 2);
  watcher.stop();
});

test("W071 budget: cost and per-direction caps are honored independently", () => {
  const make = (budget: Parameters<typeof createOpencodeServerBudget>[0]["budget"], metrics: ReturnType<typeof usage>) =>
    createOpencodeServerBudget({
      budget,
      usage: () => metrics,
      abort: async () => undefined,
      knownSessions: () => [],
    });
  const cost = make({ maxCostUsd: 0.0005 }, usage({ costUsd: 0.01 }));
  assert.match(cost.check() ?? "", /cost \$0.0100 exceeded/);
  cost.stop();
  const input = make({ maxInputTokens: 5 }, usage({ promptTokens: 10 }));
  assert.match(input.check() ?? "", /input tokens 10 exceeded/);
  input.stop();
  const output = make({ maxOutputTokens: 1 }, usage({ completionTokens: 5 }));
  assert.match(output.check() ?? "", /output tokens 5 exceeded/);
  output.stop();
});

test("W071 budget: no usage recorded means no verdict", () => {
  const watcher = createOpencodeServerBudget({
    budget: { maxTotalTokens: 1 },
    usage: () => undefined,
    abort: async () => undefined,
    knownSessions: () => ["s1"],
  });
  assert.equal(watcher.check(), undefined);
  watcher.stop();
});