<!-- Ledger fragment: extracted from TASKS.md at line 3879 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W118 - The budget-downgrade consumer, part 1: the warn-tier stage composes at the governed transformBody lane (Partial - the transform + env axes + the no-key-lane composition landed; the OpenRouter-lane variant and the wiring breadth queued) (2026-09-24)

**Source:** the park file's P15 (the W095 budget-downgrade consumer,
queued since the routing design note) — the top self-contained candidate
after P17's retirement: the seam landed (W109's transformBody), the
design recorded (the note's key-2 + the round-3 fail-open posture), the
wiring shape clear.

**What landed (part 1):**
- The warn-tier axes (session-budget.ts): `WORKFLOW_BUDGET_DOWNGRADE_MODEL`
  (required) + `WORKFLOW_BUDGET_DOWNGRADE_FRACTION` (default 0.8, must
  parse to (0,1)) — `budgetDowngradeFromEnv` fails CLOSED to undefined
  (a broken downgrade axis degrades to no-downgrade, the status quo
  ante; unlike parseCap's throw, because a broken CAP must never degrade
  to unenforced while a broken DOWNGRADE degrades to the safe default);
  `budgetDowngradeActive(usage, budget, fraction)` mirrors
  budgetViolation's per-dimension comparison at the warn fraction.
- The transform stage (model-usage-proxy.ts): the `budgetDowngrade`
  option composes a rewrite stage AFTER the caller's transformBody (the
  shaped body's model rewritten to the target when the proxy's OWN
  recorded usage has crossed the warn fraction — a per-request read of
  the mutating metrics object). The FIFTH bounded deviation from pure
  pass-through and the THIRD transformBody consumer (the header
  enumeration synced — it already anticipated this consumer).

  > **Dated supersession note (2026-09-30, the P15a round, branch `feat/p15a-downgrade`): the BEFORE/AFTER prose above is WRONG — the code and the W118 order pin (`test/open-model-proxy.test.ts:282-286`) compose the downgrade stage BEFORE the caller's transformBody** (the caller sees the already-downgraded body; the P15a diff corrected the option doc-comment that repeated the prose error). Recorded here rather than silently edited: the fragment is write-once.
- The governed-lane composition (open-model-proxy.ts + acp-runtime.ts):
  the open-source lane's transformBody (the only production
  transformBody consumer per the round-3 review) composes the stage;
  the runtime passes the env-parsed axes and additionally requires
  budget caps to exist (no caps = nothing to warn about).
- The OpenRouter-lane allowed_models-narrowing variant (the auto-router
  downgrade per the design note) and the per-family usage-granularity
  residual (a session spreading traffic across family proxies sums
  separately) are QUEUED.

**Acceptance criteria:**
- [x] Red/green: 4 pins red at compile level (the exports/option did not
      exist), 17/17 after the stage (the executor hit its step limit on a
      pin contradiction — the orchestrator resolved it: the pin's
      timeline model had an off-by-one, the crossing is observable one
      request AFTER the crossing usage records, exactly the W095 note's
      "routes remaining turns" semantics), 29/29 with the budget
      held-outs; lint + typecheck exit 0.
- [x] The governed-lane end-to-end pin (LESS-0030: through the REAL pool
      composition, not a synthetic path): pre-crossing untouched,
      remaining turns rewritten, sticky, and the metering trail records
      identically on both sides of the rewrite.
- [x] The pass-through posture pinned: absent the downgrade config the
      model rides untouched at any usage level.
- [x] The abort tier untouched: budgetViolation's comparison and the
      W045 cancel-at-cap unchanged (the downgrade is the middle step).

**Residuals (recorded, not fixed):** the abort tier is BLIND to the
open lane (the fresh-eyes round-1 P2, pre-existing W045-era:
composeSessionWithBudget wires the guard with the OpenRouter proxy's
metrics only, so the open lane's traffic is invisible to the abort tier
while the W118 downgrade activates on exactly that traffic — feeding
the guard the aggregated pool metrics is the queued design change, and
until then neither tier sees open-lane usage). RESOLVED (W119,
2026-09-24, the next iteration): the guard's usage snapshot AGGREGATES
the pool's metrics with the OpenRouter proxy's
(`composeSessionWithBudget`'s optional `additionalUsage`; the open
lane's runtime wired; the violation reason echoes the aggregated total,
pinned) — the abort tier now sees the open lane and the downgrade warn
tier covers the same usage; the OTHER residuals ((a) the OpenRouter-
lane variant, (b) the per-family granularity, (d) the fail-open
composition semantics, (e) the warn-threshold source, (f) the
fail-closed silence) stand. RESOLVED (W122, 2026-09-24): (f) the
fail-closed silence — `budgetDowngradeFromEnv` now warns `[budget]`
naming the axis and the raw value on the operator-asked fail-closed
paths, honest absence stays silent, and the fail-closed posture is
unchanged (the W122 item).
