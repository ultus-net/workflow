import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createRunRegistry } from "../src/integrations/run-registry.js";

/**
 * Iteration 21: the reasoning-claim accountability feed + honest metrics at the
 * run registry (observability-only; recall/TTR explicitly unmeasured).
 */

const tasks: WorkflowTask[] = [{ id: taskId("W1"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] }];

function registry() {
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    process.cwd(),
  );
  return { application, registry: createRunRegistry(application, graph) };
}

test("reasoning-claim feed: findings are journaled, surfaced, and counted with honest metrics", async () => {
  const { application, registry: runs } = registry();
  await runs.controller.begin({ runId: "r1", title: "Run one" });
  await runs.controller.begin({ runId: "r2", title: "Run two" });

  const before = application.snapshot().tasks.find((task) => task.title === "Run one")?.state;
  runs.recordReasoningClaim({ runId: "r1", sentence: "the tests all pass" });

  const finding = runs.reasoningClaims().get("r1");
  assert.equal(finding?.sentence, "the tests all pass");
  assert.equal(typeof finding?.observedAt, "string");
  assert.equal(runs.reasoningClaims().get("r2"), undefined);

  // The feed rides gateObservability (observation only).
  assert.equal(runs.controller.gateObservability?.().reasoningClaims?.get("r1")?.sentence, "the tests all pass");

  assert.equal(runs.reasoningClaimMetrics().monitoredRuns, 0, "beginning a run does not claim monitor coverage");
  runs.noteReasoningClaimMonitor({ runId: "r1" });
  runs.noteReasoningClaimMonitor({ runId: "r1" });
  assert.equal(runs.reasoningClaimMetrics().monitoredRuns, 1, "an observed run counts once (deduped)");
  runs.noteReasoningClaimMonitor({ runId: "r2" });

  const metrics = runs.reasoningClaimMetrics();
  assert.equal(metrics.monitoredRuns, 2, "coverage denominator counts runs the monitor actually observed");
  assert.equal(metrics.flaggedRuns, 1);
  assert.equal(metrics.findings, 1);
  assert.equal(metrics.recall, "unmeasured", "recall is never claimed without misbehavior labels");
  assert.equal(metrics.timeToResponseMs, "unmeasured", "no responder exists to measure latency");
  assert.deepEqual(
    runs.controller.gateObservability?.().reasoningClaimMetrics,
    metrics,
    "the snapshot payload carries the same metrics object",
  );

  // A second finding on the same run increments findings, not flaggedRuns.
  runs.recordReasoningClaim({ runId: "r1", sentence: "the build passes" });
  assert.equal(runs.reasoningClaimMetrics().flaggedRuns, 1);
  assert.equal(runs.reasoningClaimMetrics().findings, 2);
  assert.equal(runs.reasoningClaims().get("r1")?.sentence, "the build passes", "the latest finding per run wins");

  // A finding on another run counts once.
  runs.recordReasoningClaim({ runId: "r2", sentence: "verified" });
  assert.equal(runs.reasoningClaimMetrics().flaggedRuns, 2);
  assert.equal(runs.reasoningClaimMetrics().findings, 3);

  // Observability-only: a finding never advances/blocks a task or becomes evidence.
  const after = application.snapshot().tasks.find((task) => task.title === "Run one")?.state;
  assert.equal(after, before, "the feed never mutates canonical task state");
  assert.equal(application.snapshot().evidence.length, 0, "a finding is never evidence");

  // Unknown runs are accepted — the feed is not authorization.
  runs.recordReasoningClaim({ runId: "ghost", sentence: "claims about a run that never was" });
  assert.equal(runs.reasoningClaims().get("ghost")?.sentence, "claims about a run that never was");
});
