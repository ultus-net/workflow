/**
 * W175 phase 2: the ONE mirror of the /api/runs relay payload (the hub's
 * runs block — slice 1's run-registry projection) and the hook that polls
 * it. Every view that reads the runs lane (Overview, Runs, the run detail
 * panel) imports from here — one definition, never a per-view re-shape.
 *
 * Structurally mirrored, like the Overview's other mirrors: the view derives
 * nothing. `runs` null (or the fetch failing) is the named absence, never an
 * empty list; the maps are the relay's runId-keyed Object.fromEntries
 * serializations read as-is. Rows carry `startedAt` ONLY when the hub's
 * run-registry begin record has one — the rows never derive a time (the
 * timeline house rule).
 *
 * Poll cadence: the 1.5s panel poll, like the other shell surfaces.
 */

import { useEffect, useState } from "react";

/** The per-run usage summary the relay carries (the registry's
 * RunUsageSummary shape). */
export interface RunUsageSummaryView {
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly cacheReadTokens: number;
  readonly cacheCreateTokens: number;
  readonly recordedAt: string;
}

/** One run row as the relay's runs block carries it. `startedAt` is the
 * registry's recorded begin time when the hub has one (named absence
 * otherwise); `workspace` rides only when the record carries one. */
export interface RunRowView {
  readonly runId: string;
  readonly title?: string;
  readonly state: string;
  readonly startedAt?: string;
  readonly workspace?: string;
}

/** W153: the relay's origin record, mirrored — discriminated on the recorded
 * kind; the view renders it verbatim and never parses run ids. A record
 * missing its kind's own field attributes nothing. */
export type RunOriginView =
  | { readonly kind: "schedule"; readonly scheduleId?: string }
  | { readonly kind: "provider-task"; readonly provider?: string; readonly key?: string; readonly url?: string };

/** W165: the relay's recorded run→work-product link. */
export interface WorkProductLinkView {
  readonly provider: string;
  readonly key: string;
  readonly url: string;
}

/** The relay's review outcome (the hub reviewer's verdict record). */
export interface ReviewOutcomeView {
  readonly reviewerRunId: string;
  readonly verdict: string;
  readonly recorded: boolean;
  readonly summary: string;
  readonly parseFailure?: string;
}

/** The relay's journaled completion claim (the W114 honesty family). */
export interface CompletionClaimView {
  readonly runId: string;
  readonly claim: string;
  readonly verifiedAtClaim: boolean;
  readonly observedAt: string;
}

/**
 * W111 (issue #283): one recorded per-task boundary delta as the relay's runs
 * block carries it (the run-registry `TaskUsageSummary` shape, field for
 * field). `taskId` is the kernel id read at boundary time (the run's canonical
 * `run:<id>` for a run lane), or the explicit "unattributed" marker — never a
 * value the view derives. The journal is APPEND: a task can span many turns, so
 * a per-task rollup is the SUM of these recorded entries.
 */
export interface TaskUsageSummaryView {
  readonly taskId: string;
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly cacheReadTokens: number;
  readonly cacheCreateTokens: number;
  readonly recordedAt: string;
}

/** The relay's advisory reasoning-claim finding (observability-only). */
export interface ReasoningClaimFindingView {
  readonly runId: string;
  readonly sentence: string;
  readonly observedAt: string;
}

/** The relay's honest monitor metrics — `recall` and `timeToResponseMs` are
 * literally "unmeasured"; reporting them measured is the overclaim this repo
 * forbids. */
export interface ReasoningClaimMetricsView {
  readonly monitoredRuns: number;
  readonly flaggedRuns: number;
  readonly findings: number;
  readonly recall: "unmeasured";
  readonly timeToResponseMs: "unmeasured";
}

/** The /api/runs relay's record state. `runs` null (or the fetch failing) is
 * the named absence, never an empty list; the map families the hub omitted
 * (a hub older than their slice) are absent fields, never fabricated
 * empties. */
export interface RunsRecordState {
  readonly runs:
    | {
        readonly rows: readonly RunRowView[];
        readonly origins?: Readonly<Record<string, RunOriginView>>;
        readonly workProducts?: Readonly<Record<string, WorkProductLinkView>>;
        readonly reviewOutcomes: Readonly<Record<string, ReviewOutcomeView>>;
        readonly blockingReasons: Readonly<Record<string, string>>;
        readonly completionClaims: Readonly<Record<string, CompletionClaimView>>;
        readonly usage?: Readonly<Record<string, RunUsageSummaryView>>;
        /** W111: the recorded per-task boundary deltas (bounded append journal). */
        readonly taskUsage?: readonly TaskUsageSummaryView[];
        readonly reasoningClaims?: Readonly<Record<string, ReasoningClaimFindingView>>;
        readonly reasoningClaimMetrics?: ReasoningClaimMetricsView;
      }
    | null;
  readonly reason?: string;
}

/** Polls the W175 runs relay. Undefined until the first answer; a hub that
 * predates the relay answers runs: null with the reason. */
export function useRunsRecord(): RunsRecordState | undefined {
  const [state, setState] = useState<RunsRecordState | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/runs");
        const payload = (await response.json()) as RunsRecordState;
        if (!cancelled) setState(payload);
      } catch {
        if (!cancelled) setState({ runs: null, reason: "hub unavailable" });
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return state;
}