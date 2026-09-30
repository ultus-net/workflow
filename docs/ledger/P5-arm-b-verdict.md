<!-- Ledger fragment: authored directly (NOT extracted from TASKS.md) - this is the record of the P5 Arm B (transport + metering) LIVE verdict, not the per-role (Arm A) verdict. Write-once: append dated supersession notes, never rewrite. Park P5 and issue #284 stay OPEN - the per-role live run is still the operator's. -->

### P5b - the Arm B (transport + metering) live verdict (VERIFIED for the LANE, 2026-09-30) (issue #284 P5; docs-only, no production change)

**Source:** P5 (`docs/PARKED_AND_LIMITATIONS.md:34`) and issue #284, after the
turnkey runbook (`docs/P5_LIVE_RUN_RECIPE.md`; ledger fragment
`docs/ledger/P5-live-run-recipe.md`, P5r). The recipe names two arms: Arm A (the
manual per-role fleet turn, the operator's interactive run) and Arm B (the
existing gated transport/metering probes). This fragment records the **Arm B**
result only. Arm A remains UNRUN.

**What Arm B verifies (the LANE), and what it does not.** Arm B proves two
things: a real read-only turn is legal on the ambient ACP surface (transport
legality) and that turn crosses the hub's metered proxy with a placeholder-only
agent credential while the proxy injects the real upstream key (metering
proof). Arm B does **not** witness per-role resolution. Per the recipe §2/§3,
Arm A supplies the per-role identity and the resolved model; a green Arm B is
never read as a per-role verdict, and there is **no role→model map** (W095
key-1 does not exist).

**The live evidence (2026-09-30, this host, opencode v2.0.10 + cline 3.0.62):**

- **Transport legality** - `WORKFLOW_ACP_REAL=1 node --import tsx --test
  test/acp-real-probe.test.ts`: **2/2 pass**. opencode arm:
  `agentInfo.name "OpenCode"`, version `2.0.10`, `protocolVersion 1`, a real
  read-only turn completed (`stopReason: "end_turn"`). cline arm:
  `agentInfo.name "cline"`, version `3.0.62`, `protocolVersion 1`, a real
  read-only turn completed (`stopReason: "end_turn"`).
- **Metering proof** - `WORKFLOW_ACP_OPENCODE_METERED=1
  WORKFLOW_ACP_UPSTREAM=https://openrouter.ai node --import tsx --test
  test/acp-opencode-metered-probe.test.ts`: **1/1 pass**. The turn crossed the
  hub proxy with a placeholder-only agent credential; the proxy recorded
  `requests > 0`, `usageEvents > 0`, `totalTokens > 0`, and the turn completed
  (`stopReason: "end_turn"`).

**Prerequisite (recorded):** Arm B was previously non-functional on OpenCode v2
(zero proxy traffic on the metered lane). The OpenCode v2 connector fixes
(PRs #426-#428) are what made the metered lane work on v2. The gated-probe
README/ledger note records the same: `test/acp-real-probe.test.ts`'s opencode
arm initially failed on v2 because the probe passed `--cwd`; fixed in PR #426
(see `docs/ledger/opencode-v2-probe-args.md`).

**Verdict:** Arm B (transport + metering) `green` for the LANE. W095 c2
**stays OPEN** - the per-role LIVE check (Arm A) is still the operator's
interactive run, and no role→model map exists. The `unmeasured` / criterion-2
honesty on the P5 row is retained: this note witnesses the lane, not the
per-role resolution.

**Evidence:** the two gated probes above ran live (2/2 + 1/1). Docs-only change:
`npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped); state not
applicable (no code path).

**Boundaries (remain):** W095 c2 does not tick on this note; the `TASKS.md`
W095 criterion-2 checkbox stays unticked. The per-role rows (recipe §4a) are
unfilled. The role→model map (W095 key-1) and the affinity implementation (P19)
stay parked. P5 / issue #284 stays OPEN. No production change by this fragment.
