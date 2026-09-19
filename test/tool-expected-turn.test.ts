import assert from "node:assert/strict";
import { test } from "node:test";

import { createToolExpectedTurnSteering } from "../src/application/tool-expected-turn.js";

test("tool-expected-turn steering re-prompts at most twice then escalates", () => {
  const steering = createToolExpectedTurnSteering({
    scope: () => ({ mutationScoped: true, taskInProgress: true }),
    maxRetries: 2,
  });

  assert.equal(steering.observe({ hadToolCall: false }).action, "re-prompt");
  assert.equal(steering.observe({ hadToolCall: false }).action, "re-prompt");
  const third = steering.observe({ hadToolCall: false });
  assert.equal(third.action, "escalate");
  // The cap holds: a fourth no-tool turn must not re-prompt again.
  assert.equal(steering.observe({ hadToolCall: false }).action, "escalate");

  assert.deepEqual(steering.stats(), { toolTurns: 0, noToolTurns: 4, reprompts: 2, escalations: 2 });
});

test("a tool-call turn resets the retry budget", () => {
  const steering = createToolExpectedTurnSteering({
    scope: () => ({ mutationScoped: true, taskInProgress: true }),
    maxRetries: 2,
  });
  assert.equal(steering.observe({ hadToolCall: false }).action, "re-prompt");
  assert.equal(steering.observe({ hadToolCall: true }).action, "none");
  assert.equal(steering.observe({ hadToolCall: false }).action, "re-prompt");
  assert.equal(steering.observe({ hadToolCall: false }).action, "re-prompt");
  assert.equal(steering.observe({ hadToolCall: false }).action, "escalate");
  assert.deepEqual(steering.stats(), { toolTurns: 1, noToolTurns: 4, reprompts: 3, escalations: 1 });
});

test("steering is inert outside a mutation-scoped in-progress task", () => {
  const steering = createToolExpectedTurnSteering({
    scope: () => ({ mutationScoped: false, taskInProgress: true }),
    maxRetries: 2,
  });
  for (let turn = 0; turn < 5; turn += 1) {
    assert.equal(steering.observe({ hadToolCall: false }).action, "none");
  }
  assert.deepEqual(steering.stats(), { toolTurns: 0, noToolTurns: 5, reprompts: 0, escalations: 0 });
});

test("the corrective prompt names the expected tool class", () => {
  const steering = createToolExpectedTurnSteering({
    scope: () => ({ mutationScoped: true, taskInProgress: true }),
    expectedToolClass: "the edit tool",
  });
  const decision = steering.observe({ hadToolCall: false });
  assert.equal(decision.action, "re-prompt");
  if (decision.action === "re-prompt") {
    assert.match(decision.prompt, /the edit tool/);
    assert.match(decision.prompt, /1\/2/);
  }
});
