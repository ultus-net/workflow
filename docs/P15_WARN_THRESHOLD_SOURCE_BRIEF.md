# P15 decision brief — the warn-threshold source

**Date:** 2026-09-30 · **Status:** decision INPUT only — **this brief is the
input; the decision is the operator's.** Nothing here authorizes a code
change. · **Item:** parked P15 part (c) (docs/PARKED_AND_LIMITATIONS.md:44,
GitHub issue #294). · **Sources read in full:** the P15 row
(docs/PARKED_AND_LIMITATIONS.md:44); src/integrations/session-budget.ts
(the W118 axes, the W122 fail-closed parse + warn posture, the W151 tier);
src/integrations/hub-scheduler.ts:48–60 (`budgetViolation`); the ledger
fragments docs/ledger/W118-*.md, docs/ledger/W119-*.md,
docs/ledger/W122-*.md, docs/ledger/P15a-openrouter-downgrade.md,
docs/ledger/P15b-per-family-metrics.md; the routing note's key-2
(docs/MODEL_ROUTING_POLICY_2026-09-23.md:63–65, :173–176).

## 0. What "the source" is, precisely

The budget-downgrade consumer has three tiers on one budget
(src/integrations/session-budget.ts):

- **under** — below the warn threshold.
- **warn** — `budgetDowngradeActive(usage, budget, fraction)` returns true
  when `usage >= cap * fraction` on **any** configured dimension
  (:198–204). The warn tier is what routes remaining turns to the cheap
  target (the body-`model` rewrite at the proxy `transformBody` seam on
  concrete-model lanes; the `allowed_models` narrowing on the Auto Router
  lane, P15(a)).
- **abort** — `budgetViolation(usage, budget)` returns true when
  `usage > cap` on any dimension (hub-scheduler.ts:48–60). The W045 guard
  cancels the turn and refuses later prompts.

`sessionBudgetTier(usage, budget, warnFraction)` (:127–131) reads abort
first, then warn, then under — **the guard's own predicates are the single
threshold source**; the posture badge/bar derives nothing itself (W151,
:116–124; consumed at src/ui/web-sessions.ts:763).

The **source** under decision is the `fraction` in `cap * fraction`: today
it is an env axis, `WORKFLOW_BUDGET_DOWNGRADE_FRACTION` (default `0.8`,
must parse to `(0,1)`, `budgetDowngradeFromEnv` :160–192). The routing
note marked it design-open as "**env axis or cap fraction**"
(docs/MODEL_ROUTING_POLICY_2026-09-23.md:63–65). W118 landed the
cap-relative **mechanism** with an env-set fraction as v1 — both axes are
env (P15 row). The open question is whether the fraction stays an
operator-tunable env axis or is derived from the caps, and what fail-closed
direction a malformed source takes.

**Already-landed invariants any option must preserve:**

- The per-dimension comparison is `>=` at the fraction and `>` at the cap,
  both on ANY dimension, so an active warn precedes the abort **only while
  `fraction < 1`** — the `(0,1)` parse guard (:179) keeps that ordering
  structurally, not by convention.
- No caps configured means nothing to warn about; the downgrade composes
  only when caps AND the axes exist (src/integrations/acp-runtime.ts:
  233–237).
- A broken cap **throws** (refuse to run unenforced, :32–40); a broken
  downgrade axis **fails closed to undefined** (status quo ante, no
  downgrade) and now warns `[budget]` naming the axis + raw value (W122,
  :173–183). The asymmetry is deliberate and recorded (W118 ledger).

## 1. The options

### Option (a) — env axis (today's v1)

**What it buys.** One operator-visible knob per decision knob: the target
(`WORKFLOW_BUDGET_DOWNGRADE_MODEL`, required) and the warn fraction
(`…_FRACTION`, default `0.8`). An operator can move the warn earlier
without touching caps. The value is explicit, greppable, and
session-independent.

**What it costs.** Two numbers must stay coherent: the fraction and each
cap. A fraction set near 1 collapses warn into abort (both fire in the same
turn — the rewrite has no turn boundary left to act on); the parse guard
only forbids `>= 1`, not "practically useless". The threshold is
fraction × cap **per dimension**, so a session capped on total-tokens only
warns at `0.8 × total`, while one also capped on cost can warn on the cost
axis first — the binding dimension is implicit.

**Interaction with the tiers.** Warn = `fraction × cap`, abort = `cap`;
ordering holds for `fraction ∈ (0,1)` (:198–204 vs hub-scheduler.ts:48–60).

**Operator shape.** Two env vars; today the production default is 0.8 and
the W122 warn surfaces a malformed/valueless axis.

**Fail-closed direction on malformed configs.** Fraction malformed, or
fraction-without-target → `undefined` (downgrade off, warns). Target
without fraction → default 0.8, not off. Unchanged from W118/W122.

**Blast radius.** Zero code change (this IS the current state); the
"decision" would be a recorded reaffirmation. Any eventual change is
confined to `session-budget.ts` + the runtime call sites + the W151 UI read
(web-sessions.ts:203).

**Verification plan.** Existing pins already freeze it: session-budget
17/17 (W122), the auto-lane 5/5 (P15a), open-model-proxy 6/6,
model-usage-proxy 19/19 (P15a baseline). A reaffirmation adds only the
dated row note — no new test.

### Option (b) — derive from the guard's cap fraction (no env knob)

**What it changes.** Remove `WORKFLOW_BUDGET_DOWNGRADE_FRACTION` from the
source; the fraction becomes an internal constant (the landed 0.8) applied
cap-relative, exactly as `budgetDowngradeActive` already computes. The env
axis set shrinks to the target model alone.

**The consistency argument.** The abort tier is the cap; the warn tier
becomes a **fixed offset below it** by construction, on every dimension,
with no second number to drift. "The guard's own predicates are the single
threshold source" (W151) then holds for the *value* too, not only the
comparison: the UI badge, the proxy rewrite, and the Auto Router narrowing
cannot disagree because there is nothing to configure inconsistently.

**What it costs.** Loses operator tuning of the warn lead time. The
warning point is no longer adjustable for a session whose cap is
operator-raised (W151 override) without also changing the constant. A
future per-family or per-lane fraction (P15(b) territory) would need a new
seam.

**Interaction with the tiers.** Identical math to (a) with the fraction
pinned at 0.8. Tiers stay ordered structurally.

**Operator shape.** One env var (target). The mechanism string and the
`[budget]` warns for a malformed fraction disappear (the axis no longer
exists) — the W122 malformed-fraction warn becomes dead code and would be
retired with the axis.

**Fail-closed direction.** No fraction axis to malform; the only
downgrade-config failure left is target-missing-with-…, which collapses
too. Failure of the source is impossible because there is none.

**Blast radius.** `session-budget.ts` (drop the axis + default), the
runtime parse sites (acp-runtime.ts:233, opencode-server-runtime.ts), the
W151 UI read (web-sessions.ts:203), the W122 pins for the two
fraction-warn paths, and the env docs. Medium.

**Verification plan.** Red-first: an env-set fraction must be *ignored*
(no downgrade-config effect), the warn still fires at 0.8, and the
retired warns no longer fire. Hold-outs: the aggregate/abort pins
(W119), the auto-lane pins (P15a), the per-family pins (P15b) all stay
green. Focused: session-budget + open-model-proxy + model-usage-proxy +
the new pins.

### Option (c) — a hybrid / configured source

**What it changes.** Keep an env axis but make it **explicit about what it
sets**: an absolute threshold in the cap's units, a fraction, or both with
a documented precedence. The natural shape: `…_FRACTION` (cap-relative,
default 0.8) OR `…_TOKENS`/`…_COST` (absolute), unioned in
`budgetDowngradeActive` (warn if ANY source crosses).

**The consistency argument.** Absolute thresholds buy per-dimension
control the fraction cannot express (e.g., warn on cost early but let
tokens run). The cost is a source-of-truth question per dimension and a
second way to contradict the abort tier — an absolute threshold above the
cap would warn after abort. So (c) needs an **ordering clamp**: warn
thresholds are clamped strictly below the cap, or a threshold `>= cap` is
malformed and fails closed.

**What it costs.** The most surface, the most pins, the most operator
explanation. Two knobs can disagree; the precedence must be speced, not
inferred.

**Interaction with the tiers.** Requires the clamp above to preserve
warn-before-abort; without it, an absolute threshold can be moot.

**Operator shape.** A priority-ordered source (explicit absolute >
fraction > default), documented and warned on contradiction.

**Fail-closed direction.** Malformed value → that source is dropped with a
`[budget]` warn; if it was the only source, downgrade off (status quo
ante). A value that would warn at/after the cap is malformed (fail
closed), not silently accepted.

**Blast radius.** All of (b)'s sites plus the new axes, the clamp, and
their pins. Largest.

**Verification plan.** Red-first per source: absolute fires, fraction
fires, both set uses precedence, threshold ≥ cap is refused and warns,
malformed warns and drops. Hold-outs: every current pin stays green when
only the default source is present.

## 2. Dependency and consistency notes

**vs. P15(b) per-family metrics (landed 2026-09-30).** `perFamilyMetrics()`
is additive and **recorded-only** (docs/ledger/P15b-per-family-metrics.md):
the aggregate consumed by the abort tier and by `budgetDowngradeActive` is
byte-identical. So the warn-threshold source does **not** currently have a
per-family dimension — the warn fires on the proxy's own aggregate
(model-usage-proxy.ts:255–259) and on the pool's aggregate. Any of (a)–(c)
is agnostic to (b) as landed; only if a future decision made the threshold
*per-family* would (b)'s view become a source input, and that would be a new
seam, not a change to this one.

**vs. the P15(a) auto-lane variant (landed 2026-09-30).** The
Auto Router lane reuses the same predicate and the same runtime
`fraction` for the `allowed_models` narrowing
(model-usage-proxy.ts:352 with the runtime at acp-runtime.ts:235–236).
Changing the source (b) or (c) therefore changes the narrowing threshold
and the concrete-lane rewrite threshold together — they share one value by
construction today. The brief treats that as required: the two lanes must
not diverge on when a downgrade is active.

**As-found consistency seam worth the decision's attention (not a
recommendation, a fact).** The abort guard evaluates against the **effective**
budget — `mergeSessionBudget(sessionBudgetFromEnv(), budgetOverride)`
(acp-runtime.ts:192–199) — while the downgrade/warn runtime is built from
`sessionBudgetFromEnv()` alone (acp-runtime.ts:234–236). With a session cap
raise (W151 override), the abort tier sees the raised caps and the warn
tier sees the env caps. Options (b) (single derived value) and (c)
(ordering clamp against the *effective* cap) would each force this seam to
be resolved; option (a) leaves it as found. This brief does not decide it;
it surfaces it as an interaction the chosen source must state.

