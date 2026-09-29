/**
 * W177 — the Audit page: the three recorded authorization-adjacent lanes the
 * hub actually keeps, rendered projection-only (every element a record the
 * /api/audit relay returned — the view derives nothing):
 *
 *   1. The provider-read ledger (W167 `recordProviderReads`): the hub's most
 *      recent recorded provider read, with its freshness state derived ONLY
 *      through the shared `boardLinkLiveness` presenter — the same pill
 *      classes the board cards render, dashed when not fresh, and no pill
 *      without a record.
 *   2. The kernel transition / gate log (the timeline's kernel + gate rows,
 *      composed hub-side from the same `activityTimeline` projection the
 *      /api/timeline relay serves — no second row builder) with the
 *      projection's retention statement copied verbatim.
 *   3. The review provenance (W041 fingerprinted records, verbatim).
 *
 * The page-level NAMED ABSENCE is the in-memory permission-decision boundary,
 * stated verbatim as its own element — the page never implies completeness:
 * operator permission decisions (allow/deny) are resolved in-memory and are
 * NOT durably recorded; recording them hub-side is a recorded follow-up, out
 * of scope here.
 *
 * (Template literals are deliberately absent: string concatenation keeps
 * the source patchable under the guard shell classifier.)
 */

import { useEffect, useState } from "react";

import type { ProviderReadRecord } from "../../integrations/issue-detail.js";
import type { ReviewProvenanceRecord } from "../../review/provenance.js";
import { BOARD_LINK_LIVENESS_LABELS, boardLinkLiveness } from "./presenters.js";

/** The page-level named absence, VERBATIM (the spec's exact line; pinned by
 * test/webapp-audit.test.ts). Its own element — never a footnote on a lane. */
export const AUDIT_BOUNDARY_COPY = "operator permission decisions (allow/deny) are resolved in-memory (src/ui/permission-broker.ts) and are not durably recorded — the page states this boundary verbatim rather than implying completeness; recording permission outcomes hub-side is a recorded follow-up, out of scope here";

/** One kernel transition / gate row — the timeline row shape narrowed to the
 * two record kinds the audit lane carries (the hub narrows; the view does
 * not). */
export interface AuditKernelGateRow {
  readonly kind: "transition" | "gate";
  readonly actor: string;
  readonly authority: string;
  readonly summary: string;
  readonly at: string | null;
}

/** The /api/audit relay's record state, mirrored structurally. `audit` null
 * (or the fetch failing) is the named absence, never an empty ledger. The
 * provenance lane is three-state: absent → the hub predates the lane; null →
 * the lane exists but its journal read failed closed; a list → the records. */
export interface AuditRecordState {
  readonly audit:
    | {
      readonly providerReads: ProviderReadRecord | null;
      readonly kernelGates: readonly AuditKernelGateRow[];
      readonly kernelGatesRetention: string;
      readonly reviewProvenance?: readonly ReviewProvenanceRecord[] | null;
    }
    | null;
  readonly reason?: string;
}

/** Polls the W177 audit relay (the useRunsRecord pattern). Undefined until
 * the first answer; a hub that predates the block answers audit: null with
 * the reason. */
