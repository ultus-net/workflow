/**
 * W175 phase 2 — the run detail panel: the shell's right-side contextual
 * region for ONE run. Header (run id, state, origin, workspace when the
 * record carries one, start time) plus five tabs (Summary / Timeline /
 * Evidence / Review / Cost). Every section is fed by records — the /api/runs
 * relay's run-registry projection, the timeline lane's rows, and the evidence
 * relay's records under the run's subject — and a record family absent for
 * the run renders its NAMED absence, never a fabricated panel.
 *
 * Honesty pins this panel lives by:
 *   - usage is labelled *recorded* (an aggregation of recorded values, never
 *     a live meter); the cache read/create pair names the recorded lane
 *     asymmetry — 0 on the OpenAI chat-completions lane, and the view says so;
 *   - the completion claim carries its verified-at-claim flag BESIDE it (the
 *     W114 honesty line made legible);
 *   - the work-product reference renders the W167 liveness pill derived ONLY
 *     from the hub's recorded provider read — no record, no pill;
 *   - the timeline tab renders the timeline lane's rows that NAME this run
 *     plus the row's own startedAt begin record — the lane's kernel
 *     transition rows carry no task id, so a per-run kernel join would
 *     fabricate attribution; the panel states that boundary instead;
 *   - the reasoning-claim monitor renders recall and timeToResponseMs as
 *     "unmeasured" (the registry's own comment forbids reporting them
 *     measured);
 *   - the evidence tab joins on the subject (the only run linkage the relay's
 *     records carry) through the shared W158 row renderer, whose non-ready
 *     preview states (loading / absent-evicted / unavailable) are all named.
 *
 * (Template literals are deliberately absent: string concatenation keeps
 * the source patchable under the guard shell classifier.)
 */

import { useMemo, useState } from "react";

import {
  BOARD_LINK_LIVENESS_LABELS,
  boardLinkLiveness,
  formatRelativeTime,
  formatRunOrigin,
  formatTokens,
  statusToken,
} from "./presenters.js";
import {
  EvidenceStripRow,
  useContentPreviews,
  useHubEvidence,
  type EvidenceContentPreview,
  type HubEvidenceRow,
} from "./evidence-preview.js";
// W176 phase 3 (#347): the tab vocabulary is ONE list — the persisted opener
// record (run-detail-state.ts) validates against the same tabs the strip
// renders, so the memory and the panel can never drift apart.
import { RUN_DETAIL_TABS, type RunDetailTab } from "./run-detail-state.js";
import type {
  CompletionClaimView,
  ReasoningClaimFindingView,
  ReasoningClaimMetricsView,
  ReviewOutcomeView,
  RunOriginView,
  RunRowView,
  RunUsageSummaryView,
  RunsRecordState,
  SurfaceUsageSummaryView,
  TaskUsageSummaryView,
  WorkProductLinkView,
} from "./runs-record.js";
import type { TimelineState } from "./activity-timeline.js";
import type { TimelineRow } from "../../integrations/activity-timeline.js";
import type { ProviderReadRecord } from "../../integrations/issue-detail.js";

const TABS: readonly RunDetailTab[] = RUN_DETAIL_TABS;

const TAB_LABELS: Readonly<Record<RunDetailTab, string>> = {
  summary: "Summary",
  timeline: "Timeline",
  evidence: "Evidence",
  review: "Review",
  cost: "Cost",
};

/**
 * The timeline lane's rows that name this run — the only honest join the lane
 * allows: its registry rows (review / gate / claim / usage / origin) carry
 * the run id inside their recorded summaries, while the kernel transition
 * rows carry only a task-title join. The match is boundary-checked so a
 * prefix-colliding run id (w1 vs w12) never claims another run's rows.
 */
export function timelineRowsForRun(rows: readonly TimelineRow[], runId: string): readonly TimelineRow[] {
  const escaped = runId.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const pattern = new RegExp("run " + escaped + "(?=$|[:\\s,])");
  return rows.filter((row) => pattern.test(row.summary));
}

