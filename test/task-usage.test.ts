import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelUsageMetrics } from "../src/integrations/model-usage-proxy.js";
import {
  TaskUsageTracker,
  UNATTRIBUTED_TASK_ID,
  resolveActiveTaskId,
  taskUsageDelta,
} from "../src/integrations/task-usage.js";

/**
 * W111 per-task attribution: the pure boundary arithmetic
 * (docs/W111_ATTRIBUTION_DESIGN_BRIEF.md §2.3 / §4). These pin the DECIDED
 * mechanism — baseline-at-start/delta-at-end, the active-task pointer read,
 * the recorded absence on a throwing read, failed/cancelled no-delta, and the
 * P12 cache fields riding the delta. The host-lane wiring is deliberately NOT
 * pinned here (the brief §5 lane decisions stay open).
 */

const metrics = (overrides: Partial<ModelUsageMetrics> = {}): ModelUsageMetrics => ({
  requests: 0,
  usageEvents: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  latestPromptTokens: undefined,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  ...overrides,
});

test("W111: the tracker computes baseline-at-start / delta-at-end per field", () => {
  const tracker = new TaskUsageTracker();
  tracker.begin(
    metrics({ requests: 2, promptTokens: 100, completionTokens: 20, totalTokens: 120, costUsd: 0.01, cacheReadTokens: 40, cacheCreateTokens: 5 }),
  );
  const delta = tracker.complete(
    metrics({ requests: 5, promptTokens: 300, completionTokens: 50, totalTokens: 350, costUsd: 0.04, cacheReadTokens: 120, cacheCreateTokens: 9 }),
    () => "W42",
  );
  assert.deepEqual(delta, {
    taskId: "W42",
    requests: 3,
    promptTokens: 200,
    completionTokens: 30,
    totalTokens: 230,
    costUsd: 0.03,
    cacheReadTokens: 80,
    cacheCreateTokens: 4,
  });
  // The baseline is consumed: a second completion with no fresh begin
  // publishes nothing rather than re-emitting the same delta.
  assert.equal(tracker.complete(metrics({ totalTokens: 400 }), () => "W42"), undefined);
});

test("W111: the delta is floored at zero and carries the P12 cache fields", () => {
  // Counters should not move backwards within a turn, but if they do (a
  // restart or reset), the delta never reports negative spend.
  const delta = taskUsageDelta(
    metrics({ totalTokens: 100, costUsd: 0.02, cacheReadTokens: 30, cacheCreateTokens: 4 }),
    metrics({ totalTokens: 80, costUsd: 0.01, cacheReadTokens: 10, cacheCreateTokens: 0 }),
    "W42",
  );
  assert.equal(delta?.totalTokens, 0);
  assert.equal(delta?.costUsd, 0);
  assert.equal(delta?.cacheReadTokens, 0);
  assert.equal(delta?.cacheCreateTokens, 0);
  // No baseline or no current reading → no delta (never a fabricated zero).
  assert.equal(taskUsageDelta(undefined, metrics(), "W42"), undefined);
  assert.equal(taskUsageDelta(metrics(), undefined, "W42"), undefined);
});

test("W111: observe mirrors the UsageTurnTracker state machine — only completed publishes", () => {
  const tracker = new TaskUsageTracker();
  const start = metrics({ totalTokens: 100, costUsd: 0.01 });
  const end = metrics({ totalTokens: 160, costUsd: 0.013, cacheReadTokens: 12, cacheCreateTokens: 2 });
  assert.equal(tracker.observe("running", start, () => "W42"), undefined, "running only baselines");
  assert.deepEqual(tracker.observe("completed", end, () => "W42"), {
    taskId: "W42",
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 60,
    costUsd: 0.013 - 0.01,
    cacheReadTokens: 12,
    cacheCreateTokens: 2,
  });
  // failed and cancelled end the turn but publish NO delta, and clear the
  // baseline so it never leaks into the next turn.
  tracker.observe("running", start, () => "W42");
  assert.equal(tracker.observe("failed", end, () => "W42"), undefined);
  tracker.observe("running", start, () => "W42");
  assert.equal(tracker.observe("cancelled", end, () => "W42"), undefined);
  // A completed session with no observed baseline never invents a delta.
  assert.equal(tracker.observe("completed", end, () => "W42"), undefined);
});

test("W111: the pointer read is never inferred; a throwing read records the unattributed absence", () => {
  const tracker = new TaskUsageTracker();
  tracker.begin(metrics({ totalTokens: 50 }));
  const delta = tracker.complete(metrics({ totalTokens: 70 }), () => {
    throw new TypeError("no active workflow task selected");
  });
  assert.equal(delta?.taskId, UNATTRIBUTED_TASK_ID, "an absent pointer is recorded as the explicit marker, not guessed");
  assert.equal(delta?.totalTokens, 20, "the spend is still recorded, attributed to the absence");

  // The resolver returns a live pointer verbatim and never fabricates one.
  assert.equal(resolveActiveTaskId(() => "W42"), "W42");
  assert.equal(resolveActiveTaskId(() => {
    throw new TypeError("active task W42 is VERIFIED");
  }), UNATTRIBUTED_TASK_ID);
});
