# P16 decision brief — the branch-exit / branch-pointer unification

**Date:** 2026-09-30 · **Status:** decision INPUT only — **this brief is the
input; the decision is the operator's.** Nothing here authorizes a code
change. · **Item:** parked P16 (docs/PARKED_AND_LIMITATIONS.md:45, issue
#295). · **Sources read in full:** docs/BRANCH_EXIT_POLICY_2026-09-23.md
(frontier-ACCEPT at round 3, appendix A); the ledger fragments
docs/ledger/W099-g5-branch-exit-consistency-pins-complete-pins-landed-asymmet.md,
docs/ledger/W100-branch-exit-branch-pointer-unification-position-complete-pos.md,
docs/ledger/W101-the-protected-target-gate-unified-branch-pointer-classificat.md;
the pin blocks mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts and
test/redirect.test.ts; the vendored core mcp-toolbox/apps/workflow-guard-mcp/src/git-policy.ts; the parity log
mcp-toolbox/apps/workflow-guard-mcp/docs/policy-coverage.md;
docs/SECURITY_ASSURANCE.md residuals #20–#24.

## 0. Status correction the brief must carry first

The P16 row reads "Position complete; implementation not started"
(docs/PARKED_AND_LIMITATIONS.md:45). The row was created 2026-09-24
(W116's round-1 fixes appended P12–P16, docs/ledger/W116-*.md:50–53) —
**one day after the recorded position's implementation had already landed
as W101 (2026-09-23)**. Evidence that the unification is on main, not
queued:

- The protected-target gate is in the vendored core:
  mcp-toolbox/apps/workflow-guard-mcp/src/git-policy.ts:186–198 (the gate's
  design comment), :277–477 (the parsers and `checkPointerTarget`),
  :573–584 (the gate runs per segment inside `checkGitPolicy`).
- The W101 ledger fragment records the landing red-first
  (docs/ledger/W101-*.md:37–46) with seven subsequent review rounds folded (rounds 2–8; round 6 lives in the ledger fragment, rounds 7–8 in §7)
  in (W101-*.md:66–125), and the parity log carries the W101 divergence
  entry (mcp-toolbox/apps/workflow-guard-mcp/docs/policy-coverage.md:286).
- The W100 policy doc itself carries the implementation addendum (§7,
  docs/BRANCH_EXIT_POLICY_2026-09-23.md:483–523), including the one W099
  pin the unification superseded (§7 item 1, :489–498).
- The companion residuals closed after it: W102 (wrapper recursion,
  SECURITY_ASSURANCE #20 — RESOLVED note at docs/SECURITY_ASSURANCE.md:260)
  and W103 (alias-push #22, symbolic-ref #21's matcher half; parity-log
  entries at the parity log — W102 at mcp-toolbox/apps/workflow-guard-mcp/docs/mcp-toolbox/apps/workflow-guard-mcp/docs/policy-coverage.md:411, W103 at :489).

So the decision P16 actually queues is narrower than the row's framing:
**the pointer-write half of the W099 asymmetry is decided and implemented;
what remains open is (a) the pure-exit spelling asymmetry the W099 pins
freeze as-found (rows 3 vs 4 of the policy doc's table) and (b) the
separately-queued refinement options the position doc itself names.**
The options below are presented AS RECORDED; §5 of the policy doc already
rejects one of them, and that rejection is part of the record, not this
brief's opinion.

## 1. The recorded position (restated, dated, cited)

**W099 (2026-09-23) — the pins.** The G5 follow-up froze the branch-exit
family's as-found classification with characterization pins, pins only, no
src change (docs/ledger/W099-*.md:11–24). Its "deliberately NOT done" is
the sentence that makes P16 a decision-first item: "unifying the
checkout/switch asymmetry (**allowlist all pure exits** vs **make switch
symmetric**) is a policy decision requiring its own iteration + frontier
verification; these pins freeze current behavior so any change requires a
decision, not drift" (docs/ledger/W099-*.md:26–29). The pinned cells are
enumerated in §3 below.

**W100 (2026-09-23) — the position doc.** docs/BRANCH_EXIT_POLICY_2026-09-23.md
records, after three frontier rounds (REVISE → REVISE → ACCEPT, appendix A
:317–481; the doc header's "confirmation round pending" status line :3–4
predates round 3 and is superseded by appendix A's ACCEPT record :464–481):

- A 28-row family inventory probed LIVE against the built vendored dist,
  with and without W090 facts (§2, :39–81): the deny class is
  **spelling-shaped and current-branch-gated**, and the allow side held
  nine-plus protected-pointer-write holes (`switch -C <protected>`,
  `branch -f <protected>`, renames both-operand, force-copy, cross-branch
  delete/update-ref/fetch-destination, `switch -f/--discard-changes`, the
  shell-wrapper bypass of the entire deny class).
- The semantic analysis (§3.1, :103–135): pure exits (rows 1–3) never move
  a protected pointer and stay allowed; `git checkout <token>`'s ambiguity
  deny (row 4) is fact-gated and defensible; the holes are the
  pointer-write class allowed under non-checkout spellings.
- **The decision statement** (§4, :151–161, verbatim compressed): "classify
  by git SEMANTIC, not by spelling. Every pointer-affecting spelling the
  matcher family covers joins the deny class; the protected-target check
  runs on the PARSED TARGET against the always-on default set
  (`{main, master}` ∪ W090 `protectedBranches` facts) — the same shape the
  push lane already uses — pure exits and creates stay allowed, and any
  form the parser cannot resolve fails closed." Factless posture split by
  class (:183–206); rows 1–5, 7, 8, 16–21 do not move (:207–215); pin
  discipline red-first with no silent weakening (:216–219); two residuals
  recorded outside the family — the shell-wrapper lane and the exotic
  symbolic-ref form (:220–231).
- The rejected alternatives (§5, :270–296), which are part of the recorded
  position: symmetric-deny switch, unconditional force-allow,
  document-only, blanket fail-closed, and the `localBranches` fact
  (queued separately).
- The implementation addendum (§7, :483–523): W101 landed §4's letter with
  honest deltas — one W099 pin superseded by design (§7 item 1), three
  review-hardened fail-opens pinned (§7 item 2), and review rounds 2–8 (six round entries — rounds 2,3,4,5,7,8 in §7 plus round 6 in the ledger fragment; round 7's blocker claim was FALSIFIED to an attribution fix, round 6 found no new bypass)
  — the rounds closed real gaps (fetch destination sweep, `--refmap` veto,
  both-operand one-arg rename, variadic delete, pull spelling, #24
  mirror/all pushes; §7 items 5–8, 11).

**W101 (2026-09-23) — the implementation.** docs/ledger/W101-*.md:8–35:
`gitWriteRe` widened (the checkout clause exempts `-B`; a switch clause
joins for detach/discard; the branch clause stays `-[dDM]`), the
protected-target gate added (`mcp-toolbox/apps/workflow-guard-mcp/src/git-policy.ts:186–477`),
`hasGitMutation` widened identically per the §2.3 twin-matcher discipline
(:49–73), and the one deliberate with-facts loosening recorded:
`git checkout -B <feature>` on a protected branch flips as-found deny →
allow, unifying with `switch -C`'s pinned allow (W101-*.md:25–31; the
supersession note lives in the test at
mcp-toolbox/apps/workflow-guard-mcp/test/mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts:785–790, the
superseding assertion at :886–894). Evidence: red-first 59/10 → green;
the 28-row family re-probed 56/56 against the rebuilt dist
(W101-*.md:37–46); repo lint/typecheck exit 0 at every review tip.

## 2. The unification options AS RECORDED

Exactly two options are named by the record that queued P16
(docs/ledger/W099-*.md:26–29), plus one refinement the position doc's
§5 implies:

- **Option A — allowlist pure exits** (the recorded position, §4):
  pure exits and creates stay allowed; every pointer-affecting spelling
  joins a semantic, target-gated deny class; parse-uncertain fails closed.
  This is what W101 implemented.
- **Option B — symmetric switch forms** ("make switch symmetric",
  W099-*.md:27; policy doc §5 :271–275 records it as REJECTED): deny
  `switch <branch>` on a protected seat exactly as `checkout <branch>` is
  denied, removing the spelling asymmetry in the deny direction.
- **Option C — the `localBranches` seat fact** (implied by policy doc §5's
  last bullet :292–296, "queued separately, not part of this decision"):
  allow `checkout <known-branch>` exits when a new seat fact confirms the
  token names a local branch; the ambiguity deny stays for everything the
  fact cannot resolve.

No fourth option appears in the record; the other §5 entries
(unconditional force-allow, document-only, blanket fail-closed) were
rejected with reasons and are not restated as live options here.

## 3. Per-option analysis

### 3.1 The pinned surface all options touch

The W099 block (mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts:752–801,
four tests) and the redirect pin
(mcp-toolbox/apps/workflow-guard-mcp/test/redirect.test.ts:41–49) freeze 12 active cells + 1 already-superseded
cell:

| # | Pinned cell | Verdict pinned | Test (test name, line) |
|---|---|---|---|
| 1 | `git checkout -b feat/g5` on main | allow | "W099/G5: the allowed branch-exit spellings on a protected branch (as-found, not an endorsement)", mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts:767 |
| 2 | `git switch -c feat/g5` on main | allow | same test, :768 |
| 3 | `git switch feat/g5` on main | allow | same test, :769 |
| 4 | `git switch -C feat/g5` on main | allow | same test, :770 |
| 5 | `git switch main` from feat/g5 | allow | same test, :772 |
| 6 | `git checkout feat/g5` on main | deny | "W099/G5: the checkout spelling of the same intents is denied on a protected branch (F1 residual, pinned as found)", :776–778 |
| 7 | `git checkout -- src/a.ts` on main | deny | same test, :782–784 |
| 8 | `git checkout -B feat/g5` on main | deny → **SUPERSEDED 2026-09-23 by W101** (supersession note :785–790; superseding assertion in the W101 row-8 pin :886–894) | was in the same test |
| 9 | `git checkout feat/other` from feat/g5 | allow | "W099/G5: off a protected branch the checkout spellings are allowed (the gate targets writes, not exits)", :794 |
| 10 | `git checkout -B feat/g5` from feat/g5 | allow | same test, :795 |
| 11 | `git checkout feat/g5` factless | allow (W090 fail-open) | "W099/G5: without branch facts the protected-branch gate cannot engage (W090 fail-open)", :799 |
| 12 | `git checkout -- src/a.ts` factless | allow (W090 fail-open) | same test, :800 |
| 13 | the `protected-branch-write` redirect names `git checkout -b` | guidance pin | "W099/G5: the protected-branch-write redirect names a checkout exit the matcher partly blocks", redirect.test.ts:41–49 |

The W101 block (17 pin tests, mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts:813–1011 plus the twin-matcher
test :1337) pins the landed target gate; no option below inverts any W101
pin cell except where stated (Option B touches none of them — only the
plain-switch-exit cell above).

### 3.2 Option A — allowlist pure exits (the recorded position; LANDED as W101)

- **Behavior:** as recorded in §4 of the policy doc and now in the tree —
  exits/creates allowed, pointer writes denied by parsed target from any
  seat against `{main, master}` ∪ facts, parse-uncertain denies, detaches
  and discards stay fact-gated classes. Rows 1–5, 7, 8, 16–21 unchanged;
  rows 6, 9–15, 22–24 closed; residuals #20/#22/#24 closed by W102/W103;
  #21's ref-adjacent-filesystem part still open (SECURITY_ASSURANCE.md:262;
  parked P18 confirms the (c) remainder).
- **Pins that flip:** none further. The one flip the unification required
  (cell 8) already happened in W101 with its dated supersession note.
- **Security posture delta:** none further — this is the landed baseline.
  The W090 factless fail-open class stays the documented deliberate
  boundary (:183–206; mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts:798–801).
- **Migration/compat:** none further (dist rebuilt and re-probed; the
  upstream divergence recorded at policy-coverage.md:286).
- **Cost:** zero code. The residual cost is the one the position accepts:
  row 4's ambiguity deny over-delies `checkout <branch>` exits on
  protected seats (models must use `switch <branch>` or the redirect's
  `checkout -b`), and the F1 spelling asymmetry for pure exits stays
  pinned as-found (cells 3 vs 6) rather than unified.

### 3.3 Option B — symmetric switch forms (recorded REJECTED, §5 :271–275)

- **Behavior change:** `git switch <branch>` on a protected current branch
  flips allow → deny (fact-gated like checkout's row-4 deny; factless
  stays allow, preserving the W090 class symmetry). Creates (`switch -c`)
  and force-creates (`switch -C`/`-B`) stay allowed — they are the
  sanctioned exits and, post-W101, target-gated.
- **Pins that flip:** exactly one classification cell — cell 3
  (`git switch feat/g5` on main, mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts:769) — which needs a dated
  supersession note under the pin discipline; cells 2, 4, 5 stay green.
  The redirect pin's assertion (redirect.test.ts:48) survives, but the
  guidance text it pins (mcp-toolbox/apps/workflow-guard-mcp/src/redirect.ts:21, "create **or switch to** a
  feature branch (git checkout -b)") names a route Option B blocks, so the
  guidance's "or switch to" clause and the W099 block comments
  (mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts:752–760; the W101 row-8 rationale :890–893, which cites
  "`switch -C`'s pinned allow" as the unification twin) must be updated in
  the same change.
- **Security posture delta:** strictly tighter (a deny added), and it
  closes the variant-retry surface for the exit class (§3.1 of the policy
  doc, :130–135: a deny that blocks one spelling while the intent-identical
  spelling is allowed trains bypass). Honest counterweight, from the
  record itself: exits are not pointer writes — the class the guard exists
  to gate — so the hole B closes is an ergonomics hole, not an
  integrity hole; the pointer-write variant-retry surface that mattered
  was closed semantically by W101.
- **Migration/compat:** matcher clause + redirect text + pin supersessions;
  no fact-schema change; dist rebuild (LESS-0010 hazard: ensureBuilt only
  builds when dist is MISSING, policy doc §4.1 :265–266) + live re-probe.
  It moves the vendored core further from upstream (upstream has no switch
  write clause at all, §3.2 :137–145) — a second deliberate divergence
  row in the parity log.
- **Cost:** small code, but it REVERSES part of a frontier-ACCEPTed,
  already-implemented position: per the W099 ledger's own rule
  (W099-*.md:27–28) a policy decision requires its own iteration + frontier
  verification, and the append-only discipline
  (policy doc appendix A header :310–315) requires dated supersession notes
  on the policy doc's §5 rejection and §4 statement, plus a fresh
  fresh-eyes review. The recorded rejection reasons (:272–275) — kills the
  sanctioned pure exit, contradicts the F1 remediation direction ("gate
  commits/edits/pushes, not the exit"), the redirect would point at an
  exit the matcher then blocks — stand as written unless the operator
  supersedes them.

### 3.4 Option C — the `localBranches` seat fact (doc-implied; queued separately, §5 :292–296)

- **Behavior change:** `git checkout <token>` on a protected seat flips
  deny → allow ONLY when the new fact confirms the token is a local
  branch; sha/path/unresolvable tokens keep the ambiguity deny; factless
  seats keep today's allow (cell 11 unchanged).
- **Pins that flip:** cell 6 (`git checkout feat/g5` on main,
  mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts:776–778) needs a dated supersession for the
  fact-confirmed case, replaced by fact-shaped pins (listed branch →
  allow; unlisted/ambiguous token → deny; absent/stale fact → deny,
  fail-closed). Cell 7 (the path-discard deny) and cells 11–12 stay green.
- **Security posture delta:** roughly neutral — row 4's deny was an
  over-deny, not a hole. The new risk is the fact itself: a stale branch
  listing (the doc's named "trust question (stale caches)" :294–295).
  Direction of failure: a stale list that omits a real branch keeps the
  deny (fail-closed); a stale list cannot conjure an allow for a token
  that is not a branch, and git itself refuses a checkout of a deleted
  name — so the residual risk is low, but it is a NEW trust input where
  today there is none.
- **Migration/compat:** the widest surface of the three — the guard's
  input schema (mcp-toolbox/apps/workflow-guard-mcp/src/policy.ts:31, the zod schema at mcp-toolbox/apps/workflow-guard-mcp/src/server.ts:46) and
  the fact plumbing (mcp-toolbox/apps/workflow-guard-mcp/src/policy.ts:121, :125, :181), plus every host/surface
  that supplies `currentBranch`/`protectedBranches` facts must now also
  supply the branch list.
- **Cost:** the doc's own assessment is that the benefit is thin: "row 4's
  fact-gated deny is cheap for models to route around (`switch <branch>`
  is allowed)" (:294–296) — the deny costs a one-word spelling change, so
  the new fact buys mainly spelling symmetry for its own sake.

## 4. Recommendation (input, not decision)

**Recommendation: take no further code change (Option A stands).** The
recorded position was frontier-verified to ACCEPT, implemented red-first,
and hardened through the review rounds recorded in §7 and the ledger fragment (round 7's blocker claim falsified to an attribution fix; round 6 found no new bypass)
fail-open; nothing in the record suggests the landed gate is wrong. The
remaining asymmetry (cells 3 vs 6) is documented, pinned as-found, and
routeable at the cost of one word (`switch` for `checkout`); its severity
is ergonomics, not integrity.

Trade-offs stated honestly:

- Standing (A) leaves a pinned spelling asymmetry in the guard's most
  load-bearing lane. That is a real (if small) inconsistency cost, and it
  is the exact shape of finding F1 that started this line — kept visible
  by pins rather than resolved.
- If the operator wants that asymmetry resolved, **Option C** is the
  recorded refinement (it resolves the asymmetry in the allow direction
  without touching the deny class), at the cost of a new seat fact across
  every fact-supplying host and a stale-cache trust question. **Option B**
  resolves it in the deny direction but reverses an implemented,
  accepted position to do so, and the record's rejection reasons for it
  have not changed.
- There is no option on the table that tightens pointer integrity further;
  the open items there are residual lanes recorded as such (ref-adjacent
  filesystem routes, #21's remainder) and are P18's, not P16's.

If the operator confirms A, the P16 row can retire per the file's own rule
("an entry leaves this file only when the work lands (link the PR)") with
W101's PR as the link, after this brief and the row note below are merged.

**Restated verbatim for the record: this brief is the input; the decision
is the operator's.**

## 5. Implementation sketch per option (so the decision is executable)

**Option A — no implementation.** Verification: none beyond this brief.
Operator actions: confirm; the row amendment below records the brief; a
follow-up docs commit links W101's PR when retiring the row.

**Option B (if chosen) — its own iteration, one change:**

1. `mcp-toolbox/apps/workflow-guard-mcp/src/git-policy.ts:16` — extend the
   switch clause of `gitWriteRe` with the plain exit form (fact-gated by
   construction: the spelling lane only fires under
   `protectedBranchWriteReason`, git-policy.ts:586). `hasGitMutation`
   (:68) already counts any switch/checkout presence as the mutation
   signal — no twin change needed for this member.
2. `mcp-toolbox/apps/workflow-guard-mcp/src/redirect.ts:21` — reword the guidance to name only a route the
   matcher still allows ("create a feature branch (git checkout -b)").
3. Pins: dated supersession note on cell 3 (mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts:769) + the new
   deny cell; the block comments :752–760 and :890–893 updated; the
   redirect pin's comment (redirect.test.ts:44–45) updated (assertion
   survives). Red-first: the new deny cell must fail against unmodified
   src before the fix.
4. Append-only records: a dated supersession note on the policy doc's §5
   rejection and §4 statement (appendix-A discipline :310–315); a
   parity-log divergence entry (policy-coverage.md); TASKS.md/ledger item
   for the iteration.
5. Verification: focused policy + redirect + mcp suites
   (`node --import tsx --test`, never `npm test` — operator directive);
   vendored typecheck; dist rebuild + live re-probe of the affected §2
   cells; repo lint + typecheck exit 0 unpiped; fresh-eyes five-axis
   review with `record_review` BEFORE approval.

**Option C (if chosen) — its own iteration, one change:**

1. `mcp-toolbox/apps/workflow-guard-mcp/src/git-policy.ts` — `GitPolicyContext` gains `localBranches?:
   string[]`; the checkout ambiguity lane allows only a fact-confirmed
   branch token and keeps the deny for path/sha/uncertain tokens
   (fail-closed on staleness: an unusable fact denies).
2. Fact plumbing: `mcp-toolbox/apps/workflow-guard-mcp/src/policy.ts:31` (input type), `:121`, `:125`, `:181`
   (context construction), `mcp-toolbox/apps/workflow-guard-mcp/src/server.ts:46` (the zod schema), then every
   host surface that supplies branch facts — the compatibility audit is
   the real work.
3. Pins: supersession for cell 6 (mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts:776–778) with the
   fact-shaped pins listed in §3.4; cells 7, 11–12 re-asserted green.
4. Records: SECURITY_ASSURANCE residual for the fact's trust boundary
   (stale caches); parity-log note (upstream has no such fact); the
   policy doc's §5 last bullet gets its dated "taken" note.
5. Verification: the same battery as B, plus fact-shaped probes (listed,
   unlisted, stale, absent).

## 6. Decision record requirements (what the operator's decision must produce)

Whichever option is chosen, the decision lands as: a dated note on the P16
row (append-only, per the file rules at docs/PARKED_AND_LIMITATIONS.md:15–24);
A also retires the row with W101's PR linked; B or C also produce a TASKS.md
item, the append-only supersessions listed in §5, and a fresh-eyes review
recorded before the change is treated as approved.
