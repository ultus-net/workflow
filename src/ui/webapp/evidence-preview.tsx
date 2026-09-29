/**
 * W158 — the evidence strip's preview primitives and the evidence/content
 * hooks, one home for both consumers (the chat inspector's Evidence panel
 * and, since W175 phase 2, the run detail panel's Evidence tab). Moved out of
 * app.tsx so the detail panel can import them without an app.tsx import
 * cycle; app.tsx re-exports the pinnable surface so test/webapp-surface's
 * imports stay stable.
 *
 * ONE row renderer for local and hub evidence records. A record without
 * content renders as its plain self (the W154 strip); a record with content
 * renders the capture inline, and every non-ready state is NAMED, never a
 * silent fallback or a fabricated payload: loading (fetch in flight), absent
 * (the hub answered 404 — the ref is evicted, or the store restarted), and
 * unavailable (no hub to ask). The preview fetch is deduped per ref.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** W154 (the artifact strip's discriminator): an evidence record whose subject
 * is a filesystem path is an in-worktree SIGNPOST — the strip must never
 * present it as a durable artifact (the borrowings spec's criterion 3, pinned
 * by test). Everything else renders as the record it is. */
export function artifactKind(subject: string): "record" | "workspace-path" {
  return subject.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(subject) || subject.startsWith("~")
    ? "workspace-path"
    : "record";
}

/** W158: the strip's view of a kernel content reference — exactly what the
 * record carries (kind + ref + byteSize); the bytes live behind the ref in
 * the hub's bounded store, fetched through the same-origin /api/evidence-content
 * proxy. */
export interface EvidenceContentRefView {
  readonly kind: string;
  readonly ref: string;
  readonly byteSize: number;
}

/** W158: the strip's named preview states — every non-ready state says why,
 * and "ready" carries exactly the bytes the hub's route answered. No state is
 * fabricated: loading (fetch in flight), absent (the hub answered 404 — the
 * ref is evicted, or the store restarted: the per-store nonce makes a
 * persisted record miss honestly), unavailable (no hub to ask). */
export type EvidenceContentPreview =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly kind: string; readonly mediaType: string; readonly bytes: string }
  | { readonly status: "absent" }
  | { readonly status: "unavailable" };

const EVIDENCE_OUTPUT_RENDER_CAP = 4096;

/** W158 (the strip's preview rendering): ONE row renderer for local and hub
 * evidence records. A record without content renders as its plain self (the
 * W154 strip, unchanged); a record with content renders the capture inline —
 * test-output as text, screenshot as a data-URL image (the capture contract:
 * screenshots ride base64, test outputs ride utf8) — and every non-ready
 * state is named, never a silent fallback or a fabricated payload. A long
 * test-output renders its head plus a named truncation; the full bytes stay
 * in the hub's bounded store. */
export function EvidenceStripRow(props: {
  readonly subject: string;
  readonly result: string;
  readonly freshness: string;
  readonly origin: "local" | "hub";
  readonly content?: EvidenceContentRefView | undefined;
  readonly preview?: EvidenceContentPreview | undefined;
}) {
  const path = artifactKind(props.subject) === "workspace-path";
  return (
    <div className={`evidence-row ${props.freshness === "stale" ? "evidence-row-stale" : ""}`}>
      <p className="evidence-row-line">
        {path
          ? <span className="evidence-signpost" title="in-worktree signpost — a path, not a durable artifact">workspace path · </span>
          : <span className="evidence-record-tag">record · </span>}
        {props.origin === "hub" && <span className="evidence-origin-hub" title="produced by the hub's own flows (run-registry verdicts, the test runner)">hub · </span>}
        {props.subject}: {props.result} / {props.freshness}
      </p>
      {props.content !== undefined && <EvidenceContentPreviewBlock content={props.content} preview={props.preview ?? { status: "loading" }} />}
    </div>
  );
}

/** The strip's in-place preview block: only reached when the record carries a
 * content reference. */
