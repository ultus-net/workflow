<!-- Ledger fragment: opened 2026-10-06 as a post-freeze W-item backfill (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### W165 - Work products and the in_review column (registry-sourced run->PR linkage) (Complete) (2026-09-28)

**Source:** GitHub issue #321 (closed 2026-09-28); spec `docs/superpowers/specs/2026-09-26-paperclip-dashboard-borrowings.md:267` (W165 section); landed in PR #327 (merge 2026-09-28T00:35:34Z, commit `a964b2d3`, 2026-09-28).

**What landed:**

- Hub-side run->PR linkage: `RunController.recordWorkProductLink({runId, link})` and `workProductLinks()` (bounded registry map, `src/integrations/run-registry.ts:269-270,400-406`) — the linkage is registry-sourced, never a UI computation.
- The provider-neutral card-state model in `src/integrations/task-provider.ts`: `WorkProductPullRequestState`, `WorkProductStateOutcome`, `WorkProductCardState`.
- `store state` of the card renders PR state read-only from the provider; the `in_review` column appears only when the linkage AND the provider PR state exist — an absent linkage renders "unlinked" honestly, never from a label guess.

**Evidence:** `test/work-product-linkage.test.ts` 14/14 (registry-source pin; hub-side-only guarantee; `recordWorkProductLink` keyed by runId; a mis-deduced linkage is refused; read-only provider state). The W171 follow-up later extended the discover/onDiscovered join; the linkage contract here is unchanged.

**Depends on:** W162's provider-task origin linkage (land order).
