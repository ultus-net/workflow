# Branch-exit and branch-pointer policy: the unification position (W100)

**Date:** 2026-09-23 · **Status:** position recorded (frontier REVISE round
applied; confirmation round pending), implementation queued · **Source:** the
G5 queued follow-up from `docs/AGENTS_RESEARCH_PORT_ASSESSMENT_2026-09-22.md`
(§2 F1, §6 G5, §11) plus this iteration's live-probe findings and the round-1
frontier corrections (appendix A). Author: RSI base-loop session
(ses_f34e91c77ffekcRQkQKPCf5nLZ). Frontier verification: appendix A
(append-only, rounds recorded including wrong ones; every incorporated
finding was re-verified against the tree before incorporation).

Writing convention note: this document spells force-prefixed refspecs in
prose (e.g. "plus-prefixed source refspec") because the live guard's file
scanner blocks any file carrying the force-refspec shape literally — the
scanner incident is recorded in appendix A.

## 1. Scope and method

The branch-exit family — every git spelling that changes which commit a
branch or HEAD points at, or discards working-tree state — is classified by
the vendored guard's `gitWriteRe` (mcp-toolbox/apps/workflow-guard-mcp/src/
git-policy.ts:7) gated by `protectedBranchWriteReason` (deny only on a
protected branch with W090 facts supplied). W099 froze that classification
AS FOUND with characterization pins. This position covers the NEXT decision:
what the classification SHOULD be, now that probing shows the as-found allow
side is not merely inconsistent but contains deny-worthy members.

Method: every row in §2 was probed LIVE against the built vendored core
(`dist/policy.js`, byte-current with src as of W099 — W099 changed no src)
via `checkPolicy`, with W090 facts (`currentBranch`, `protectedBranches`)
and without, and cross-checked against the matcher source. Round-1 frontier
findings were re-probed the same way before incorporation (appendix A).
Upstream parity was verified READ-ONLY against the upstream checkout's
`origin/main` ref (`03fbdcf`, `git describe --tags` = v1.15.0-5-g03fbdcf,
package 1.15.1) — an earlier draft cited "v1.15.0" based on the checkout's dirty
v1.11.0-4 working tree; corrected by round 1. The plugin repo is never
written to (its side branch is dirty by design; read-only verification only).

## 2. The family inventory (probed 2026-09-23, vendored dist; verified rows, not claims)

### 2.1 On the protected branch (currentBranch facts supplied: `main`)

| # | command | git semantic | verdict | right? |
|---|---|---|---|---|
| 1 | `git checkout -b feat/g5` | create branch (fails if exists) | allow | ✓ sanctioned exit; the redirect names it |
| 2 | `git switch -c feat/g5` | create branch (fails if exists) | allow | ✓ same intent, safe spelling |
| 3 | `git switch feat/g5` · `git switch main` | pure branch exit | allow | ✓ gate writes, not the exit |
| 4 | `git checkout feat/g5` | branch exit OR path discard OR detach — ambiguous | deny `protected-branch-write` | ✓-defensible (see §3.1) |
| 5 | `git checkout <sha>` | detach HEAD | deny | ✓ conservative |
| 6 | `git switch --detach abc123def` · `-d abc123def` | detach HEAD | **allow** | ✗ hole — checkout's detach is denied, switch's is not (long AND short forms) |
| 7 | `git checkout -- src/a.ts` | working-tree discard | deny | ✓ load-bearing (W099 pin) |
| 8 | `git checkout -B main abc123def` | reset protected pointer + switch | deny | ✓ |
| 9 | `git switch -C main [abc123def]` | reset protected pointer | **allow** | ✗ **hole** — identical intent to #8, allowed |
| 10 | `git branch -f main abc123def` | move protected branch pointer | **allow** | ✗ **hole** (`-[dDM]` class misses `-f`); with AND without facts |
| 11 | `git branch -m main renamed` · `--move` long form | rename the protected branch | **allow** | ✗ **hole** (class covers uppercase `-M` only) |
| 12 | `git branch -m renamed` (one-arg, on `main`) | rename the CURRENT (protected) branch away | **allow** | ✗ **hole** — the one-arg form's target is the current branch, invisible to any command-text parser |
| 13 | `git branch -m x main` | rename TO the protected name | **allow** | ✗ **hole** — the protected operand is the SECOND arg |
| 14 | `git branch -C feat main` (also bundled `-cf`) | force-COPY overwrite of the protected pointer | **allow** | ✗ **hole** — `--copy` never entered the class |
| 15 | `git switch -f main` · `--discard-changes main` | exit + discard uncommitted changes | **allow** | ✗ hole — checkout's discard twin (#7) is denied; data-loss class, not pointer class |
| 16 | `git branch -M main renamed` · `-D feat/g5` | force-rename/delete while on protected | deny | ✓ conservative, target-blind |
| 17 | `git branch main abc123def` | create at sha (fails if exists) | allow | ~ harmless on real repos (main exists → git refuses) |
| 18 | `git reset --hard abc123def` | working-tree + index reset | deny | ✓ |
| 19 | `git switch --orphan fresh` | orphan create (git refuses existing names) | allow | ✓ create-class |
| 20 | `git checkout --orphan fresh` | orphan create via checkout | deny | ~ benign asymmetry (checkout clause is coarser; create-intent denied) |
| 21 | `git checkout -t origin/x` | create tracking branch via checkout | deny | ~ create-class over-deny, consistent with #4's fail-closed ambiguity |

