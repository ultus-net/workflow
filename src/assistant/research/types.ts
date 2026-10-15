import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { artifactDigest } from "../../integrations/conductor-checkpoint.js";

/**
 * Research conductor types (deep-research step 0, `planning-questions.md`).
 *
 * The conductor is the orchestrator half of the orchestrator-worker split: it
 * plans, decomposes, dispatches cheaper workers, and synthesizes. It is
 * deliberately provider-agnostic — every model call is an injected seam — so
 * the control flow and the cost controls are testable with no network. The
 * Foundry/OpenRouter provider is a detail behind `runWorker`/`plan`/
 * `synthesize`, never baked in here.
 */

export type ResearchRole = "search" | "verify";

export interface ResearchTask {
  /** Stable across a resume: the idempotency key for this unit of work. */
  readonly stepId: string;
  readonly subQuestion: string;
  readonly role: ResearchRole;
}

/**
 * Effort scales to complexity, in the plan (Anthropic's documented guidance,
 * quoted in `planning-questions.md`): a simple fact-finding question gets one
 * worker and a handful of calls; a comparison gets a few; genuinely complex
 * research gets more. Without this bound the conductor over-invests and spawns
 * dozens of workers for a trivial question.
 */
export type ResearchComplexity = "simple" | "comparison" | "complex";

export interface ResearchEffort {
  readonly maxSubagents: number;
  readonly maxToolCallsPerSubagent: number;
}

export function researchEffort(complexity: ResearchComplexity): ResearchEffort {
  switch (complexity) {
    case "simple":
      return { maxSubagents: 1, maxToolCallsPerSubagent: 10 };
    case "comparison":
      return { maxSubagents: 4, maxToolCallsPerSubagent: 15 };
    case "complex":
      return { maxSubagents: 12, maxToolCallsPerSubagent: 20 };
  }
}

/**
 * The research-specific breaker. A 15x-token fan-out against a runaway loop is
 * the failure mode; `hub-scheduler`'s `RunBudget` is a per-run token/cost cap,
 * and this is the conductor's own cap on agent count, tool calls, and spend.
 */
export interface ResearchBudget {
  readonly maxSubagents: number;
  readonly maxToolCalls: number;
  readonly maxCostUsd: number;
}

/**
 * A worker's product. The BODY is written to the artifact store and never
 * carried through the conductor's context; only the ref, digest, and a short
 * summary travel back ("hand off artifacts, not transcripts").
 */
export interface WorkerResult {
  readonly stepId: string;
  readonly artifactRef: string;
  readonly body: string;
  /** Optional one-line digest of the finding, for the synthesis prompt. */
  readonly summary?: string;
  readonly usage?: { readonly costUsd: number; readonly toolCalls: number };
}

export interface ArtifactStore {
  write(ref: string, body: string): void;
  read(ref: string): string | undefined;
}

/** A filesystem artifact store rooted at the shared workspace (e.g. `/workspace`). */
export function createFileArtifactStore(root: string): ArtifactStore {
  return {
    write(ref: string, body: string): void {
      const target = join(root, ref);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body, "utf8");
    },
    read(ref: string): string | undefined {
      try {
        return readFileSync(join(root, ref), "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

/** Does the artifact at `ref` still digest to `digest`? Used on resume. */
export function artifactVerifies(store: ArtifactStore, ref: string, digest: string): boolean {
  const body = store.read(ref);
  return body !== undefined && artifactDigest(body) === digest;
}

/** A per-run usage ledger the conductor reports against its budget. */
export interface ResearchUsage {
  readonly subagents: number;
  readonly toolCalls: number;
  readonly costUsd: number;
}

export function emptyUsage(): ResearchUsage {
  return { subagents: 0, toolCalls: 0, costUsd: 0 };
}
