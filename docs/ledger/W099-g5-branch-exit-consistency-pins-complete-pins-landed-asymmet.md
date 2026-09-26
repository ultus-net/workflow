<!-- Ledger fragment: extracted from TASKS.md at line 2523 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W099 - G5 branch-exit consistency pins (Complete - pins landed; asymmetry unification queued) (2026-09-23)

**Source:** frontier agents-research assessment §6 G5
(docs/AGENTS_RESEARCH_PORT_ASSESSMENT_2026-09-22.md; operator priority
"frontier findings are top priority"). F1's identical-intent disease survived
its fix in a new spelling, and no vendored test pinned any branch-creation
behavior (grep 2026-09-22).

**What landed (vendored guard, pins only — no src change, dist untouched):**
- policy.test.ts: the as-found classification set frozen — allowed exits on a
  protected branch (`git checkout -b`, `git switch`, `git switch -c/-C`,
  `git switch main`); the F1 asymmetry residual pinned verbatim
  (`git checkout <branch>` and `git checkout -B` DENIED on a protected branch
  while the intent-identical switch forms are allowed — the case-sensitive
  `(?!-b\b)` lookahead at src/git-policy.ts:7); the load-bearing
  `git checkout -- <file>` working-tree-discard deny; the off-protected-branch
  allowance (the gate targets protected-branch writes, not exits); and the
  W090 no-facts fail-open (the protected-branch gate cannot engage without
  facts).
- redirect.test.ts: the protected-branch-write redirect names
  `git checkout -b` — the one checkout spelling the matcher partly blocks —
  so matcher and guidance must move together.

**Deliberately NOT done:** unifying the checkout/switch asymmetry (allowlist
all pure exits vs make switch symmetric) is a policy decision requiring its
own iteration + frontier verification; these pins freeze current behavior so
any change requires a decision, not drift. One change per iteration.

**En-route finding (pre-existing, queued):** package.test.ts fails on this
host for reasons unrelated to W099 — npm 12.0.2's `npm pack --json` returns a
keyed object while the untouched test destructures the legacy array shape
("object is not iterable"). It was already outside the focused-evidence set
(W097 recorded policy+mcp+redirect only). Fixing it is a legitimate
test-vs-npm-version repair but its own iteration; NOT folded here.

**Acceptance criteria:**
- [x] Every branch-exit spelling class pinned (characterization, as-found:
      all 4 policy pins + 1 redirect pin green on first run — predicted,
      then verified; no pin was weakened).
- [x] The asymmetry documented in-source-comment + ledger so the F1 disease
      cannot resurrect silently.
- [x] Focused suites green: policy 58/0 (54 + 4), redirect 5/0 (4 + 1), mcp
      5/0; vendored typecheck exit 0 (node --import tsx --test; npm 12).
- [x] Assessment doc §11 addendum appended (G3 closure by W091/W092
      recorded; G5 closure recorded; G2 part 2 + G4 remain open).
