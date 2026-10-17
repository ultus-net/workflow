import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenRouterProvider } from "../src/assistant/provider/openrouter.js";
import { runResearchEntry } from "../src/assistant/research/entry.js";
import { ConductorCheckpointStore } from "../src/integrations/conductor-checkpoint.js";

/**
 * W216: the production entry point for the deep-research conductor.
 *
 * These exercise `runResearchEntry` — the REAL composition (file artifact
 * store, checkpoint load/create, budget derivation, OpenRouter port binding) —
 * through a fake `fetchImpl`, so the whole run is offline and deterministic.
 * Nothing here builds a stub conductor: the point is that the entry point
 * wires the real thing end to end.
 *
 * The fake endpoint inspects the request body to decide the role: a
 * `response_format` marks the plan call, a `tools` array marks a worker, and
 * everything else is synthesis.
 */

type Role = "plan" | "worker" | "synthesize";

function roleOf(body: Record<string, unknown>): Role {
  if (body.response_format !== undefined) return "plan";
  if (Array.isArray(body.tools)) return "worker";
  return "synthesize";
}

const PLAN_JSON = JSON.stringify({
  subQuestions: [{ subQuestion: "What is X?" }, { subQuestion: "What is Y?" }],
});
const FINAL_ANSWER = "# Answer\n\nSynthesized from the two findings.\n\nSource: [a](https://example.com/a)\n";

interface FakeLane {
  readonly provider: OpenRouterProvider;
  /** Roles in call order, shared across runs so a caller can count per-role. */
  readonly calls: Role[];
}

function fakeLane(): FakeLane {
  const calls: Role[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const role = roleOf(body);
    calls.push(role);
    const content =
      role === "plan"
        ? PLAN_JSON
        : role === "worker"
          ? "# finding\n\nA grounded paragraph with a [source](https://example.com/a).\n\n## Sources\n- [a](https://example.com/a)\n"
          : FINAL_ANSWER;
    return new Response(
      JSON.stringify({
        model: body.model,
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, server_tool_use: { web_search_requests: 1 } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const provider = new OpenRouterProvider({
    endpoint: "https://example.invalid/v1/chat/completions",
    authorization: "Bearer test",
    config: { models: ["m"], variant: "", allowFallbacks: true },
    fetchImpl,
  });
  return { provider, calls };
}

function countRole(calls: readonly Role[], role: Role): number {
  return calls.filter((r) => r === role).length;
}

test("runResearchEntry: writes the answer, worker artifacts, and a digests checkpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-research-entry-"));
  try {
    const lane = fakeLane();
    const result = await runResearchEntry({
      question: "compare X and Y",
      complexity: "comparison",
      lang: "en",
      runId: "entry-1",
      root: dir,
      provider: lane.provider,
    });

    // The answer file holds the synthesized text.
    assert.ok(existsSync(result.answerPath), "answer.md is written");
    assert.match(readFileSync(result.answerPath, "utf8"), /Synthesized from the two findings/);
    assert.equal(result.answerPath, join(dir, "answer.md"));
    assert.equal(result.checkpointPath, join(dir, "checkpoint.json"));
    assert.equal(result.artifactRoot, join(dir, "findings"));
    assert.match(result.outcome.answer, /Synthesized/);

    // One worker artifact per planned sub-question, under <root>/findings/.
    assert.ok(existsSync(join(result.artifactRoot, "search.subquestion.1.md")), "worker 1 artifact landed");
    assert.ok(existsSync(join(result.artifactRoot, "search.subquestion.2.md")), "worker 2 artifact landed");

    // The checkpoint carries the rolled-up digests.
    assert.ok(existsSync(result.checkpointPath), "checkpoint.json is written");
    const persisted = JSON.parse(readFileSync(result.checkpointPath, "utf8")) as {
      dispatched: { stepId: string; digest: string; status: string }[];
    };
    assert.equal(persisted.dispatched.length, 2, "both dispatches recorded");
    for (const entry of persisted.dispatched) {
      assert.equal(entry.status, "done");
      assert.ok(typeof entry.digest === "string" && entry.digest.length > 0, `digest recorded for ${entry.stepId}`);
    }

    // Roles: one plan, two workers, one synthesis.
    assert.equal(countRole(lane.calls, "plan"), 1);
    assert.equal(countRole(lane.calls, "worker"), 2);
    assert.equal(countRole(lane.calls, "synthesize"), 1);

    // Run 2: same runId + root resumes — skip both workers, do NOT re-call them.
    const before = lane.calls.length;
    const resumed = await runResearchEntry({
      question: "compare X and Y",
      complexity: "comparison",
      lang: "en",
      runId: "entry-1",
      root: dir,
      provider: lane.provider,
    });
    const added = lane.calls.slice(before);
    assert.deepEqual(
      [...resumed.outcome.skipped].sort(),
      ["search.subquestion.1", "search.subquestion.2"],
      "the second run reports both steps skipped",
    );
    assert.equal(countRole(added, "worker"), 0, "no worker is re-called on resume");
    assert.equal(countRole(added, "plan"), 0, "the persisted plan is reused, not re-planned");
    assert.equal(countRole(added, "synthesize"), 1, "synthesis still runs from the recorded findings");
    assert.match(readFileSync(resumed.answerPath, "utf8"), /Synthesized/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runResearchEntry: a 2-task plan under a 1-subagent budget reports exhaustion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-research-entry-budget-"));
  try {
    // Seed a checkpoint that already holds a 2-task plan (a resumed run), so the
    // plan port's own maxSubagents trim does not mask the budget breaker.
    new ConductorCheckpointStore(
      {
        runId: "entry-2",
        plan: [
          { stepId: "search.subquestion.1", subQuestion: "What is X?", role: "search" },
          { stepId: "search.subquestion.2", subQuestion: "What is Y?", role: "search" },
        ],
        dispatched: [],
        cursor: 0,
      },
      { path: join(dir, "checkpoint.json") },
    );

    const lane = fakeLane();
    const result = await runResearchEntry({
      question: "compare X and Y",
      complexity: "comparison",
      lang: "en",
      runId: "entry-2",
      root: dir,
      provider: lane.provider,
      maxSubagents: 1,
    });

    assert.equal(result.outcome.budgetExhausted, true, "the run stopped at the subagent cap");
    assert.equal(result.outcome.usage.subagents, 1, "exactly one worker spent the budget");
    assert.equal(countRole(lane.calls, "worker"), 1, "the second worker was never dispatched");
    assert.equal(countRole(lane.calls, "plan"), 0, "the seeded plan was reused");
    // The answer is still written honestly from the one finding that completed.
    assert.ok(existsSync(result.answerPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runResearchEntry: new runs are independent when the run id differs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-research-entry-fresh-"));
  try {
    const lane = fakeLane();
    const first = await runResearchEntry({
      question: "a question",
      complexity: "simple",
      lang: "en",
      runId: "fresh-a",
      root: join(dir, "fresh-a"),
      provider: lane.provider,
    });
    const second = await runResearchEntry({
      question: "a question",
      complexity: "simple",
      lang: "en",
      runId: "fresh-b",
      root: join(dir, "fresh-b"),
      provider: lane.provider,
    });
    assert.equal(first.outcome.skipped.length, 0);
    assert.equal(second.outcome.skipped.length, 0);
    assert.notEqual(first.checkpointPath, second.checkpointPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