/**
 * The relay's evidence records under ONE run: the subject IS the run id —
 * the records carry no other run linkage, so a record under any other subject
 * (the workspace test subject among them) is not claimed by this run.
 */
export function evidenceRowsForRun(rows: readonly HubEvidenceRow[], runId: string): readonly HubEvidenceRow[] {
  return rows.filter((row) => row.subject === runId);
}

/**
 * W111: the recorded per-task boundary deltas for ONE run's task. Q1 (issue
 * #283) decided the run application's task is the canonical `run:<id>` — the
 * exact id its lanes record at boundary time — so the join is on that recorded
 * task id. The view derives no delta and no task id: it selects the records the
 * hub wrote. A run whose task recorded nothing selects nothing (the named
 * absence), never a fabricated zero.
 */
export function taskUsageForRun(entries: readonly TaskUsageSummaryView[], runId: string): readonly TaskUsageSummaryView[] {
  const recordedTaskId = "run:" + runId;
  return entries.filter((entry) => entry.taskId === recordedTaskId);
}

/**
 * P4 topology A1 (issue #283): the provenance-stamped SURFACE observations
 * that NAME one run's canonical task. The join is the same exact recorded-task
 * id the canonical selector uses, but the section renders SEPARATELY and
 * labelled: the posted task id is the SURFACE's observation, never
 * hub-authoritative attribution, so it is never merged into the canonical
 * rollups. A surface observation that names no canonical `run:<id>` task is
 * not claimed by any run panel — it stays in the hub's surface journal, its
 * honest home, rather than being attributed to a run that did not record it.
 */
export function surfaceUsageForRun(entries: readonly SurfaceUsageSummaryView[], runId: string): readonly SurfaceUsageSummaryView[] {
  const recordedTaskId = "run:" + runId;
  return entries.filter((entry) => entry.taskId === recordedTaskId);
}

/**
 * W111: the recorded rollup for a task's entries — the SUM of the recorded
 * boundary deltas (the documented per-task rollup). This is an aggregation of
 * records, never a view-side delta computed from cumulative counters; an empty
 * list sums to zero entries and is rendered as the named absence upstream.
 */
export function sumTaskUsage(entries: readonly TaskUsageSummaryView[]): { readonly requests: number; readonly totalTokens: number; readonly costUsd: number } {
  let requests = 0;
  let totalTokens = 0;
  let costUsd = 0;
  for (const entry of entries) {
    requests += entry.requests;
    totalTokens += entry.totalTokens;
    costUsd += entry.costUsd;
  }
  return { requests, totalTokens, costUsd };
}

/**
 * W111: the recorded per-task attribution for ONE run's task. Renders each
 * recorded entry VERBATIM, the recorded rollup (the sum of the entries), and a
 * boundary statement; a hub that omitted the family and a run whose task
 * recorded nothing each render their own NAMED absence, never a fabricated
 * zero. Projection-only: the entries are the relay's records, read as-is.
 */
function TaskAttributionSection({ journal, runId }: { readonly journal: readonly TaskUsageSummaryView[] | undefined; readonly runId: string }) {
  if (journal === undefined) {
    return <p className="runs-absent">task attribution not recorded by this hub</p>;
  }
  const entries = taskUsageForRun(journal, runId);
  if (entries.length === 0) {
    return <p className="runs-absent">no task attribution recorded for this run</p>;
  }
  const totals = sumTaskUsage(entries);
  return (
    <>
      <ul className="run-task-usage">
        {entries.map((entry, index) => (
          <li key={entry.taskId + ":" + entry.recordedAt + ":" + String(index)} className="run-task-usage-row">
            <code>{entry.taskId}</code>{" · "}
            requests {entry.requests}{" · "}
            total {formatTokens(entry.totalTokens)}{" · "}
            {"$" + entry.costUsd.toFixed(4)}{" · "}
            cache r/w {entry.cacheReadTokens}/{entry.cacheCreateTokens}{" · "}
            <time dateTime={entry.recordedAt} title={entry.recordedAt}>{formatRelativeTime(entry.recordedAt)}</time>
          </li>
        ))}
      </ul>
      <p className="runs-muted">
        recorded rollup (sum of recorded entries): {formatTokens(totals.totalTokens)} tokens · {"$" + totals.costUsd.toFixed(4)} · {totals.requests} requests · {entries.length} recorded turn{entries.length === 1 ? "" : "s"}
      </p>
      <p className="runs-muted">the rollup is the sum of recorded boundary deltas — the view derives no delta from cumulative counters</p>
    </>
  );
}

