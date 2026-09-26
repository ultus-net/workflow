<!-- Ledger fragment: extracted from TASKS.md at line 2864 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W103 - The W101/W102 residual closures: alias-push resolution + symbolic-ref gate line (Complete - residuals #22 and #21 resolved, red→green pinned, dist probed) (2026-09-23)

**Source:** the pain-point queue's items 2+3 (one guard-touch iteration,
same file, same region as W102): SECURITY_ASSURANCE #22 (HEAD-alias
pushes from a protected seat) and #21 (the symbolic-ref protected-NAME
matcher line), both queued by the W101/W102 records.

**What landed (vendored guard core + dist rebuilt):**
- Push lane: HEAD/`@` refspecs and the default push (no refspec beyond
  the remote slot) resolve against the `currentBranch` fact — a
  protected seat's alias/default push denies `protected-branch-push`;
  a feature seat's stays the normal publish flow. FACTLESS seats keep
  the as-found allow (the documented W090 fail-open class; the round-8
  bare-pull symmetry; the W102-era transparency principle — the alias
  destination is fact-shaped, not base-set-shaped). The `--mirror`/
  `--all` sweep hoisted per segment (the no-remote-argument form never
  ran it before; a #24 edge). Honest config edge recorded: push.default
  =upstream toward a differently-named protected upstream stays
  repo-config-dependent (recorded in #22, not guessed at).
- Target gate: `symbolic-ref` joins `parseUpdateRef` (sub-aware mode) —
  the two-operand write form checks BOTH names (the protected NAME and
  the referent it is aimed at: a symref aimed AT a protected branch
  routes later commits through it), while the HEAD-form repoint stays
  the row-25 exit-class allow, the one-operand form stays a read, and
  --short/-q are enumerated so benign reads do not newly fail closed;
  --delete and -m fail closed on parse uncertainty. The `.git/`
  filesystem-route half of #21 remains the open residual (part 2).
- Twin matcher: hasGitMutation's extras gain symbolic-ref ≥2-token
  forms (write/delete) — the gate and the twin widen together (§2.3).
- SECURITY_ASSURANCE #21 (RESOLVED PART 1, part 2 kept open) and #22
  (RESOLVED, edges stated); parity-log W103 entry; the W101 round-5
  as-found allow pin flipped WITH a resolution note (the residual
  pre-registered its own successor).

**Evidence:** pre-change live probe (24-row matrix against src) captured
every as-found allow; pins authored red-first ran 79/4 with EXACTLY the
four expected failures (the two new W103 blocks, the flipped pin, the
twin additions) and zero collateral; green 93/0 (policy 83 + redirect 5
+ mcp 5) after the src edits; dist rebuilt and the dist probe re-run
(src≡dist); vendored typecheck OK; repo lint/typecheck exit 0;
security-assurance checker 7/0.

**Review round 1 (fresh-eyes completion reviewer, executed evidence):**
[APPROVE] across all five axes (recorded via record_review) — red-first
reproduced (79/4), a 108-cell matrix showed 32 allow→deny flips and ZERO
deny→allow, all gates re-run, dist≡src verified by execution. Three P2s
addressed in the follow-up commit with red→green re-verification
(tags-only and --delete/-d refspec-shaping flags excluded from the
default-push reading; the twin's read-flagging fixed with a
flags-skipping two-operand pattern; the dangling LESS-0021 reference
resolved by the append) and one P3 recorded as-found (`:`-sourced remote
HEAD deletion stays allow, pinned). Final: suites 93/0, dist re-probed
after the post-fix rebuild (a mid-iteration stale-dist divergence was
caught by the dist probe itself), repo lint/typecheck exit 0, checker
7/0.

**Review round 2 (the completing reviewer's continuation):**
[REQUEST_CHANGES] with one P1 — the round-1 tags-only fix had gated the
WHOLE alias disjunction, re-opening the #22 hole for tag-flag combos
with an explicit alias refspec; fixed by scoping the exclusion to the
default-push readings only (explicit HEAD/@ refspecs always resolve),
plus the twin's interleaved-flags fix (git permutes options) and the
LESS-0021 append (the REMEMBER step). The round-2 table's no-remote
cell was corrected against the reviewer's own formula (git's grammar
makes the single positional the repository slot; tags-only flags push
no branch refs). Re-verified: 81/2 red (exactly the round-2 pins) then
93/0 green, dist rebuilt and probed (8 round-2 cells), repo
lint/typecheck exit 0, checker 7/0. Round 3 re-binds the verdict to the
final tip.

**Review round 3 (the same reviewer's continuation):**
[REQUEST_CHANGES] with one P1, falsified by the reviewer's executed git
dry-run (git 2.55.0): `--follow-tags` is NOT tags-only — the man page
has it push "all the refs that would be pushed without this option"
(the default push fires), so the round-1/2 allow for `git push
--follow-tags` from a protected seat was a false premise re-opening the
#22 hole (the round-2 record had endorsed that allow pin without a
grammar probe — recorded as the falsification, not hidden). Fixed: the
tags-only reading requires `--tags` WITHOUT `--follow-tags` (folding
the round-3 P3 combined-flags shape in); the follow-tags pins flipped
with the falsification note; the false premise corrected in the src
comment, the test comment, #22's sentence, the parity log, and
LESS-0021's dated correction. Re-verified: 82/1 red (exactly the
flipped pin) then 93/0 green, dist rebuilt and probed (11 cells match),
repo lint/typecheck exit 0, checker 7/0. Round 4 re-binds the verdict
to the final tip.

**Acceptance criteria:**
- [x] Alias/default pushes from a protected seat deny; from a feature
      seat and a factless seat they keep their classification; mixed
      refspecs, plus-forms, and wrapped variants pinned.
- [x] symbolic-ref protected-NAME writes deny factlessly and through
      wrappers; the HEAD-form, reads, and benign writes keep their
      classification; unenumerated shapes fail closed.
- [x] The --mirror/--all zero-argument edge fails closed.
- [x] The as-found pin moved only as the residual's pre-registered
      resolution, with the note in place; SECURITY_ASSURANCE and the
      parity log record the honest factless and config edges.
