<!-- Ledger fragment: opened 2026-09-30 as a closure-confirmation record. Write-once — append dated supersession notes, never rewrite. -->

### Closure confirmations - P13 (issue #292) and P9 (issue #288) (2026-09-30)

**Source:** the operator's backlog direction ("close issues if you can"); direct agent closes are blocked by the workflow-guard's live-system policy, so this merge-route PR carries both `Closes` footers.

**#292 (P13, the message-lane breakpoint policy):** the operator approved implementing **option B** (per-turn boundary marks), and it landed behind the dark `cacheMarkers` opt-in (merged in the marker-lane carrier; ledger `docs/ledger/P13b-per-turn-marks.md`). The policy is therefore DECIDED and IMPLEMENTED: the previous turn's end is marked each turn (exactly one conversation breakpoint, the static head preserved, never double-marked), default byte-unchanged. Activation waits on the operator's P8 per-lane verdicts (tracked on #287), not on this issue. The brief (`docs/P13_BREAKPOINT_POLICY_BRIEF.md`) remains as the re-open reference.

**#288 (P9, the messages-lane transform+metering governance):** the operator approved landing **option C** (markers-only) behind the dark opt-in, fixing the governance posture as "hold the shaping stance; markers available only under the per-family opt-in" (merged in the carrier; ledger `docs/ledger/P9c-markers-only.md`); the A′ parse-only model-label journal landed earlier (ledger `docs/ledger/P9a-parse-only-labels.md`). The lane stays untransformed by default; option D (the Messages-schema replay integrity check) remains a recorded successor if it is ever wanted, and the live marker effectiveness stays gated on #287. The brief (`docs/P9_MESSAGES_LANE_GOVERNANCE_BRIEF.md`) remains as the re-open reference.

**Note:** no source, runtime, or test change accompanies this record — it is the closure vehicle only. Docs-only; lint/typecheck not applicable.