/**
 * P4 topology A1 (issue #283): the SEPARATE surface-observation journal, rendered
 * as its own section so a viewer never conflates a surface OBSERVATION with the
 * canonical per-task attribution above. Each entry renders VERBATIM: its
 * provenance stamp (`surface:<surface>[:<sessionId>]`), the task id the SURFACE
 * posted (a labelled observation, never authoritative), and the posted numbers.
 * A hub that omitted the family and a run no surface observation names each
 * render their own NAMED absence, never a fabricated entry. The boundary line
 * states that the journal is hub-wide and its other entries stay unattributed
 * here. Projection-only: the view derives no stamp and no delta.
 */
function SurfaceObservationsSection({ journal, runId }: { readonly journal: readonly SurfaceUsageSummaryView[] | undefined; readonly runId: string }) {
  if (journal === undefined) {
    return <p className="runs-absent">surface observations not recorded by this hub</p>;
  }
  const entries = surfaceUsageForRun(journal, runId);
  if (entries.length === 0) {
    return (
      <>
        <p className="runs-absent">no surface observation names this run</p>
        <p className="runs-muted">the surface journal is hub-wide; an observation naming no canonical run task stays recorded here, never attributed to a run that did not record it</p>
      </>
    );
  }
  return (
    <>
      <ul className="run-surface-usage">
        {entries.map((entry, index) => (
          <li key={entry.recordedBy + ":" + entry.taskId + ":" + entry.recordedAt + ":" + String(index)} className="run-surface-usage-row">
            <code>{entry.recordedBy}</code>{" · "}
            observed task <code>{entry.taskId}</code>{" · "}
            requests {entry.requests}{" · "}
            total {formatTokens(entry.totalTokens)}{" · "}
            {"$" + entry.costUsd.toFixed(4)}{" · "}
            cache r/w {entry.cacheReadTokens}/{entry.cacheCreateTokens}{" · "}
            <time dateTime={entry.recordedAt} title={entry.recordedAt}>{formatRelativeTime(entry.recordedAt)}</time>
          </li>
        ))}
      </ul>
      <p className="runs-muted">these are the SURFACE's own observations, relayed through the observability-only /usage/record route and never merged into the canonical per-task attribution above</p>
    </>
  );
}

export interface RunDetailPanelProps {
  readonly runId: string;
  readonly record: RunsRecordState | undefined;
  readonly timeline: TimelineState | undefined;
  /** The hub's recorded provider-read record — the ONLY source the work
   * product's liveness pill derives from (no record, no pill). */
  readonly boardRead: ProviderReadRecord | null | undefined;
  /** The page that opened the panel (the sessionStorage origin memory) —
   * the back affordance names it verbatim. */
  readonly opener: string;
  /** W176 phase 3 (#347): the tab the panel opens on — the Reviews page
   * opens it on the Review tab (the opener memory carries the choice).
   * Absent → the default Summary tab. The tab strip stays operator-owned
   * after the initial render. */
  readonly initialTab?: RunDetailTab | undefined;
  readonly onBack: () => void;
  /** Injected evidence records/previews (the pins drive them); undefined →
   * the panel polls the evidence relay itself. */
  readonly evidenceRows?: readonly HubEvidenceRow[] | null | undefined;
  readonly evidencePreviews?: ReadonlyMap<string, EvidenceContentPreview> | undefined;
}