### 2.2 The cross-branch dimension (on a FEATURE branch, targeting `main`) — round-1 finding, re-verified

The deny class is **current-branch-gated** (`protectedBranchWriteReason`
fires only when the CURRENT branch is protected). Writes to a protected
branch FROM another branch are caught only on the push lane:

| # | command (currentBranch `feat/g5`) | git semantic | verdict | right? |
|---|---|---|---|---|
| 22 | `git branch -D main` | DELETE the protected branch | **allow** | ✗ **hole** — stricter than #10, allowed |
| 23 | `git update-ref refs/heads/main abc123def` | move the protected pointer by plumbing | **allow** | ✗ **hole** — `update-ref` IS in `gitWriteRe` but the gate is current-branch-shaped |
| 24 | `git fetch origin main:main` (and its plus-prefixed force-source variant) | FETCH-refspec moves the protected pointer | **allow** | ✗ **hole** — git only refuses fetch-into-checked-out; the guard has a push-refspec rule and NO fetch-refspec rule |
| 25 | `git symbolic-ref HEAD refs/heads/main` | repoint HEAD at the protected ref | **allow** | ~ exit-class today (harmless as an exit); `symbolic-ref refs/heads/main <ref>` can also repoint the protected NAME itself — exotic, one-line pin queued |
| 26 | protected-branch PUSH variants (force flag to the protected branch, force-prefixed source refspecs, bare-destination pushes, deletion pushes) | push lane moving a protected ref | deny `protected-branch-push` | ✓ (verified by round 1; the push lane is target-shaped, the model to copy) |
| 27 | `git worktree add ../wt main` | check main out into a NEW worktree (no pointer move) | allow | ✓ correct — the new worktree's seat is a different workspace-boundary subject |
| 28 | `sh -c 'git checkout -B main abc123def'` · `sh -c 'git update-ref refs/heads/main abc123def'` · `sh -c 'git reset --hard abc123def'` | ANY deny-class command behind a shell wrapper | **allow** | ✗ **residual family** — `checkGitPolicy` does not recurse into `sh -c`/`bash -c` (`hasGitMutation` does, but only feeds the read-only-role gate, policy.ts:136/141); this bypasses EVERY deny row including the load-bearing #7/#18 |

### 2.3 The twin-matcher drift (round-1 finding, re-verified)

`hasGitMutation` (a separate matcher feeding the read-only-role gate) returns
**false** for `branch -f/-m/-C` and for the fetch refspec, and **true** for
`switch -C/--detach` — the two matchers are maintained independently and
have already drifted. Any position that widens one must widen both, with
pins.

