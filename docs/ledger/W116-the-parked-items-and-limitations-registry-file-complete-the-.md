<!-- Ledger fragment: extracted from TASKS.md at line 3708 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W116 - The parked-items and limitations registry file (Complete - the operator-directed re-address queue; the loop's work-picking source) (2026-09-24)

**Source:** the operator's direction closing the contradiction sweep
("parked items and limitations need to be in their own file so we can
readdress with loops in the future") after PR #107's merge. The
inventory existed only scattered across ledger items and lessons — the
operator had approved it (2026-09-24) but nothing made it the loop's
work-picking surface.

**What landed:**
- `docs/PARKED_AND_LIMITATIONS.md` — one canonical file, two sections
  (**P1-P11 at creation; P12-P16 appended by the round-1 review fixes;
  P17-P18 appended by the round-2 completion pass** — 18 parked items,
  8 recorded limitations), every entry
  carrying its source ledger item, dependencies/conditions, TRUTHFUL
  verification status (landed+verified / structural-only / unmeasured /
  dispositioned-not-audited), and its approval record. File rules:
  append-only, dated supersession notes, entries leave only when the
  work lands (PR linked) or the operator retires them, and future loops
  consult it BEFORE picking work.
- The operator's explicit approval of the limitations and parked items
  (2026-09-24) is recorded in the file's approval record — the honest
  chain: earlier entries rode inside merged PRs (#101-#107) implicitly;
  this file's creation is the explicit approval act.
- TASKS.md's header carries the pointer so every loop entry point
  finds it (the loop reads TASKS.md's header; the `guard_next_tasks`
  tool surfaces TASKS.md content).

**Acceptance criteria:**
- [x] Every entry's facts match its source ledger item (the fresh-eyes
      review round 1 — REQUEST_CHANGES — caught a duplicate invariant
      line, three entry drifts (P1/P4/P9), and FIVE missing queued items;
      all fixed in this iteration's follow-up commit and re-verified by
      the round-2 cross-check, recorded below).
- [x] The file is append-only by stated rule; the operator's approval
      date recorded per entry.
- [x] The discoverability pointer exists in TASKS.md.
- [x] Docs-only: lint/typecheck exit 0.

**Review record (round 1, 2026-09-24, REQUEST_CHANGES — all findings
applied):** the reviewer's source cross-check found: the W116 criterion
was ticked before its named verifier ran (this very round); an unintended
duplicate "The invariant is:" line my header edit introduced; P1's
"metering trail verified unaffected" read as completed (it is future
work); P4's cross-reference pointed at the wrong W109 gap; P9 dropped
the corrected pollution nuance (the trail is polluted via zero-token
events, not absent); FIVE queued items were missing from a file claiming
canonicity (W109 gaps 2/4/6, the budget-downgrade consumer, the
W099/W100 unification implementation). All fixed: the criterion unticked
then re-ticked against the round-2 cross-check; the duplicate removed;
the entries corrected/appended as P12-P16; the guard-discoverability
claim in TASKS.md softened to what is true (the pointer exists in
TASKS.md, the header every loop reads).

**Review record (round 2, 2026-09-24 — TWO passes, honestly incomplete
then completed):** the round-2 reviewer hit its step limit mid-sweep and
honestly reported the cross-check INCOMPLETE (the tick cited a verifier
that had not demonstrably run — the same defect round 1 flagged, in a
new form; its interim verdict: REQUEST_CHANGES). The completion pass
(a fresh reviewer, scope-tightened to the remaining pairs) verified
15/16 pairs + all four limitations faithful (P2/P3/P4/P5/P15/P6/P7/
P9/P12/P13/P14/P10/L3/L4/L5/L6 ✓) and found TWO further omissions from
the file claiming canonical completeness: the ci-intelligence-mcp
pre-existing build/typecheck break (W105's queued item) and the open
W102/W103 wrapper/push residual edges (residual #20's queued edges +
#21's still-open part). Both appended as P17/P18; the W113 numbering
skip noted (no ledger item exists — another session's branch never
landed its item; nothing dangles). Interim verdict: REVISE → the
fixes applied in this commit; the criterion's tick stands on BOTH
passes recorded here.
