# Model-routing policy — the local router position (2026-09-23)

> Purpose: W095's first acceptance criterion — the routing-policy design
> note answering the operator's mixture-of-experts question ("classify
> things before handing them to OpenRouter?") before any routing code.
> Bases: Workflow `origin/main@78eb839` (PRs #76–#84 merged). Companion:
> `TASKS.md` W095 (the recorded position), `src/integrations/model-profile.
> ts` (the class/effort machinery), `src/integrations/model-usage-proxy.ts`
> + `openrouter-auto-latest.ts` (the per-request transform seam),
> `src/integrations/hub-scheduler.ts` + `off-peak.ts` (the schedule
> machinery), `assets/opencode-fleet/agents/*` (the roles),
> `docs/CONTROL_PLANE_MIGRATION_BOUNDARY_2026-09-22.md` §1 (the four-home
> rule). External verification: frontier critique (Kimi K3, fresh context,
> adversarial) — §7; findings and dispositions in §8.

## 1. The verified starting state (what exists today)

- **The fleet roles exist; per-role model assignment does not.** The four
  fleet agents (`decompose`, `executor`, `reviewer`, `retrospective`) carry
  roles and their docs prescribe model strength per role (decompose writes
  specs "a cheap model can complete mechanically"; reviewer is the
  acceptance-check giver), but **no mechanism assigns a model per role** —
  sessions run the composed default (the open-source pool's first entry
  when composed, else `openrouter/auto`). The fleet's own doc states the
  design outright: "No agent pins a model — routing is upstream — so tiers
  are role assignments, not hardcoded IDs." The de-facto MoE is
  operator-manual.
- **The class machinery exists**: `model-profile.ts` carries
  `ModelTaskClass` (coding/general/batch), per-family vendor defaults
  (deepseek/glm/kimi: wires, endpoints, thinking modes), and per-class
  reasoning-effort defaults (coding→strongest, general→vendor default,
  batch→low, with the off-peak pairing documented in-code).
- **The schedule machinery exists**: the hub scheduler carries per-schedule
  budget and **off-peak vendor windows** (`off-peak.ts`, W070a) — batch
  work can already be *time*-constrained to discounted windows.
- **The per-request transform seam exists**: the metering proxy is a
  loopback pass-through holding the real key, with bounded deviations
  from pure pass-through already shipped — the autoLatest plugin injection (`openrouter-auto-latest.ts` resolves `~lab/model-latest`
  aliases against the public catalog and injects the resolved pool as an
  `allowed_models` constraint before forwarding), the W070a `transformBody`
  model-profile shaping, the W070b replay policy, and — since W109
  (2026-09-23, after this note's base) — the W098 c2 cache-marker pass
  (`applyCacheMarkers`, composed through the `transformBody` seam;
  opt-in per pool, wire-gated). It already
  *constrains* OpenRouter's own router deterministically. (Enumeration
  scope: ROUTING/POLICY deviations — the `usage: {include: true}`
  injection is the proxy's declared metering function itself, not a
  policy transform, and is not counted. Count current as of the W109
  merge; supersession recorded in §8.)
- **The budget machinery exists**: per-session caps (`session-budget.ts`,
  W045) abort turns on violation — today they stop work; they do not
  *downgrade* it.

## 2. The position

**The mixture-of-experts is the fleet's task decomposition, and the router
should make its model assignments declarative — not classify prompt
content per request.** Concretely, four routing keys, in precedence order:

| # | Key | Decides | Source (already exists) | Mechanism |
|---|---|---|---|---|
| 1 | **Role / task-class** | which pool a session's model is drawn from: decompose/review → strong pool; **executor → cheap pool (the fleet's declared cheap-tier role — strong-only subtasks stay on the decompose/primary tier by fleet design, `executor.md` frontmatter + `decompose.md` `tier: cheap | strong-only` output labels)**; retrospective/batch → cheap pool | the fleet roles + the decomposer's tier labels; `ModelTaskClass` | **composition-time**: per-role model assignment in the hub-written agent config (`opencode-agent-config.ts` gains a role→model map; settings-overridable) |
| 2 | **Budget** | downgrade at turn boundaries: a session nearing its caps routes remaining turns to the cheap pool (the W045 caps stop *aborting* work first; downgrade is the softer middle step before abort) | `session-budget.ts` (warn-tier threshold source design-open: env axis or cap fraction; the
      server-path budget watcher is global across sessions - per-session
      downgrade applies to the interactive/launch path) | **turn-boundary**: the session-budget watcher proposes the downgrade; enforcement is a body-`model` rewrite at the proxy's `transformBody` seam (NOT the `allowed_models` injection — that fires only for auto-router model sessions) |
