import assert from "node:assert/strict";
import { test } from "node:test";

import { UsageTurnTracker, formatUsageLine, usageViewFromMetrics, type UsageView } from "../src/ui/usage.js";

const view = (totalTokens: number, costUsd: number): UsageView => ({ totalTokens, costUsd });

test("usageViewFromMetrics maps the proxy's cumulative metrics", () => {
  assert.equal(usageViewFromMetrics(undefined), undefined);
  assert.deepEqual(
    usageViewFromMetrics({ requests: 1, usageEvents: 1, promptTokens: 90, completionTokens: 30, totalTokens: 120, costUsd: 0.002, latestPromptTokens: 90 }),
    { totalTokens: 120, costUsd: 0.002 },
  );
});

test("the turn tracker publishes a per-turn delta at turn boundaries", () => {
  const tracker = new UsageTurnTracker();
  // Turn 1: baseline at running, delta at completed.
  const start = tracker.observe("running", view(1000, 0.0100));
  assert.deepEqual(start, { totalTokens: 1000, costUsd: 0.0100 });
  const end = tracker.observe("completed", view(1120, 0.0111));
  assert.deepEqual(end, { totalTokens: 1120, costUsd: 0.0111, perTurnTokens: 120, perTurnCostUsd: 0.0111 - 0.0100 });
  // The delta is sticky between turns (idle shows the last turn's figures).
  assert.deepEqual(tracker.observe("idle", view(1120, 0.0111)), { totalTokens: 1120, costUsd: 0.0111, perTurnTokens: 120, perTurnCostUsd: 0.0111 - 0.0100 });
  // Turn 2 baselines fresh — the per-turn figure reflects only turn 2.
  tracker.observe("running", view(1120, 0.0111));
  const second = tracker.observe("completed", view(1300, 0.0130));
  assert.deepEqual(second, { totalTokens: 1300, costUsd: 0.0130, perTurnTokens: 180, perTurnCostUsd: 0.0130 - 0.0111 });
});

test("failed and cancelled turns publish no per-turn figure", () => {
  const tracker = new UsageTurnTracker();
  tracker.observe("running", view(500, 0.005));
  const failed = tracker.observe("failed", view(600, 0.006));
  assert.deepEqual(failed, { totalTokens: 600, costUsd: 0.006 });
  // A failed turn never leaves a stale baseline behind.
  tracker.observe("running", view(600, 0.006));
  const cancelled = tracker.observe("cancelled", view(700, 0.007));
  assert.deepEqual(cancelled, { totalTokens: 700, costUsd: 0.007 });
});

test("a completed session without a running baseline never invents a delta", () => {
  const tracker = new UsageTurnTracker();
  // The UI may mount mid-turn (state already running observed only via poll
  // gaps) or a session may complete with no observed baseline: no delta.
  const observed = tracker.observe("completed", view(8668, 0.0132));
  assert.deepEqual(observed, { totalTokens: 8668, costUsd: 0.0132 });
  assert.equal("perTurnTokens" in observed, false);
});

test("the usage line formats cumulative and per-turn figures", () => {
  assert.equal(formatUsageLine(view(8668, 0.0132)), "8668 tokens · $0.0132");
  assert.equal(
    formatUsageLine({ totalTokens: 8668, costUsd: 0.0132, perTurnTokens: 120, perTurnCostUsd: 0.0011 }),
    "8668 tokens · $0.0132 · +120 this turn · $0.0011",
  );
});
