<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) - this is the record of the P8 turnkey live-run RECIPE landing, not a landed live verdict. Write-once: append dated supersession notes, never rewrite. Park P8 and issue #287 stay OPEN - the live run is the operator's. -->

### P8r - the operator's turnkey live-run recipe (Complete - the recipe itself; the live per-lane verdicts remain operator-gated/unrun) (issue #287 P8; docs-only, no production change) (2026-09-30)

**Source:** P8 (docs/PARKED_AND_LIMITATIONS.md:37, L8 at :61) and issue #287,
after the harness (`docs/ledger/P8-vendor-cache-probe-harness.md`) and the
provider-lane re-frame (`docs/ledger/P8p-provider-lane-probe.md`). Those two
fragments carried the run recipe inside their landing records; this fragment
records collapsing it into one operator-facing runbook so the live run is
turnkey: one copy-paste block, the exact read of the output, the recording
templates, and the watch items in one place.

**What landed (docs only):**

1. `docs/P8_LIVE_RUN_RECIPE.md` - the operator runbook. It carries:
   - **One copy-paste block** for the DEPLOYED provider lane
     (`WORKFLOW_VENDOR_CACHE_PROBE=provider` +
     `WORKFLOW_PROVIDER_ANTHROPIC_URL` / `WORKFLOW_PROVIDER_API_KEY` /
     `WORKFLOW_PROVIDER_MODEL`) with the direct per-family arms
     (`WORKFLOW_VENDOR_CACHE_PROBE=all` + family keys) commented alongside;
   - **What to read**: the marker-placement assertion (the printed
     `request.systemMarker` / `lastToolMarker` / `boundaryMarker` must each be
     the ephemeral marker; the composed shape itself is frozen by the ungated
     pins) and the response's `cacheUsage` fields
     (`cache_creation_input_tokens` / `cache_read_input_tokens` /
     `input_tokens` / `output_tokens`, observed never asserted);
   - **The verdict-record templates**: the `docs/PROBE_VERDICTS.json` row
     shape with the green/negative/red/blocked mapping (posture `advisory`),
     and the `docs/HOST_ADAPTERS.md` "Vendor anthropic cache-marker probes"
     short write-up;
   - **The watch items**: the provider arm's dual auth header (a non-2xx must
     NOT be recorded as a marker red; replay with only the expected header
     first) and the P13 boundary marker now recorded (issue #292).
2. The register row `vendor-anthropic-cache` gained `docs/P8_LIVE_RUN_RECIPE.md`
   as a cited evidence path, so `workflow doctor` and the anti-drift test
   resolve the runbook. The row's `result` / `posture` are UNCHANGED:
   `blocked` / `unqualified` until a live run.
3. The P8 row (docs/PARKED_AND_LIMITATIONS.md:37) gained the dated run-recipe
   note.

**Evidence:**

- Docs-only: `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped);
  state not applicable (no code path).
- The register anti-drift test
  (`node --import tsx --test test/probe-verdict-register.test.ts`) resolves the
  new cited evidence path `docs/P8_LIVE_RUN_RECIPE.md`, which exists.

**Boundaries (remain):** the live per-lane verdicts are UNRUN - the operator's
run is what flips the register. The W109 marker opt-in stays dark for every
family until a live verdict. P8 / issue #287 stays OPEN and P14 / issue #293
stays blocked on it. No production change; no live call is made by this
recipe.
