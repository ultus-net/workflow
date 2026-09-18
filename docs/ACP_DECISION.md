# ACP Decision: adopt stock-ACP Cline with whole-agent containment as the lead surface path

**Status:** Accepted — 2026-09-14; **amended 2026-09-16 — lead surface pivoted to stock-ACP OpenCode** (see the Pivot section)
**Decision owner:** operator
**Evidence:** `docs/ACP_RESEARCH.md` (W032–W035), `docs/ACP_SURFACE.md` (W036), TASKS Phase 8; pivot evidence: `docs/HOST_ADAPTERS.md` conformance matrix (2026-09-16 live probes)

## Context

The spike proved an asymmetric field: OpenCode's default ACP mode edits files without sending `session/request_permission` (advisory transport only), while Cline 3.0.61 `--acp --auto-approve false` with `CLINE_API_KEY`/`CLINE_PROVIDER=openrouter` intercepts reads, edits, and `run_commands` with usable reject options and honors denial. Cline never delegates execution to client `terminal/*`/`fs/*` capabilities (source-verified), so enforcement is achieved by launching the agent process itself under Bubblewrap: permission interception intact, allowed workspace writes applied, random-secret host canary invisible despite an active `find /` search, `/tmp` escape writes never reaching the host (network `host` retained for model egress). The ACP session stream projects messages, reasoning, tool lifecycle, mode/model/auto-approve config, and cancellation — but not token usage, error detail, iteration boundaries, plan content, or slash commands.

## Decision

**GO.** Build the clean Workflow terminal surface over **stock-ACP Cline launched under whole-agent Bubblewrap containment** as the lead path. Patched Cline Ink (current `src/cli/tui.tsx` surface) remains the **fallback/migration surface**, not the base.

> **Supersession note (2026-09-18):** the lead agent pivoted to stock-ACP **OpenCode** (`docs/ACP_DECISION.md` pivot section, 2026-09-16), and the `workflow` default bind has now moved from the patched-Cline TUI launcher to the browser operator UI over OpenCode ACP (`src/cli/web-launch.ts` → `src/cli/web-service.ts`). `src/cli/tui.tsx` is retired. The vendored-Cline ACP runtime remains a selectable fallback agent (`WORKFLOW_ACP_AGENT=cline`); its full retirement stays evidence-gated under W050. This note supersedes the "Patched Cline Ink … fallback/migration surface" clause above; the dated sentence is kept, not rewritten.

**Headless-auth qualification (2026-09-16):** stock Cline (3.0.62 PATH) is account-cloud-only in ACP mode — no API-key auth method is advertised, and headless key sessions fail with `re-authenticate your Cline account` — so the stock surface cannot run headless; the vendored patched binary (`--acp --provider openrouter` plus `CLINE_API_KEY`) is the only headless Cline path, and gathering stock-ACP evidence requires an interactive account-cloud login (`docs/ACP_SURFACE.md` §4, `docs/ACP_RESEARCH.md`).

## Pivot (2026-09-16): the lead surface is now stock-ACP OpenCode

The 2026-09-16 conformance probes reversed the original asymmetry. Every finding that made Cline the lead surface dissolved on OpenCode 1.18.31, and every cap that held the ACP path back resolved in OpenCode's favor:

- **Spawn gateability (G6) — Green on OpenCode, Red on Cline.** The subagent probe shows OpenCode's `task` tool call projected to the hub *and* its `session/request_permission` reaching the client (config-owned: `permission: { task: "ask" }` in the hub-written project `opencode.json`), so spawns are deniable per operator policy. Cline's `spawn_agent` ran with neither the tool call nor any permission projected — spawn stays default-denied there and Cline cannot be labeled `enforced` for spawn-inclusive workflows (`docs/HOST_ADAPTERS.md` matrix).
- **Hub-owned MCP config (F1/G3 prerequisite) — honored on OpenCode, ignored on Cline.** OpenCode mounts hub-written config from both surfaces (project `opencode.json` and `XDG_CONFIG_HOME`; `list_skills` returned the fixture skill verbatim), unblocking the skills-mcp/fs-exec-mcp single-delivery-path wiring. The vendored Cline 3.0.61 ACP surface ignores every candidate config path (`NO_MCP_TOOLS`, twice reproduced).
- **Session-resume fidelity (G4) — restored on OpenCode.** `session/load` replays the transcript *and* restores model context (exact keyword recalled across a full agent restart); Cline replays the visible transcript only.
- **Token visibility (G7 family) — `usage_update` streams on OpenCode** (observed live 2026-09-16 in the MCP-mount probe's projected `updateKinds` and the metered probe's turn-result usage); unimplemented by Cline's pinned SDK.
- **Operating cost — zero patch tax on OpenCode.** Cline's headless auth exists only in the vendored patched binary, making the patch load-bearing for auth and re-verified on every Cline release. OpenCode runs headless stock.

