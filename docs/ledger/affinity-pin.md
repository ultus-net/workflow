<!-- Ledger fragment: opened 2026-09-30 as a post-freeze record (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### P19 - The affinity-routing implementation per the landed spec (Part landed - the pure pin + the one-slug narrowing + the default-OFF per-pool opt-in + the five pins; the per-role SETTINGS axis waits on W095 key-1) (2026-09-30)

**Source:** PARKED_AND_LIMITATIONS.md row P19, GitHub issue #297: implement
`docs/AFFINITY_ROUTING_SPEC_2026-09-24.md` §8 (the pure `affinityPin`, the
one-slug narrowing before the `allowed_models` injection, the opt-in flag, the
five pins). The operator chose the pin inputs = **per-(role, tier, settings)**
(the decided §9 answer).

**What landed (branch `feat/affinity-pin`, base `origin/main@08dcb8bd`; commit
to be linked — the tip is `c6768cd7`, named in the dated note at the foot of
this fragment):**

- **The pure pin** (`src/integrations/openrouter-auto-latest.ts`):
  `affinityPin(role, tier, configuredAliases) -> slug` returns the FIRST alias
  in **CONFIGURED** order — never the first *resolved* slug — so a partial
  catalog outage cannot silently re-point the pin at a later alias. It is
  deterministic and restart-stable: the same configured aliases pin the same
  slug across processes. `role`/`tier` are the declared inputs and are logged,
  but they do not yet select (see the key-1 wait below).
- **The one-slug narrowing** (`narrowToAffinityPin`): the resolved pool is
  filtered to the pinned slug BEFORE the `allowed_models` injection
  (`src/integrations/model-usage-proxy.ts`). The resolver gained
  `resolvePairs()` (alias→slug, configured order, shared cache) so the pin can
  honour configured order under a partial outage without a second catalog
  fetch. **OpenRouter lane only**; the open-source-pool lane needs no work.
- **The default-OFF opt-in** (`WORKFLOW_OPENROUTER_AUTO_AFFINITY`, per pool):
  absent/disabled leaves the pool un-narrowed (byte-as-found). Optional
  `_ROLE`/`_TIER` labels ride the pin/re-pin/degradation events through the new
  `affinity.onEvent` sink; the env opt-in composes a `console.error` default
  sink, so events are logged in production.
- **The five pins** (`test/affinity-pin.test.ts`, NEW, red-first): determinism
  (pure + restart-stable across two proxies); DEGRADED-RESOLVER (an
  unresolvable pinned alias leaves the pin ABSENT and free-routes the resolved
  pool + a degradation event; a fail-open `[]` injects nothing + a degradation
  event); re-pin (an active budget downgrade re-pins to its target at the turn
  boundary + a logged re-pin); narrowing (the injected list is exactly one
  slug); unchanged-metering (the trail records every request identically across
  the narrowing).

**Red-first capture (verbatim, base tree):**

```
# /var/home/hunter/Documents/projects/personal/Workflow/.wave/affinity-pin/test/affinity-pin.test.ts:7
#   affinityPin,
#   ^
# SyntaxError: The requested module '../src/integrations/openrouter-auto-latest.js' does not provide an export named 'affinityPin'
#     at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)
#     at async ModuleJob.run (node:internal/modules/esm/module_job:335:17)
1..1
# pass 0
# fail 1
```

**Green:** `test/affinity-pin.test.ts` 11/11; the five focused suites
(affinity-pin + openrouter-auto-latest + model-usage-proxy +
budget-downgrade-auto-lane + opencode-server-runtime-downgrade) **70/70**;
`npm run lint` exit 0; `npm run typecheck` exit 0 unpiped.

**The pin-input shape landed:** `affinityPin(role, tier, configuredAliases)`
returns the first configured alias, and the proxy narrows the resolved pool to
that alias's concrete slug. The settings axis is the existing per-runtime
`autoLatest.aliases` option (the only composition-time anchor that exists
today), not a new mechanism.

**What waits for key-1 (honest boundary):** the per-role **settings axis**
(spec §8 item 3 / §5) is NOT wired. W095 key-1's role→model map does not exist
— `opencode-agent-config.ts` composes ONE model per launch and the routing
note records the map in future tense — so there is no per-role entry to hang
the opt-in on. `role`/`tier` are accepted and logged but do not select a
different alias until that map lands. The opt-in is therefore per **pool**
(the `autoLatest` config / env), which is the operator-accessible half today.

**Recorded costs and coverage (spec §3/§4/§5):**

- **Never mid-stream.** The narrowing is a composition-time body choice, like
  the role assignment it modifies; a mid-stream model switch still never
  happens. Re-pins land only at turn boundaries.
- **Outage persistence.** Narrowing `allowed_models` to one slug REMOVES
  OpenRouter's own cross-vendor reroute for the session; key 4 (failover) is
  NOT wired, so a pinned vendor's outage persists to the turn boundary — and,
  with no wired failover, potentially the whole session. The sharpest cost of
  the pin, on the tradeoff ledger by design.
- **Open-lane no-op coverage note.** The `open-source-pool.ts` substrate is
  already maximally pinned (one family per proxy, one composed model per
  launch) and the topology-daemon surface wires no `autoLatest` option, so this
  spec's surface coverage is the OpenRouter-lane proxies; no open-lane work.

**Deviations (recorded honestly):**

- The dispatch named `src/integrations/model-routing-policy.ts` as the
  "precedence context" file. **No such file exists** in the tree (the
  precedence context lives in `docs/MODEL_ROUTING_POLICY_2026-09-23.md` and the
  proxy's in-code comments). Rather than invent a dead module, the precedence
  context is recorded as a comment at the narrowing site in
  `model-usage-proxy.ts` and here; no `model-routing-policy.ts` was created.
- The `affinityPin` return is the **pinned alias** (the configured first
  alias), not a catalog-resolved concrete slug; the concrete slug is derived
  from `resolvePairs()` at the injection site. This keeps the function pure
  (no IO) per §8 item 1.

**Boundaries (remains):** the per-role settings axis (key-1); the live
cache-hit measurement (P11) stays `unmeasured` until P12's fields are consumed
downstream; the failover backstop (key 4) stays unwired; the §9 restart /
alias-drift semantics stand as specced (pin the resolved slug, drift recorded).

> **Dated note (2026-09-30, branch `feat/harvest-7`): the "commit to be linked"
> placeholder above is `c6768cd7`.** The affinity-pin P3 (`guard_review_followups`,
> commit `c6768cd7807857e8e3d8169895f8a6ebaeebd342`) recorded that the fragment
> said "commit to be linked" where the pushed tip is `c6768cd7` — cosmetic, no
> behavior. The write-once body is left as authored (this fragment's own rule);
> the reference is corrected here in an appended note rather than rewritten in
> place. No code or test change.
