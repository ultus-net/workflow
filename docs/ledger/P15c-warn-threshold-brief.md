<!-- Ledger fragment: opened 2026-09-30 as the P15 part (c) record (issue #294). Write-once — append dated supersession notes, never rewrite. -->

### P15 (c) — the warn-threshold source decision brief (Brief recorded - the options, the tier interactions, the dependency notes, and a recommendation; the DECISION stays the operator's) (2026-09-30)

**Source:** `docs/PARKED_AND_LIMITATIONS.md` row P15, remaining part (c)
— "the warn-threshold source decision (env axes for v1, design-open per
the note)". The note's key-2 reads "warn-tier threshold source design-open:
env axis or cap fraction" (`docs/MODEL_ROUTING_POLICY_2026-09-23.md:63–65`,
`:173–176`). GitHub issue #294; the issue stays OPEN (the decision is
queued). Parts (a) and (b) landed 2026-09-30 (`docs/ledger/P15a-*.md`,
`docs/ledger/P15b-*.md`).

**What landed (the brief):** `docs/P15_WARN_THRESHOLD_SOURCE_BRIEF.md` —
a decision input only, no code change. It frames the source as the
`fraction` in `cap * fraction` of `budgetDowngradeActive`
(`src/integrations/session-budget.ts:198–204`; today
`WORKFLOW_BUDGET_DOWNGRADE_FRACTION`, default 0.8, `:160–192`) and presents
three options: **(a) the env axis (today's v1)** — control of warn lead
time, at the cost of a second number that can drift from the caps;
**(b) derive from the guard's cap fraction** — a fixed internal fraction,
guaranteed warn-before-abort coherence, at the cost of tuning; **(c) a
hybrid/configured source** — an absolute threshold OR a fraction with
documented precedence and an ordering clamp below the cap, most control and
most surface. Per option it records the interaction with the warn/abort
tiers (`sessionBudgetTier` `:127–131` + `budgetViolation`,
`hub-scheduler.ts:48–60`), the operator-facing shape, the fail-closed
direction on malformed configs (W122's `[budget]` warn + undefined), the
blast radius, and the verification plan.

It also records the dependency/consistency notes: the source is agnostic to
P15(b)'s additive, recorded-only per-family view (the warn reads the
aggregate); it is shared BY CONSTRUCTION with P15(a)'s Auto Router narrowing
(the same runtime fraction, `model-usage-proxy.ts:352`); and an **as-found
seam**: the abort guard evaluates the W151 override-merged budget
(`mergeSessionBudget`, `acp-runtime.ts:192–199`) while the downgrade/warn
runtime is built from `sessionBudgetFromEnv()` alone (`:234–236`).

**Recommendation (non-binding):** option (a) reaffirmed for v1, option (b)
recorded as the coherence direction, the override seam named as the trigger
to revisit. Core trade-off: (a) buys operator control of warn lead time at
the cost of a second number that can drift; (b) buys guaranteed
warn-before-abort coherence at the cost of tuning. **The decision stays the
operator's.**

**Evidence:** docs-only — no compiled artifact changed, so `npm run lint`
and `npm run typecheck` are not applicable (stated in the brief, §4). The
as-found state is pinned by the existing focused suites cited in the brief:
session-budget 17/17 (W122), the auto-lane 5/5 (P15a), open-model-proxy
6/6 + model-usage-proxy 19/19 (P15a baseline), and the P15(b) pins
(32/32 across open-model-proxy + session-budget + open-source-pool).

**Boundaries:** the part (c) decision itself remains queued (operator);
the W151 override seam stays as found unless (b) or (c) is chosen; no
option is implemented here.

> **Dated supersession note (2026-09-30, the P15c brief review round):** the
> brief's §2 as-found seam is stated from the tree at the time of writing
> (`acp-runtime.ts:192–199` vs `:234–236`); if a later change unifies the
> two budgets, this fragment is the pointer to it.
