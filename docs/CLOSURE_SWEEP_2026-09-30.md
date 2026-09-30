# Closure sweep — 2026-09-30

Three GitHub issues remain stale-OPEN although their work landed days ago.
This sweep re-verifies each landing claim independently against this worktree's
git history and files (not against any summary), records the boundaries that
belong to other items, and gives a one-line closure recommendation per issue.
Agents cannot post comments or close issues; this document is the operator's
close-out record. Docs-only — no code touched.

Verified state at sweep time (read-only `gh issue view`):

```text
$ gh issue view 315 --json number,state,title
{"number":315,"state":"OPEN","title":"W162 - delegate from a board card (the amendment's first dispatch-class addition)"}
$ gh issue view 317 --json number,state,title
{"number":317,"state":"OPEN","title":"W163 - column convergence + volume honesty (state_reason splits, per-column caps, ETag conditional requests)"}
$ gh issue view 291 --json number,state,title
{"number":291,"state":"OPEN","title":"Parked P12: The cached-token metering blind spot (W109 gap 2, P2): the metrics model knows only…"}
```

Reachability of every cited commit from `HEAD` (`feat/stale-issue-closure`,
base `origin/main`):

```text
$ for c in a0e2f76 52284fa ddf9141 131ef1c 830849a ca4a6e9; do
    git merge-base --is-ancestor "$c" HEAD && echo "$c REACHABLE" || echo "$c NOT reachable";
  done
a0e2f76 REACHABLE
52284fa REACHABLE
ddf9141 REACHABLE
131ef1c REACHABLE
830849a REACHABLE
ca4a6e9 REACHABLE
```

---

## Issue #315 — W162, delegate from a board card

**State at sweep:** OPEN (stale; work landed).

**Verification commands run and their output:**

Durable ledger fragment present:

```text
$ ls docs/ledger/ | grep -i W162
W162-delegate-from-a-board-card-the-amendments-first-dispatch-class-addition.md
```

Slice 1 — delegate dispatch + hub-recorded provider-task attribution:

```text
$ git log --oneline --all --grep='W162 slice 1'
1bc63223 feat(ui): delegate from a board card — the dispatch-class slice with hub-recorded provider-task attribution (W162 slice 1)
$ git log --oneline --ancestry-path 1bc63223..HEAD --merges | tail -1
c55b9edd Merge pull request #322 from ultus-net/feat/w162-board-delegate
$ git show -s --format='%H %ci %s' c55b9edd
c55b9eddccb38a36a64505fda79dd62f7cd67992 2026-09-28 10:22:42 +1300 Merge pull request #322 from ultus-net/feat/w162-board-delegate
```

Slice 2 — hub-owned in_progress column (registry-side):

```text
$ git log -1 --format='%H %s' 52284fa
52284fafe61c0ee697c08458d64dcb97b3086816 feat(ui): the hub-owned in_progress column — open issues joined to active linked runs, registry-side (W162 slice 2)
$ git log --oneline --ancestry-path 52284fa..HEAD --merges | tail -1
ca4a6e9d Merge pull request #334 from ultus-net/feat/w163-column-convergence
```

Deferral c — the delegate form preselects the scoped project's workspace binding:

```text
$ git log -1 --format='%H %s' ddf9141
ddf9141fcba979295673ba7bd50643df207d5b8d feat(ui): the delegate form preselects the scoped project's workspace binding (W162 deferral c)
$ git log --oneline --ancestry-path ddf9141..HEAD --merges | tail -1
ca4a6e9d Merge pull request #334 from ultus-net/feat/w163-column-convergence
```

