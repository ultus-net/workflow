# ACP Surface Evaluation (W036)

Decision inputs for the clean Workflow terminal surface versus the patched Cline fallback, grounded in Cline 3.0.61 source (`apps/cli/src/acp/session-updates.ts`), the current ACP spec, and the W035 runtime evidence. Status: 2026-09-14.

## 1. What the hub ACP session stream projects reliably

From Cline 3.0.61's ACP emitter and probe evidence:

| Projection | Mechanism | Reliability |
|---|---|---|
| Assistant message text | `agent_message_chunk` (text; base64 images; other media as text placeholders) | Reliable for Cline; streamed incrementally |
| Reasoning | `agent_thought_chunk` | Reliable for Cline |
| Tool lifecycle | `tool_call` (pending, title/kind/rawInput) + `tool_call_update` (status transitions incl. permission-driven `in_progress`/`failed`) | Reliable for Cline; other agents vary |
| Mode / model / config | `session/new` result (`availableModes`, `availableModels`, `configOptions` incl. `auto_approve`), `current_mode_update`, `config_option_update`, `session_info_update` | Reliable for Cline 3.0.61 |
| Permission authority | `session/request_permission` with usable allow/reject options; denial honored | Proven (W035) |
| Cancellation | `session/cancel`; fail-closed turn/session cancel on no-reject denial | Proven (W035) |
| Session resume | `loadSession` advertised by Cline and OpenCode | Advertised; replay fidelity **unproven** |

Authority rule: the stream is agent-cooperative UX projection only. Enforcement never derives from it — subjects come from permission requests, filesystem effects from OS containment.

## 2. What the stream cannot project (Cline 3.0.61 verified)

`translateEvent` explicitly drops `usage`, `error`, `iteration_start`, and `iteration_end`:

- **Token/cost usage** — no token-economy visibility **with Cline 3.0.61's pinned SDK 0.16.1**, which predates and drops `usage`. Note: `usage_update` (context `used`/`size` tokens + optional cumulative cost) is **stabilized in current ACP v1**; it becomes available when Cline upgrades its ACP SDK, and the hub projection forwards unknown update types untouched, so no hub change is needed to receive it.
- **Context/compaction lifecycle** — context is managed and honored inside the agent; on the ACP path it is **not even hub-configurable**: `cline --compaction` is dropped before `runAcpMode` in 3.0.61 (verified in `apps/cli/src/main.ts` — only `autoApproveTools` reaches ACP mode), so ACP sessions always run the Core default strategy. Model choice remains hub-controllable via `CLINE_MODEL`/`configOptions`; compaction-strategy control is deferred alongside visibility. Coarse signal exists: stop reasons `max_tokens`/`max_turn_requests`. Compaction lifecycle updates (`compaction_update`/`compaction_summary_chunk`) are an **active RFD draft** (2026-07-22), capability-gated, not yet stable.
- **Error details** — failures surface only as a failed tool status or turn end.
- **Iteration boundaries** — no agent-loop step markers.
- **Plan content** — plan/act exposed only as mode ids; no `plan` updates emitted.
- **Available slash commands** — not emitted.
- **Terminal output embedding** — `ToolCallContent` type `terminal` is agent-optional; Cline does not use it (and never calls `terminal/*`, W035).
- **Exact conversation history** — agent-owned; `session/load` replay correctness is per-agent and unverified.

## 3. Clean-surface daily-driver parity evaluation

Today's product surface: `src/cli/tui.tsx` launches the patched Cline 3.0.61 TUI (native commands, mentions, Plan/Act controls, dialogs, queueing, keyboard behavior, rendering) plus Workflow seams (authorization bridge, contained bash, MCP token economy, hub task panel).

A clean Workflow surface over ACP gets for free: message/reasoning streaming, tool cards with live status, mode/model/auto-approve controls via `configOptions`, permission prompts as first-class Workflow authorization UX, cancellation, and a hub-native task panel and enforcement badges (stronger than the bridged equivalent).

Parity gaps:

| # | Gap | Materiality |
|---|---|---|
| G1 | No token/cost visibility (`usage` dropped) | Directly conflicts with Workflow's token-economy goal |
| G2 | No slash-command/mention parity (commands not emitted; `@`-mentions are CLI-side, not ACP) | Daily-driver ergonomics |
| G3 | Input/editor UX (mid-turn queueing, attachments) must be built client-side | Build cost, not a protocol blocker (image prompt content exists) |
| G4 | Session resume fidelity depends on agent replay correctness | Unproven; needs a resume probe before relying on it |
| G5 | Error surfacing is thin (error events dropped) | Debuggability cost |
| G6 | Subagent/task spawning (`spawn_agent`) not distinctly gated or projected | Acceptable short-term |
| G7 | Context/compaction not observable at runtime and not configurable on the ACP path (`--compaction` dropped before `runAcpMode` in 3.0.61; `usage_update` stabilized in spec but unimplemented by pinned SDK; compaction signaling still an RFD draft) | Same family as G1 — both control and visibility deferred on the ACP path |

## 4. Fallback classification

Patched Cline Ink (the current `src/cli/tui.tsx` surface) remains the **fallback/migration surface**, not the base. It becomes required only if G1 (token economy) or G2 (commands/mentions) are judged material daily-driver requirements the clean surface cannot yet meet; otherwise the clean Workflow surface over stock-ACP Cline is the lead path, with the gaps tracked as explicit follow-ups. This classification stands unless spike evidence shows the clean surface cannot satisfy a material requirement.

**Resolved 2026-09-14 (`docs/ACP_DECISION.md`):** G1 deferred (token economy via a future hub-metered proxy; MCP cannot observe model turns), G2 satisfied (model/settings switching is covered by ACP `configOptions`) — **GO**: the clean Workflow surface over stock-ACP Cline with whole-agent containment is the lead path; patched Cline Ink stays fallback.
