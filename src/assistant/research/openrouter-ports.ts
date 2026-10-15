import {
  OpenRouterProvider,
  langDirective,
  type ChatResult,
} from "../provider/openrouter.js";
import {
  conductorPlanPrompt,
  conductorSynthesizePrompt,
  parsePlan,
  CONDUCTOR_PLAN_SCHEMA,
} from "./prompt.js";
import type { ArtifactStore, WorkerResult } from "./types.js";
import type { ConductorPorts } from "./conductor.js";
import type { Lang } from "../model/source.js";

/**
 * The conductor wired to the existing OpenRouter lane (deep-research step 0's
 * "usable" half).
 *
 * This is a BINDING, not the conductor: `conductor.ts` stays provider-agnostic
 * and holds no transport. Here the three ports are realised against
 * `OpenRouterProvider`, which is already deployed on both lanes (direct key or
 * the assistant gateway front door). The provider choice is therefore a detail
 * of this file, and the eventual Foundry move replaces this binding rather than
 * the conductor — exactly the provider-agnostic property the plan required.
 *
 * Cost note: this lane's `ChatResult` carries token usage but no price. The
 * `estimateCostUsd` seam lets a host price by model; it defaults to zero, so the
 * subagent and tool-call breakers are the always-on caps and the dollar breaker
 * engages only once a host supplies prices.
 */

export interface OpenRouterConductorOptions {
  readonly provider: OpenRouterProvider;
  readonly store: ArtifactStore;
  readonly lang: Lang;
  /**
   * Frontier-tier models for planning and synthesis (few tokens). Absent means
   * the provider's configured list. This is the "tier the roles" control: the
   * expensive model is pinned to the two low-token phases.
   */
  readonly conductorModels?: readonly string[];
  /** Cheap-tier models for the search/verify workers (many tokens). */
  readonly workerModels?: readonly string[];
  /** Bound each worker's search loop. Default 4. */
  readonly maxSearchesPerWorker?: number;
  /** Price a completed call, in USD. Default: zero (no dollar breaker). */
  readonly estimateCostUsd?: (result: ChatResult, role: "conductor" | "worker") => number;
}

/** A worker's artifact path is derived from its stable step id. */
function artifactRefFor(stepId: string): string {
  return `findings/${stepId}.md`;
}

function workerSystemPrompt(lang: Lang): string {
  return [
    "You are a research worker. You receive ONE sub-question and answer it from primary sources you retrieve.",
    langDirective(lang),
    "Search before asserting anything time-sensitive. Cite the sources you actually retrieved, inline as markdown links.",
    "Return a short, self-contained markdown finding (a heading, a few grounded paragraphs, and a 'Sources' list).",
    "Do not speculate. If the sources disagree, say so plainly. Do not answer questions you were not asked.",
  ].join("\n");
}

export function openRouterConductorPorts(options: OpenRouterConductorOptions): ConductorPorts {
  const maxSearches = options.maxSearchesPerWorker ?? 4;
  return {
    async plan(input) {
      const result = await options.provider.chat({
        messages: [
          { role: "system", content: "You decompose research questions. Return only the structured plan." },
          { role: "user", content: conductorPlanPrompt(input) },
        ],
        ...(options.conductorModels === undefined ? {} : { model: options.conductorModels }),
        temperature: 0,
        responseFormat: { type: "json_schema", json_schema: CONDUCTOR_PLAN_SCHEMA },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      // The provider accepts a json_schema format; parse defensively because not
      // every endpoint honors it strictly, and a malformed plan must not crash a
      // durable run (it degrades to a single-question plan).
      const tasks = parsePlan(result.text);
      return tasks.length > 0 ? tasks.slice(0, input.maxSubagents) : [{ stepId: "search.subquestion.1", subQuestion: input.question, role: "search" }];
    },

    async runWorker(input): Promise<WorkerResult> {
      const result = await options.provider.chat({
        messages: [
          { role: "system", content: workerSystemPrompt(options.lang) },
          { role: "user", content: input.task.subQuestion },
        ],
        ...(options.workerModels === undefined ? {} : { model: options.workerModels }),
        temperature: 0.2,
        webSearch: { enabled: true, engine: "auto", maxResults: 5, maxUses: Math.min(input.maxToolCalls, maxSearches) },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      // One-line summary for the conductor's synthesis prompt; the BODY stays in
      // the artifact store and never crosses the conductor's context.
      const firstLine = result.text.split("\n").map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith("#"));
      return {
        stepId: input.task.stepId,
        artifactRef: artifactRefFor(input.task.stepId),
        body: result.text,
        ...(firstLine === undefined ? {} : { summary: firstLine.slice(0, 200) }),
        usage: { toolCalls: result.usage.webSearches, costUsd: options.estimateCostUsd?.(result, "worker") ?? 0 },
      };
    },

    async synthesize(input): Promise<string> {
      // Read the artifact bodies for synthesis, bounded so a large run cannot
      // blow the conductor's context. The summary is still passed for the case
      // where an artifact read fails.
      const bodies = input.findings.map((finding) => {
        const body = options.store.read(finding.artifactRef);
        return {
          stepId: finding.stepId,
          artifactRef: finding.artifactRef,
          ...(finding.summary === undefined ? {} : { summary: finding.summary }),
          excerpt: body === undefined ? "(artifact unavailable)" : body.slice(0, 6000),
        };
      });
      const result = await options.provider.chat({
        messages: [
          { role: "system", content: `${conductorSynthesizePrompt({ question: input.question, findings: input.findings })}\n\n${langDirective(options.lang)}` },
          {
            role: "user",
            content: bodies
              .map((b) => `## ${b.stepId} (${b.artifactRef})\n\n${b.excerpt}`)
              .join("\n\n"),
          },
        ],
        ...(options.conductorModels === undefined ? {} : { model: options.conductorModels }),
        temperature: 0.3,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      return result.text;
    },
  };
}