Refinements — the bridge capabilities object (#330) and the W170 residual
closure (#331, provider-honest runId + pre-click capability disclosure +
detail-view guard):

```text
$ git log --oneline 7bad4348^1..7bad4348 | tail -2
9cb2d228 refactor(hub): the bridge capabilities object — the extension point is a field, never a positional
$ git log --oneline 00d1f752^1..00d1f752 | tail -2
bcdaa6f9 fix(hub): the delegate lane's provider-honest runId + the card's pre-click capability disclosure + the detail-view guard (W170)
```

The landed surfaces exist in source (spot-check, not exhaustive):

```text
$ git grep -n "provider-task" -- src/integrations/run-registry.ts
src/integrations/run-registry.ts:101:  | { readonly kind: "provider-task"; readonly provider: "github" | "azure_devops"; readonly key: string; readonly url: string };
$ git grep -n "delegateBoardTask" -- src/cli/hub.ts
src/cli/hub.ts:456:    delegateBoardTask: recordProviderReads(providerReadLedger, (issue: number) => fetchBoardTask(boardProviderFromEnv(process.env), issue)),
$ git grep -n "inProgressBoardTasks\|activeRunIds" -- src/integrations/run-controller.ts
src/integrations/run-controller.ts:53:  activeRunIds?(): readonly string[];
$ git grep -n "delegateDefaultWorkspace" -- src/ui/webapp/board-view.tsx
src/ui/webapp/board-view.tsx:514:export function delegateDefaultWorkspace(projectWorkspaces?: readonly string[]): string {
```

**Discrepancy (verified, not a closure blocker).** The briefing attributed
W162 slice 1 to "PR #314 (a0e2f76)". That is wrong. PR #314 is
`Merge pull request #314 from ultus-net/feat/board-kanban-projection` (the W161
external-task board), and its head commit `a0e2f76` is
`docs(spec): the review's two self-consistency pointers …`, not the delegate
slice. The delegate slice-1 commit is `1bc63223` (`1bc6322` bound in the
fragment's evidence), carried by **PR #322** (`c55b9edd`). The W162 fragment
already records #322 correctly; the briefing's PR/commit attribution is the
only error, and no landing claim depends on it.

```text
$ git log -1 --format='%s' a0e2f76
docs(spec): the review's two self-consistency pointers — the superseded driving-split note and the vocabulary guard now carry dated forward-pointers to the amendment (the 'board' narrowing recorded in place, paperclip product-senses still forbidden)
```

**Boundaries that belong to other items (out-of-scope-by-design, not open
promises):**

- Scope cut, registered in the fragment: no checkout locks, no wake-on-assign,
  no agent self-claim — Workflow runs start via the application authority
  (`docs/ledger/W162-…:12,32`). These are design boundaries, not promises
  against this issue.
- The DOM-level rendered-deny round-trip (the spec's carried P3) is deferred
  and gated on the browser-e2e dependency decision — a **human gate** owned by
  the operator, re-registered on #315 per LESS-0062
  (`docs/ledger/W162-…:29`).
- The Board page's project scoping, which is what activates deferral c's
  default, is a registered deferral; the seam and pins landed
  (`docs/ledger/W162-…:25,30`).
- Precedence partner W165's in_review column (#327) and W171 (#333) are
  related waves recorded in the fragment; not part of #315's acceptance.

**Closure recommendation:** **close** — all three deliverables (slice 1, slice 2,
deferral c) are landed and verified on `origin/main`; the remaining items are
registered boundaries/human gates, not open promises.

---

## Issue #317 — W163, column convergence + volume honesty

**State at sweep:** OPEN (stale; work landed).

**Verification commands run and their output:**

Durable ledger fragment present:

```text
$ ls docs/ledger/ | grep -i W163
W163-column-convergence-and-volume-honesty.md
```

W163 commit and its carrier:

```text
$ git log -1 --format='%H %s' 131ef1c
131ef1c3dc128f8db0dcbb855af378624ba3e9eb feat(ui): provider-owned state_reason columns, per-column caps + honest counts, UI-local issue view state, hub-side ETag conditional reads (W163)
$ git log --oneline --ancestry-path 131ef1c..HEAD --merges | tail -1
ca4a6e9d Merge pull request #334 from ultus-net/feat/w163-column-convergence
$ git log -1 --format='%H %ci' ca4a6e9
ca4a6e9dcd33d61b42f55baca4b8222727890db2 2026-09-28 21:18:55 +1300
```

The #334 review's four P3s were dispositioned on PR #336 (merged):

```text
$ git log --oneline --all --grep='#336'
c14e54f0 Merge pull request #336 from ultus-net/fix/board-p3-residuals
$ git log -1 --format='%H %ci' c14e54f0
c14e54f0fcaa56780b63137a8d9393cbfd9813df 2026-09-29 00:15:08 +1300
$ git merge-base --is-ancestor c14e54f0 HEAD && echo REACHABLE
REACHABLE
```

The four landed surfaces exist in source (spot-check):

```text
$ git grep -n "stateReasonAuthority" -- src/integrations/task-provider.ts
src/integrations/task-provider.ts:865:  readonly stateReasonAuthority: boolean;
$ git grep -n "IssueViewState" -- src/ui/webapp/app.tsx
src/ui/webapp/app.tsx:24:import { readIssueViewStateGuarded, saveIssueViewStateGuarded, type IssueViewState } from "./issue-view-state.js";
$ git grep -n "BoardReadCache\|If-None-Match" -- src/integrations/task-provider.ts
src/integrations/task-provider.ts:140:export interface BoardReadCache {
```

**Boundaries that belong to other items (out-of-scope-by-design, not open
promises):**

- The DOM-level reason-propagation pin (LESS-0061's carried P3) stays gated on
  the browser-e2e dependency decision — a human gate; recorded on the W162
  fragment where the deferral boundary lives
  (`docs/ledger/W163-…:23`, `docs/ledger/W162-…:29`).
- The #336 residuals branch landed its three fixes and merged (c14e54f0); the
  W163 fragment's "branch-landed, not merged" caveat is superseded by that
  merge (append-only note appended below).

**Closure recommendation:** **close** — the state_reason splits, per-column
caps with received-count honesty, browser-local IssueViewState, and the hub-side
ETag conditional read all landed via #334; the #334 review's four P3s are
dispositioned and merged via #336. The DOM-level pin is a named human-gated
boundary, not an open promise.

---

## Issue #291 — P12, cached-token metering blind spot

**State at sweep:** OPEN (stale; work landed).

**Verification commands run and their output:**

The P12 row carries its dated landed note (W109 gap 2 closed):

```text
$ git grep -n "cacheReadTokens" -- docs/PARKED_AND_LIMITATIONS.md
docs/PARKED_AND_LIMITATIONS.md:41:| P12 | **The cached-token metering blind spot** (W109 gap 2, P2) — **LANDED (2026-09-27, PR #311): `cacheReadTokens`/`cacheCreateTokens` are first-class on the metrics model** … | … | Landed+verified (52/52 focused, test:ci 167/167) | Operator-approved 2026-09-24 (this file); landed note 2026-09-27 |
```

The W109 fragment carries the matching dated supersession:

```text
$ git grep -n "2026-09-27 supersession" -- docs/ledger/W109-the-transformbody-seam-bundle-w098-c2-w095-c2-w098-c4-comple.md
docs/ledger/W109-the-transformbody-seam-bundle-w098-c2-w095-c2-w098-c4-comple.md:144:**2026-09-27 supersession (P12 landed — W109 gap 2 closed, PR #311):**
```

The landing commit and its carrier:

```text
$ git log -1 --format='%H %s' 830849a
830849abfdd54e59044f89e42b8f1a19eede4c1c feat(p12): first-class cache metering fields — the cached-token blind spot closed (W109 gap 2)
$ git log --oneline --ancestry-path 830849a..HEAD --merges | tail -1
3c5dcdc0 Merge pull request #311 from ultus-net/feat/p12-cache-metering-fields
$ git log -1 --format='%H %ci' 3c5dcdc0
3c5dcdc0ee7a5baafc68181aea362580c14e6901 2026-09-27 18:37:29 +1300
```

The landed surfaces exist in source (spot-check):

```text
$ git grep -n "cacheReadTokens\|cacheCreateTokens" -- src/integrations/model-usage-proxy.ts
src/integrations/model-usage-proxy.ts:87:  readonly cacheReadTokens: number;
src/integrations/model-usage-proxy.ts:88:  readonly cacheCreateTokens: number;
$ git grep -n "RunUsageSummary" -- src/integrations/run-registry.ts
src/integrations/run-registry.ts:43:export interface RunUsageSummary {
```

**Boundaries that belong to other items (out-of-scope-by-design, not open
promises):**

- The OpenAI-lane cached-subset split refinement is named in the landed note
  itself: cached reads ride `prompt_tokens` on that lane; the cached-subset
  split via `prompt_tokens_details` is the recorded queued refinement
  (`docs/PARKED_AND_LIMITATIONS.md:41`; `docs/HUB_DASHBOARD_UI_GUIDE.md:144`
  states the recorded asymmetry, not hidden). The blind spot itself is closed;
  the refinement is a separate follow-on, not part of P12's acceptance.

**Closure recommendation:** **close** — the blind spot is closed with
first-class `cacheReadTokens`/`cacheCreateTokens` on the metrics model and the
per-run `RunUsageSummary`, verified in the merged PR #311; the OpenAI-lane
subset split is a named follow-on refinement.

---

## Record-completeness check

- #315 durable record: `docs/ledger/W162-delegate-from-a-board-card-the-amendments-first-dispatch-class-addition.md` — present.
- #317 durable record: `docs/ledger/W163-column-convergence-and-volume-honesty.md` — present.
- #291 durable record: `docs/PARKED_AND_LIMITATIONS.md` (row P12, dated landed note 2026-09-27) + `docs/ledger/W109-…` (dated supersession) — present.

One append-only caveat note was added to the W163 fragment this sweep (the #336
residuals merged after the fragment was written). Otherwise: **records
complete**.

Sweep fragment (write-once): `docs/ledger/CLOSURE-SWEEP-2026-09-30.md`.
