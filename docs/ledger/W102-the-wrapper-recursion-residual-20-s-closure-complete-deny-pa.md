<!-- Ledger fragment: extracted from TASKS.md at line 2780 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W102 - The wrapper recursion: residual #20's closure (Complete - deny-path sh -c recursion landed, residual resolved) (2026-09-23)

**Source:** the W100 position's §4.6 queued companion fix and the W101
review record's residual #20 (SECURITY_ASSURANCE): every git deny class
was bypassable by wrapping — `sh -c 'git reset --hard <sha>'` classified
allow because `checkGitPolicy` did not recurse while `hasGitMutation`
did (the twin matchers' wrapper scopes diverged).

**What landed (vendored guard core + dist rebuilt):**
- `checkGitPolicy` recurses into sh/bash/zsh/dash/ksh `-c` wrappers with
  the same seat facts and a depth-16 fail-closed cap (shared verbatim
  with `hasGitMutation`'s detection — the twin matchers' wrapper scope is
  now identical). The wrapper is TRANSPARENT to the full inner git
  pipeline (alias, push, target gate, spelling lanes): a wrapped command
  inherits exactly the verdict its unwrapped form would get, because the
  wrapper executes in the same repository with the same facts.
- The design direction the pins settled: wrapper TRANSPARENCY, not a
  deny-everything blanket — the first draft's deny-everything test
  expectation was wrong (a feature-branch reset stays allow through the
  wrapper) and the corrected pins assert wrapper ≡ inner. The as-found
  allow residual pin superseded with a note (residual closure);
  SECURITY_ASSURANCE #20 marks the resolution including the honest edge
  (CORRECTED across rounds 1-2: the env-prefix claim was falsified —
  prefixed wrappers were always detected; the fused -c-quote and
  bundled-flag forms were real and are now detected via the SHARED
  wrapperCommands implementation, not a verbatim copy; the remaining
  edge is exotic interpreter names and the zsh EQUALS caveat).
- W100 doc §7 item 12; parity-log W102 entry (after the W101 rounds).

**Evidence:** red-first — the 2 new W102 pin blocks ran 75/2 against the
pre-fix tree (the wrapper shapes classified allow as-found), then green
87/0 (policy 77 + redirect 5 + mcp 5) after one test-expectation
correction (the wrapped feature-branch reset is allow — transparency,
not a blanket). Live verification against the REBUILT dist: wrapped
pointer writes deny through the wrapper (branch -f / update-ref / push
from any seat where the inner command denies), wrapped benign commands
allow, nested wrappers recurse, the depth cap fails closed; the 46-row
W100-era inventory re-probe green. Repo lint/typecheck exit 0;
security-assurance checker 7/0.

**Acceptance criteria:**
- [x] The deny path recurses into sh-family wrappers with the same facts
      and depth cap, sharing hasGitMutation's detection (twin-matcher
      scope identical).
- [x] Wrapped pointer writes deny; wrapped benign commands allow
      (transparency, not a blanket); nested wrappers recurse; the depth
      cap fails closed.
- [x] The as-found residual pin superseded with a note; SECURITY_ASSURANCE
      #20 marks the resolution with the env-prefix limitation stated.
      CORRECTION (review round 1, 2026-09-23): the env-prefix limitation
      was FALSIFIED (prefixed wrappers were always detected — live probe:
      deny across all three prefix forms); #20's corrected text states the
      real edges (busybox/xsh interpreters, the zsh EQUALS caveat).
- [x] dist rebuilt + the 46-row re-probe green; suites 87/0.
      (Suite count at this item's write time; superseded across review
      rounds 1-4 — the final count is 91/0, see the evidence below.)
- [x] Queued (NOT this iteration): env-prefixed wrapper coverage
      (`env sh -c '...'` — shared with hasGitMutation's scope); the
      symbolic-ref matcher line; the HEAD-alias push resolution; the
      localBranches fact.
      CORRECTION (review round 1, 2026-09-23): the queued env-prefix
      item above was FALSIFIED — env/timeout/assignment prefixes are
      consumed by the unwrapper and prefixed wrappers were always
      detected; the correction is recorded in SECURITY_ASSURANCE #20,
      LESS-0019, the W100 doc §7 item 12, and here (this line). The
      genuinely queued edges are the exotic interpreter names (busybox
      sh, xsh), the zsh EQUALS caveat, and the fused-bundle shapes the
      review rounds continue to harden. (Review rounds 3-4 appended:
      the -o bundle consumption and the -O/+O shopt family — see the
      parity-log W102 rounds 3-4; the duplicate correction block that
      stood here was a splice artifact, deduped.)
      (Round-5 hygiene: the correction block appeared TWICE — the second
      occurrence above is the splice artifact itself, retained and
      marked here rather than silently deleted; the canonical correction
      is the first one.)
      CORRECTION (review round 1, 2026-09-23): the queued env-prefix
      item above was FALSIFIED — env/timeout/assignment prefixes are
      consumed by the unwrapper and prefixed wrappers were always
      detected; the correction is recorded in SECURITY_ASSURANCE #20,
      LESS-0019, the W100 doc §7 item 12, and here (this line). The
      genuinely queued edges are the exotic interpreter names (busybox
      sh, xsh), the zsh EQUALS caveat, and the fused-bundle shapes the
      review rounds continue to harden.
