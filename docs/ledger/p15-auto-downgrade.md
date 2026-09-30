<!-- Ledger fragment: opened 2026-09-30 on branch feat/p15-auto-downgrade as a post-freeze record (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### P15 part (a) - the OpenRouter-lane allowed_models-narrowing downgrade variant - composition verification (Already landed on origin/main - the four requested pins are green as-found; NO code change was required on this branch) (2026-09-30)

**Source:** the recorded backlog row P15 remaining part (a), GitHub issue #294,
dispatched as one executor subtask on branch `feat/p15-auto-downgrade`, base
`origin/main@77702361` (the P15a auto-lane variant + the P15 wiring-breadth +
the P19 affinity re-pin all precede this base). The dispatch asked for the
auto-router downgrade "composing with the affinity narrowing": budget is key 2,
affinity narrows WITHIN key 1, yields to budget, and re-pins at the downgrade
turn boundary (never mid-stream).

**As-found result (the honest headline): the subtask was already implemented
and merged before this branch.** The requested behavior is present at the base
pin and pinned by existing focused tests; this branch adds no production code
and no test code. The four requested red-first pins are green as-found:

| Requested pin | Where it is green (base tree) | Result |
|---|---|---|
| A warn tier narrows the injected list to the downgrade target | `test/budget-downgrade-auto-lane.test.ts` ("an active downgrade narrows the auto-router allowed_models to the target instead of rewriting the model") | 6/6 |
| The affinity re-pin fires at the downgrade boundary | `test/affinity-pin.test.ts` ("re-pin: an active budget downgrade re-pins the session to the target at the turn boundary") | 11/11 |
| The metering trail is unchanged | `test/budget-downgrade-auto-lane.test.ts` ("the metering trail records identically across the narrowing") | 6/6 |
| Default-off leaves the pool untouched | `test/budget-downgrade-auto-lane.test.ts` (malformed axes / no-seam fallback) + `test/affinity-pin.test.ts` (opt-in off, byte-as-found) | green |

**The landed implementation (origin/main, cited):**

- **The auto-lane narrowing** (`src/integrations/model-usage-proxy.ts:529-578`):
  when `aliasResolver !== undefined && isAutoRouterModel(parsed.model)` and the
  downgrade is active, `allowedModels = [downgrade.targetModel]` — the injected
  `allowed_models` narrows to exactly the target and the body `model` stays the
  router. Narrow-before-inject and resolver-independent (the target is
  operator-configured, not catalog-resolved, so a catalog outage cannot
  un-apply an active downgrade). Landed by `952e7f04` (P15a, merge `df416c05`,
  PR #352).
- **The W118 concrete-model rewrite stays** (`model-usage-proxy.ts:352-359`):
  on a concrete model the transformBody stage still rewrites `body.model`; the
  lane decides the enforcement shape. Landed by the W118 stage (`4b73e920`).
- **The affinity re-pin** (`model-usage-proxy.ts:538-542`): when the downgrade
  is active AND affinity is enabled, the pin re-pins to the target at the turn
  boundary with a logged `{ event: "re-pin", reason: "budget-downgrade" }`;
  budget (key 2) yields the affinity narrowing (within key 1). Landed by
  `c6768cd7` (P19 / issue #297, merge `7799006b`, PR #409).
- **The runtime wiring**: `src/integrations/acp-runtime.ts` and
  `src/integrations/opencode-server-runtime.ts` compose both the W118 downgrade
  and the autoLatest seam. The `opencode-server-runtime.ts` site landed by the
  P15 wiring-breadth task (`7ecc6b93`, merge `51902a5e`, PR #370).

**Precedence composition (as landed, per `docs/MODEL_ROUTING_POLICY_2026-09-23.md`
keys 1-4):** role/task-class (key 1) is the base pool; the affinity pin is a
one-slug narrowing WITHIN key 1; budget (key 2) YIELDS the pin and re-pins to
its target at the turn boundary; schedule (key 3) composes an off-peak pool's
own pin; failover (key 4) is the yield-to case and is NOT wired today. A
mid-stream model switch never happens: routing decisions apply at composition
time and at turn boundaries only. The metering pass-through posture is
unchanged — one metering path; the narrowing is a body-shape choice upstream of
the forwarding seam and the `usage: { include: true }` injection survives it.

**Evidence (this branch, base `origin/main@77702361`, working tree clean):**

- `test/budget-downgrade-auto-lane.test.ts` 6/6
- `test/affinity-pin.test.ts` 11/11
- `test/opencode-server-runtime-downgrade.test.ts` 4/4
- The combined focused battery (budget-downgrade-auto-lane + affinity-pin +
  model-usage-proxy + openrouter-auto-latest + opencode-server-runtime-downgrade
  + open-model-proxy + session-budget): **100/100**.
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Red-first capture (honest deviation): none.** The implementation and its pins
predate this branch, so there was no red state to capture without reverting
landed, merged work. The red-first discipline was satisfied by the original
landings (P15a captured 2 pass / 3 fail pre-change; the affinity re-pin was
pinned red-first by P19); this branch verifies them green rather than
re-deriving them. Capturing a synthetic red here would require deleting
production behavior, which is out of scope and would be dishonest.

**Deviation (recorded): the dispatch duplicated already-landed work.** Part (a)
was recorded landed in `docs/ledger/P15a-openrouter-downgrade.md` and the P15 row
before this branch was cut; this branch's tree is byte-identical to the base.
No duplicate implementation was written. The value added here is the
consolidated composition pin (budget-yields-affinity + re-pin) and this
verification record.

**Boundaries (remain, unchanged):** Cline/goose stay deliberately unwired per
the recorded W118 breadth boundary (Cline is probe-PENDING on stock 3.0.62); the
per-role settings axis (W095 key-1's role→model map) does not exist, so
`role`/`tier` are logged but do not select; failover (key 4) stays unwired; the
warn-threshold source (part c) is decided as option (a), the env axis
(`WORKFLOW_BUDGET_DOWNGRADE_FRACTION`, default 0.8). The P15 parts (b)/(c)
records stand in `docs/ledger/P15b-per-family-metrics.md` and
`docs/ledger/P15c-decision-recorded.md`.