## 3. Recommendation (the decision stays the operator's)

**Recommend option (a) reaffirmed for v1, with option (b) recorded as the
coherence direction and the override seam named as the trigger to revisit.**
The core trade-off: **(a) buys operator control of warn lead time at the
cost of a second number that can drift from the caps; (b) buys guaranteed
warn-before-abort coherence at the cost of tuning.** (c) adds the most
control and the most ways to contradict the abort tier, so it earns its
surface only if a concrete need for per-dimension lead time appears.

Grounding for the recommendation: the warn tier already holds structural
ordering under the `(0,1)` parse guard (a broken fraction cannot invert the
tiers); the operator-visible shape of (a) is already shipped and pinned; and
the one real coherence gap found (the W151 override split, §2) is not fixed
by (a) or (b) alone — it is a separate decision. Making (b) the default
today would silently remove an axis the W122 pins freeze, without the
operator asking for less control.

**This recommendation does not bind the operator; the P15 row's decision
remains queued and the operator chooses.** Whichever option is chosen, the
landing must keep the guard's predicates as the single threshold source,
keep warn strictly before abort, and keep the malformed-source direction
fail-closed with a `[budget]` warn.

## 4. What is left

- The decision itself (operator).
- If (b) or (c): the W151 override seam in §2 must be resolved in the same
  change, or the two tiers keep evaluating different budgets.
- Docs-only here: **no code changed; `npm run lint` / `npm run typecheck`
  are not applicable to this deliverable** (nothing compiled changed). The
  existing focused suites cited above are the verification of the
  as-found state, not of this brief.
