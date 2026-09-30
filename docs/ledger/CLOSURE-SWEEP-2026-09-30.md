<!-- Ledger fragment: opened 2026-09-30 as a closure-sweep record (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### CLOSURE-SWEEP - stale-issue closure sweep for #315 / #317 / #291 (2026-09-30)

**Source:** operator closure hygiene — three GitHub issues (#315 W162, #317 W163,
#291 P12) remain stale-OPEN although the work landed days earlier. Agents cannot
post comments or close issues (guard live-block), so this record is the
operator's close-out artifact. Full per-issue verification, commands, and output:
`docs/CLOSURE_SWEEP_2026-09-30.md`.

**What landed (the sweep record):**

- **#315 (W162 — delegate from a board card):** slice 1 `1bc63223` (PR #322,
  merge `c55b9edd`), refined by #330 (`7bad4348`) and #331 (`00d1f752`,
  `bcdaa6f9`); slice 2 `52284fa` and deferral c `ddf9141` (both PR #334, merge
  `ca4a6e9`). Durable fragment
  `docs/ledger/W162-delegate-from-a-board-card-the-amendments-first-dispatch-class-addition.md`.
- **#317 (W163 — column convergence + volume honesty):** `131ef1c` (PR #334,
  merge `ca4a6e9`; the #334 review's four P3s dispositioned on PR #336, merge
  `c14e54f0`). Durable fragment
  `docs/ledger/W163-column-convergence-and-volume-honesty.md`.
- **#291 (P12 — cached-token metering blind spot):** `830849a` (PR #311, merge
  `3c5dcdc0`). Durable record `docs/PARKED_AND_LIMITATIONS.md` row P12 (dated
  landed note 2026-09-27) + `docs/ledger/W109-…` (dated supersession).
- **Discrepancy recorded (not a blocker):** the sweep briefing attributed W162
  slice 1 to "PR #314 (a0e2f76)". `a0e2f76` is a docs(spec) commit carried by PR
  #314 (`a7dc008f`, the W161 board projection); the delegate slice-1 commit is
  `1bc63223`, carried by PR #322. No landing claim depends on the bad
  attribution.
- **Record maintenance:** the W163 fragment's "residuals #336 branch-landed, not
  merged" caveat was superseded by an appended dated note (2026-09-30); #315's
  and #317's durable records and #291's landed note were already complete.

**Evidence:** read-only `gh issue view` confirmed all three states OPEN at sweep
time; every cited commit verified reachable from HEAD via
`git merge-base --is-ancestor`; landing PRs resolved via
`git log --oneline --ancestry-path <commit>..HEAD --merges`; landed surfaces
spot-checked via `git grep` (`provider-task` origin, `delegateBoardTask`,
`inProgressBoardTasks`/`activeRunIds`, `delegateDefaultWorkspace`,
`stateReasonAuthority`, `IssueViewState`, `BoardReadCache`/`If-None-Match`,
`cacheReadTokens`/`cacheCreateTokens`, `RunUsageSummary`). `npm run lint` and
`npm run typecheck` exit 0 unpiped. No code changed; docs-only. Closure
recommendations: close all three; the remaining items (W162's scope cut, the
DOM-level reason-propagation pin's browser-e2e human gate, P12's OpenAI-lane
cached-subset refinement) are registered boundaries/human gates, not open
promises.
