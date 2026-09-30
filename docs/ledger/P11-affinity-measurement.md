<!-- Ledger fragment: authored directly as the record of the FIRST live P11 (#290) with/without-affinity cache measurement. The result is a NON-EFFECT for the observed pool; per the recipe §5 the P11 row stays `unmeasured` and this is a dated note, appended, never a rewrite. -->

### P11 - the with/without-affinity cache measurement (RUN; verdict NEGATIVE/non-effect for the observed pool) (issue #290 P11; gated probe + docs, no production change) (2026-09-30)

**Source:** issue #290 / park P11 (`docs/PARKED_AND_LIMITATIONS.md:40`), the
runbook `docs/P11_AFFINITY_MEASUREMENT_RECIPE.md` (§3 the matched pair, §5 the
verdict mapping, §6 the watch items), and the landed P19 affinity pin (env
opt-in `WORKFLOW_OPENROUTER_AUTO_AFFINITY`, PR #409) plus the landed metered
OpenCode-v2 lane (PRs #427/#428). This is the live run the recipe names; it
records the observed cache fields on matched arms and makes no fleet claim.

**The instrument:** `test/affinity-measurement-probe.test.ts`, gated by
`WORKFLOW_AFFINITY_MEASUREMENT=1` (ungated: 1 structural pin runs, the two live
arms skip with a named reason, no network). It reuses the metered OpenCode lane
(`test/acp-opencode-metered-probe.test.ts`: the hub proxy + hub-written
`XDG_CONFIG_HOME` config + `launchContainedAcpAgent`), drives TWO sequential
prompts on ONE OpenCode session, and runs the pair twice:

- **Arm "without"** - the `WORKFLOW_OPENROUTER_AUTO_AFFINITY` env opt-in
  stripped: the default free-route, the full resolved pool injected.
- **Arm "with"** - the env opt-in set (`=1`, role `rsi`): the resolved pool is
  narrowed to the FIRST configured alias's slug before injection.

Each arm uses a **unique per-arm prefix nonce**, so a turn-2 cache read can only
be a within-arm read (never provider cache left by the other arm or an earlier
run). The probe reads the cache accounting through several seams crossed
through the hub proxy:

1. `proxy.metrics()` `cacheReadTokens`/`cacheCreateTokens` (the recipe §2 named
   seam);
2. the proxy's raw per-response usage records (`onUsage`), reading the
   OpenAI-lane `prompt_tokens_details.cached_tokens`;
3. the ACP per-turn prompt result's `usage` (opencode's projection, e.g.
   `cachedReadTokens`);
4. a **recording upstream** in front of OpenRouter, capturing the injected
   `allowed_models` per request AND the concrete served `model`/`provider` from
   the response body (the recipe §3/§6 "resolved slug/model per arm" and the
   §6 injection-narrowing confirmation).

**Why seams 2-4 are load-bearing:** the deployed OpenCode lane speaks the
OpenAI-shaped chat-completions protocol (`openrouter/openrouter/auto` via
`@ai-sdk/openai-compatible`). The proxy's first-class cache fields are the
ANTHROPIC Messages-lane extraction; on the OpenAI lane cached reads ride
`prompt_tokens` and the proxy's `cacheReadTokens`/`cacheCreateTokens` stay at
their W123-recorded zero. Reading only `proxy.metrics()` would therefore show
`0/0` on both arms and manufacture a false non-effect. The provider's own
per-response `prompt_tokens_details.cached_tokens` is the reachable accounting.

**The two runs (live, 2026-09-30, OpenCode v2.0.10, upstream
`https://openrouter.ai`; the Auto Router pool = the 18 default
`~<lab>/<model>-latest` aliases, first `~anthropic/claude-opus-latest` ->
`anthropic/claude-opus-5.5`).**

Pool resolved (18 slugs, both arms identical): `anthropic/claude-opus-5.5`,
`anthropic/claude-sonnet-5.5`, `anthropic/claude-haiku-4.5`,
`anthropic/claude-fable-5.1`, `openai/gpt-6-astra`, `openai/gpt-6.1-sol`,
`openai/gpt-5.6-terra`, `openai/gpt-6-luna`, `openai/gpt-5.4-mini`,
`google/gemini-3.1-pro-preview`, `google/gemini-3.8-flash`, `x-ai/grok-4.7`,
`deepseek/deepseek-v4-pro-0813`, `deepseek/deepseek-v4.1-flash`,
`deepseek/deepseek-v4-flash-0731`, `z-ai/glm-5.3`, `z-ai/glm-5.3-flash`,
`moonshotai/kimi-k3`.

| Pool (role/tier) | Arm | Injected `allowed_models` | Served model (provider) | Turn | `cacheCreateTokens` (proxy) | `cacheReadTokens` (proxy) | provider `cached_tokens` | ACP `cachedReadTokens` | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| default 18-alias pool / rsi | without (free-route) | 18 slugs | `deepseek/deepseek-v4.1-flash` (Together) | 1 | 0 | 0 | 256 | 256 | baseline |
| default 18-alias pool / rsi | without (free-route) | 18 slugs | `deepseek/deepseek-v4.1-flash` (Together) | 2 | 0 | 0 | **12032** | **12032** | baseline |
| default 18-alias pool / rsi | with (pinned) | `[anthropic/claude-opus-5.5]` | `anthropic/claude-opus-5.5` (Azure) | 1 | 0 | 0 | 0 | - | - |
| default 18-alias pool / rsi | with (pinned) | `[anthropic/claude-opus-5.5]` | `anthropic/claude-opus-5.5` (Azure) | 2 | 0 | 0 | **0** | - | **negative/non-effect** |

Raw per-request provider usage (the main `openrouter/auto` call per turn; the
turn also carries a title/summary call on opencode's internal
`openai/gpt-5.6-luna-pro`, which bypasses the Auto Router and is not the
treatment):

```text
without turn1 main: prompt=12034 completion=5 total=12039 cached=256   cache_write=0
without turn2 main: prompt=12067 completion=5 total=12072 cached=12032 cache_write=0
with    turn1 main: prompt=19585 completion=9 total=19594 cached=0     cache_write=0
with    turn2 main: prompt=19632 completion=9 total=19641 cached=0     cache_write=0
```

Treatment validity (recipe §6) was CONFIRMED, not assumed: the pinned arm's
injected `allowed_models` was exactly `[anthropic/claude-opus-5.5]` on every
Auto Router request, the baseline's was the full 18-slug pool, and the pin
event (`{event:"pin", slug:"anthropic/claude-opus-5.5"}`) was logged with no
degradation.

**Verdict: `negative` / honest NON-EFFECT for this observed pool.** The pinned
arm's turn-2 read (`0`) is NOT greater than the baseline's (`12032`); per the
recipe §5 mapping this is a non-effect, so the pool stays **`unmeasured`** and
the P11 row's verification status is NOT advanced. Recording it honestly: on
this account the DEFAULT free-route already served ONE model
(`deepseek/deepseek-v4.1-flash` via Together) on both turns and read the shared
prefix on turn 2, while the pin moved the session to `anthropic/claude-opus-5.5`
(via Azure), which returned zero cached reads on both turns. The affinity pin
therefore bought no read delta here; it removed the read the free-route was
already getting.

**Honest caveats (do not extrapolate):**

- **This is one observation, not a rate.** Both arms ran once; the recipe says
  one observation is not a rate. The verdict is scoped to this pool + this
  account + these two turns.
- **The pin changed the served MODEL, so the comparison is not a same-model
  A/B.** The spec's pin targets the FIRST configured alias
  (`~anthropic/claude-opus-latest` -> `anthropic/claude-opus-5.5`); the
  free-route's price-driven choice was `deepseek/deepseek-v4.1-flash`. The
  measured difference is entangled with each model/provider's own cache
  support (Together vs Azure), not only with "pin vs no pin". This is the
  behavior of the pin AS CONFIGURED, and it is recorded as such.
- **The free-route already served one vendor/model per session** on this
  account (same served model both turns, confirmed by the recording upstream),
  which is exactly the non-effect case the recipe §6 anticipates ("the route
  may already serve one vendor per session"). A different pool or a
  price/health state that bounces the free-route could differ.
- **The recipe §6 static-prefix caveat stands.** Affinity without the W109
  per-turn boundary policy saves the static head only; here the OpenAI lane
  appeared to cache the growing conversation too (turn-2 read ~ the whole
  prompt), but that is an OBSERVATION on this lane, not a governed claim, and
  the anthropic-marker lane's static-only slice is a different surface.
- **Observability, not enforcement.** The proxy's first-class cache fields read
  `0/0` on this lane (W123: the OpenAI-lane `prompt_tokens_details` split is the
  named queued refinement); the read comes from the provider usage / opencode
  projection / the recording upstream. A green or red here makes no authority
  claim and enables/disables no routing behavior.

**Evidence:**

- Live: `WORKFLOW_AFFINITY_MEASUREMENT=1 node --import tsx --test
  test/affinity-measurement-probe.test.ts` -> `# tests 3 / # pass 3 / # fail 0`
  (1 ungated structural pin + both live arms; the narrowing assertions passed,
  confirming the treatment).
- Ungated: `node --import tsx --test test/affinity-measurement-probe.test.ts`
  -> `# tests 3 / # pass 1 / # fail 0 / # skipped 2` (the live arms skip with
  `WORKFLOW_AFFINITY_MEASUREMENT is unset`; no network).
- No regression: `WORKFLOW_ACP_OPENCODE_METERED=1 node --import tsx --test
  test/acp-opencode-metered-probe.test.ts` -> `# tests 1 / # pass 1 / # fail 0`.
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Boundaries (remain):** this is a partial run (one pool, one observation), so
it never widens to pools it did not measure. P11 / issue #290 stays OPEN and the
row stays `unmeasured`; no savings claim is earned. P13 (the W109 per-turn
boundary policy) is a separate governor. No production change.