export function RunDetailPanel({
  runId,
  record,
  timeline,
  boardRead,
  opener,
  initialTab,
  onBack,
  evidenceRows,
  evidencePreviews,
}: RunDetailPanelProps) {
  const [tab, setTab] = useState<RunDetailTab>(initialTab ?? "summary");
  const runs = record?.runs ?? null;
  const runRow: RunRowView | undefined = runs?.rows.find((row) => row.runId === runId);
  const origin: RunOriginView | undefined = runs?.origins?.[runId];
  const workProduct: WorkProductLinkView | undefined = runs?.workProducts?.[runId];
  const usage: RunUsageSummaryView | undefined = runs?.usage?.[runId];
  const taskUsageJournal: readonly TaskUsageSummaryView[] | undefined = runs?.taskUsage;
  const surfaceUsageJournal: readonly SurfaceUsageSummaryView[] | undefined = runs?.surfaceUsage;
  const claim: CompletionClaimView | undefined = runs?.completionClaims[runId];
  const outcome: ReviewOutcomeView | undefined = runs?.reviewOutcomes[runId];
  const blocking: string | undefined = runs?.blockingReasons[runId];
  const finding: ReasoningClaimFindingView | undefined = runs?.reasoningClaims?.[runId];
  const metrics: ReasoningClaimMetricsView | undefined = runs?.reasoningClaimMetrics;
  const liveness = boardLinkLiveness(boardRead, Date.now());
  const polledEvidence = useHubEvidence();
  const evidenceSource = evidenceRows !== undefined ? evidenceRows : polledEvidence.rows;
  const runEvidence = evidenceSource === null || evidenceSource === undefined
    ? null
    : evidenceRowsForRun(evidenceSource, runId);
  const evidenceReason = evidenceRows !== undefined ? undefined : polledEvidence.reason;
  const refs = useMemo(() => {
    const list: string[] = [];
    for (const row of runEvidence ?? []) if (row.content !== undefined) list.push(row.content.ref);
    return list;
  }, [runEvidence]);
  const polledPreviews = useContentPreviews(refs);
  const previews = evidencePreviews ?? polledPreviews;
  const namedRows = timeline === undefined || timeline.timeline === null
    ? []
    : timelineRowsForRun(timeline.timeline.rows, runId);
  const startCell = runRow?.startedAt === undefined
    ? <span className="runs-cell-absent">no recorded time</span>
    : <time dateTime={runRow.startedAt} title={runRow.startedAt}>{formatRelativeTime(runRow.startedAt)}</time>;
  return (
    <section className="run-detail" aria-label={"run detail: " + runId}>
      <header className="run-detail-header">
        <div className="run-detail-titleline">
          <code className="run-detail-id">{runId}</code>
          {runRow === undefined
            ? <span className="runs-state runs-cell-absent">state not recorded</span>
            : <span className={"runs-state runs-state-" + statusToken(runRow.state)}>{runRow.state}</span>}
        </div>
        <p className="run-detail-facts">
          <span>{formatRunOrigin(origin) ?? "origin not recorded"}</span>
          {runRow?.workspace !== undefined && <span>workspace {runRow.workspace}</span>}
          <span>start: {startCell}</span>
        </p>
        <button
          type="button"
          className="run-detail-back"
          onClick={onBack}
          title={"close the detail (Esc); back to " + opener}
          aria-label={"close the run detail; back to " + opener}
        >
          back to {opener}
        </button>
      </header>
      <div className="run-detail-tabs" role="tablist" aria-label="run detail tabs">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={"run-detail-tab" + (tab === name ? " run-detail-tab-on" : "")}
            onClick={() => setTab(name)}
          >
            {TAB_LABELS[name]}
          </button>
        ))}
      </div>
      <div className="run-detail-body">
        <section role="tabpanel" aria-label="Summary" hidden={tab !== "summary"}>
          <h4 className="run-detail-sub">Recorded usage</h4>
          {usage === undefined
            ? <p className="runs-absent">no usage recorded for this run</p>
            : (
              <>
                <dl className="run-usage">
                  <div className="run-usage-row"><dt>requests</dt><dd>{usage.requests}</dd></div>
                  <div className="run-usage-row"><dt>prompt tokens</dt><dd>{formatTokens(usage.promptTokens)}</dd></div>
                  <div className="run-usage-row"><dt>completion tokens</dt><dd>{formatTokens(usage.completionTokens)}</dd></div>
                  <div className="run-usage-row"><dt>total tokens</dt><dd>{formatTokens(usage.totalTokens)}</dd></div>
                  <div className="run-usage-row"><dt>recorded cost</dt><dd>{"$" + usage.costUsd.toFixed(4)}</dd></div>
                </dl>
                <p className="run-cache-note">cache read: {usage.cacheReadTokens} · cache create: {usage.cacheCreateTokens} — the recorded lane asymmetry: on the OpenAI chat-completions lane both stay 0 (its cached reads are inside promptTokens)</p>
                <p className="runs-muted">recorded at {formatRelativeTime(usage.recordedAt)}</p>
              </>
            )}
          <h4 className="run-detail-sub">Completion claim</h4>
          {claim === undefined
            ? <p className="runs-absent">no completion claim recorded</p>
            : (
              <p className="run-claim">
                <span className="run-claim-text">{claim.claim}</span>{" "}
                <span className={"claim-flag claim-flag-" + (claim.verifiedAtClaim ? "verified" : "unverified")}>verified at claim: {claim.verifiedAtClaim ? "yes" : "no"}</span>
              </p>
            )}
          <h4 className="run-detail-sub">Work product</h4>
          {workProduct === undefined
            ? <p className="runs-absent">no work-product link recorded</p>
            : (
              <p className="run-workproduct">
                <a href={workProduct.url} target="_blank" rel="noreferrer noopener"><code>{workProduct.key}</code></a>{" "}
                <span className="runs-muted">{workProduct.provider}</span>{" "}
                {liveness !== undefined && (
                  <span className={"board-liveness board-liveness-" + liveness} title={boardRead?.reason}>
                    {BOARD_LINK_LIVENESS_LABELS[liveness]}
                  </span>
                )}
              </p>
            )}
        </section>
        <section role="tabpanel" aria-label="Timeline" hidden={tab !== "timeline"}>
          <h4 className="run-detail-sub">Timeline</h4>
          {timeline === undefined || timeline.timeline === null
            ? <p className="runs-absent" role="status">{timeline === undefined || timeline.reason === undefined ? "hub timeline: loading…" : "hub timeline unavailable (" + timeline.reason + ")"}</p>
            : (
              <>
                <ul className="run-timeline">
                  <li className="run-timeline-row run-timeline-begin">
                    <span className="run-timeline-kind">begin</span>
                    <span className="run-timeline-summary">run begun (recorded begin)</span>
                    <span className="run-timeline-attribution">
                      {runRow?.startedAt === undefined
                        ? "no recorded time"
                        : <time dateTime={runRow.startedAt} title={runRow.startedAt}>{formatRelativeTime(runRow.startedAt)}</time>}
                    </span>
                  </li>
                  {namedRows.map((row, index) => (
                    <li key={row.kind + ":" + String(index)} className="run-timeline-row">
                      <span className="run-timeline-kind">{row.kind}</span>
                      <span className="run-timeline-summary">{row.summary}</span>
                      <span className="run-timeline-attribution">
                        {row.actor} · {row.authority} · {row.at === null ? "no recorded time" : new Date(row.at).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
                {namedRows.length === 0 && <p className="runs-absent">no timeline rows name this run yet</p>}
                <p className="runs-muted">{timeline.timeline.retention}</p>
                <p className="runs-muted">kernel transition rows are not joined per run — the timeline lane's rows carry no task id (W157 is the record change that would add one)</p>
              </>
            )}
        </section>
        <section role="tabpanel" aria-label="Evidence" hidden={tab !== "evidence"}>
          <h4 className="run-detail-sub">Evidence</h4>
          {runEvidence === null
            ? <p className="runs-absent" role="status">{evidenceReason === undefined ? "hub evidence unavailable" : "hub evidence unavailable: " + evidenceReason}</p>
            : runEvidence.length === 0
              ? <p className="runs-absent" role="status">no evidence records carry this run id as subject</p>
              : runEvidence.map((row, index) => (
                <EvidenceStripRow
                  key={row.id ?? String(index)}
                  origin="hub"
                  subject={row.subject}
                  result={row.result}
                  freshness={row.freshness}
                  content={row.content}
                  preview={row.content === undefined ? undefined : previews.get(row.content.ref)}
                />
              ))}
          <p className="runs-muted">the relay's evidence records carry no run linkage beyond the subject — records under other subjects (the workspace test subject among them) are not claimed by this run</p>
        </section>
        <section role="tabpanel" aria-label="Review" hidden={tab !== "review"}>
          <h4 className="run-detail-sub">Review</h4>
          {outcome === undefined
            ? <p className="runs-absent">no review outcome recorded</p>
            : (
              <div className="run-review-outcome">
                <p className="run-review-line">
                  <span className="run-review-verdict">verdict: {outcome.verdict}</span>
                  {" · reviewer "}<code>{outcome.reviewerRunId}</code>
                  {" · "}{outcome.recorded ? "admitted" : "not admitted"}
                </p>
                <blockquote className="run-review-summary">{outcome.summary}</blockquote>
                {outcome.parseFailure !== undefined && <p className="runs-absent">parse failure: {outcome.parseFailure}</p>}
              </div>
            )}
          {blocking === undefined
            ? <p className="runs-absent">no blocking reason recorded</p>
            : <p className="run-blocking" role="alert">blocking reason: {blocking}</p>}
          <h4 className="run-detail-sub">Reasoning-claim monitor</h4>
          {metrics === undefined
            ? <p className="runs-absent">no reasoning-claim monitor record</p>
            : (
              <>
                <dl className="run-usage">
                  <div className="run-usage-row"><dt>monitored runs</dt><dd>{metrics.monitoredRuns}</dd></div>
                  <div className="run-usage-row"><dt>flagged runs</dt><dd>{metrics.flaggedRuns}</dd></div>
                  <div className="run-usage-row"><dt>findings</dt><dd>{metrics.findings}</dd></div>
                  <div className="run-usage-row"><dt>recall</dt><dd className="run-unmeasured">{metrics.recall}</dd></div>
                  <div className="run-usage-row"><dt>timeToResponseMs</dt><dd className="run-unmeasured">{metrics.timeToResponseMs}</dd></div>
                </dl>
                {finding === undefined
                  ? <p className="runs-absent">no reasoning-claim finding recorded</p>
                  : <p className="run-finding">reasoning-claim finding: {finding.sentence}</p>}
              </>
            )}
        </section>
        <section role="tabpanel" aria-label="Cost" hidden={tab !== "cost"}>
          <h4 className="run-detail-sub">Recorded usage — full record</h4>
          {usage === undefined
            ? <p className="runs-absent">no usage recorded for this run</p>
            : (
              <dl className="run-usage">
                <div className="run-usage-row"><dt>requests</dt><dd>{usage.requests}</dd></div>
                <div className="run-usage-row"><dt>prompt tokens</dt><dd>{usage.promptTokens}</dd></div>
                <div className="run-usage-row"><dt>completion tokens</dt><dd>{usage.completionTokens}</dd></div>
                <div className="run-usage-row"><dt>total tokens</dt><dd>{usage.totalTokens}</dd></div>
                <div className="run-usage-row"><dt>recorded cost</dt><dd>{"$" + usage.costUsd.toFixed(4)}</dd></div>
                <div className="run-usage-row"><dt>cache read tokens</dt><dd>{usage.cacheReadTokens}</dd></div>
                <div className="run-usage-row"><dt>cache create tokens</dt><dd>{usage.cacheCreateTokens}</dd></div>
                <div className="run-usage-row"><dt>recorded at</dt><dd><time dateTime={usage.recordedAt} title={usage.recordedAt}>{usage.recordedAt}</time></dd></div>
              </dl>
            )}
          <h4 className="run-detail-sub">Per-task attribution</h4>
          <TaskAttributionSection journal={taskUsageJournal} runId={runId} />
          <h4 className="run-detail-sub">Surface observations (not canonical attribution)</h4>
          <SurfaceObservationsSection journal={surfaceUsageJournal} runId={runId} />
        </section>
      </div>
    </section>
  );
}