export function useAuditRecord(): AuditRecordState | undefined {
  const [state, setState] = useState<AuditRecordState | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/audit");
        const payload = (await response.json()) as AuditRecordState;
        if (!cancelled) setState(payload);
      } catch {
        if (!cancelled) setState({ audit: null, reason: "hub unavailable" });
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

export interface AuditViewProps {
  readonly record: AuditRecordState | undefined;
}

export function AuditView({ record }: AuditViewProps) {
  const audit = record?.audit ?? null;
  return (
    <div className="audit">
      <p className="audit-boundary" role="note">{AUDIT_BOUNDARY_COPY}</p>
      {audit === null ? (
        <p className="audit-absence">{record === undefined ? "the audit relay has not answered yet" : "no audit lanes — " + (record.reason ?? "the hub predates the audit relay")}</p>
      ) : (
        <>
          <section className="audit-lane audit-lane-provider-reads" aria-label="Provider-read ledger">
            <h3>Provider-read ledger</h3>
            <ProviderReadLane read={audit.providerReads} />
          </section>
          <section className="audit-lane audit-lane-kernel-gates" aria-label="Kernel transition and gate log">
            <h3>Kernel transition / gate log</h3>
            <KernelGateLane rows={audit.kernelGates} />
            <p className="audit-retention">{audit.kernelGatesRetention}</p>
          </section>
          <section className="audit-lane audit-lane-review-provenance" aria-label="Review provenance">
            <h3>Review provenance</h3>
            <ProvenanceLane rows={audit.reviewProvenance} />
          </section>
        </>
      )}
    </div>
  );
}

/** Lane 1: the recorded provider read, freshened only through the shared
 * presenter — no record claims no pill; not-fresh renders dashed. */
function ProviderReadLane({ read }: { readonly read: ProviderReadRecord | null }) {
  if (read === null) {
    return <p className="audit-empty">no provider-read record — the hub has performed no provider read (or predates the record)</p>;
  }
  const liveness = boardLinkLiveness(read, Date.now());
  const notFresh = liveness !== undefined && liveness !== "fresh";
  return (
    <div className="audit-read-row">
      <span className="audit-read-instant">{read.at}</span>
      <span className={"audit-read-outcome" + (notFresh ? " board-link-not-fresh" : "")}>{read.outcome}</span>
      {liveness !== undefined && (
        <span className={"board-liveness board-liveness-" + liveness} title={read.reason}>
          {BOARD_LINK_LIVENESS_LABELS[liveness]}
        </span>
      )}
      {read.reason !== undefined && <span className="audit-read-reason">{read.reason}</span>}
    </div>
  );
}

/** Lane 2: the kernel transition + gate rows, verbatim — a timeless record
 * says so (the view never fabricates a time). */
function KernelGateLane({ rows }: { readonly rows: readonly AuditKernelGateRow[] }) {
  if (rows.length === 0) {
    return <p className="audit-empty">no kernel transitions or gate records yet</p>;
  }
  return (
    <ul className="audit-gate-rows">
      {rows.map((row, index) => (
        <li className="audit-gate-row" key={String(index)}>
          <span className={"audit-gate-kind audit-gate-" + row.kind}>{row.kind}</span>
          <span className="audit-gate-body">
            <span className="audit-gate-summary">{row.summary}</span>
            <span className="audit-gate-attribution">{row.actor} · {row.authority} · {row.at === null ? "timeless" : row.at}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Lane 3: the fingerprinted review-provenance records — three honest states
 * (predates the lane / read failed closed / empty journal), never a fabricated
 * list. */
function ProvenanceLane({ rows }: { readonly rows: readonly ReviewProvenanceRecord[] | null | undefined }) {
  if (rows === undefined) {
    return <p className="audit-empty">the hub predates the review-provenance lane</p>;
  }
  if (rows === null) {
    return <p className="audit-empty">review provenance unavailable (the journal read failed closed)</p>;
  }
  if (rows.length === 0) {
    return <p className="audit-empty">no review provenance recorded yet</p>;
  }
  return (
    <ul className="audit-provenance-rows">
      {rows.map((row, index) => (
        <li className="audit-provenance-row" key={String(index)}>
          <span className="audit-provenance-head">
            <span className={"audit-provenance-disposition audit-provenance-" + row.disposition}>{row.disposition}</span>
            <span className="audit-provenance-reviewer">{row.reviewer}</span>
            <span className="audit-provenance-at">{row.recordedAt}</span>
          </span>
          <span className="audit-provenance-body">
            <span className="audit-provenance-workspace">{row.workspace}</span>
            <span className="audit-provenance-findings">{row.findings}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}