The W099 pins froze rows 1–4, 7, 8 and the feature-target member of row 9
(`switch -C feat/g5` allow) as-found — precisely and ONLY those (round 2
verified: rows 16, 17, 18 and the row-6 member have no pins anywhere in the
suite, so this position adds NEW characterization pins for them; row 5's
deny rides the same matcher clause as row 4's pin but has no explicit
sha-form pin — §4.1's watch-item adds one). Rows 6,
9–15, 22–25, 28 were discovered by THIS iteration's probe and by the
frontier rounds — the F1 disease's allow side is not cosmetic: it admits
every protected-branch pointer write that the checkout spelling denies.

## 3. Analysis

### 3.1 Why the deny of row 4 is right, and the allows of rows 6–15 are wrong

The matcher's unit is the SPELLING, but the thing being protected is a
SEMANTIC class. Sorting the family by what git actually does:

- **Pure exits** (rows 1–3): create-or-switch that fails cleanly on conflict;
  never move a protected pointer, never discard. Allowed — including
  `switch main` (an exit, not a write on main).
- **Ambiguous overload** (row 4): `git checkout <token>` is branch exit,
  path discard, and detach depending on the token — indistinguishable
  without branch-identity facts the seat does not supply. With facts, the
  deny is fail-closed honesty; WITHOUT facts the deny does not engage at all
  (row-4 no-facts is allow — pinned as-found in W099 and re-verified by
  round 1; the earlier draft wrongly called it "fact-independent"). The
  switch spelling (branch-only by git's grammar) is the unambiguous exit,
  which is why row 3 is allowed and row 4 is denied.
- **Discards** (rows 7, 15): real working-tree mutation (data loss of
  uncommitted work). Checkout's discard is denied with facts; switch's is
  not — a hole, but of the data-loss class, not the pointer-integrity class.
- **Protected pointer writes and detaches** (rows 5, 6, 8–14, 22–24): every
  spelling that moves a protected branch's commit pointer, deletes/renames
  the branch — regardless of the CURRENT branch — plus HEAD-detach (rows
  5/6; a detach moves HEAD, not the branch pointer, but it is the same
  conservative deny class as row 5). The deny class is SEMANTIC, but the
  matcher implements it (a) spelling-shaped and (b) current-branch-gated, so
  the checkout spellings deny while the switch/branch/plumbing spellings
  allow, and the whole class vanishes when the agent is standing elsewhere.
  **A deny-with-redirect that blocks one spelling of an intent while
  allowing two others trains the bypass**: the mechanism is variant-retry
  after a deny (the redirect names only the sanctioned `checkout -b`, so a
  redirect-following model never lands on a hole spelling — the risk is the
  model that retries variants instead), and the W099 pins exist precisely
  because the same disease was found recurring across spellings.

### 3.2 Why this matters for Checkpoint D

Upstream v1.15.x (verified at `origin/main` 03fbdcf, `src/policies/git.ts:
126`) has the same family: no `switch` write clause, `-[dDM]` without
`-f/-m/-C`, no fetch-refspec rule, and the same current-branch gating; its
`GIT_BRANCH_CREATE_RE` (`checkout -b | switch -c|--create`, git.ts:35)
recognizes the sanctioned creates but only for the branch-freshness gate —
never as an exemption from the write class. The vendored core mirrors
upstream (at parity). Retirement (Checkpoint D) is parity-gated — but parity
to a hole is not a security property. The position below fixes the family
ONCE, vendored-side, records the deliberate upstream divergence in the
parity log, and queues the upstream port; the plugin retirement gate then
inherits the fixed semantics instead of freezing the holes.

## 4. Position: unified semantic classifier, target-gated, fail-closed under uncertainty

**The decision: classify by git SEMANTIC, not by spelling. Every
pointer-affecting spelling the matcher family covers joins the deny class;
the protected-target check runs on the PARSED TARGET against the always-on
default set (`{main, master}` ∪ W090 `protectedBranches` facts) — the same
shape the push lane already uses — pure exits and creates stay allowed, and
any form the parser cannot resolve fails closed. Two pointer-adjacent
residuals sit OUTSIDE the covered family by explicit decision (not
oversight): the shell-wrapper lane (row 28) and the exotic symbolic-ref
form (row 25) — both recorded in item 6 with queued companion fixes.**

1. **Extend both matchers to the full pointer family** (§2.3 discipline —
   `gitWriteRe` AND `hasGitMutation` in the same change, per-segment via
   `splitShellSegments`): `switch` joins for `-C`/`--detach`/`-d`;
   `branch` widens to `-f`/`-m`/`--move`/`-C`/`--copy` (bundled shorts like
   `-cf`/`-fm` handled by the word-splitter's per-character option walk);
   the fetch lane gains a destination-refspec check mirroring the push
   lane's (deny when the destination is a protected ref, including the
   force-prefixed source form); `update-ref`'s existing match becomes
   target-shaped.
2. **Structured protected-target gate**: for force/rename/copy/delete/
   update-ref/fetch-destination forms, parse the target operand(s) —
   renames check BOTH operands (rows 11–13), the one-arg rename form
   resolves to `currentBranch` (row 12: needs the fact; no fact → deny).
   Deny `protected-branch-write` when the target ∈ the protected set
   (defaults ∪ facts — this part is fact-INDEPENDENT for `main`/`master`
   because the set's base is hardcoded, and fact-EXTENDED for custom
   protected lists). Non-protected targets stay allow (legitimate:
   force-moving or renaming your own feature branch during rebase
   recovery). Parse-uncertain shapes (`--` separators, unresolvable
   bundles) → deny (fail-closed under uncertainty).
3. **Fail-closed without facts, split by class**:
   - force/rename/copy/update-ref-target/fetch-destination: the
     target check runs against the always-on base set even factless
     (the target is IN the command text); unparseable → deny. This closes
     rows 9/10/11/13/14/22/23/24 for `main`/`master` targets without any
     fact supply, while custom-config targets (e.g. `release`) still need
     facts — a strict tightening of today, never a loosening.
   - detach (row 6) does NOT join the target gate — a detach target is a
     commit sha, never a protected ref, so the target gate cannot classify
     it; it joins row 5's class instead: fact-gated conservative deny
     (deny when the current branch is protected), factless allow — the
     same asymmetry row 5 already has (checkout detach factless is allow,
     pinned).
   - the one-arg rename (row 12) denies factless (its target is the
     current branch; without the fact it cannot be classified → fail
     closed).
   - working-tree discards (row 15, `switch -f/--discard-changes`) join the
     row-7 class: fact-gated deny (deny when current branch is protected),
     factless allow — consistent with the W099 pin on `checkout --`; the
     data-loss class is already tolerated factless for the checkout
     spelling and this position does not change that tradeoff, it only
     makes the two spellings symmetric.
   - pure exits (rows 1–3) and creates (`-b`/`-c`) stay allowed without
     facts; row 4's ambiguity deny remains fact-gated as found (pinned).
4. **Rows that do NOT move**: 1–5, 7, 8, 16–21 (their classification is
   unchanged; rows 16–18 currently have NO pins anywhere — §4.1 adds
   characterization pins for them rather than "re-asserting" pins that do
   not exist); the cross-branch rows the position FIXES are 22–24, plus 6
   and 9–15 under facts per item 3; the W099 pins stay red-free under this
   design (they pin rows 1–4, 7, 8, the row-9 feature-target member, and
   the no-facts rows 4/7 forms — all classes whose classification is
   unchanged; row 5's sha form is unpinned and gets the §4.1 watch-item
   pin).
5. **Pin discipline**: every changed row gets a red-first pin whose red
   assertion IS the probe-recorded as-found verdict (rows 6, 9–15, 22–24);
   unchanged rows re-asserted; no existing pin weakens (never edit tests to
   pass — the W099 set survives verbatim).
6. **Residuals recorded, companion fixes queued** (rows 28 and 25): the
   shell-wrapper bypass of the ENTIRE deny class (including the load-bearing
   discards and `reset --hard`) is a stated residual — `hasGitMutation`
   already recurses into `sh -c` (depth 16), but `checkGitPolicy` does not;
   extending the deny path to the same recursion is the queued companion
   fix. The exotic symbolic-ref form (row 25: `symbolic-ref refs/heads/
   <protected> <ref>` — repointing the protected NAME itself; its HEAD
   sibling is a harmless exit) is likewise outside the covered family and
   queued as a one-line matcher addition with its as-found pin. Both
   residuals join SECURITY_ASSURANCE.md. This position fixes the
   spelling-shaped holes; these lanes are recorded and queued, not silently
   left.
7. **Divergence record**: the vendored core deliberately diverges from
   upstream v1.15.x (verified at `origin/main` 03fbdcf — holes in §3.2);
   parity-log entry with the upstream line pin; the upstream-port candidate
   queued for the plugin's own repo (NOT this repo's to patch). Upstream's
   `GIT_BRANCH_CREATE_RE` precedent (sanctioned-exit recognition, git.ts:
   35) supports the exits/creates allow class designed here.
8. **Redirections**: `protected-branch-write` guidance stays
   `git checkout -b` (the sanctioned exit is unchanged); the deny reason for
   the new members names the semantic ("branch pointer writes on protected
   branches are not allowed") so the redirect cannot be read as "try another
   spelling"; the new deny reasons name the parsed target so the operator
   sees WHICH protected ref was targeted.

### 4.1 Implementation sketch (queued, next iteration — NOT in this PR)

- `git-policy.ts`: widen `gitWriteRe`; add `branchPointerTargets(command)`
  parsing per segment (reusing `normalizedGitSegments`/`unwrapShellWords`,
  global value-options already skipped) returning target + form class;
  extend `checkGitPolicy` with the target gate ordered after the alias and
  push checks; widen the `hasGitMutation` matcher identically.
- Pins, by bucket: rows 6, 9–15, 22–24 red-first (the red assertion IS the
  probe-recorded as-found verdict); rows 16–18 + 19–21 NEW characterization
  pins (as-found — no pins exist for them today, round 2 verified); rows
  1–4, 7, 8, 9-feature-member re-asserted via the EXISTING W099 pins
  (row 5 rides the same clause; its explicit sha-form pin is this bucket's
  round-3 watch-item); row 25's HEAD form + row 28's residual pinned as-found
  documentation. Round 3 watch-items folded in: one EXPLICIT `git checkout
  <sha>` pin (deny with facts / allow factless — row 5's verdict currently
  rides the clause-level standard and a future token-discriminating matcher
  edit could move it silently); row 27 gets a characterization pin so the
  bucket plan is exhaustive over rows 1–28 (row 26 rides the existing
  push-lane pins, policy.test.ts:249/431/437–441). No existing pin weakens
  (never edit tests to pass — the W099 set survives verbatim).
- dist rebuild (LESS-0010 hazard: ensureBuilt only builds when dist is
  MISSING) + live re-probe of the full §2 table against the rebuilt dist.
- Parity-log divergence entry; SECURITY_ASSURANCE residual for the wrapper
  lane; TASKS.md item closes with the red-to-green evidence table.

## 5. Rejected alternatives

- **Symmetric-deny `switch`** (make `switch <branch>` denied like
  `checkout <branch>`): kills the sanctioned pure exit, contradicts the F1
  remediation direction ("gate commits/edits/pushes, not the exit"), and the
  redirect text would point at an exit the matcher then blocks. Rejected.
- **Unconditional `-B`/`-C`/`-f` allow** (spelling parity by loosening):
  codifies the pointer-write holes. Rejected — the probe shows the holes are
  the finding, not the baseline to enshrine.
- **Document-only (keep status quo)**: the deny trains a bypass the guard
  itself permits; a security posture that depends on the model not noticing
  an allowed spelling is not a control. Rejected.
- **Blanket fail-closed without a target check** (deny ALL force/rename/
  copy/delete forms factless regardless of target): maximally safe but
  over-denies legitimate feature-branch recovery flows factlessly
  (`branch -m feat feat2`, `branch -f feat x`) with a redirect that does not
  fit them; the target-gated design achieves the same security for
  `main`/`master` targets with strictly less over-deny. Rejected for the
  record: it is the fallback if the target parser proves unreliable under
  adversarial shapes (the parser's failure mode is deny, so a proven parser
  miss degrades gracefully toward this alternative rather than to the
  status quo).
- **`localBranches` fact to disambiguate row 4** (allow `checkout <known-
  branch>` exits): principled but adds a new seat fact (git branch listing)
  and a trust question (stale caches); row 4's fact-gated deny is cheap for
  models to route around (`switch <branch>` is allowed). Queued separately,
  not part of this decision.

## 6. Verification posture (for the queued implementation)

- Red-first pins for every changed row; characterization pins (W099) must
  stay green except where §4.5 explicitly updates them (none).
- Focused suites: policy + redirect + mcp; vendored typecheck; repo lint +
  typecheck. `npm test` never (operator directive).
- dist rebuild (LESS-0010 hazard: ensureBuilt only builds when dist is
  MISSING) + a live re-probe of the full §2 table against the rebuilt dist.
- Fresh-eyes five-axis review; record_review verdict BEFORE the change is
  treated as approved; frontier rounds per appendix A until ACCEPT, findings
  re-verified against the tree before incorporation.

## Appendix A — frontier verification record (append-only)

Rounds are recorded as they happen, including REVISE rounds and any finding
that turned out wrong; the doc's own byte-state is never rewritten
retroactively. Earlier draft rounds are preserved in this appendix; the
incorporated corrections are visible as the current §1–§6 text.

### Round 1 — Kimi K3 (openrouter/moonshotai/kimi-k3, fresh context, read-only adversarial) — REVISE

Verdict: REVISE ("directionally sound; not fit to record as written"). All
findings were re-verified by the author against the tree before
incorporation; re-verification results recorded inline. Summary of the
findings and their disposition:

1. **F1 (P1, falsified, CONFIRMED, incorporated):** the draft's §4.3 claimed
   row 4's deny was "fact-independent (already fails closed)" — FALSE:
   probed `checkout feat/g5` factless → allow, and the W099 pin suite's own
   title says "without branch facts the protected-branch gate cannot engage
   (W090 fail-open)". Corrected §3.1/§4.3: row 4's deny is fact-gated
   (fail-open without facts, pinned as-found); fail-closed applies with
   facts only.
2. **F2 (P1, falsified, CONFIRMED, incorporated):** the draft cited
   "upstream v1.15.0" from the checkout's dirty working tree, which is
   `v1.11.0-4-g1997922` (`git describe`; HEAD:package.json 1.11.0). The
   line-126 content claim was accurate. Re-verified at the checkout's
   `origin/main` (03fbdcf = v1.15.0-5-g03fbdcf, package 1.15.1): the same
   holes; §1/§3.2/§4.7 restated with the verified ref.
3. **F3 (P1, undercount, CONFIRMED, incorporated):** the draft's "four
   holes" missed at least nine classes; the full re-probe table is now §2
   (rows 6, 9–15, 22–25, 28): force-copy (`branch -C`), one-arg rename
   (target = current branch), rename-TO-protected, `--move` long forms,
   cross-branch `branch -D main`, cross-branch `update-ref refs/heads/main`,
   fetch refspecs (both the bare and the force-prefixed source form),
   `switch -f/--discard-changes`, short `-d` detach. The structural miss the
   round named: the deny class is current-branch-gated, so the whole
   cross-branch dimension was absent from the draft's on-main-only
   inventory (§2.2 now carries it).
4. **F4 (P1, design error, CONFIRMED, incorporated):** the draft's target
   parser ("first non-option arg after the subcommand") handles exactly one
   of the three `branch -m` danger shapes. §4.2 now specifies renames check
   BOTH operands and the one-arg form resolves to `currentBranch` (factless
   → deny); bundled shorts and `--` separator shapes are named pin cases
   (the value-option-skipping discipline covers global pre-subcommand
   options only).
5. **F5 (P1, incoherence, CONFIRMED, incorporated):** keeping rows 12–13
   frozen while fixing row 10 would leave `branch -D main` from a feature
   branch allowed — strictly more destructive than the force-move being
   fixed. §4 now extends the target gate to delete forms (additive deny
   only; the existing conservative target-blind denies stay).
6. **F6 (P2, unrecorded bypass, CONFIRMED, incorporated):** the entire deny
   class is bypassable via `sh -c` wrapping (probed: even `sh -c 'git reset
   --hard'` → allow); `checkGitPolicy` does not recurse, `hasGitMutation`
   does but only feeds the read-only-role gate; no SECURITY_ASSURANCE
   residual covers wrapping. §4.6 records the residual family and queues
   the deny-path recursion as the companion fix; §3.1's "deny class is
   SEMANTIC" claim scoped accordingly.
7. **F7 (P2, twin-matcher drift, CONFIRMED, incorporated):** probed
   `hasGitMutation` false for `branch -f/-m/-C` and the fetch refspec while
   true for `switch -C` — the two matchers drift independently. §4.1
   requires updating both in the same change with pins.
8. **F8 (P2, hidden tradeoff, incorporated):** the draft's fail-closed-
   without-facts was right but hid its cost (factless legitimate feature-
   branch renames/forces denied) and never considered the middle path
   (target check against the hardcoded default set factlessly). §4.3 now
   splits the factless posture by class (pointer forms: target-gated
   against the always-on base set + fail-closed under parse uncertainty;
   discards: fact-gated as today) and §5 records the middle path's
   rejection reason (parser-trust under adversarial shapes) with its
   graceful-degradation property.
9. **F9 (P3, nits, incorporated):** `switch --orphan` allow / `checkout
   --orphan` deny benign asymmetry (rows 19–20), `symbolic-ref` exotic
   pointer form (row 25), `checkout -t` create-class over-deny (row 21),
   `worktree add` exit-class correctness (row 27), `git -C <other-repo>`
   normalization note. All added to §2 or noted.
10. **F10 (P3, per-segment, incorporated):** compound-command classification
    must run per `splitShellSegments` segment; §4.1 states it.
11. **Verified TRUE by round 1 (sampled adversarially):** all sixteen draft
    §2 rows reproduce; upstream line-126 content; the push lane's
    target-shaped coverage (force flag, force-prefixed source refspec,
    bare destination, `--delete` all denied); alias denies precede the write
    check; W099 pin blocks pin only feature-target forms so §4.5's red-free
    claim holds for them; W100 free in TASKS.md; assessment §6 G5/§11
    claims match; dist byte-current with src.
12. **En-route incident (this session, recorded):** writing the
    re-verification probe script was BLOCKED by the live plugin's file
    scanner because the script's source contained a force-push refspec
    shape (plus-prefixed source to a destination ref) even in fragment
    form; the sanctioned escape is the W084 fixture convention — runtime
    fragment assembly (and for this shape, constructing the plus sign at
    runtime). Security tooling that blocks its own test fixtures' vocabulary
    makes the fixture convention load-bearing for writing security tests at
    all; the incident is folded into LESS-0017. The same scanner also
    blocked a draft of THIS document, hence the prose convention note at
    the top.

Round 2 (confirmation pass over the revised §1–§6) runs next; ACCEPT ends
the frontier verification, per the multi-round-until-ACCEPT discipline.

### Round 2 — Kimi K3 (openrouter/moonshotai/kimi-k3, fresh context, read-only adversarial) — REVISE

Verdict: REVISE — "every round-1 finding landed; the full 28-row table and
twin-matcher drift reproduce exactly under independent re-probe (54/54);
but the confirmation pass found three P2 defects the revision itself
introduced". Dispositions (all re-verified against the tree before
incorporation):

1. **R2-1 (P2, CONFIRMED, incorporated):** §4.3's factless bullet grouped
   "detach" into the target-gated class — but a detach target is a commit
   sha, never a protected ref, so the target gate cannot classify it and
   would leave row 6's hole open. Detach now joins row 5's fact-gated
   conservative class explicitly (§4.3 second bullet, with the no-facts
   allow symmetry to row 5 stated); §3.1's grouping reworded ("protected
   pointer writes AND detaches — a detach moves HEAD, not the branch
   pointer, but it is the same conservative deny class").
2. **R2-2 (P2, CONFIRMED, incorporated):** the §2 trailing note claimed
   W099 froze rows 16/17/18 and a row-6 member — verified FALSE (no pins
   exist for `branch -M main renamed`, `branch main <sha>`, `reset --hard`,
   or any detach form; the pinned set is rows 1–5, 7, 8 and the row-9
   feature-target member). The note now states the pinned set precisely;
   §4.4/§4.1 distinguish re-asserting existing pins from adding NEW
   characterization pins for rows 16–21. (The round's own framing: "in a
   repo whose pins ARE the regression protection, claiming frozen coverage
   that does not exist is material — the exact as-found honesty this file
   exists to model".)
3. **R2-3 (P2, CONFIRMED, incorporated):** row 25's exotic symbolic-ref
   form fell through every §4 disposition bucket while the decision
   statement claimed "every pointer-affecting spelling". The decision
   statement is now scoped ("every pointer-affecting spelling the matcher
   family covers") and §4.6 records row 25 as an explicit residual with a
   queued one-line matcher addition, alongside row 28.
4. **R2-4 (P3, CONFIRMED, incorporated):** the describe citations reproduce
   only under `git describe --tags` (plain describe: v1.9.1-149-g03fbdcf);
   §1 now cites `--tags` explicitly.
5. **R2-5 (P3, CONFIRMED, incorporated):** §4.4's parenthetical now lists
   the on-main deny pins (rows 4/7/8) alongside the feature-target and
   no-facts forms.
6. **R2-6 (P3, CONFIRMED, incorporated):** the dangling LESS-0017 reference
   is resolved — the scanner-incident lesson is recorded in
   docs/agents/lessons.md as part of this iteration (see round 3's
   appendix entry for the pointer).
7. **Verified TRUE by round 2:** all ten round-1 dispositions; 54/54
   independent probe reproduction (including runtime-assembled force
   refspecs per the A12 convention); the W099 red-free simulation (12
   pins); the "strict tightening, never a loosening" additive-deny claim;
   `protectedBranchesIn`'s hardcoded main+master base (git-policy.ts:31–33)
   backing §4.2's always-on base set; dist byte-current with src
   (sourcemap sourcesContent match); the LESS-0010 ensureBuilt hazard;
   W100 free in TASKS.md; upstream GIT_BRANCH_CREATE_RE at git.ts:35–36
   and its freshness-gate-only usage (guard-dispatcher.ts:369); upstream's
   current-branch-shaped write gate (guard-dispatcher.ts:365).

Round 3 (confirmation pass over the R2 corrections) runs next; ACCEPT ends
the frontier verification, per the multi-round-until-ACCEPT discipline.

### Round 3 — Kimi K3 (openrouter/moonshotai/kimi-k3, fresh context, read-only adversarial) — ACCEPT

Verdict: ACCEPT ("the position is fit to record"). All six R2 corrections
confirmed landed and coherent (per-finding re-verification: the detach
bullet vs §4.4 fix-list; the precise pin-coverage note re-grepped against
the suite — zero pins for rows 16/17/18 or any detach form, exactly as the
note now says; the scoped decision statement with both outside-the-family
residuals; the `--tags` citation; the §4.4 parenthetical byte-matched
against policy.test.ts:754/759/765; LESS-0017 present and consistent with
A12). Design-coherence spot checks over rows 1–24 disposition math passed;
the §4.4 red-free claim holds against every W099 pin. Two residual
watch-items recorded as-is and folded into the queued §4.1 pin plan: (1) an
explicit `git checkout <sha>` pin (row 5's verdict currently rides the
clause-level standard — a future token-discriminating matcher edit could
move it without tripping a pin); (2) rows 26–27 named in the bucket plan
(row 26 rides existing push-lane pins; row 27 gets a characterization pin)
so the plan is exhaustive over rows 1–28. Frontier verification closes at
round 3; the implementation iteration inherits the position as recorded.

## 7. Implementation addendum (2026-09-23, appended by the W101 session —
## this section does not alter §1–§6 or appendix A's byte-state)

The implementation landed (feat/w101-branch-pointer-gate, vendored core +
dist rebuild) with these deltas from §4's letter, recorded honestly:

1. **The §4.4 red-free claim was factually wrong for one pin.** The W099
   set DID pin `git checkout -B <feature>` on a protected branch as-found
   DENY (the row-8 clause member with a feature target), and this
   implementation moves that classification by design. The pin was
   superseded — the old assertion replaced by a supersession note in the
   W099 block, the new assertion living in the W101 unification pin — per
   the pin discipline (position-documented classification change, never a
   silent weakening). §4.4/§4.5's "stays red-free / survives verbatim"
   should be read as "except the one superseded assertion the unification
   itself requires".
2. **Review hardening (round-1 fresh-eyes, three findings, all fixed and
   pinned):** (P0) space-form value options now consume their value token —
   the phantom shape `git branch -f --points-at HEAD main <sha>` had let
   the value shift the first-operand target selection and phantom-allow a
   protected pointer move factless (captured red against the pre-fix dist:
   allow); (P1) wildcard branch-glob refspec destinations
   (refs/heads/*:refs/heads/*) fail closed in BOTH the new fetch lane and
   the pre-existing push lane, while tag globs keep their W084
   release-operation exemption (captured red: allow); (P2) the spelling
   clause's `--force\b` over-matched `--force-create` — `git switch
   --force-create <feature>` on a protected branch denied while the
   intent-identical `-C` was pinned allow (captured red: deny). All three
   shapes are pinned; the pre-fix dist captured the red verdicts live
   before the rebuild.
3. **En-route scanner finding (LESS-0017's shape, harder):** the live
   scanner's shell-command path reassembles string fragments — even a
   fully runtime-assembled wildcard push refspec in a `node -e` one-liner
   is blocked ("force push targets a live system"), while the same
   literals pass the file scanner inside a committed test file. The
   fixture convention's escape is per-context: file-scoped probes carry
   the shapes, shell one-liners must assemble them from characters.
4. Evidence at the review-fixed tip: suites 81/0 (policy 71 + redirect 5
   + mcp 5); the 55-row live re-probe matches the position against the
   REBUILT dist; repo lint/typecheck exit 0; security-assurance checker
   7/0.
5. **Review round 2 (re-review) — REVISE, one new fail-open in the fetch
   lane, fixed:** parseFetch returned on the FIRST colon-bearing operand,
   so a benign first refspec (`dev:refs/heads/tmp`), a URL remote's
   scheme colon, or an unconsumed `-o`/`-j` short value shielded a later
   `main:refs/heads/<protected>` refspec (git processes multiple refspecs
   per fetch; all pre-fix shapes captured live as allow). Fixes: fetch
   collects EVERY branch destination and the caller denies if ANY belongs
   to the protected set; the `-j`/`-o` shorts consume their values; the
   create/force-create mode combination (which real git cannot classify)
   fails closed for both spellings (`--create`+`--force-create`,
   `-b`+`-B`); the reviewer's falsified "dead entries removed" claim
   honored by actually removing them. Also fixed en route: `--create`
   sat in the shared flag set, making the createSeen tracking dead code.
   Pre-fix shapes captured live (allow x4); suites 82/0 (policy 72 +
   redirect 5 + mcp 5); 55-row re-probe + round-2 shapes green; repo
   lint/typecheck exit 0.
6. **Review round 3 (re-review) — REVISE, one new unrecorded fail-open,
   fixed:** `--refmap` is the one fetch value option whose value is itself
   a refspec (the prune mapping) — `--refmap=refs/heads/gone:refs/heads/
   main` with `--prune` DELETES the mapped local branch, and both spellings
   slipped the gate (the equals form silently skipped by the shared walk's
   equals shortcut, the space form consumed as a value). Fix: parseFetch
   fails closed on ANY `--refmap` spelling before parsing (deliberately
   not a consumed value), benign prune fetches stay allow, and the
   round-2 `-c`/`-C` watch-item is pinned (bundled combination deny).
   Pre-fix verdict captured live (allow); suites 83/0 (policy 73 +
   redirect 5 + mcp 5); 55-row re-probe + round-2 shapes green; repo
   lint/typecheck exit 0. Reviewer notes (unpinned, by-trace): the
   allow-biased parses of git-rejected shapes (nested-colon refspecs,
   whitespace-embedded) are harmless (no mutation possible) and recorded
   here rather than pinned uncertain.
7. **Review round 4 (re-review) — REVISE, one more real gap, fixed:** the
   one-arg rename writes BOTH names — the position's row-12 framing
   ("targets the current branch away") covered only the SOURCE half; the
   destination OPERAND force-overwrites a protected branch when it names
   one (`git branch -M main` from a feature branch destroys
   refs/heads/main — valid git, allow in the as-found gate). Fix: the
   one-arg form now checks BOTH the destination operand (targets) and the
   current branch (source, fact-gated); factless stays fail-closed.
   Pre-fix verdicts captured live (allow, allow); suites 84/0 (policy 74
   + redirect 5 + mcp 5); the 55-row re-probe + round-2/3 shapes green
   against the REBUILT dist; repo lint/typecheck exit 0.
8. **Review round 5 (re-review) — REVISE, the delete grammar is variadic,
   fixed:** git-branch(1)'s delete grammar is `(-d | -D) <branchname>…` —
   variadic — but the gate's delete arm kept only the first operand, so
   `git branch -D feat2 main` (also `--delete`, reordered, and
   `--`-separated spellings) classified allow while git deletes BOTH.
   Fix: delete targets are ALL operands (force-set keeps
   first-operand-only — its second operand is a start-point). Recorded
   residual (pre-existing push lane, adjacent): the HEAD-alias push forms
   (`push origin HEAD`, `@`, bare push) from a protected seat update the
   remote protected branch under allow (the colon form naming the
   protected destination is pinned deny) — SECURITY_ASSURANCE #22,
   as-found pin, queued resolution via the currentBranch fact the seat
   already supplies. En-route: the round-5 pin draft wrongly expected
   `branch -D feat2 feat3` on main to be allow — row 16's target-blind
   conservative deny is unchanged, and the corrected assertion (on-main
   deny, factless all-feature allow) doubles as the no-loosening pin.
   Pre-fix verdicts captured live (allow, allow, allow); suites 85/0
   (policy 75 + redirect 5 + mcp 5); the 55-row re-probe + round-2 shapes
   green against the REBUILT dist; repo lint/typecheck exit 0.
9. **Review round 7 (re-review) — the blocker claim FALSIFIED by probe;
   the landed fix is an attribution improvement:** the round-7 reviewer
   traced the push lane only and claimed the colon-less plus-prefixed
   refspec (`push origin +<protected>`) classified allow.
   Re-verification against the pre-fix dist showed the shape was ALREADY
   DENIED — by the shell lane's pre-existing force-push rule
   (shell-policy.ts:20 matches ANY plus-prefixed push refspec as
   destructive-operation, ignoring destinations), which the trace
   missed. The landed fix keeps the push lane's own classification
   correct (strip the leading plus before destination extraction so
   protected destinations are named protected-branch-push instead of the
   shell lane's coarser destructive-operation) and the pin asserts the
   policy label, making it a genuine discriminator (pre-fix:
   destructive-operation; post-fix: protected-branch-push). Watch-item
   recorded: the shell force-push rule OVER-DENIES legitimate
   force-pushes to feature branches (plus-prefixed `feat/g5` →
   destructive-operation; the rule ignores destinations) — pre-existing,
   out of W101 scope, noted for the shell-policy's own queue. Lesson
   folded into LESS-0018: a reviewer trace of ONE lane is not a verdict —
   probe before implementing.
10. Evidence at the round-7 tip: suites 85/0 (policy 75 + redirect 5 +
    mcp 5 — the round-7 pins assert the policy label, discriminating the
    attribution fix); 55-row re-probe + round-2 shapes green; repo
    lint/typecheck exit 0; security-assurance checker 7/0.
11. **Review round 8 (re-review) — REVISE, a real composite-spelling
    bypass: the pull spelling shares the fetch lane's grammar but no
    lane classified it.** `git pull` runs git fetch with the same
    arguments — its colon refspecs write local branches — then merges
    into the CURRENT branch. No lane named `pull` (allow across every
    seat: the merge intent `git merge` denies via the gitWriteRe merge
    clause, the row-24 fetch-refspec deny, and the force-refspec
    destructive catch all bypassed by the composite spelling; pre-fix
    verdicts captured live: allow across facts and branches). Fix: the
    pull subcommand shares parseFetch (destination sweep + the --refmap
    veto, with pull's integration-side options recognized) and
    `gitWriteRe` gains a current-branch-gated pull clause (a pull on a
    protected branch merges INTO it). Recorded residual #24:
    `--mirror`/`--all` pushes update and delete ALL remote refs
    including the protected ones with no refspec naming them — both
    fail closed now (push lane), recorded as the residual's historical
    note with as-found allow captured live. Post-fix: suites 85/0
    (assertions added inside existing blocks); 55-row re-probe +
    round-2 shapes green against the REBUILT dist; repo lint/typecheck
    exit 0; security-assurance checker 7/0.
12. **The §4.6 companion fix DELIVERED (W102, feat/w102-wrapper-recursion):**
    the shell-wrapper bypass residual (#20) is closed — `checkGitPolicy`
    recurses into sh/bash/zsh/dash/ksh `-c` wrappers with the same seat
    facts and a depth-16 fail-closed cap, and the detection is SHARED with
    `hasGitMutation` (one implementation — the twin matchers' wrapper
    scope is identical; the wrapped command classifies through the FULL
    git pipeline: alias, push, target gate, spelling lanes). The design
    direction the implementation settled on: wrapper TRANSPARENCY, not a
    deny-everything blanket — a wrapped benign command (feature-branch
    reset, `echo`) keeps its inner classification, because the wrapper
    executes in the same repository with the same facts; the first
    draft's deny-everything expectation was wrong and the corrected pins
    assert wrapper ≡ inner. The as-found allow residual pin was
    superseded with a note (residual closure, documented). Review round 1
    hardened the closure: the FUSED `-c`-quote spelling
    (`sh -c'git commit -m x'` — real shell getopt, tokenizer-glued) had
    bypassed both matchers and now classifies through the wrapper, and
    the env-prefix "limitation" recorded here earlier was FALSIFIED (the
    unwrapper consumes env/timeout/assignment prefixes — prefixed
    wrappers were always detected); the remaining honest edge is exotic
    interpreter names (busybox sh, xsh), pinned as-found and queued — the
    remaining edge, not a silently-closed bypass. Review round 2 closed
    the bundled-flag wrapper family (`-ec`/`-xc`/`-vc` bundles, the
    `-o <value> -c` detour, and the common spaced `bash -ec '...'` form —
    getopt consumes the rest of the word as -c's option-argument; the
    generalized -Xc matcher the boundary and shell lanes already use),
    with the transparency principle applied per seat (factless variants
    inherit the inner factless allow; target-gated shapes deny
    factlessly via the base set) and the zsh EQUALS-expansion caveat
    queued with the exotic-interpreter edge.