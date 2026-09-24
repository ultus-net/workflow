# Parked items and recorded limitations

**Purpose:** the canonical file where this repository's PARKED ITEMS
(work queued but deliberately not taken) and RECORDED LIMITATIONS
(claims with honest boundaries) live, so the operator-directed base
loops can re-address them. Created 2026-09-24 at the operator's
direction ("parked items and limitations need to be in their own file
so we can readdress with loops in the future").

**Approval record:** the operator explicitly approved the parked items
and limitations on 2026-09-24 (the merge of PR #107 plus this file's
direction). Individual entries created earlier rode inside merged PRs
(#101–#107) — the per-entry approval column states which.

**File rules:**
- Append-only entries; superseded entries get dated notes, never
  deletions.
- An entry leaves this file only when the work lands (link the PR) or
  the operator retires it.
- Every entry names its verification status truthfully: `landed+verified`
  / `structural-only` / `unmeasured` / `dispositioned-not-audited`.
- Future loops: consult this file BEFORE picking work — a parked item
  whose dependencies have since landed is the highest-value candidate,
  and a limitation marked `unmeasured` is a measurement opportunity.

## Parked items (work queued, deliberately not taken)

| # | Parked item | Source | Dependencies / conditions | Verification status | Approval |
|---|---|---|---|---|---|
| P1 | **W098 c3 — model affinity routing** as a W095 key-1 modifier (pool narrowing; cost tradeoff recorded: gives up per-request optimization for cache-hit savings; metering trail verified unaffected) | W098 criterion 3 | Unblocked 2026-09-24 (c1 audit complete, PR #106); W109's transformBody seam is the transform point | Design not started — `unmeasured` | Operator-approved 2026-09-24 (this file) |
| P2 | **W112 — the grant lifecycle**: `allow_always` is tool-name-wide, immortal, in-memory (expiry/ownership/consumption queued); nearest building blocks named (the opencode-server authority's single-use consumption maps; the provenance-store fingerprint discipline) | W112 item | Self-contained; pairs naturally with residual #26's mitigation if the answer route gains server-side checks | Design not started | Operator-approved 2026-09-24 (this file) |
| P3 | **W114 follow-on — the authorized-attach machinery**: surface the producing flow per missing artifact, route around claim-shaped endpoints; plus the kernel-side operator/claim authority class (a kernel design with gate semantics of its own — its own iteration) | W114; feeds residual #26's mitigation | Depends on the kernel authority-vocabulary design decision (operator input recommended) | Design not started | Operator-approved 2026-09-24 (this file) |
| P4 | **W111 — per-task attribution mechanism**: turn-boundary deltas paired with the active-task pointer at boundary time (the UsageTurnTracker pattern); the server-topology path needs new plumbing for per-session split. Also: the cache-read split (queued on the W109 gap, P8) and signature-dedup (moot without a persisted event ledger — the dependency is named) | W111 | Needs the turn-boundary mechanism design; the honest C4 slice (landed) states what is measured today | Design not started | Operator-approved 2026-09-24 (this file) |
| P5 | **W095 — the routing design note's frontier round 3 + the per-role end-to-end verification** (the note exists, frontier-verified through round 2) | W095 criteria 1/3/4 | Round 3 pending; the de-facto MoE per-role check needs live provider runs | Note exists, frontier r2 done; e2e unrun | Operator-approved 2026-09-24 (this file) |
| P6 | **W097 queue**: the ask channel on the other four seats; the plane-3-prime pending-ask surface; a daemon-level end-to-end ask pin; G2 part 2 (`trustedRole`); the G4 matched-surface field; the dist-freshness pin; the npm pack verifier debt (**human-gated** — needs operator action) | W097's queued list | Independent items; the npm-pack debt is npm-version drift vs the artifact tests | Mixed: the ask-channel work has landed designs to extend; the rest queued | Operator-approved 2026-09-24 (this file) |
| P7 | **W093/W096 duplicate resolution** — the same operator-intent item (serverless hosting, 2026-09-22) recorded twice; merge into one or supersede one | The contradiction sweep (PR #107) | **Operator's call** — both are operator-intent records; W096 carries the fuller constraint enumeration, W093 the plane-3 loopback facts | Flagged, unresolved | Operator decision pending (surfaced 2026-09-24, PR #107) |
| P8 | **Vendor probes**: whether the anthropic-compatible endpoints (deepseek/glm/kimi) accept the Messages-schema `cache_control` markers — the W109 cache-marker opt-in stays dark until per-vendor probes land | W109/W098 c2 note | Needs live vendor probes (the HOST_ADAPTERS probe pattern) | Unprobed | Operator-approved 2026-09-24 (this file) |
| P9 | **The messages-lane transform+metering governance gap** (pre-existing, P1): the messages path passes through the proxy unmetered and untransformed — the pipeline gates on /chat/completions | W109's end-to-end finding | Pre-existing gap; W111's cache-read split queues on it | Recorded as a live gap in the W109 item | Operator-approved 2026-09-24 (this file) |
| P10 | **Residual #26 mitigation** — a server-side approvability gate on the permission answer route (one field read: the broker classifies at parking) or an operator-confirmation field riding the existing answer path | SECURITY_ASSURANCE residual #26 (W115's recorded residual) | Surfaced explicitly to the operator 2026-09-24; pairs with P2/P3 | The residual is code-verified (reviewer, PR #107) | Operator-approved 2026-09-24 (this file) |
| P11 | **W098 affinity measurement** — when c3 lands, the cache-hit improvement needs a live-traffic measurement (the honest caveat from c1: structural verification only) | W098 c1 note | Depends on P1 landing + provider-side observability | Unmeasured | Operator-approved 2026-09-24 (this file) |

## Recorded limitations (claims with honest boundaries)

| # | Limitation | Where recorded | Verification status | Approval |
|---|---|---|---|---|
| L1 | W098's cache effects are verified **structurally only** (ordering pins + append-only serialization); the live provider cache-hit improvement is **unmeasured** | W098 criterion 1 (PART 1 note); LESS-0034 | structural-only | Operator-approved 2026-09-24 (this file) |
| L2 | Host-composed prefixes (the OpenCode environment block, compaction rewrites, mid-session tool churn; MCP-mount tool serialization on the wire) are **dispositioned as host-side, not audited** — the hub cannot pin what it does not compose; that segment's cache behavior is **unmeasured** | W098 criterion 1 (PART 2 note); LESS-0037 | dispositioned-not-audited | Operator-approved 2026-09-24 (this file) |
| L3 | The under-cap permission-poll wire **gains** `inputOverCap: false` — the view is identity for unflagged requests but not byte-identity | W115 residuals; LESS-0036 | landed+verified (view-identity pinned) | Operator-approved 2026-09-24 (this file) |
| L4 | The permission answer route applies **no server-side approvability re-check** — the card's cap and the transport cap are display-side disciplines | SECURITY_ASSURANCE residual #26; W115 residuals | Code-verified (fresh-eyes reviewer, PR #107); trust boundary = the accepted uncredentialed-loopback web channel | Operator-approved 2026-09-24 (residual #26 + this file) |
| L5 | The full parked permission input still lives in memory at the broker (the agent's own spend) — only the per-poll shipping is capped | W115 residuals; LESS-0036 | landed+verified (the answer-path pin) | Operator-approved 2026-09-24 (this file) |
| L6 | The evidence endpoint's honest closure: the claim-shaped endpoint was **removed**; the authorized-attach replacement is parked (P3) | W114 item; LESS-0035 | landed+verified (closure pins) | Operator-approved 2026-09-24 (this file) |
| L7 | Determinism pins on the pure guidance composers deliberately **not** added — the full-content snapshot pins already freeze any interpolation; a call-to-call equality pin on a pure function adds no discriminating power | LESS-0037 | structural-only (rationale recorded) | Operator-approved 2026-09-24 (this file) |
| L8 | The anthropic-compatible vendor endpoints (deepseek/glm/kimi) accepting the Messages-schema cache markers is **unprobed** — the W109 opt-in stays dark | W098 c2 note; W109 | unprobed (per-vendor probes queued, P8) | Operator-approved 2026-09-24 (this file) |