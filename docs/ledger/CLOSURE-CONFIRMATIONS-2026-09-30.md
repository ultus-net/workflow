<!-- Ledger fragment: opened 2026-09-30 as a closure-confirmation record. Write-once — append dated supersession notes, never rewrite. -->

### Closure confirmations - the three stale-landed issues (#315, #317, #291) (2026-09-30)

**Source:** the operator's direction to close the stale-open issues whose work landed; the direct close route is blocked for agent sessions by the workflow-guard's live-system policy (only the `WORKFLOW_GUARD_ALLOW_LIVE=1` environment variable, set before launch, overrides). The closure evidence was posted as issue comments (#315 comment-5901853045; #317 comment-5901857829; #291 comment-5901858263) and the merged closure sweep (`docs/CLOSURE_SWEEP_2026-09-30.md`, PR #368) carries the verification. This record is the merge-route confirmation: the PR's `Closes` footers close all three when it merges.

**Evidence per issue:**

- **#315 (W162):** all slices landed — the delegate dispatch + hub-recorded provider-task attribution (commit 1bc63223, carried by PR #322; the batch-4 sweep corrected the earlier PR #314 attribution, corroborated by docs/agents/lessons.md:485), the hub-owned in_progress column (commit 52284fa, PR #334), the delegate-form workspace default (commit ddf9141, PR #334). Durable record: docs/ledger/W162-delegate-from-a-board-card-the-amendments-first-dispatch-class-addition.md. Remaining items are registered boundaries (the cut list; the DOM-level pin's browser-e2e human gate).
- **#317 (W163):** landed complete via PR #334 (the W163 commit 131ef1c) — state_reason splits, per-column caps with received-count honesty, browser-local IssueViewState, the hub-side ETag conditional read; the #334 review's P3s dispositioned on PR #336. Durable record: docs/ledger/W163-column-convergence-and-volume-honesty.md.
- **#291 (P12):** landed via PR #311 (commit 830849a) — first-class cacheReadTokens/cacheCreateTokens on the metrics model and the per-run RunUsageSummary; the parked-file P12 row carries its dated landed note. The OpenAI-lane cached-subset split remains a named refinement.

**Note:** no source, runtime, or test change accompanies this record — it is the closure vehicle only. Docs-only; lint/typecheck not applicable.