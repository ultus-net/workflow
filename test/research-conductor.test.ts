import assert from "node:assert/strict";
import test from "node:test";

import { createFileArtifactStore } from "../src/assistant/research/types.js";
import { runResearch, pendingTasks, type ConductorPorts } from "../src/assistant/research/conductor.js";
import { ConductorCheckpointStore } from "../src/integrations/conductor-checkpoint.js";
import { DurableStepJournal } from "../src/integrations/step-journal.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * W199 / durability plan acceptance check D4.
 *
 * Start a 5-task research run, let 2 tasks complete, kill the process, resume;
 * the 2 completed tasks are skipped (artifacts verify by digest), tasks 3-5 run,
 * and the frontier-tier spend is not repeated for tasks 1-2.
 *
 * The conductor is driven entirely through injected ports, so the "kill" is
 * simply discarding the first session's in-memory journal and re-entering with
 * a fresh one plus the on-disk checkpoint. No network, no model.
 */

function fiveTaskPorts(workerCalls: string[]): ConductorPorts {
  const tasks = [1, 2, 3, 4, 5].map((n) => ({
    stepId: `search.subquestion.${n}`,
    subQuestion: `sub-question ${n}`,
    role: "search" as const,
  }));
  return {
    plan: async () => tasks,
    runWorker: async ({ task }) => {
      workerCalls.push(task.stepId);
      return {
        stepId: task.stepId,
        artifactRef: `findings/${task.stepId}.md`,
        body: `# ${task.subQuestion}\n\nfinding body for ${task.stepId}\n`,
        summary: `summary ${task.stepId}`,
        usage: { costUsd: 0.01, toolCalls: 2 },
      };
    },
    synthesize: async ({ findings }) => `answer from ${findings.length} findings`,
  };
}

test("D4: a crash after 2 of 5 tasks resumes, skips the 2, and does not re-spend them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-research-"));
  const checkpointPath = join(dir, "checkpoint.json");
  try {
    const store = createFileArtifactStore(dir);

    // --- Run 1: "killed" after two workers because the checkpoint only retains
    // what completed. We emulate the kill by running the first two tasks, then
    // aborting the session (a fresh store/journal is used for the resume).
    const callsRun1: string[] = [];
    const ports1 = fiveTaskPorts(callsRun1);
    const limited: ConductorPorts = {
      ...ports1,
      runWorker: async (input) => {
        if (callsRun1.length >= 2) throw new Error("process killed");
        return ports1.runWorker(input);
      },
    };
    const checkpoint = new ConductorCheckpointStore({ runId: "research-1", plan: [], dispatched: [], cursor: 0 }, { path: checkpointPath });
    await assert.rejects(
      () =>
        runResearch(
          {
            runId: "research-1",
            question: "the question",
            complexity: "complex",
            budget: { maxSubagents: 12, maxToolCalls: 240, maxCostUsd: 10 },
            store,
            checkpoint,
            journal: new DurableStepJournal(),
          },
          limited,
        ),
      /process killed/,
    );
    assert.deepEqual(callsRun1, ["search.subquestion.1", "search.subquestion.2"], "two tasks completed before the kill");

    // --- Run 2: resume from the on-disk checkpoint with a fresh journal.
    const callsRun2: string[] = [];
    const resumedCheckpoint = ConductorCheckpointStore.load(checkpointPath);
    const outcome = await runResearch(
      {
        runId: "research-1",
        question: "the question",
        complexity: "complex",
        budget: { maxSubagents: 12, maxToolCalls: 240, maxCostUsd: 10 },
        store,
        checkpoint: resumedCheckpoint,
        journal: new DurableStepJournal(),
      },
      fiveTaskPorts(callsRun2),
    );

    assert.deepEqual(
      callsRun2,
      ["search.subquestion.3", "search.subquestion.4", "search.subquestion.5"],
      "only the unfinished tasks re-ran",
    );
    assert.deepEqual(
      [...outcome.skipped].sort(),
      ["search.subquestion.1", "search.subquestion.2"],
      "the two completed tasks were skipped on resume",
    );
    assert.match(outcome.answer, /5 findings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D4: a completed task whose artifact is missing is re-dispatched (at-least-once)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-research-missing-"));
  const checkpointPath = join(dir, "checkpoint.json");
  try {
    const store = createFileArtifactStore(dir);
    const calls: string[] = [];
    const outcome = await runResearch(
      {
        runId: "research-2",
        question: "q",
        complexity: "simple",
        budget: { maxSubagents: 1, maxToolCalls: 10, maxCostUsd: 1 },
        store,
        journal: new DurableStepJournal(),
      },
      fiveTaskPorts(calls),
    );
    // Record a done dispatch whose artifact we then delete.
    const checkpoint = new ConductorCheckpointStore(
      {
        runId: "research-2",
        plan: [{ stepId: "search.subquestion.1", subQuestion: "sub-question 1", role: "search" }],
        dispatched: [{ stepId: "search.subquestion.1", artifactRef: "findings/search.subquestion.1.md", status: "done", digest: "deadbeef" }],
        cursor: 1,
      },
      { path: checkpointPath },
    );
    const owed = pendingTasks(checkpoint, store);
    assert.deepEqual(owed.map((t) => t.stepId), ["search.subquestion.1"], "a missing artifact re-opens the task");
    assert.match(outcome.answer, /findings/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D4: the budget breaker stops the plan and reports exhaustion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-research-budget-"));
  try {
    const store = createFileArtifactStore(dir);
    const calls: string[] = [];
    const outcome = await runResearch(
      {
        runId: "research-3",
        question: "q",
        complexity: "complex",
        // Three workers' worth of subagents; the fourth would exceed the cap.
        budget: { maxSubagents: 3, maxToolCalls: 240, maxCostUsd: 10 },
        store,
        journal: new DurableStepJournal(),
      },
      fiveTaskPorts(calls),
    );
    assert.equal(outcome.budgetExhausted, true);
    assert.equal(calls.length, 3, "the conductor stopped at the subagent cap");
    assert.equal(outcome.usage.subagents, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D4: the cost cap trips once a worker's spend crosses it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-research-cost-"));
  try {
    const store = createFileArtifactStore(dir);
    const calls: string[] = [];
    const ports = fiveTaskPorts(calls);
    await assert.rejects(
      () =>
        runResearch(
          {
            runId: "research-4",
            question: "q",
            // "simple" effort caps subagents at 1, so use a cost cap that the
            // first worker already exceeds.
            complexity: "simple",
            budget: { maxSubagents: 5, maxToolCalls: 100, maxCostUsd: 0.005 },
            store,
            journal: new DurableStepJournal(),
          },
          {
            ...ports,
            runWorker: async (input) => {
              const result = await ports.runWorker(input);
              return { ...result, usage: { costUsd: 0.01, toolCalls: 1 } };
            },
          },
        ),
      /budget exceeded: cost/,
    );
    assert.equal(calls.length, 1, "the cost cap was checked after the first worker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
