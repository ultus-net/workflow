# ACP Surface Evaluation (W036)

Decision inputs for the clean Workflow terminal surface versus the patched Cline fallback, grounded in Cline 3.0.61 source (`apps/cli/src/acp/session-updates.ts`), the current ACP spec, and the W035 runtime evidence. Status: 2026-09-14; probe-fidelity corrections 2026-09-16 (G4 resume, stock-ACP headless auth).

## 1. What the hub ACP session stream projects reliably

From Cline 3.0.61's ACP emitter and probe evidence:

| Projection | Mechanism | Reliability |
|---|---|---|
| Assistant message text | `agent_message_chunk` (text; base64 images; other media as text placeholders) | Reliable for Cline; streamed incrementally |
| Reasoning | `agent_thought_chunk` | Reliable for Cline |
| Tool lifecycle | `tool_call` (pending, title/kind/rawInput) + `tool_call_update` (status transitions incl. permission-driven `in_progress`/`failed`) | Reliable for Cline; other agents vary |
| Mode / model / config | `session/new` result (`availableModes`, `availableModels`, `configOptions`), `current_mode_update`, `config_option_update`, `session_info_update` | Workflow retains the complete current config-option state and mutates advertised settings with `session/set_config_option` on the active session |
| Permission authority | `session/request_permission` with usable allow/reject options; denial honored | Proven (W035) |
| Cancellation | `session/cancel` honored at runtime (W035); fail-closed turn/session cancel on no-reject denial (unit-tested) | Proven |
| Session resume | `session/load` replays user/agent message chunks + session info before resolving (tool-call replay code-inspected in `session-load.ts`, not probe-exercised) | **Split verdict 2026-09-16:** transcript replay after a full agent restart is proven (2026-09-14 gated probe — user/agent chunks + session info), but continuation recall fails deterministically — `loadSession` restores the visible transcript, not the model's context. The resume probe's recall assertion documents the failure |

Authority rule: the stream is agent-cooperative UX projection only. Enforcement never derives from it — subjects come from permission requests, filesystem effects from OS containment.

## 2. What the stream cannot project (Cline 3.0.61 verified)

`translateEvent` explicitly drops `usage`, `error`, `iteration_start`, and `iteration_end`:

- **Token/cost usage** — no token-economy visibility **with Cline 3.0.61's pinned SDK 0.16.1**, which predates and drops `usage`. Note: `usage_update` (context `used`/`size` tokens + optional cumulative cost) is **stabilized in current ACP v1**; it becomes available when Cline upgrades its ACP SDK, and the hub projection forwards unknown update types untouched, so no hub change is needed to receive it.
- **Context/compaction lifecycle** — context is managed and honored inside the agent; on the ACP path Cline 3.0.61 does not advertise compaction strategy as a config option and `cline --compaction` is dropped before `runAcpMode` (verified in `apps/cli/src/main.ts` — only `autoApproveTools` reaches ACP mode), so ACP sessions use the Core default strategy. Model and other advertised settings are protocol-native active-session controls; compaction-strategy control is deferred alongside visibility. Coarse signal exists: stop reasons `max_tokens`/`max_turn_requests`. Compaction lifecycle updates (`compaction_update`/`compaction_summary_chunk`) are an **active RFD draft** (2026-07-22), capability-gated, not yet stable.
- **Error details** — failures surface only as a failed tool status or turn end.
- **Iteration boundaries** — no agent-loop step markers.
- **Plan content** — plan/act exposed only as mode ids; no `plan` updates emitted.
- **Available slash commands** — not emitted.
- **Terminal output embedding** — `ToolCallContent` type `terminal` is agent-optional; Cline does not use it (and never calls `terminal/*`, W035).
- **Exact conversation history** — agent-owned; `session/load` transcript replay is verified for Cline 3.0.61 (2026-09-14), but restored *model* context is disproven (2026-09-16): a resumed continuation cannot recall pre-restart turns (see §1 resume row).

## 3. Clean-surface daily-driver parity evaluation

Today's product surface: the `workflow` bin launches the browser operator UI (`src/cli/web-launch.ts`) with OpenCode in ACP mode by default, over the same application boundary. The OpenCode ACP terminal surface is `src/cli/acp-tui.tsx` (`npm run tui:acp`) and the universal driver TUI is `workflow-tui`. The patched Cline 3.0.61 TUI launcher (`src/cli/tui.tsx`) was retired from the default bind 2026-09-18; the vendored-Cline ACP runtime remains a selectable agent (`WORKFLOW_ACP_AGENT=cline`, the web switcher) pending the W050 evidence-gated retirement.

A clean Workflow surface over ACP gets message/reasoning streaming, tool cards with live status, config metadata and active-session selectors, permission prompts as first-class Workflow authorization UX, cancellation, and a hub-native task panel and enforcement badges (stronger than the bridged equivalent).

Parity gaps:

