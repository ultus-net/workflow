import { ConductorCheckpointStore, artifactDigest, type ConductorDispatch } from "../../integrations/conductor-checkpoint.js";
import { DurableStepJournal, type StepKey } from "../../integrations/step-journal.js";
import {
  artifactVerifies,
  emptyUsage,
  researchEffort,
  type ArtifactStore,
  type ResearchBudget,
  type ResearchComplexity,
  type ResearchTask,
  type ResearchUsage,
  type WorkerResult,
} from "./types.js";

/**
 * The research conductor (deep-research step 0).
 *
 * Role split, the cost-control core of the orchestrator-worker design
 * (`planning-questions.md`, deep-research section):
 *
 *   - The CONDUCTOR plans and synthesizes on the frontier tier (few tokens).
 *   - The WORKERS search and verify on the cheap tier (many tokens), each with
 *     its own context and its web-search loop, and each handing back an
 *     ARTIFACT REFERENCE rather than its transcript.
 *
 * Every model call is an injected function, so the conductor holds no provider
 * and no transport. That keeps it inside the assistant's kernel-purity posture
 * and lets the whole thing be tested offline with a fake planner/worker.
 *
 * Durability composition (W199): the conductor takes a `DurableStepJournal`
 * (D1, dedupes each worker by step key on replay) and a
 * `ConductorCheckpointStore` (D4, the plan + dispatched refs + cursor). On a
 * restart, `resume()` skips completed steps whose artifacts still verify and
 * re-dispatches the rest without re-spending the frontier tier on synthesis it
 * already has.
 */

