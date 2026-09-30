<!-- Ledger fragment: opened 2026-09-30 as a closure-confirmation record. Write-once — append dated supersession notes, never rewrite. -->

### Closure confirmation - P14 (issue #293) (2026-09-30)

**Source:** the operator's review of the open-issue backlog; the standalone issue is LANDED and the direct close route is blocked for agent sessions by the workflow-guard's live-system policy (only `WORKFLOW_GUARD_ALLOW_LIVE=1`, set before launch, overrides). This is the merge-route vehicle: the PR's `Closes #293` footer closes the issue on merge.

**Evidence:** the per-family cache-marker opt-in granularity landed via the merged PR #380 (`CacheMarkerOptIn = boolean | { [family]: boolean }`; a pure `cacheMarkersEnabled(optIn, family)`; `applyCacheMarkers` gated through it; the default dark, `true` all-keyed byte-unchanged, an omitted family OFF). The P14 row in `docs/PARKED_AND_LIMITATIONS.md` carries its dated landed note; the ledger fragment is `docs/ledger/P14-marker-granularity.md`. The issue's own ask ("per-family granularity queued") is delivered; the remaining dependency is the SEPARATE P8 item (#287 — the live vendor-probe verdicts gate enabling any family, and the gated harness landed via PR #378).

**Note:** no source, runtime, or test change accompanies this record — it is the closure vehicle only. Docs-only; lint/typecheck not applicable. The P8 probe dependency stays tracked on #287, not this issue.