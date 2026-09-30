<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) — this is the record of the P8 vendor cache-marker probe HARNESS landing, not a landed live verdict. Write-once: append dated supersession notes, never rewrite. Park P8 and issue #287 stay OPEN, and P14/#293 stays blocked on P8 — the harness makes the live measurement runnable; it does not produce it. -->

### P8 - The vendor anthropic cache-marker probe HARNESS (Complete - the harness itself; the per-vendor live verdicts remain operator-gated/unrun) (issue #287 P8 + the P14/#293 dependency; gated probe test + docs, no production change) (2026-09-30)

**Source:** park P8 (docs/PARKED_AND_LIMITATIONS.md:37, operator-approved
2026-09-24): "whether the anthropic-compatible endpoints (deepseek/glm/kimi)
accept the Messages-schema `cache_control` markers — the W109 cache-marker
opt-in stays dark until per-vendor probes land," with the dependency column
naming "the HOST_ADAPTERS probe pattern." P8 gates P14 (docs/PARKED_AND_LIMITATIONS.md:43,
the cache-marker opt-in per-family granularity, issue #293) and the recorded
limitation L8 (docs/PARKED_AND_LIMITATIONS.md:61). The marker shape under probe
is the one `applyCacheMarkers` emits
(src/integrations/model-profile.ts:207-248): `{ type: "ephemeral" }` on the
system block and the last tool definition of an anthropic-wire body, messages
lane deliberately unmarked (the P13 boundary policy owns that decision).

**What landed (the harness):**

1. `test/vendor-anthropic-cache-probe.test.ts` — one gated probe file covering
   all three families, armed by `WORKFLOW_VENDOR_CACHE_PROBE=<family|list|all>`
   plus that family's key. It mirrors the ACP probe pattern: the gate and the
   key are checked at module load, each family arm carries its OWN named skip
   reason, and ungated/unkeyed runs make no network call, so CI never reaches a
   vendor. The live arm composes the request through the PRODUCTION marker pass
   (`modelProfile({ wire: "anthropic", cacheMarkers: true })` →
   `applyCacheMarkers`), POSTs it to the vendor's `anthropicEndpoint` +
   `/v1/messages` (base URLs from `VENDOR_DEFAULTS`,
   src/integrations/model-profile.ts:43-70), reads the response's `usage`, and
   PRINTS the observed shape (status, `cache_creation_input_tokens`,
   `cache_read_input_tokens`, `input_tokens`, `output_tokens`, response body).
   The committed assertions are STRUCTURAL ONLY: a live response must be a
   well-formed Messages body with numeric `usage`; the cache fields are
   OBSERVED, never asserted present or positive. A non-2xx fails the arm as a
   real live finding, but the file never asserts that a vendor accepts caching.
2. The ungated structural pin in the same file freezes the discriminator that
   survives the gate: for every family the composed body must carry the
   ephemeral marker on the system block and the last tool, and NO marker on the
   messages lane. A weakened request (a dropped or misplaced marker) goes red in
   the ordinary suite with no keys, so the gated path's structure cannot quietly
   rot. Red-first is not applicable to the gated assertions — with no keys and
   no gate nothing runs, so there is no red to earn; that is stated in the file
   header rather than manufactured.
3. A machine-readable register row: `vendor-anthropic-cache` in
   docs/PROBE_VERDICTS.json (`gate: WORKFLOW_VENDOR_CACHE_PROBE`, result
   `blocked`, posture `unqualified`, the missing per-vendor keys named in
   `blocker`), so `workflow doctor` renders the honest open state and the
   anti-drift test keeps the gate/file/write-up in lockstep.

**Run recipe (the operator's):**

```bash
# One family (deepseek), from the repo root with the key in the env:
WORKFLOW_VENDOR_CACHE_PROBE=deepseek DEEPSEEK_API_KEY=sk-… \
  node --import tsx --test test/vendor-anthropic-cache-probe.test.ts

# All keyed families (each unkeyed family skips with its own reason):
WORKFLOW_VENDOR_CACHE_PROBE=all \
  DEEPSEEK_API_KEY=… ZAI_API_KEY=… MOONSHOT_API_KEY=… \
  node --import tsx --test test/vendor-anthropic-cache-probe.test.ts
```

Keys resolve from env (`OPEN_MODEL_KEY_ENV`, src/integrations/open-model-keys.ts:15-19)
or from the 0600 `~/.config/workflow/<family>-api-key` file. The arm prints one
JSON block per family containing the request markers and the response's cache
usage — that block IS the measurement; copy it into the dated verdict.

**Where the per-vendor verdicts get recorded (proposal):** the register row is
the machine-readable layer, but it is intentionally `blocked` until a live run.
The human write-up belongs where the other live probe verdicts live
(`docs/HOST_ADAPTERS.md`, the "probe-gated, never date-gated" pattern): a new
section, **"Vendor anthropic cache-marker probes"**, with one dated row per
vendor family (family, model id, endpoint, the observed cache fields, accept /
reject / error, date) — not a separate sprawling doc. This fragment proposes
that section; it does not create it, because there is nothing live to write into
it yet. When the operator runs a family, the honest sequence is: run the arm,
paste its printed block into the new section, flip that family's register entry
from `blocked` to `green` (cache fields present, endpoint accepted) or `red`
(the endpoint rejected the marker/request), and advance the register stamp. Row
"vendor-anthropic-cache" is a single per-family-family row here for register
simplicity; if per-family rows are wanted, split it when the first verdict
lands.

**Evidence:** the gated probe file skips cleanly ungated (4 tests: 1 ungated
structural pass, 3 named skips) and under a family gate with no key the selected
arm skips with the key env named and the others with the selection reason —
shown in the session's gate transcript; repo `npm run lint` + `npm run
typecheck` exit 0. Docs-only elsewhere: no production change, the W109 opt-in
stays dark. P8/issue #287 and P14/issue #293 stay OPEN — the live verdicts
remain operator-gated and unrun.

> **Dated supersession note (2026-09-30, branch `feat/p8-lane-probe`, issue
> #287): the lane is RE-FRAMED and a generic provider lane was added.** The
> operator does NOT send production traffic with direct vendor API keys — it
> crosses a reseller/provider (Azure AI Foundry or OpenRouter)
> anthropic-compatible lane. The per-family arms above stay (they measure the
> vendor contracts themselves) but are NOT the deployed lane, and this fragment
> now says so. `test/vendor-anthropic-cache-probe.test.ts` gained the
> `provider` gate token plus `WORKFLOW_PROVIDER_ANTHROPIC_URL` /
> `WORKFLOW_PROVIDER_API_KEY` / `WORKFLOW_PROVIDER_MODEL`, sending the same
> marker-shaped anthropic body through the operator's reseller base URL; a
> second ungated structural pin freezes the provider lane's composed shape
> (unchanged from the direct arms — the lane reuses the production marker pass,
> so there was no shape change to earn a red-first on). Ungated, the file now
> reports 6 tests: 2 ungated structural passes + 4 named skips. Full record:
> `docs/ledger/P8p-provider-lane-probe.md`. The live per-lane verdicts remain
> UNRUN; P8/issue #287 stays OPEN.
