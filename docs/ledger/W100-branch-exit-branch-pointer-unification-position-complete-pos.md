<!-- Ledger fragment: extracted from TASKS.md at line 2569 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W100 - Branch-exit/branch-pointer unification position (Complete - position recorded, frontier-verified at round 3; implementation queued) (2026-09-23)

**Source:** the G5 queued follow-up (the checkout/switch asymmetry decision
queued by W099); operator priority "frontier findings are top priority".

**What landed (position doc only — NO code change):**
- docs/BRANCH_EXIT_POLICY_2026-09-23.md: the 28-row family inventory probed
  LIVE against the built vendored core (with and without W090 facts), the
  structural finding (the deny class is spelling-SHAPED and
  current-branch-GATED — nine+ protected-pointer-write holes on the allow
  side: `switch -C <protected> [sha]`, `branch -f <protected> <sha>`,
  one/two-arg `-m`/`--move` renames, force-copy `-C`, `switch --detach/-d`,
  cross-branch `branch -D <protected>` / `update-ref refs/heads/<protected>`
  / fetch destination refspecs, `switch -f/--discard-changes`, and the
  shell-wrapper bypass of the ENTIRE deny class), the semantic analysis
  (exits/creates vs discards vs pointer writes vs the justified
  row-4 ambiguity deny), the position (unified semantic classifier,
  target-gated against the always-on `{main, master}` ∪ facts base — the
  push lane's own shape — fail-closed under parse uncertainty, pure
  exits/creates allowed, the factless posture split by class), two explicit
  outside-the-family residuals (shell-wrapper lane, exotic symbolic-ref
  form) with queued companion fixes, and the rejected-alternatives record
  (including the blanket-fail-closed fallback with its
  graceful-degradation property).
- Upstream parity verified read-only at `origin/main` 03fbdcf
  (v1.15.0-5-g03fbdcf, package 1.15.1): the same holes; upstream's
  `GIT_BRANCH_CREATE_RE` (git.ts:35) recognizes the sanctioned creates but
  only for the freshness gate. The unified fix is a deliberate, recorded
  upstream divergence (parity-log entry queued with the implementation).
- Frontier verification: Kimi K3, three rounds (REVISE → REVISE → ACCEPT,
  appendix A append-only). Round 1 falsified two draft claims (row-4
  "fact-independence"; the upstream version label read off the dirty
  v1.11.0-4 working tree) and under-counted the family by five classes
  plus the whole cross-branch dimension; round 2 caught three defects the
  revision itself introduced (detach mis-grouped into the target gate;
  pin-coverage overclaim for rows 16–18/6; row 25 outside every §4
  bucket); round 3 confirmed all corrections and accepted. Every
  incorporated finding was re-verified by live probe before incorporation;
  the appendix carries the per-finding dispositions.
- LESS-0017 (the scanner incident: the live plugin's file scanner blocks
  probe scripts AND documents carrying force-refspec shapes — the W084
  fixture convention is load-bearing for writing security analysis at
  all; finest-grain escapes recorded).

**Queued (next iteration, per §4.1 of the doc):** widen BOTH matchers
(`gitWriteRe` + `hasGitMutation`) to the full pointer family; the
structured protected-target gate (renames check both operands; one-arg
rename resolves to `currentBranch`; parse-uncertain → deny); the fetch
destination-refspec rule mirroring the push lane; red-first pins for rows
6/9–15/22–24 + new characterization pins for 16–21 + the round-3
watch-item pins (explicit `checkout <sha>`, row 27) — W099 pins stay
red-free by design; dist rebuild + live re-probe; parity-log divergence
entry; SECURITY_ASSURANCE residuals for the wrapper lane and symbolic-ref
form; the deny-path `sh -c` recursion as the companion fix.

**Acceptance criteria (this item = the position; implementation has its
own item):**
- [x] Family inventory probed live (with + without facts), 28 rows, every
      verdict reproducible.
- [x] The holes enumerated precisely, including the cross-branch dimension
      and the twin-matcher drift.
- [x] Position recorded with the factless posture split by class and the
      residuals explicit.
- [x] Frontier verification ACCEPT at round 3 (appendix A append-only,
      wrong rounds preserved).
- [x] Upstream divergence basis verified at a pinned ref (read-only).
- [x] LESS-0017 recorded; LESS-0016 stands from W099.
