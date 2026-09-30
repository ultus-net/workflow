<!-- Ledger fragment: opened 2026-09-30 as the P15 wiring-breadth record (issue #294). Write-once — append dated supersession notes, never rewrite. -->

### P15 — wiring breadth (Landed — the W118 downgrade + the P15(a) auto-lane narrowing are now composed into the opencode-server-runtime proxy; Cline/goose stay deliberately unwired per the recorded probe/breadth boundary) (2026-09-30)

**Source:** `docs/PARKED_AND_LIMITATIONS.md` row P15 ("the downgrade wiring breadth stays queued per W118's recorded boundary — Cline, goose, AND the `opencode-server-runtime.ts` proxy site (recorded by the review round)"), GitHub issue #294. Predecessors: the W118 downgrade consumer (`feat/p15a-downgrade`, P15 part (a)'s ledger fragment) wired `createOpencodeRuntime` but left the server-runtime proxy site uncomposed; the review round recorded it as the THIRD unwired site.

**What landed (branch `feat/p15-wiring-breadth`, PR to be linked at open):**

- **The server-runtime proxy composes the W118 downgrade** (`src/integrations/opencode-server-runtime.ts`): `createOpencodeServerRuntime` now parses the same env axes the ACP lane composes (`budgetDowngradeFromEnv()` + `sessionBudgetFromEnv()`, the downgrade additionally gated on caps existing) and hands `budgetDowngrade` to the proxy factory. The malformed-axis posture is the W122 fail-closed-to-undefined parse — a broken fraction/warn axis composes NO downgrade, the safe direction, never an unenforced or partially-applied one.
- **The autoLatest seam is composed proxy-side too** (same file): previously parsed only for the config-side alias catalog (the model picker), `autoLatestConfigFromEnv` now also feeds the proxy, so the P15(a) narrowing applies on this lane: an active downgrade on an auto-router request narrows the injected `allowed_models` to the target (narrow-before-inject, resolver-independent) instead of switching the session off the router; a concrete-model request keeps the W118 body rewrite. The composition is named once (`OpencodeServerProxyInput`) so the runtime call site and the injectable factory cannot drift.
- **Cline/goose deliberately unwired (assessed, not silently widened).** `createClineRuntime` (`acp-runtime.ts:483`) already composes the autoLatest seam, so the same composition would apply structurally; `createGooseRuntime` (`acp-runtime.ts:655`) composes neither and is provider-conditional (azure_foundry runs no local proxy). The blocker to wiring them is the RECORDED boundary, not a technical gap: Cline is probe-PENDING on stock 3.0.62 (AGENTS.md; a probe-gated surface whose claims are capped `advisory` until re-probed) and W118 recorded the Cline/goose wiring breadth as queued. They stay queued and recorded.
- **Docs:** the P15 row's dated append-only note (what is now wired, what remains + why); the P15a fragment's dated supersession note correcting its stale "server-runtime composes neither" boundary.

**Evidence:**

- Red-first: `test/opencode-server-runtime-downgrade.test.ts` captured verbatim against unmodified src — `4 tests / 0 pass / 4 fail` (composition absent: `budgetDowngrade` and proxy-side `autoLatest` both `undefined`; the replayed proxy therefore failed to narrow). Green after the implementation: 4/4.
- The seven focused suites (`opencode-server-runtime-downgrade` + `budget-downgrade-auto-lane` + `session-budget` + `open-model-proxy` + `model-usage-proxy` + `openrouter-auto-latest` + `opencode-server-runtime`): **77/77 pass, 0 fail, 0 skipped**.
- Pins: the composition carries the exact axes + budget; no caps → no downgrade; a malformed fraction → no downgrade; the replayed composed proxy narrows the auto lane (stays on the router, `allowed_models: [target]`) and rewrites the concrete lane; the metering trail is unchanged across the narrowing and the `usage.include` request survives.
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Boundaries (remains):** Cline and goose stay unwired per the recorded breadth + Cline's probe-PENDING status; P15 (c) the warn-threshold source decision stays design-open. Nothing else in P15 is open.