**G1 metering carries over unchanged:** the hub-side metering proxy is agent-agnostic. The gated metered probe (`test/acp-opencode-metered-probe.test.ts`, live 2026-09-16) proved a contained, `--pure` OpenCode turn completing end-to-end with only a placeholder credential inside the boundary while the proxy recorded the traffic — the same posture as the Cline path (`apiKey` is a plain placeholder string in the per-runtime 0600 config; opencode 1.18's schema rejects env references there, verified live).

**Implementation:** `createConfiguredAcpRuntime` (`src/integrations/acp-runtime.ts`) selects the agent via `WORKFLOW_ACP_AGENT` — `opencode` is the default, `cline` selects the vendored fallback. The OpenCode runtime writes a per-runtime hub-owned config (`XDG_CONFIG_HOME`, pruned with the same stale-runtime rules as the Cline provider settings), launches `opencode acp --pure` under whole-agent Bubblewrap, and routes every permission request through `WorkflowApplication.authorize`.

**Post-pivot surface findings (2026-09-16, live, wedge-feature probe):**

- **OpenCode `--pure` delegates file operations to the client fs server** (`fs/write_text_file` for edits; the earlier un-pure probes had a plugin performing writes). The hub implements the ACP fs server (`AcpFsServer` in `src/adapters/acp-subprocess.ts`, wired in `AcpSessionDriver`): every delegated write crosses hub authorization and the guard dispatcher (mapped to the same write policy as a direct write; delegated reads are not guard-gated, same as direct reads) before the hub performs it — a control-plane *strengthening*, since the mutation literally passes through the authority rather than the agent's own hands. Paths must be absolute so the authorized subject and the performed path are the identical string (a relative path would authorize workspace-joined but perform against the hub's cwd — fail-closed). Denied delegations surface to the agent as JSON-RPC errors (normal outcomes, like denied permissions).
- **OpenCode titles edit-permission requests with the target path**, so title-derived tool classification sees an unrecognized name; classification now falls back to the ACP `kind` field (the protocol's own discriminator) before the fail-closed mutation default. Unknown kinds still fail closed.
- **The scheduled-run wedge chain now closes VERIFIED live on the pivoted runtime** (`test/hub-scheduled-turn-probe.test.ts`): schedule fires → hub spawns a contained OpenCode turn → the agent's edit delegates through the hub fs server (mutation lands) → the hub-owned reviewer agent reviews the real diff and approves with the 5-axis structured summary the anti-rubber-stamp gate requires → the verify flow runs the workspace's own test command and records the passing `test:<workspace>` evidence → the run verifies with no blocking reason. Two reviewer-prompt contract lines were needed (read-only disclosure; axis-naming requirement) because an agent that hits a permission denial may end its turn without a final message, and an approval that names fewer than 3 axes is rejected by design.

**Alternatives considered for the pivot:**

- **Patched-SDK bridge instead of ACP** — rejected as base. What host-hook interception uniquely buys is visibility into *everything* the agent does internally (including subagent-internal tool calls that no ACP projection surfaces); what it costs is Cline forever (the bridge is Cline-specific, the multi-agent `HOST_ADAPTERS` matrix exists only because of ACP), a patch that is now load-bearing for *auth* as well as interception, and ambient-filesystem visibility for the agent process (per-command isolation ≠ whole-agent isolation). The residual ACP gaps (G2/G3 client-side UX, G5 error surfacing, G7 compaction control) are cost-shaped with hub-side mitigations, not enforcement-shaped. The SDK fallback stays retained insurance per the consequence below — the one scenario that flips this choice is subagent-*internal* gateability becoming a hard requirement that OpenCode will not surface.
- **Staying on Cline** — rejected: advisory-capped spawn, dead MCP-config surface, no context restore across restart, and a permanent patch tax, against a stock surface that passes all four.


Gap dispositions from W036:

- **G1 token/cost visibility — MITIGATED 2026-09-14 (hub metering proxy, proven).** An MCP server **cannot** track token usage (it observes tool calls, never model turns), so the hub owns a loopback metering proxy instead: `createModelUsageProxy` (`src/integrations/model-usage-proxy.ts`) holds the real key proxy-side ONLY, injects it upstream, forces `usage: { include: true }` on chat completions, and records per-session prompt/completion/total tokens plus USD cost from JSON responses and the final SSE chunk. The agent launches with a placeholder credential and `baseUrl` → proxy via `meteredProviderSettings` + `CLINE_PROVIDER_SETTINGS_PATH`. Gated probe (`test/acp-cline-metered-probe.test.ts`, WORKFLOW_ACP_CLINE_METERED=1): a full contained turn completed (`end_turn`, workspace mutation applied) with the sandbox env containing only the placeholder, while the proxy recorded 2 requests / 8,668 tokens / $0.0132 (post-P1-fix re-run; original run showed 8,790 tokens / $0.0140). Remaining work: surface the metrics in the hub/session UI and add budget enforcement on top of the recorded usage. Budget-enforcement alternatives noted 2026-09-14: OpenRouter supports **per-key credit limits** (created at openrouter.ai/keys) — a per-session limited key would make caps server-enforced without proxy-side enforcement; and the official `@openrouter/sdk` client exists for future hub-side model calls (client library, not a proxy; does not replace the metering path).
- **G1 addendum — OpenRouter Auto Router "latest" pool (2026-09-18).** The hub defaults agents to `openrouter/auto`, but OpenRouter's Auto Router `allowed_models` constraint only matches concrete catalog IDs: `~<lab>/<model>-latest` aliases resolve as a top-level `model` yet resolve to nothing inside `allowed_models`, collapsing the candidate pool to `404 No models match your request and model restrictions`. The hub closes that at the meter proxy (`src/integrations/openrouter-auto-latest.ts` + the `autoLatest` seam in `createModelUsageProxy`): for chat completions targeting an Auto Router slug it resolves each alias to its current `alias_target.slug` from the public `/api/v1/models` catalog (6h success cache, 60s failure backoff, fail-open) and injects the concrete list as the `auto-router`/`auto-beta-router` plugin before forwarding. Agent-agnostic — one implementation covers OpenCode, Cline, and future adapters, so no client-side plugin is needed. Enabled by default for OpenRouter upstreams; `WORKFLOW_OPENROUTER_AUTO_LATEST` disables it, `WORKFLOW_OPENROUTER_AUTO_ALIASES` overrides the pool, `WORKFLOW_OPENROUTER_AUTO_COST_TIER` sets the cost band. **Limitation:** OpenRouter's "Prevent overrides" toggle makes saved account values final and ignores request-level settings, so a hub-side injection cannot apply either if the saved allowlist is unhealthy — the saved list must be corrected. The same alias pool is also exposed as selectable models in the ACP model picker: `meteredOpencodeConfig` populates the hub-written provider `models` map with the aliases and friendly labels (`Auto Router`, `Claude Sonnet (latest)`, …), so an operator can switch to a specific family's latest without pinning while `openrouter/auto` stays the default.
- **G2 commands/mentions — RESOLVED FOR SETTINGS (2026-09-15).** ACP v1 `configOptions` and `session/set_config_option` are implemented end-to-end: the driver retains the complete agent-returned option state, accepts agent-originated `config_option_update` replacement state, and the `/` menu cycles advertised select settings (model/mode/reasoning included) on the active session without rebuilding it. Slash commands and `@`-mention parsing remain client-side conveniences rather than ACP projections, an accepted UX difference.
- **G3 input/editor UX** — client-side build cost, accepted.
- **G4 session-resume fidelity — ~~RESOLVED (2026-09-14)~~ REOPENED (2026-09-16).** The gated probe (`test/acp-cline-resume-probe.test.ts`) launched a fresh contained agent against the persistent scratch `HOME` after a full process restart and `session/load` faithfully replayed the transcript (user/agent message chunks plus session info). **Correction (2026-09-16):** `loadSession` does **not** restore model context — continuation recall fails deterministically — so a resumed session loses pre-restart conversational state (`docs/ACP_SURFACE.md` §1/§3).
- **G5 thin error surfacing** — accepted as a debuggability cost.
- **G6 subagent projection** — accepted short-term.
- **G7 context/compaction — DEFERRED (same family as G1, covering both visibility AND control).** Context is managed and honored inside the agent. On the ACP path the hub cannot even configure the strategy: `cline --compaction` parses but is dropped before `runAcpMode` in 3.0.61 (verified in `apps/cli/src/main.ts`), so ACP sessions always run the Core default. Model choice stays hub-controllable via `CLINE_MODEL`/`configOptions`. Stabilized `usage_update` becomes visible when Cline upgrades its pinned ACP SDK (hub projection forwards unknown update types unchanged); compaction lifecycle signaling remains an RFD draft. No decision impact.

## Consequences

- Implementation phase (post-decision), landed 2026-09-14/15: session lifecycle wired into hub `authorize` by `AcpSessionDriver` (`src/integrations/acp-session.ts`, per-request permission resolution → `WorkflowApplication.authorize` with fail-closed title classification), whole-agent containment as the default spawn path (`AcpSessionDriver.contained` → `launchContainedAcpAgent`), protocol-native active-session config mutation, and a clean terminal surface over the ACP projection (`src/cli/acp-tui.tsx`, `npm run tui:acp`; `WORKFLOW_ACP_RESUME=<sessionId>` resumes). Migrate daily use off patched Cline after dogfooding.
- **SDK seam retention (explicit):** the SDK fallback is load-bearing insurance, not legacy. `src/adapters/cline.ts`, `src/integrations/cline-{plugin,runtime,session,shell-executor,tui-bridge}.ts`, their unit tests (`test/cline-*.test.ts`), the real-model integration regressions (`test/integration/cline-coding-session.mjs`, `cline-runtime.mjs`, `cline-resume.mjs`), the pinned patch `patches/cline-cli-v3.0.61-workflow.patch`, and its regeneration scripts (`scripts/build-cline-tui.mjs` — which runs as `pretest` on every suite run — and `scripts/bump-cline-tag.mjs`) are all retained and continuously exercised. If the ACP path hits a blocking limitation, the fallback must be a working tree, not an archeology project; patch re-pinning happens whenever the fallback needs a newer Cline, not only at migration time. **Post-pivot (2026-09-16) the vendored-ACP Cline runtime is the same kind of insurance:** selectable with `WORKFLOW_ACP_AGENT=cline`, exercised on demand by its gated probes, retained for the host-hook interception capability (full internal tool visibility) that no ACP projection provides.
- **Subagent-internal hook visibility — evidence note (2026-09-17, W050 SDK-seam input):** the W050 granted-spawn probe (`test/acp-goose-subagent-hooks-probe.test.ts`, live twice against goose 1.50.1) resolved the arm NEGATIVE on the takeover surface: the delegated subagent's file-write fired NO PreToolUse record and projected NO ACP tool_call update — only the top-level session's calls and the `delegate` spawn itself intercept (the spy plugin logged the top-level todo_write ×2, the delegate spawn, and one agent-attribution-ambiguous shell `cat` verify; the write-shaped classifier was tightened twice against the real payloads and re-validated offline against both preserved logs). This retention rationale's "full internal tool visibility" therefore remains UNDEMONSTRATED LIVE on both surfaces — goose demonstrably lacks it, and the vendored-Cline seam has never proven subagent-internal hook firing either (SubagentStart/Stop never emitted by the adapter). W050's seam decision can now rest on evidence: either a live Cline-side proof lands, or the operator records the explicit accepted-risk that this visibility is not required — silence retires nothing.
- ~~OpenCode integration is capped at advisory transport unless a future launch mode proves complete permission coverage~~ **Superseded by the 2026-09-16 pivot:** the ask-configured launch mode proves permission coverage (requests emitted, denials honored — G1 probe), spawn gateability (subagent probe), hub-owned config (mount probe), and resume fidelity (resume probe), so OpenCode is the lead `enforced`-eligible surface. Its remaining conformance evidence (fs/terminal delegation, auto-approve exposure, contained bypass under bwrap) is deferred unless reconsidered.
- Follow-ups: wire the skills-mcp mount into the OpenCode runtime config (F1 — needs skills-dir semantics and `readablePaths` threading for the server script), surface G1 metrics in the hub UI + budget enforcement on recorded usage, per-prompt task decomposition (today every proposal authorizes against the single session task), error-surfacing improvements (G5), context/compaction (G7). G1 alternatives worth revisiting: OpenRouter supports **per-key credit limits** (key creation at openrouter.ai/keys) for server-side budget caps, and the official `@openrouter/sdk` client exists for any future hub-side model calls (the metering proxy stays the pass-through for agent traffic; the SDK is for hub-as-caller).

## Alternatives considered

- **Patched-SDK bridge as the base surface** — rejected as base (pinned patch must be re-applied and re-verified per Cline release; ambient filesystem stays visible to the agent process); retained as fallback.
- ~~**OpenCode ACP** — rejected for enforcement: observed default mode mutates without permission requests; remains a viable advisory transport only.~~ Superseded by the 2026-09-16 pivot: the ask-configured mode is the launch mode this rejection asked for, and the conformance probes proved it.
- **Wait for Cline `terminal/*` delegation** — rejected: unimplemented in 3.0.61 with no committed timeline; whole-agent containment already satisfies the enforcement requirement.

## Supersession notes (2026-09-16, W043 documentation reconciliation)

This decision record is amended in place with dated notes; nothing above is
silently rewritten.

1. **Wedge-chain review step (line 35).** The described review gate (5-axis
   anti-rubber-stamp, `<3` axes rejected, distinct reviewer) was accurate when
   written and is now strengthened: the hub-owned reviewer additionally
   enforces the W039 deterministic coverage manifest with the fail-closed
   `[COVERAGE]` approval gate, W040 risk-aware partitioning (per-unit
   isolated reviewers, an integration review exactly when a scope spans more
   than one unit), and W041 fingerprinted provenance journaling before every
   record with exact-fingerprint resume — wired through the production
   reviewer factory (`src/integrations/hub-run-gates.ts`,
   `src/review/{manifest,partition,provenance}.ts`,
   `src/integrations/review-provenance-store.ts`).
2. **G1 remaining-work line (line 45).** "Surface the metrics in the
   hub/session UI and add budget enforcement on top of the recorded usage" —
   both shipped: the ACP TUI header carries the live usage meter
   (`src/cli/acp-tui.tsx`), the hub session channel records usage
   (`src/ui/web-sessions.ts`), and the scheduler enforces per-run token/cost
   budget caps with the budget as the run's recorded blocking reason
   (`src/integrations/hub-scheduler.ts`, `src/cli/hub.ts`).
3. **Deferred conformance evidence (line 57).** "Its remaining conformance
   evidence (fs/terminal delegation, auto-approve exposure, contained bypass
   under bwrap) is deferred unless reconsidered" — corrected: fs delegation
   is no longer deferred; this record's own Pivot section (line 33) plus the
   implementation (`AcpFsServer` in `src/adapters/acp-subprocess.ts`, every
   delegated write authorized through the application then the guard) and the
   contained `--pure` turn probe (`test/acp-opencode-metered-probe.test.ts`)
   prove it. Auto-approve (enforcement-altering config) exposure is guarded
   fail-closed client-side (`src/integrations/acp-session.ts`). Genuinely
   still deferred: `terminal/*` delegation (the hub client advertises no
   terminal capability).
4. **Follow-up ledger (line 58).** "Wire the skills-mcp mount into the
   OpenCode runtime config (F1)" — done: skills mount + readablePaths
   threading in `src/integrations/acp-runtime.ts`, the skills-mcp entry in
   the hub-written per-runtime config, and the gated delivery probe
   (`test/acp-opencode-skills-delivery-probe.test.ts`, gate
   `WORKFLOW_ACP_OPENCODE_SKILLS`; no live verdict recorded yet). The G1
    metrics/budget follow-up is likewise complete (note 2). Per-prompt task
    decomposition landed as W046: the task-command port
    (`src/application/task-commands.ts`) drives canonical create/activate/
    complete/retry through application commands, and the ACP driver
    correlates proposals with the active eligible task (`activeTaskCorrelation`
    — blocked work fails closed through the `no-active-task` sentinel). The
    original follow-up line at :58 keeps its dated wording; this note
    supersedes its decomposition clause.

## W050 SDK-seam decision — PROPOSED, awaiting operator signature (2026-09-18)

**Decision required (TASKS W050 criterion 2):** whether the vendored-Cline SDK
seam is retained for its unique capability — host-hook visibility into
**subagent-internal** tool calls — or the operator records an explicit
accepted-risk that this visibility is not required.

**Evidence on record (no new runs):**

- The goose granted-spawn SUBAGENT-HOOKS probe
  (`test/acp-goose-subagent-hooks-probe.test.ts`, gate
  `WORKFLOW_ACP_GOOSE_SUBAGENT_HOOKS=1`) ran live twice against goose 1.50.1 and
  resolved **NEGATIVE**: the delegated subagent's file-write fired **no**
  PreToolUse record and projected **no** ACP tool_call update — only the
  top-level session's calls and the `delegate` spawn itself intercept
  (`docs/HOST_ADAPTERS.md` goose row; `TASKS.md` W050 status).
- The vendored-Cline seam has **never** demonstrated subagent-internal hook
  firing either: the Cline ACP subagent probe is **Red** (the spawn itself is
  invisible to the hub — `spawnToolCallObserved: false`), and
  `SubagentStart`/`Stop` ACP updates are not emitted.
- Where spawns are projected, the **spawn call** remains gateable (OpenCode
  `task` Green, goose `delegate` Green-denied). What no surface demonstrates is
  visibility into the work *inside* a granted spawn.

**Drafted decision (operator to confirm or reject):** record the explicit
accepted-risk that the seam's unique subagent-internal visibility is **not** a
required capability, so the seam is not retained on that ground. Rationale: the
capability is undemonstrated live on both candidate surfaces; the vendored-Cline
patch is load-bearing for auth as well as interception (a recurring tax);
spawn-level gateability — the operationally relevant control — is preserved on
the lead surfaces; and whole-agent containment plus per-mutation permission
interception remain the enforcement backstops.

**Residual risk this records (stated, not hidden):** tool activity *inside a
granted subagent spawn* is neither hook-intercepted nor projected on any current
surface, so a subagent can act within the boundary without a per-internal-call
authorization decision. Spawns remain default-denied on `enforced` surfaces, so
this is reachable only through an operator-granted spawn.

**Scope:** this resolves W050 criterion 2 only. The backup-slot takeover
(criterion 1) still depends on the operator's W049 daily-driver period, and the
vendored-Cline removal (criterion 3) proceeds only once criterion 1 holds and
this criterion-2 signature is recorded.

**Status:** PROPOSED — the seam is not retired by silence or by this draft.
Operator signature below closes criterion 2; absent it, the seam stays retained.

Operator decision:

- [ ] accept the accepted-risk (the seam is not required)
- [ ] reject (retain the seam; commission a live Cline-side subagent-internal proof)

Signed: __________ Date: __________

**Supersession note (2026-09-18, W050 step 6).** The vendored-Cline SDK runtime,
its `.workflow-cline/` checkout, and its Workflow patch were removed on branch
`feat/w050-cline-removal` (not yet merged), together with the hub's
Cline-specific `/before-tool` and `/team-task` routes. The thin stock-ACP
connector is retained (`src/integrations/cline-launch.ts` resolves ambient
`cline --acp`; the `cline` agent kind composes the generic ACP runtime) and is
probe-PENDING on stock 3.0.62. Prior statements in this decision record about
the retained SDK seam are historical.
