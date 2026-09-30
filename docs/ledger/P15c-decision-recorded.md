<!-- Ledger fragment: opened 2026-09-30 as the P15 part (c) DECISION record (issue #294). Write-once — append dated supersession notes, never rewrite. -->

### P15 (c) — the warn-threshold source decision recorded (Decided (a) - the warn-threshold source STAYS the env axis for v1; a recorded reaffirmation, no code change) (2026-09-30)

**Source:** `docs/PARKED_AND_LIMITATIONS.md` row P15, remaining part (c) —
"the warn-threshold source decision (env axes for v1, design-open per the
note)". The decision INPUT is `docs/P15_WARN_THRESHOLD_SOURCE_BRIEF.md`
(recorded 2026-09-30, ledger `docs/ledger/P15c-warn-threshold-brief.md`).
GitHub issue #294. Parts (a) and (b) landed 2026-09-30
(`docs/ledger/P15a-*.md`, `docs/ledger/P15b-*.md`).

**What landed (the decision):** the operator chose **option (a) — the env
axis — reaffirmed for v1.** The warn-threshold source STAYS the env axis:
the `fraction` in `cap * fraction` of `budgetDowngradeActive`
(`src/integrations/session-budget.ts:198–204`), today
`WORKFLOW_BUDGET_DOWNGRADE_FRACTION` (default `0.8`, parsed to `(0,1)`,
`budgetDowngradeFromEnv` `:160–192`). **No code change** — this is a
recorded reaffirmation of the as-shipped state (W118 landed the
cap-relative mechanism with the env fraction as v1; the routing note marked
the source design-open, `docs/MODEL_ROUTING_POLICY_2026-09-23.md:63–65`).

Options (b) derive-from-the-cap and (c) hybrid/configured source are
**not** taken; the brief's three options remain as the re-open reference, so
a future decision can re-open from the same frame without re-deriving it.

**What would trigger revisiting:** a **warn/abort coherence drift** — the
brief's §2 as-found seam: the abort guard evaluates the W151
override-merged effective budget (`mergeSessionBudget`, `acp-runtime.ts:
192–199`) while the downgrade/warn runtime is built from
`sessionBudgetFromEnv()` alone (`:234–236`). With a session cap raise the
two tiers see different budgets; option (b)'s single derived value or
option (c)'s ordering clamp would each force that seam to be resolved, so a
coherence drift is the recorded trigger to revisit (brief §2, §4).

**Already-landed invariants preserved (unchanged by this decision):** the
guard's own predicates stay the single threshold source
(`sessionBudgetTier` `:127–131`); warn (`>= fraction`) stays strictly
before abort (`> cap`) under the structural `(0,1)` parse guard; a
malformed fraction fails closed to undefined (downgrade off) with the W122
`[budget]` warn naming the axis and raw value.

**Evidence:** docs-only — no compiled artifact changed, so `npm run lint`
and `npm run typecheck` are **not applicable** (stated in the brief, §4, and
unchanged here). The as-found state is pinned by the existing focused suites
cited in the brief: session-budget 17/17 (W122), the auto-lane 5/5 (P15a),
open-model-proxy 6/6 + model-usage-proxy 19/19 (P15a baseline), and the
P15(b) pins (32/32 across open-model-proxy + session-budget +
open-source-pool). This decision adds only the dated notes (the P15 row, the
brief) — no new test.

**Boundaries:** the W151 override seam stays as found (option (a) leaves it
as-is); no option is implemented here. With this record every P15 part is
dispositioned: (a) landed, (b) landed, (c) decided-(a), (d) resolved W122.

> **Dated supersession note:** (append future re-open here — e.g. if a
> warn/abort coherence drift is observed, or options (b)/(c) are revisited).
