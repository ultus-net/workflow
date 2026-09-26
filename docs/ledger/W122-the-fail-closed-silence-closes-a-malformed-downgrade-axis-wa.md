<!-- Ledger fragment: extracted from TASKS.md at line 4033 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W122 - The fail-closed silence closes: a malformed downgrade axis warns `[budget]` instead of disabling silently (Complete - the W118 residual (f) / park P15 (d) closed) (2026-09-24)

**Source:** park P15 (d) + the W118 item's residual (f) ("the
fail-closed silence: a malformed axis silently disables the downgrade;
operator-facing logging queued"): W118's `budgetDowngradeFromEnv`
returned undefined silently on the two operator-asked paths — a
malformed fraction with a target set, and a fraction without a target —
so an operator who configured the downgrade never learned it was off
(the W045 guard's own never-silent posture, applied to configuration).

**Prediction (registered before the edit):** the parse fires exactly
one `[budget]`-prefixed warning naming the axis and the raw value on
the two operator-asked fail-closed paths and still returns undefined
(the fail-closed posture unchanged); valid configs, honest absence, and
the blank-target path stay silent; the return semantics and the
runtime shapes are untouched. At-risk regressions: the consumer suites
(open-model-proxy, model-usage-proxy) and the strict compile of the new
optional parameter.

**What landed:** the injectable `warn` parameter (the containment
platform.ts pattern) on `budgetDowngradeFromEnv`, defaulting to
`(message) => console.warn(\`[budget] ${message}\`)`; the two
operator-asked fail-closed paths warn (the malformed fraction names the
axis + the raw value + the configured target; the missing-target path
names the missing axis + echoes the set fraction); honest absence
(nothing set; a blank target with no fraction) stays silent; the stale
in-code residual comment superseded in place.

**Red/green:** the pins authored FIRST against the pre-change src:
3 red (a malformed fraction warns once and still fails closed; a
fraction without a target model warns; the default warn reaches the
operator console) — runtime reds under tsx AND compile-level red
(tsc exit 2: six TS2554 at the red-first snapshot's pin call sites —
the final pin set carries 8 two-arg call sites); 1 regression hold-out
green before (runtime-scoped: tsx strips the ignored second argument —
at compile level the hold-out too would be TS2554 against the
one-param signature) AND after by design (valid configs and honest
absence stay silent); the 13 pre-existing pins green throughout. After the
implementation: 17/17 session-budget; 21/21 consumers (open-model-proxy
+ model-usage-proxy); lint exit 0; typecheck exit 0.

**Acceptance criteria:**
- [x] The operator-asked fail-closed paths warn (`[budget]` prefix; the
      axis named; the value echoed; once per parse — the single
      runtime-composition call site keeps it non-spammy).
- [x] The fail-closed return is UNCHANGED (pinned per raw value: 1.5,
      0, abc all still return undefined — the warn never softens it).
- [x] Honest absence stays silent (nothing set; a blank target with no
      fraction; a whitespace-only fraction is unset per parseCap's
      convention — the hold-out pins freeze the interpretation).
- [x] The production default is operator-facing through the real
      console.warn (pinned through the un-injected default path).
- [x] The recording sites updated in the same change: park P15 (d), the
      W118 item's residual (f), the in-code comment.

**Deliberately NOT done:** the remaining P15 residuals ((a) the
OpenRouter-lane allowed_models-narrowing variant, (b) the per-family
usage-granularity residual, (c)/(e) the warn-threshold source decision)
stay queued — each is an operator/design decision, not a logging fix;
no composition-level wiring change (the default warn fires at the
existing createOpencodeRuntime call site, once per runtime
composition). Region note: the id gap is deliberate — W121 (and the
LESS-0044 slot, which the concurrent W120 stream's branch carried and
which has since merged as PR #114) left for that stream; this item
rebases onto main@d2fce29 so the docs tails splice in id order
(W120 → W122, LESS-0044 → LESS-0045 — LESS-0009).
