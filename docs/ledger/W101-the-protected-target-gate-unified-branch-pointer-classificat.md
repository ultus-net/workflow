<!-- Ledger fragment: extracted from TASKS.md at line 2637 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W101 - The protected-target gate: unified branch-pointer classification (Complete - implemented, pinned red→green, live-probed; wrapper + symbolic-ref residuals recorded) (2026-09-23)

**Source:** the W100 position (docs/BRANCH_EXIT_POLICY_2026-09-23.md,
frontier-ACCEPT, PR #88 merged) — its §4.1 implementation sketch.

**What landed (vendored guard core + dist rebuilt):**
- `gitWriteRe` widened: the checkout clause exempts `-B` (the force form is
  target-gated now, not spelling-gated); a switch clause joins for the
  fact-gated detach/discard classes (`-d/--detach/-f/--force/
  --discard-changes`); the branch clause stays `-[dDM]` (row 16's
  conservative target-blind deny untouched). `hasGitMutation` widened
  identically per the twin-matcher discipline (branch pointer forms +
  fetch colon-refspec).
- NEW protected-target gate in `checkGitPolicy` (runs per segment, before
  the current-branch-gated lanes, after alias/push): force/rename/copy/
  delete forms target-classified from ANY branch against the always-on
  `{main, master}` base ∪ W090 facts; renames check BOTH operands; the
  one-arg rename targets the current branch and fails closed factless
  (row 12); parse-uncertain shapes fail closed; `update-ref refs/heads/
  <T>` and fetch destination refspecs (incl. the force-prefixed source
  form) target-shaped. Pure exits/creates/feature-target recovery flows
  stay allowed (row 10's `branch -f <feature>` recovery flow pinned).
- **One deliberate with-facts loosening, recorded for parity honesty:**
  `git checkout -B <feature>` on a protected branch flips as-found DENY →
  allow — unifying the identical intent with the `switch -C` spelling's
  pinned allow. The superseded W099 characterization pin carries a
  supersession note (append-only comment); the superseding assertion is
  the W101 unification pin. Upstream divergence recorded in the parity
  log (W101 entry) with the upstream-port candidate queued.
- SECURITY_ASSURANCE residuals #20 (shell-wrapper bypass of the deny
  class — queued companion fix: deny-path `sh -c` recursion) and #21
  (exotic symbolic-ref form + ref-adjacent filesystem routes) recorded;
  the security-assurance checker stays green (7/0).

**Evidence:** red-first — the 11 new W101 pin blocks ran 59/10 against the
unmodified tree (exactly the position's promised changes), then green
79/0 (policy 69 + redirect 5 + mcp 5) with TWO gate bugs caught by the
pins and fixed before commit (the one-arg rename's currentBranch check
was unreachable through the empty-targets loop; the factless fail-closed
deny was dropped in the rewrite) — the pins caught both; the W099 pin
collisions resolved by supersession + probe, never by weakening. Live
re-probe of the 28-row family inventory against the REBUILT dist: all 56
probe rows match the position (facts + factless, on-branch +
cross-branch, fixes + residuals).

**Review round 1 (fresh-eyes) — REJECT, three real gate defects, all
fixed and pinned:** (P0) space-form value options (`--points-at HEAD`,
`--format x`) shifted the parser's first-operand target selection —
`git branch -f --points-at HEAD main <sha>` phantom-allowed a protected
pointer move factless; (P1) wildcard branch-glob destinations
(refs/heads/*:refs/heads/*) escaped BOTH the new fetch lane and the
pre-existing push lane (tag globs keep their W084 exemption); (P2)
`--force\b` over-matched `--force-create`, re-introducing the exact
spelling-vs-intent asymmetry for the switch spelling (deny-direction).
Fixes: value consumption in the operand walk; wildcard branch-glob
destinations fail closed in both lanes; `--force(?!-create)\b` lookahead.
Pre-fix verdicts captured LIVE against the pre-fix dist (allow, allow,
allow, allow, deny — genuine red), post-fix green. The spec's §4.4
"W099 stays red-free" claim was corrected by a §7 implementation addendum
on the W100 doc (the -B feature-on-main pin supersession always moved one
pin; the doc's red-free claim missed it — the supersession is disclosed
in the pin comment, the parity log, and here).

**Evidence (final, at the review-fixed tip):** review round 2 (re-review)
— REVISE with one new fail-open: parseFetch's first-colon-operand early
return let a benign first refspec, a URL remote, or an unconsumed
`-o`/`-j` short value shield a later protected-branch destination
(pre-fix shapes captured live as allow). Fixed: every branch
destination checked (deny on ANY protected), `-j`/`-o` values consumed,
the create/force-create mode combination fails closed for both
spellings, and the falsified "dead entries removed" claim honored by
removing them. Review round 3 (re-review) — REVISE with one new
unrecorded fail-open: `--refmap`'s value is itself a refspec (the prune
mapping — with `--prune` a mapped absent source DELETES the mapped
local destination) and both spellings slipped the gate; parseFetch now
fails closed on ANY `--refmap` spelling before parsing; the `-c`/`-C`
combination watch-item pinned; benign prune fetches stay allow (pre-fix
verdict captured live as allow). Suites 83/0 (policy 73 + redirect 5 +
mcp 5); the 55-row live re-probe + all round-2/3 shield shapes green
against the REBUILT dist; repo lint/typecheck exit 0. Review round 4
(re-review) — REVISE: the one-arg rename writes BOTH names (the
position's row-12 framing covered only the source half; the destination
operand force-overwrites a protected branch when it names one — git
branch -M main from a feature branch destroys refs/heads/main, valid
git); fixed — the one-arg form checks BOTH the destination operand and
the current branch (fact-gated source), factless stays fail-closed;
pre-fix verdicts captured live (allow, allow); suites 84/0 (policy 74 +
redirect 5 + mcp 5). Review round 5 (re-review) — REVISE: the
delete grammar is variadic (git-branch(1): (-d|-D) <branchname>...) and
the gate's delete arm kept only the first operand — git branch -D feat2
main classified allow while git deletes BOTH; fixed — delete targets
are ALL operands (force-set keeps first-operand-only). Recorded
residual #22 (pre-existing push lane): push origin HEAD / @ / bare push
from a protected seat update the remote protected branch under allow
(colon form pinned deny) — queued resolution via the currentBranch
fact. Pre-fix verdicts captured live (allow x3); suites 85/0 (policy 75
+ redirect 5 + mcp 5); 55-row re-probe + round-2 shapes green against
the REBUILT dist; repo lint/typecheck exit 0. Review round 7
(re-review) — the blocker claim FALSIFIED by probe: the colon-less
plus-prefixed refspec shape was already denied by the shell lane's
pre-existing force-push rule (destructive-operation, ignoring
destinations); the landed fix is an attribution improvement (protected
destinations named protected-branch-push by the push lane; the pin
asserts the policy label). Watch-item recorded: the shell rule
over-denies legitimate force-pushes to feature branches — pre-existing,
noted for the shell-policy queue. LESS-0018: a reviewer trace of ONE
lane is not a verdict — probe before implementing. Review round 8
(re-review) — REVISE: the pull spelling shares the fetch lane's grammar
but no lane classified it (allow across every seat — the merge intent,
the row-24 fetch-refspec deny, and the force-refspec destructive catch
all bypassed by the composite spelling; pre-fix verdicts captured live:
allow across facts and branches). Fixed: pull shares parseFetch
(destination sweep + --refmap veto; pull's integration options
recognized) and gitWriteRe gains a current-branch-gated pull clause.
--mirror/--all pushes fail closed (residual #24, as-found allow
captured). Suites 85/0 (assertions added inside existing blocks);
55-row re-probe + round-2 shapes green against the REBUILT dist; repo
lint/typecheck exit 0; security-assurance checker 7/0. Review round 6
(re-review) — no new bypass found (all shapes trace fail-closed or
harmless; the variadic fix confirmed in src and dist); the one open
watch-item — bundled conflicting branch modes (a -dc/-md short bundle)
— hardened: multi-mode bundles fail closed (real git rejects the
combination); pinned; suites 85/0; all probes green.

**Acceptance criteria:**
- [x] Both matchers widened in the same change (`gitWriteRe` lanes +
      `hasGitMutation` extras), per §2.3's drift discipline.
- [x] The target gate closes rows 6/9–15/22–24 (with facts and, for
      pointer forms, factless via the base set) without loosening anything
      except the documented row-8-class unification.
- [x] Red-first pins for every changed row; W099 set survives except the
      one position-superseded assertion (supersession note recorded);
      characterization pins added for rows 16–21 + the round-3 watch-items
      (explicit `checkout <sha>`, row 27) + the review-round shapes
      (value-option phantom, wildcard globs, `--force-create`).
- [x] dist rebuilt + live re-probe green (56/56 pre-review, 55/55
      post-review-fixes).
- [x] Parity-log W101 divergence entry (incl. the review round);
      SECURITY_ASSURANCE residuals #20/#21; repo lint/typecheck exit 0.
- [x] Queued (NOT this iteration): the deny-path `sh -c` recursion
      companion fix; the exotic symbolic-ref matcher line; the
      `localBranches` fact for row 4's disambiguation (separately queued).