function EvidenceContentPreviewBlock(props: { readonly content: EvidenceContentRefView; readonly preview: EvidenceContentPreview }) {
  if (props.preview.status === "loading") {
    return <p className="evidence-content-state">content · loading…</p>;
  }
  if (props.preview.status === "absent") {
    return (
      <p className="evidence-content-state" title="the ref is not in the hub's bounded store: evicted, a store restart (per-store nonce), or the capture was over-cap and never got a ref">
        content not available — evicted from the bounded store ({props.content.byteSize} bytes were recorded)
      </p>
    );
  }
  if (props.preview.status === "unavailable") {
    return <p className="evidence-content-state">content not available — the hub is unreachable</p>;
  }
  if (props.content.kind === "screenshot") {
    return (
      <img
        className="evidence-content-preview evidence-content-screenshot"
        src={`data:${props.preview.mediaType};base64,${props.preview.bytes}`}
        alt={`${props.content.kind} capture (${props.content.byteSize} bytes)`}
      />
    );
  }
  // test-output: bounded rendering — the store caps captures at 256KB and a
  // DOM node that big is a browser freeze, so the strip renders the head and
  // NAMES the truncation (the full bytes stay in the hub's store).
  const truncated = props.preview.bytes.length > EVIDENCE_OUTPUT_RENDER_CAP;
  return (
    <>
      <pre className="evidence-content-preview evidence-content-output">{truncated ? props.preview.bytes.slice(0, EVIDENCE_OUTPUT_RENDER_CAP) : props.preview.bytes}</pre>
      {truncated && <p className="evidence-content-state">first {EVIDENCE_OUTPUT_RENDER_CAP} bytes shown of {props.content.byteSize}; the full capture stays in the hub's bounded store</p>}
    </>
  );
}

/** The same 1.5s panel cadence the other shell surfaces poll (app.tsx's
 * constant is module-private, so the poll lives beside its consumers here). */
const PANEL_POLL_MS = 1500;

/** W158: a hub evidence record as the /api/evidence relay carries it — the
 * hub's kernel projection narrowed to what the strip renders. */
export interface HubEvidenceRow {
  readonly id?: string;
  readonly subject: string;
  readonly result: string;
  readonly freshness: string;
  readonly content?: EvidenceContentRefView;
}

/** W158: polls the hub's evidence relay. Degraded state is a NAMED absence:
 * rows null with the reason (no hub, or a hub older than the relay) — never a
 * fabricated empty list. */
export function useHubEvidence() {
  const [rows, setRows] = useState<readonly HubEvidenceRow[] | null>(null);
  const [reason, setReason] = useState<string | undefined>(undefined);
  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/evidence");
      if (response.ok) {
        const payload = await response.json() as { evidence: readonly HubEvidenceRow[] | null; reason?: string };
        setRows(payload.evidence);
        setReason(payload.reason);
      }
    } catch {
      // Keep the last good rows; the next poll retries.
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), PANEL_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { rows, reason };
}

/** W158: one preview fetch per content ref (deduped — two records citing the
 * same capture fetch once, and a settled ref never re-fires on the poll
 * cadence). Evicted/unknown refs stay absent; a hub outage marks
 * unavailable. */
export function useContentPreviews(refs: readonly string[]): ReadonlyMap<string, EvidenceContentPreview> {
  const [previews, setPreviews] = useState<ReadonlyMap<string, EvidenceContentPreview>>(new Map());
  const requested = useRef<ReadonlySet<string>>(new Set());
  const wanted = useMemo(() => [...new Set(refs)], [refs]);
  const wantedKey = wanted.join("\u0000");
  useEffect(() => {
    const pending = wanted.filter((ref) => !requested.current.has(ref));
    if (pending.length === 0) return;
    for (const ref of pending) (requested.current as Set<string>).add(ref);
    setPreviews((current) => {
      const next = new Map(current);
      for (const ref of pending) if (!next.has(ref)) next.set(ref, { status: "loading" });
      return next;
    });
    for (const ref of pending) {
      void (async () => {
        try {
          const response = await fetch("/api/evidence-content", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ref }),
          });
          if (response.status === 200) {
            const stored = await response.json() as { kind: string; mediaType: string; bytes: string };
            setPreviews((current) => new Map(current).set(ref, { status: "ready", kind: stored.kind, mediaType: stored.mediaType, bytes: stored.bytes }));
          } else if (response.status === 404) {
            setPreviews((current) => new Map(current).set(ref, { status: "absent" }));
          } else {
            setPreviews((current) => new Map(current).set(ref, { status: "unavailable" }));
          }
        } catch {
          setPreviews((current) => new Map(current).set(ref, { status: "unavailable" }));
        }
      })();
    }
    // wantedKey (not wanted) is the semantic dependency; wanted's identity
    // changes with the poll cadence, and the requested-guard above turns
    // those refires into no-ops.
  }, [wantedKey, wanted]);
  return previews;
}