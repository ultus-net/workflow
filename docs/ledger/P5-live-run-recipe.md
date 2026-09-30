<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) - this is the record of the P5 turnkey live-run RECIPE landing, not a landed live verdict. Write-once: append dated supersession notes, never rewrite. Park P5 and issue #284 stay OPEN - the live run is the operator's. -->

### P5r - the operator's turnkey per-role live-run recipe (Complete - the recipe itself; the live per-role check remains operator-gated/unrun) (issue #284 P5; docs-only, no production change) (2026-09-30)

**Source:** P5 (`docs/PARKED_AND_LIMITATIONS.md:34`) and issue #284, after the
W095 design note (`docs/MODEL_ROUTING_POLICY_2026-09-23.md`, frontier-verified
through round 3, §8) and the landed W109 `transformBody` seam. The design note
carried the routing position but no operator-facing run sequence; this
fragment records collapsing it into one runbook so the live c2 check is
turnkey: the gates, the per-role commands, the read of the output, the
recording templates, and the watch items in one place. Mirrors the P8 recipe
shape (`docs/P8_LIVE_RUN_RECIPE.md`, `docs/ledger/P8-live-run-recipe.md`).

**What landed (docs only):**

1. `docs/P5_LIVE_RUN_RECIPE.md` - the operator runbook. It carries:
   - **The env/credential gates**: the upstream key resolution
     (`WORKFLOW_UPSTREAM_KEY` / `~/.config/workflow/upstream-key`, legacy
     `CLINE_API_KEY`, explicit `CLINE_API_KEY_FILE`), the pool anchor
     (`WORKFLOW_OPENROUTER_AUTO_ALIASES` + the disable/cost-tier axes), and the
     live gate tokens (`WORKFLOW_ACP_REAL=1`,
     `WORKFLOW_ACP_OPENCODE_METERED=1`);
   - **The run**: Arm A (the fleet path - `workflow install fleet` then the per
     role command in its own session, the intended tier per role) and Arm B
     (the existing gated transport/metering probes), with the honest note that
     no dedicated per-role probe exists;
   - **What to read per role**: the role→model resolution (the ACP
     model/mode picker, the hub-written config `model`, the proxy's recorded
     request `model`) and a real turn (`stopReason: end_turn` + metered
     `requests`/`tokens`);
   - **The verdict-record templates**: the per-role rows and the dated
     HOST_ADAPTERS-prose write-up (no `PROBE_VERDICTS.json` row - P5 is not a
     gated probe file);
   - **The watch items**: the W095 c2 narrowing (no role→model map exists, so
     the run witnesses the operator-manual fleet path, not an automatic
     per-role assignment); alias drift / "Prevent overrides"; the
     concrete-slug `allowed_models` constraint; the composed default.
2. The P5 row (`docs/PARKED_AND_LIMITATIONS.md:34`) gained the dated run-recipe
   note and the `docs/P5_LIVE_RUN_RECIPE.md` / this fragment pointers.

**Evidence:**

- Docs-only: `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped);
  state not applicable (no code path).

**Boundaries (remain):** the live per-role verdict is UNRUN - the operator's
run is what ticks W095 c2. The role→model map (W095 key-1) does not exist, so
even a green run witnesses the composed default / operator pick, never an
automatic per-role assignment. P5 / issue #284 stays OPEN; the affinity
implementation (P19) stays parked. No production change; no live call is made
by this recipe.