| # | Gap | Materiality |
|---|---|---|
| G1 | ~~No token/cost visibility~~ **MITIGATED 2026-09-14** — hub metering proxy (`createModelUsageProxy` + `meteredProviderSettings`) holds the key proxy-side, forces `usage.include`, records tokens/cost; gated probe: 2 requests / 8,668 tokens / $0.0132 with placeholder-only sandbox env (post-P1-fix re-run; original 8,790 / $0.0140). Wired into the clean surface 2026-09-14: `tui:acp` runs all model traffic through the proxy (placeholder-only contained env) and prints metrics at exit | Remaining: budget enforcement |
| G2 | No slash-command/mention parity (commands not emitted; `@`-mentions are CLI-side, not ACP) | Daily-driver ergonomics |
| G3 | Input/editor UX (mid-turn queueing, attachments) must be built client-side | Build cost, not a protocol blocker (image prompt content exists) |
| G4 | ~~Session resume fidelity~~ **REOPENED 2026-09-16** — the 2026-09-14 probe proved transcript replay (user/agent chunks + session info after agent restart), but continuation recall fails deterministically: `loadSession` does not restore model context, so a resumed session loses pre-restart conversational state. **Cline-surface-specific:** the equivalent OpenCode probe (1.18.31, `test/acp-opencode-resume-probe.test.ts`, live 2026-09-16) replays the transcript AND recalls the exact keyword across an agent restart — model context restored — so the gap is the Cline surface, not ACP | Correctness of long-running tasks across agent restarts |
| G5 | Error surfacing is thin (error events dropped) | Debuggability cost |
| G6 | Subagent/task spawning (`spawn_agent`) not distinctly gated or projected | Acceptable short-term |
| G7 | Context/compaction not observable at runtime and not configurable on the ACP path (`--compaction` dropped before `runAcpMode` in 3.0.61; `usage_update` stabilized in spec but unimplemented by pinned SDK; compaction signaling still an RFD draft) | Same family as G1 — both control and visibility deferred on the ACP path |

## 4. Fallback classification

Patched Cline Ink (the former `src/cli/tui.tsx` surface, retired as the default bind 2026-09-18) remains the **fallback/migration surface** conceptually, but the vendored-Cline ACP runtime is now the fallback vehicle (selectable, probe-gated). Retirement happens only through W050's evidence-gated removal, never by silence; the clean Workflow surface over OpenCode ACP is the lead path, with the gaps tracked as explicit follow-ups. This classification stands unless spike evidence shows the clean surface cannot satisfy a material requirement.

**Stock-ACP headless-auth qualification (2026-09-16):** the stock PATH Cline (3.0.62) is account-cloud-only in ACP mode — its `initialize` advertises no API-key auth method, and headless key sessions fail with `re-authenticate your Cline account`. Stock-ACP therefore cannot run headless; the vendored patched binary (`--acp --provider openrouter` plus `CLINE_API_KEY`, the production hub launch path) is the only headless Cline surface. Consequence for probing: the gated MCP mount probe (`test/acp-cline-mcp-mount-probe.test.ts`) is retargeted at the vendored entry, and its live runs (2026-09-16, twice reproduced) record a **negative finding** — the agent replied `NO_MCP_TOOLS` against every scratch-home candidate config path, so hub-owned MCP-config delivery to a fresh scratch home is not honored by the vendored 3.0.61 ACP surface and the F1/G3 mounts stay deferred on Cline until a working config surface is identified. **OpenCode contrast (2026-09-16):** the equivalent OpenCode probe (`test/acp-opencode-mcp-mount-probe.test.ts`) mounts hub-written config on both surfaces — project `opencode.json` and `XDG_CONFIG_HOME` global config — returning the fixture skill verbatim via `list_skills`, so the F1/G3 deferral is Cline-surface-specific; on OpenCode the hub-owned MCP-config assumption is probe-proven.

**Settings follow-up completed 2026-09-15:** Workflow now implements `session/set_config_option`, replaces local option state with the complete agent response (including dependent changes), accepts agent-originated `config_option_update` state, and projects advertised selectors through the `/` menu without rebuilding the active session. `CLINE_MODEL` remains only an optional initial launch selection.

**W047 correction + G5/G7 completion (2026-09-17):** the line above claiming "the hub projection forwards unknown update types untouched, so no hub change is needed to receive it" was true only at the wire-client listener layer — the session record DROPPED unknown kinds. W047 closes that: every well-formed kind this projection doesn't specialize (e.g. `usage_update`) and all agent-custom notification methods (e.g. goose's `_goose/unstable/session/update` usage channel) now project into the session record as advisory `agent-context` events, rendered as dim `[context]` rows; agent-custom REQUESTS (with an id) stay fail-closed (the client cannot answer a method it doesn't implement). The G5 row ("error surfacing is thin") is likewise superseded: boot/composition failures now print blocking-reason-style causes (`failed to start the contained session: …`), a fail-closed permission denial threads its wire cause (`fail-closed: no_reject_option`) into the failed turn, an agent crash mid-turn surfaces as a failed turn with the exit cause, and an operator-armed turn watchdog (`WORKFLOW_ACP_TURN_TIMEOUT_MS`, off by default) bounds the one failure that produced no event at all — a hung turn. **G7 mitigation, stated once and coherently:** compaction-time CONTROL stays explicitly outside hub scope over ACP (no ACP equivalent of the plugin-era compaction gating; revisited if the compaction RFD stabilizes) — the mitigation is restart discipline, resume-backed: the session id is projected into the transcript for resume, `WORKFLOW_ACP_RESUME` restores the session across agent restarts, and `session/load` context restoration is probe-proven on the OpenCode lead. Visibility (this correction) is never upgraded to control.

**Supersession note (2026-09-18, W050 step 6).** The vendored-Cline SDK runtime, its `.workflow-cline/` checkout, and its Workflow patch were removed on branch `feat/w050-cline-removal` (not yet merged), together with the hub's Cline-specific `/before-tool` and `/team-task` routes. The thin stock-ACP connector is retained (`src/integrations/cline-launch.ts` resolves ambient `cline --acp`; the `cline` agent kind composes the generic ACP runtime) and is probe-PENDING on stock 3.0.62. Prior statements in this record about the stock-ACP headless-auth qualification and the vendored fallback vehicle are historical.
