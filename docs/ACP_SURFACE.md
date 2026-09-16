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

Today's product surface: `src/cli/tui.tsx` launches the patched Cline 3.0.61 TUI (native commands, mentions, Plan/Act controls, dialogs, queueing, keyboard behavior, rendering) plus Workflow seams (authorization bridge, contained bash, MCP token economy, hub task panel).

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

Patched Cline Ink (the current `src/cli/tui.tsx` surface) remains the **fallback/migration surface**, not the base. It becomes required only if G1 (token economy) or G2 (commands/mentions) are judged material daily-driver requirements the clean surface cannot yet meet; otherwise the clean Workflow surface over stock-ACP Cline is the lead path, with the gaps tracked as explicit follow-ups. This classification stands unless spike evidence shows the clean surface cannot satisfy a material requirement.

**Stock-ACP headless-auth qualification (2026-09-16):** the stock PATH Cline (3.0.62) is account-cloud-only in ACP mode — its `initialize` advertises no API-key auth method, and headless key sessions fail with `re-authenticate your Cline account`. Stock-ACP therefore cannot run headless; the vendored patched binary (`--acp --provider openrouter` plus `CLINE_API_KEY`, the production hub launch path) is the only headless Cline surface. Consequence for probing: the gated MCP mount probe (`test/acp-cline-mcp-mount-probe.test.ts`) is retargeted at the vendored entry, and its live runs (2026-09-16, twice reproduced) record a **negative finding** — the agent replied `NO_MCP_TOOLS` against every scratch-home candidate config path, so hub-owned MCP-config delivery to a fresh scratch home is not honored by the vendored 3.0.61 ACP surface and the F1/G3 mounts stay deferred on Cline until a working config surface is identified. **OpenCode contrast (2026-09-16):** the equivalent OpenCode probe (`test/acp-opencode-mcp-mount-probe.test.ts`) mounts hub-written config on both surfaces — project `opencode.json` and `XDG_CONFIG_HOME` global config — returning the fixture skill verbatim via `list_skills`, so the F1/G3 deferral is Cline-surface-specific; on OpenCode the hub-owned MCP-config assumption is probe-proven.

**Settings follow-up completed 2026-09-15:** Workflow now implements `session/set_config_option`, replaces local option state with the complete agent response (including dependent changes), accepts agent-originated `config_option_update` state, and projects advertised selectors through the `/` menu without rebuilding the active session. `CLINE_MODEL` remains only an optional initial launch selection.
