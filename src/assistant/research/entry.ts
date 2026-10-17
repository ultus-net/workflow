import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ConductorCheckpointStore } from "../../integrations/conductor-checkpoint.js";
import {
  runResearch,
  researchBudget,
  type ResearchOutcome,
} from "./conductor.js";
import { openRouterConductorPorts } from "./openrouter-ports.js";
import { createFileArtifactStore, type ResearchComplexity } from "./types.js";
import type { OpenRouterProvider } from "../provider/openrouter.js";
import type { Lang } from "../model/source.js";

/**
 * W216: the production entry point for the deep-research conductor.
 *
 * The conductor (`./conductor.ts`) has no transport and no caller; the
 * OpenRouter binding (`./openrouter-ports.ts`) realises the three ports against
 * a provider but still composes nothing durable. This module is that
 * composition, and it is the only place a run becomes a durable, resumable,
 * on-disk research run:
 *
 *   - a per-run root directory (`<workspace>/research/<runId>`) owns the
 *     artifacts, the checkpoint, and the written answer;
 *   - the checkpoint is loaded when present, so re-running the SAME question
 *     (same deterministic `runId`) resumes the run rather than re-spending;
 *   - the budget is derived from complexity and open to explicit overrides.
 *
 * It is deliberately provider-agnostic at the boundary: it takes an
 * `OpenRouterProvider` and returns paths and an outcome, never a transcript. A
 * caller (the `augur research` CLI subcommand) owns config resolution and
 * credential transport; the Foundry move replaces the provider binding, not
 * this composition.
 */

export interface ResearchRunOptions {
  readonly question: string;
  readonly complexity: ResearchComplexity;
  readonly lang: Lang;
  readonly runId: string;
  /** Per-run directory, e.g. `<workspace>/research/<runId>`. */
  readonly root: string;
  readonly provider: OpenRouterProvider;
  /** Override the complexity-derived dollar ceiling. */
  readonly maxCostUsd?: number;
  /** Override the complexity-derived subagent ceiling. */
  readonly maxSubagents?: number;
  /** Frontier-tier models for planning and synthesis. */
  readonly conductorModels?: readonly string[];
  /** Cheap-tier models for the search/verify workers. */
  readonly workerModels?: readonly string[];
  readonly now?: () => Date;
}

export interface ResearchRunResult {
  readonly outcome: ResearchOutcome;
  readonly answerPath: string;
  readonly checkpointPath: string;
  readonly artifactRoot: string;
}

/**
 * A run id becomes a single path segment under `<workspace>/research/`, so it
 * must not carry a separator or a `.`/`..` traversal: an operator-supplied
 * `--run-id ../../../etc` would otherwise place the run root outside the
 * workspace and let `mkdirSync`/`writeFileSync` write there. The generated
 * question hash already satisfies this; only an explicit id needs the gate.
 * Exported so the CLI can share it and tests can pin it without importing the
 * CLI module (whose import runs `main()`).
 */
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

export function resolveRunId(value: unknown, question: string): string {
  const generated = (): string => createHash("sha256").update(question).digest("hex").slice(0, 16);
  if (value === undefined) return generated();
  const raw = String(value);
  if (raw.length === 0) return generated();
  if (raw === "." || raw === ".." || !SAFE_RUN_ID.test(raw)) {
    throw new Error(`run id '${raw}' is not a safe path segment (allowed: letters, digits, '.', '_', '-')`);
  }
  return raw;
}

export async function runResearchEntry(options: ResearchRunOptions): Promise<ResearchRunResult> {
  const { root } = options;
  mkdirSync(root, { recursive: true });

  const store = createFileArtifactStore(root);
  const checkpointPath = join(root, "checkpoint.json");
  const checkpoint = existsSync(checkpointPath)
    ? ConductorCheckpointStore.load(checkpointPath)
    : new ConductorCheckpointStore(
        { runId: options.runId, plan: [], dispatched: [], cursor: 0 },
        { path: checkpointPath },
      );

  const base = researchBudget(options.complexity);
  const budget = {
    maxSubagents: options.maxSubagents ?? base.maxSubagents,
    maxToolCalls: base.maxToolCalls,
    maxCostUsd: options.maxCostUsd ?? base.maxCostUsd,
  };

  const ports = openRouterConductorPorts({
    provider: options.provider,
    store,
    lang: options.lang,
    ...(options.conductorModels === undefined ? {} : { conductorModels: options.conductorModels }),
    ...(options.workerModels === undefined ? {} : { workerModels: options.workerModels }),
  });

  const outcome = await runResearch(
    {
      runId: options.runId,
      question: options.question,
      complexity: options.complexity,
      budget,
      store,
      checkpoint,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
    ports,
  );

  const answerPath = join(root, "answer.md");
  writeFileSync(answerPath, outcome.answer, "utf8");

  return { outcome, answerPath, checkpointPath, artifactRoot: join(root, "findings") };
}
