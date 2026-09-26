import { useEffect, useState } from "react";

import type { OperatorDecisionKind, OperatorDecisionRow, OperatorPosture } from "../../integrations/operator-posture.js";

/**
 * W150 — the operator posture strip + unified decision inbox (the Paperclip
 * borrow wave 1). A fixed strip ABOVE the shell's content regions answering
 * the three questions in order: runs awaiting review, budget incidents,
 * orphaned runs, schedules whose last run failed — then one decision list
 * merging them.
 *
 * Projection-only: every count and row comes from the hub's /snapshot posture
 * block (computed by the shared projection function over registry state);
 * this component mutates nothing — every action is navigation into an
 * existing panel. Actions render ONLY for targets the shell can honor today
 * (the schedules view); run/session inspection panels do not exist yet, so
 * those rows render without a button and the hub-served target is preserved
 * in the title (the recorded wave-1 gap, not a dead link).
 *
 * Fail-closed: no hub, or a hub that predates W150 (posture null), renders
 * the degraded strip ("hub posture unavailable") — never fabricated zeros.
 * Absent registries inside a live posture render as named "state
 * unavailable" counts.
 */

export interface PostureState {
  readonly posture: OperatorPosture | null;
  readonly reason?: string;
}

const COUNT_LABELS: ReadonlyArray<{ readonly key: keyof OperatorPosture["counts"]; readonly label: string }> = [
  { key: "awaitingReview", label: "awaiting review" },
  { key: "budgetIncidents", label: "budget incidents" },
  { key: "orphanedRuns", label: "orphaned runs" },
  { key: "failedSchedules", label: "failed schedules" },
];

const KIND_LABELS: Record<OperatorDecisionKind, string> = {
  review: "review",
  budget: "budget",
  orphan: "orphan",
  schedule: "schedule",
};

/** The targets the shell can route into an existing panel today. */
function actionView(target: string): "schedules" | undefined {
  if (target === "#schedules") return "schedules";
  return undefined;
}

export function usePosture(): PostureState | undefined {
  const [state, setState] = useState<PostureState | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/posture");
        const payload = (await response.json()) as PostureState;
        if (!cancelled) setState(payload);
      } catch {
        if (!cancelled) setState({ posture: null, reason: "hub unavailable" });
      }
    };
    void load();
    const poll = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, []);
  return state;
}

export function PostureStrip({ state, onAction }: {
  readonly state: PostureState | undefined;
  readonly onAction: (view: "schedules") => void;
}) {
  if (state === undefined || state.posture === null) {
    return (
      <div className="posture-strip posture-strip-degraded" role="status">
        <span className="posture-degraded-note">
          {state?.reason === undefined ? "operator posture: loading…" : `operator posture: hub unavailable (${state.reason})`}
        </span>
      </div>
    );
  }
  const posture = state.posture;
  const degraded = new Set(posture.degraded);
  return (
    <div className="posture-strip" role="status">
      <div className="posture-counts" aria-label="Operator posture">
        {COUNT_LABELS.map(({ key, label }) => {
          const count = posture.counts[key];
          return (
            <span key={key} className={`posture-count${typeof count === "number" && count > 0 ? " posture-count-active" : ""}`}>
              <span className="posture-count-value">{count === null ? "—" : String(count)}</span>
              <span className="posture-count-label">{label}</span>
            </span>
          );
        })}
      </div>
      {degraded.size > 0 && (
        <div className="posture-degraded-note">
          state unavailable: {[...degraded].join(", ")}
        </div>
      )}
      {posture.decisions.length > 0 && (
        <ul className="posture-decisions" aria-label="Decision inbox">
          {posture.decisions.map((row, index) => (
            <DecisionRowView key={`${row.kind}:${index}`} row={row} onAction={onAction} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DecisionRowView({ row, onAction }: {
  readonly row: OperatorDecisionRow;
  readonly onAction: (view: "schedules") => void;
}) {
  const view = actionView(row.action.target);
  return (
    <li className={`posture-row posture-row-${row.kind}`}>
      <span className={`posture-kind posture-kind-${row.kind}`}>{KIND_LABELS[row.kind]}</span>
      <span className="posture-row-body">
        <span className="posture-row-summary">{row.summary}</span>
        <span className="posture-row-attribution">
          {row.actor} · {row.authority}
        </span>
      </span>
      {view !== undefined ? (
        <button type="button" className="btn btn-ghost posture-row-action" onClick={() => onAction(view)}>
          {row.action.label}
        </button>
      ) : (
        <span className="posture-row-action posture-row-action-absent" title={`panel pending — target ${row.action.target}`}>
          {row.action.label}
        </span>
      )}
    </li>
  );
}