export interface ConductorPorts {
  /** Decompose the question into sub-questions at the chosen effort. */
  plan(input: {
    readonly question: string;
    readonly complexity: ResearchComplexity;
    readonly maxSubagents: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly ResearchTask[]>;
  /** Run one worker (search or verify). The only place a worker model is called. */
  runWorker(input: {
    readonly task: ResearchTask;
    readonly maxToolCalls: number;
    readonly signal?: AbortSignal;
  }): Promise<WorkerResult>;
  /** Synthesize the final answer from artifact references and short summaries. */
  synthesize(input: {
    readonly question: string;
    readonly findings: readonly { readonly stepId: string; readonly artifactRef: string; readonly summary?: string }[];
    readonly signal?: AbortSignal;
  }): Promise<string>;
}

export interface RunResearchInput {
  readonly runId: string;
  readonly question: string;
  readonly complexity: ResearchComplexity;
  readonly budget: ResearchBudget;
  readonly store: ArtifactStore;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  /** Durable journal for worker step keys. Defaults to a fresh in-memory one. */
  readonly journal?: DurableStepJournal;
  /** Durable plan/dispatch checkpoint. Enables resume semantics. */
  readonly checkpoint?: ConductorCheckpointStore;
}

export interface ResearchOutcome {
  readonly answer: string;
  readonly dispatched: readonly ConductorDispatch[];
  readonly usage: ResearchUsage;
  /** True when the run stopped at the budget rather than completing the plan. */
  readonly budgetExhausted: boolean;
  /** Step ids skipped on resume because their artifact still verified. */
  readonly skipped: readonly string[];
}

export function researchBudget(complexity: ResearchComplexity): ResearchBudget {
  const effort = researchEffort(complexity);
  return {
    maxSubagents: effort.maxSubagents,
    maxToolCalls: effort.maxSubagents * effort.maxToolCallsPerSubagent,
    // Cost has no sensible complexity-derived default; the caller must pass one
    // and this value is only the ceiling used when the caller leaves it open.
    maxCostUsd: Number.POSITIVE_INFINITY,
  };
}

function keyFor(runId: string, stepId: string): StepKey {
  return { runId, stepId, attempt: 0 };
}

function assertWithinBudget(budget: ResearchBudget, usage: ResearchUsage): void {
  if (usage.subagents > budget.maxSubagents) throw new Error(`research budget exceeded: subagents ${usage.subagents} > ${budget.maxSubagents}`);
  if (usage.toolCalls > budget.maxToolCalls) throw new Error(`research budget exceeded: tool calls ${usage.toolCalls} > ${budget.maxToolCalls}`);
  if (usage.costUsd > budget.maxCostUsd) throw new Error(`research budget exceeded: cost $${usage.costUsd.toFixed(4)} > $${budget.maxCostUsd.toFixed(4)}`);
}

/** Tasks owed for `runId`, honouring the persisted plan and artifact digests. */
function owedTasks(
  input: RunResearchInput,
  plan: readonly ResearchTask[],
): readonly ResearchTask[] {
  if (input.checkpoint === undefined) return plan;
  const done = new Set(
    input.checkpoint.checkpoint.dispatched
      .filter((entry) => entry.status === "done" && artifactVerifies(input.store, entry.artifactRef, entry.digest))
      .map((entry) => entry.stepId),
  );
  const byId = new Map(plan.map((task) => [task.stepId, task]));
  // A dispatched step that is not in the plan (the plan changed across a
  // restart) is still re-dispatched from the checkpoint entry, so completed
  // frontier work is never silently dropped.
  const extras: ResearchTask[] = input.checkpoint.checkpoint.dispatched
    .filter((entry) => !byId.has(entry.stepId) && !done.has(entry.stepId))
    .map((entry) => ({ stepId: entry.stepId, subQuestion: entry.stepId, role: "search" }));
  return [...plan.filter((task) => !done.has(task.stepId)), ...extras];
}

export async function runResearch(input: RunResearchInput, ports: ConductorPorts): Promise<ResearchOutcome> {
  const now = input.now ?? ((): Date => new Date());
  const journal = input.journal ?? new DurableStepJournal({ now });
  const effort = researchEffort(input.complexity);
  const budget: ResearchBudget = {
    maxSubagents: Math.min(input.budget.maxSubagents, effort.maxSubagents),
    maxToolCalls: input.budget.maxToolCalls,
    maxCostUsd: input.budget.maxCostUsd,
  };

  // Plan. On a resumed run the checkpoint already holds the plan.
  const planned: readonly ResearchTask[] =
    input.checkpoint !== undefined && input.checkpoint.checkpoint.plan.length > 0
      ? (input.checkpoint.checkpoint.plan as readonly ResearchTask[])
      : await ports.plan({
          question: input.question,
          complexity: input.complexity,
          maxSubagents: budget.maxSubagents,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
  if (input.checkpoint !== undefined && input.checkpoint.checkpoint.plan.length === 0) {
    input.checkpoint.replacePlan(planned);
  }

  const skipped = input.checkpoint === undefined
    ? []
    : input.checkpoint.checkpoint.dispatched
        .filter((entry) => entry.status === "done" && artifactVerifies(input.store, entry.artifactRef, entry.digest))
        .map((entry) => entry.stepId);

  const tasks = owedTasks(input, planned);
  const dispatches: ConductorDispatch[] = skipped.length === 0 ? [] : input.checkpoint!.checkpoint.dispatched.filter((entry) => skipped.includes(entry.stepId));
  let usage = emptyUsage();
  let budgetExhausted = false;

  for (const task of tasks) {
    if (usage.subagents + 1 > budget.maxSubagents) {
      budgetExhausted = true;
      break;
    }
    const remainingToolCalls = budget.maxToolCalls - usage.toolCalls;
    if (remainingToolCalls <= 0) {
      budgetExhausted = true;
      break;
    }
    const taskKey = keyFor(input.runId, task.stepId);
    const spec = {
      subQuestion: task.subQuestion,
      role: task.role,
      maxToolCalls: Math.min(remainingToolCalls, effort.maxToolCallsPerSubagent),
    };
    // D1: a worker is a durable step. On replay the recorded result is served
    // and the worker is NOT called again (no repeated token spend).
    const step = await journal.step(taskKey, spec, async (): Promise<WorkerResult> =>
      ports.runWorker({
        task,
        maxToolCalls: spec.maxToolCalls,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    );
    const result = step.output;
    // The worker's BODY goes to the artifact store; only the ref travels on.
    input.store.write(result.artifactRef, result.body);
    const dispatch: ConductorDispatch = {
      stepId: result.stepId,
      artifactRef: result.artifactRef,
      status: "done",
      digest: artifactDigest(result.body),
    };
    input.checkpoint?.markDispatched(dispatch);
    dispatches.push(dispatch);
    usage = {
      subagents: usage.subagents + 1,
      toolCalls: usage.toolCalls + (result.usage?.toolCalls ?? 0),
      costUsd: usage.costUsd + (result.usage?.costUsd ?? 0),
    };
    if (!step.replayed) assertWithinBudget(budget, usage);
  }

  const answer = await ports.synthesize({
    question: input.question,
    findings: dispatches.map((entry) => {
      const record = journal.get<WorkerResult>(keyFor(input.runId, entry.stepId));
      return {
        stepId: entry.stepId,
        artifactRef: entry.artifactRef,
        ...(record?.output.summary === undefined ? {} : { summary: record.output.summary }),
      };
    }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  return { answer, dispatched: dispatches, usage, budgetExhausted, skipped };
}

/**
 * Resume a crashed run from its checkpoint: skip completed steps whose
 * artifacts still verify, re-dispatch the rest. Returns the tasks still owed.
 */
export function pendingTasks(
  checkpoint: ConductorCheckpointStore,
  store: ArtifactStore,
): readonly { readonly stepId: string; readonly artifactRef: string }[] {
  return checkpoint.checkpoint.dispatched
    .filter((entry) => entry.status !== "done" || !artifactVerifies(store, entry.artifactRef, entry.digest))
    .map((entry) => ({ stepId: entry.stepId, artifactRef: entry.artifactRef }));
}