| 3 | **Schedule** | batch/CI work routes to off-peak windows and their discounted vendors | `off-peak.ts` (W070a) | **composition/schedule-time**: the scheduler already time-constrains; batch pools join the same field |
| 4 | **Failover** | an upstream failure routes to the fallback pool | **partially exists**: `open-source-pool.ts` declares pools with verified per-family OpenRouter fallbacks and `resolveOpenModelRoute` encodes the direct-first/fallback policy - but it is **not yet wired** (zero callers; `open-model-proxy.ts` skips no-key families rather than rerouting them) | **per-request at the proxy**: on upstream failure-class responses (pre-first-byte; SSE mid-stream failures surface as errors — recorded), retry the next pool before surfacing |

Precedence: role assignment is the base; budget *downgrades within* the
role's pool tier; schedule *shifts time* for batch work; failover overrides
only on upstream failure. A mid-stream model switch never happens — routing
decisions apply at composition time and at turn boundaries.

## 3. The unit of routing is the session/role, not the request

The operator's "classify things before handing them to OpenRouter" is right
about *where the decision should live* (local, ours, auditable) and wrong
about *its granularity*: a per-request content classifier re-derives —
worse, and unreviewably — what the decomposition already decided. The
classification that matters is the **task decomposition itself** (the
working MoE: roles are the experts; the acceptance-check discipline is the
mis-route backstop). The router's job is to make those assignments
declarative and to react to budget/schedule/failure state at boundaries —
all rule-based, testable, logged (HOME-A/B per the migration-boundary rule:
routing policy that gates cost and quality authority is control-plane
owned; the model-selection *quality* for general traffic stays with
OpenRouter's Auto, which the hub constrains but does not duplicate).

## 4. The seam

- **Composition-time (primary)**: `opencode-agent-config.ts` gains a
  role→model map (settings key; pool references resolved against
  `open-source-pool.ts` — the pool substrate, not `model-profile.ts`,
  which carries classes/effort/vendor defaults only). The fleet's four
  roles are the first consumers. No proxy change needed for this half —
  the model id is simply composed per role.
- **Boundary/turn-time (secondary)**: the session-budget watcher gains a
  downgrade proposal (caps → warn tier before the abort tier). Enforcement
  note (round-1 P2): the existing `allowed_models` injection fires only
  for auto-router model sessions; downgrade enforcement for concrete pool
  models is a body-`model` rewrite at the proxy's `transformBody` seam —
  the FIFTH bounded deviation from pure pass-through (after the autoLatest
  plugin injection, the W070a `transformBody` profile shaping, the W070b
  replay policy, and the W098 c2 cache-marker pass) and the THIRD consumer
  of that seam (corrected 2026-09-24 in round 3: W109's cache-marker pass
  became the second consumer after this note's base — the model-usage-
  proxy's own W109 header comment already enumerates it that way).
- **Per-request (failover only)**: upstream failure-class responses
  (pre-first-byte) retry the fallback pool once before surfacing the
  error — the same transform point as the alias seam; SSE mid-stream
  failures surface as errors (recorded limitation). Pass-through posture
  preserved for everything else.

## 5. Rejected, residuals

- **Rejected: per-request prompt-content classification** (the literal
  "classify before OpenRouter" reading) — duplicates the vendor router,
  adds a model call per request, blurs the proxy's pass-through posture,
  and its errors are quality-authority errors caught only after the fact.
  Revisit only if OpenRouter Auto becomes unavailable or demonstrably
  worse than a local classifier at equal cost.
- **Residuals**: model quality is not the hub's to guarantee — the
  acceptance-check discipline remains the quality gate for cheap-pool
  output; role→model assignments are operator-tunable and wrong assignments
  are a config risk (settings-validated against the `open-source-pool.ts`
  pool substrate);
  budget downgrades change model mid-task at turn boundaries — the
  acceptance checks run on the downgraded model's output by design (that is
  the cost/quality tradeoff, recorded).

## 6. Verification

Frontier critique (Kimi K3, fresh context, read-only, adversarial): falsify
the table, the precedence, the seam placement, and the "de-facto MoE is
operator-manual" starting-state claim; name missed machinery; state whether
any routing key is over- or under-powered. Dispositions in §8; the durable
verdict binding is `record_review`.

## 7. Frontier round record (Kimi K3)

**Round 1 — REVISE** (the thesis survives falsification; the seam section
pointed at the wrong machinery):

- **P1 — row 1 overpromised granularity its own mechanism forbids:**
  "executor per subtask class → strong-or-mid" paired with a
  composition-time per-role map is internally tense (one model per
  session). The fleet's actual architecture resolves it differently:
  `executor.md` declares the cheap-tier role and `task-decomposition.md`'s
  `tier: cheap | strong-only` labels select which ROLE gets the subtask
  (strong-only stays on the decompose/primary tier). Corrected to the
  fleet design. Strongest-objection check: "your router doesn't route —
  rows 1/3 are config OpenCode already supports; row 4 is a stub; row 2's
  enforcement provably doesn't fire for the concrete models row 1 pins" —
  the doc survives it (declarative role-level config IS the position) but
  only after the seam corrections below.
- **P2 — missed machinery: `open-source-pool.ts` is the pool substrate and
  already fails over** (`DEFAULT_OPEN_SOURCE_POOL` with per-family
  fallbacks; `resolveOpenModelRoute` routes no-key families through the
  OpenRouter fallback today via `open-model-proxy.ts`). Row 4's "new
  (small)" corrected to "partially exists"; §4/§5's
  `model-profile.ts`-as-pool-substrate miscites corrected (it carries
  classes/effort/vendor defaults, no pools).
- **P2 — the budget-downgrade enforcement seam didn't reach the models
  row 1 composes:** the `allowed_models` injection fires only for
  auto-router model sessions (`isAutoRouterModel`); downgrade enforcement
  for concrete pool models is a body-`model` rewrite at the proxy's
  `transformBody` seam — named (the third bounded deviation from pure
  pass-through, alongside the autoLatest injection and the W070b replay
  policy; "one working transform precedent" understated the history).
- **P3 — accepted:** the stale composed-default detail corrected
  (open-source pool first entry when composed); the general→effort nit
  (exact only for deepseek); the failover row now records the SSE
  mid-stream limitation; the warn-tier threshold source marked design-open
  (env axis or cap fraction) and the server-path budget watcher's
  global-vs-per-session distinction noted for the design note's next
  revision.

## 8. Dispositions

All round-1 findings accepted and incorporated (the corrections are
text-level; the correct modules and precedents existed and are now cited).
**Round 2 - REVISE** (five round-1 corrections verified landed; the reviewer self-corrected one of its own round-1 claims - the resolveOpenModelRoute failover wiring it asserted does not exist: zero callers, no-key families are skipped not rerouted - and the revision had faithfully incorporated that error): row 4 evidence cell corrected to the honest state (open-source-pool.ts declares pools with verified fallbacks; resolveOpenModelRoute encodes the policy but is NOT wired); the section-1 transform-seed sentence repaired after a partial edit application (the quantifier said one while listing three - the half-applied state the round-2 review caught); row 1 tier-label cite corrected to decompose.md (the output spec); row 2 server-path budget-watcher globality recorded in row 2 itself; the section-4 deviation-count corrected (third -> FOURTH bounded deviation, second transformBody consumer).

**Round 3 - REVISE (2026-09-24; the stated scope ran: the diff-check
confirmation of the round-2 repairs) — all four round-2 repairs
confirmed against the tree:** (1) the repaired transform-seed sentence
(§1's quantifier now matches its list); (2) row 4's honest unwired state
(`resolveOpenModelRoute` still has ZERO production callers — grep
re-verified; no-key families skipped, never rerouted); (3) row 1's
tier-label cite lands on `decompose.md:45`'s `tier: cheap | strong-only`
output spec; (4) row 2's server-path globality note accurate
(opencode-server-budget.ts aborts every known session + sticky
broker-wide denial — global; the interactive path composes the
per-session guard). **Two new findings, accepted and incorporated:**
(P2) the deviation counts were STALE post-W109 — the W098 c2
cache-marker pass (`applyCacheMarkers`, composed via `transformBody`)
is a fourth shipped body-transform deviation and the seam's SECOND
consumer, so the budget-downgrade rewrite is the FIFTH deviation and
THIRD consumer (the model-usage-proxy's own W109 header comment
enumerates it that way — the doc's count predated the W109 merge and
the base pin 78eb839 makes the staleness attributable); §1 and §4
corrected with the dated supersession. (P3) the enumeration boundary
clarified: the `usage: {include: true}` injection is the proxy's
declared metering function itself, not a policy transform, and is not
counted (§1's scope half-sentence added). Verdict: the note's
substance survived; the counts are now current as of the W109 merge.

**Round 3 verdict binding:** the criterion's "frontier-verified" state
is reached — W095 criterion 1 ticks with this record.
