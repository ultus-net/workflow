import assert from "node:assert/strict";
import test from "node:test";

import { OpenCodeV2CircuitBreaker } from "../src/integrations/opencode-v2-circuit-breaker.js";

const stats = (failed: number) => ({ sessions: 1, subagents: 0, prompts: 1, steps: 1, cost: 0, tools: { calls: failed + 1, succeeded: 1, failed, unfinished: 0 } });

test("v2 circuit breaker counts policy failures by durable session identity", () => {
  const breaker = new OpenCodeV2CircuitBreaker();
  const identity = { sessionId: "ses-1", taskId: "task-1", stepId: "step-1" };
  assert.equal(breaker.recordFailure(identity, "policy_denial", "bash"), 1);
  assert.equal(breaker.recordFailure(identity, "policy_denial", "bash"), 2);
  assert.equal(breaker.isOpen("ses-1", "task-1", "step-1"), true);
  breaker.recordSuccess("ses-1", "task-1", "step-1");
  assert.equal(breaker.isOpen("ses-1", "task-1", "step-1"), false);
});

test("v2 circuit breaker observes stats deltas without making stats authoritative", () => {
  const breaker = new OpenCodeV2CircuitBreaker();
  assert.deepEqual(breaker.observeStats("ses-1", stats(2)), { failedDelta: 2, totalFailed: 2 });
  assert.deepEqual(breaker.observeStats("ses-1", stats(3)), { failedDelta: 1, totalFailed: 3 });
  assert.equal(breaker.isOpen("ses-1"), false, "stats alone must not authorize or open the Workflow gate");
});