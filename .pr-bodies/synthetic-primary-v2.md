## Summary

Lands Synthetic as the PRIMARY metered upstream with automatic OpenRouter failover (W095 routing-policy key 4), rebased onto current `main`.

The work was developed on `feat/synthetic-primary-origin` and had drifted 124 commits, where upstream's NVIDIA egress wave (W179-W184) landed at the same proxy/runtime seams. The conflicts were resolved as unions so both features coexist.

- `src/integrations/synthetic-provider.ts` (new) — hosts, upstreams, key env/file names, `resolveMeteredLane` composition, `isFailoverStatus` (429/5xx), `fallbackBody` (`openrouter/auto`), structured logger. Pure policy, no IO.
- `src/integrations/model-usage-proxy.ts` — the `syntheticFailover` option, the once/pre-first-byte retry, the bounded failover journal; composed with the W179 credential gate, W180 payload/egress tier, W181 observation journal, W182 denial sink.
- `src/integrations/acp-runtime.ts`, `opencode-server-runtime.ts` — lane resolution at every metered seat (opencode, cline, goose, server), preserving the egress seams upstream added at the same call sites.
- `src/integrations/upstream-key.ts`, `src/ui/web.ts` — `syntheticKeyPresent` (env, auth store, key file) and the settings fact.
- `test/*` — `synthetic-provider` unit tests plus e2e/server/runtime coverage pins.
- `docs/FEATURES.md`, `docs/ledger/synthetic-primary-failover.md`, and the supersession notes in `docs/MODEL_ROUTING_POLICY_2026-09-23.md` / `docs/AFFINITY_ROUTING_SPEC_2026-09-24.md` / ledger fragments.

## Verification

- `npm run lint` -> exit 0
- `npm run typecheck` -> exit 0
- `npm run build` -> exit 0
- Focused battery (synthetic + egress + proxy + session-budget + runtime-context + compiled `e2e-settings`) -> 332/332 pass

## Review findings (P2, non-blocking, follow-ups)

The independent five-axis review returned ACCEPT (reviewer `reviewer-synthetic-primary-v2-r1`, fingerprint `af8d5fc0db77`), with two observability/security follow-ups:

- The W179 gate-2 credential binding is not re-checked on the fallback hop: `failoverRequest` injects `fallbackApiKey` to `config.fallback` without re-binding the endpoint.
- The reach observation records the primary `target.hostname` even when the request completes against the fallback.

Both are pre-existing to the Synthetic design (not introduced by the rebase) and are recorded here rather than bundled into this PR.

## Scope note

The RSI-loop housekeeping (`docs/agents/lessons.md`, `docs/agents/ledger.md`) and the NVIDIA adoption docs are intentionally NOT in this PR: `main` already carries its own LESS-0067/0068 and the NVIDIA docs, and the loop's lesson numbers would collide. Those stay on the original branch.

Closes nothing; tracks W095 key 4.
