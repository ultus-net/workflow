# ACP Research — Universal TUI and Agent Client Protocol Evaluation

**Status:** Research findings, pre-decision. Authored for independent sanity check before any architectural commitment.

**Date:** 2026-09-14

## Provenance and how to review this document

This document was produced in one research session from public sources. Two provenance levels are marked:

- **[D]** — verified by direct fetch of the linked primary source during the session (ACP protocol overview, ACP agents registry page, stdiobus.com, github.com/stdiobus/stdiobus).
- **[R]** — reported by research subagents citing the linked primary source. The URL is the claimed source; spot-check these before relying on them for the decision.

Time-sensitivity: several facts are snapshot-dependent (preview statuses, org moves, product transitions, star counts). Re-verify anything load-bearing.

**Suggested reviewer checklist:** Section 12 lists the specific claims most worth independently re-verifying, in priority order.

## Terminology

"ACP" here means the **Agent Client Protocol** (agentclientprotocol.com): a JSON-RPC protocol between a *client* (editor/TUI — the UI that a user interacts with) and an *agent* (a coding-agent process). It is unrelated to IBM/BeeAI's **Agent Communication Protocol** (agent↔agent interoperability, Linux Foundation orbit). This document concerns only the Agent Client Protocol.

## 1. Research question

Workflow (this repo) currently ships a vendored, patched Cline CLI 3.0.61 as its interactive TUI, with authorization enforced by patch seams, and a loopback hub (`workflow-hub`) as the universal authority (`docs/HUB.md`, `docs/HUB_PROTOCOL.md`).

The proposal under evaluation: **use ACP as the universal glue between agent CLIs and the workflow-hub, and serve sessions from the hub to any surface (TUI, web, monitor, cron)** — instead of patching each agent's SDK. This repo is intended to replace the operator's current OpenCode + opencode-workflow-guard daily-driver setup.

## 2. ACP protocol facts

Transport and shape **[D]** (`https://agentclientprotocol.com/protocol/overview`):

- JSON-RPC 2.0; agents typically run as subprocesses of the client; NDJSON framing (one message per line) over stdio **[R]** (`https://agentclientprotocol.com/protocol/v1/transports`).
- Flow: `initialize` → optional `authenticate` → `session/new`, capability-gated `session/load`, or capability-gated `session/resume` → prompt turns (`session/prompt`, `session/update` notifications, `session/cancel`). **[D]**
- All file paths absolute; line numbers 1-based; camelCase keys, snake_case discriminators. **[D]**
- Extensibility is built in: `_meta` fields, underscore-prefixed custom methods, custom capabilities negotiated at `initialize`. **[D]**

Client-side methods **[D]** (listed on the overview page; semantics per linked spec pages):

- `session/request_permission` — **baseline client method**, but agents are not required to invoke it before tool execution: the v1 spec says an agent **MAY** request permission. When invoked it is a blocking JSON-RPC request. The agent supplies opaque permission options whose `kind` hints are `allow_once / allow_always / reject_once / reject_always` (a UI hint, not a semantic guarantee); the client answers with `outcome: selected(optionId) | cancelled`. `cancelled` is for cancellation of the current prompt turn, not an ordinary policy denial. Clients may auto-select an option according to user settings. **[D]** (`https://agentclientprotocol.com/protocol/v1/tool-calls`)
- Optional, capability-gated: `fs/read_text_file`, `fs/write_text_file` (agent file IO can be delegated to the client) and the `terminal/*` family (`create`, `output`, `release`, `wait_for_exit`, `kill`) — agent shell execution can be delegated to the client. **[D]** for existence; semantics **[R]** (`https://agentclientprotocol.com/protocol/v1/terminals`)
- Optional, capability-gated: `elicitation/create` (structured user input), `elicitation/complete`. **[D]**

Versioning and SDKs **[R]**:

- Wire version is a single integer negotiated in `initialize`. Current stable = **1**. A **v2 draft** exists for review/testing (`https://agentclientprotocol.com/announcements/acp-v2-draft`).
- Official TypeScript SDK: `@agentclientprotocol/sdk` v1.4.0, zero runtime dependencies, ~5.6M weekly downloads; 1.0 milestone announced 2026-06-25 (`https://agentclientprotocol.com/announcements/sdk-1-0-releases`). v2 exposed under `/experimental/v2`, marked breakable. Official SDKs also exist for Rust, Python, Kotlin, Java. Older `@zed-industries/*` package names are deprecated/moved.
- Governance has moved off Zed Industries to the `agentclientprotocol` GitHub org (own site, registry, governance; new lead maintainer announced). Registry is curated — listing requires implementing ACP authentication (`https://github.com/agentclientprotocol/registry`).
- Streamable HTTP transport is a draft RFD; a transports working group is stabilizing remote transports. Stdio is the stable transport today.

## 3. ACP capabilities mapped to Workflow requirements

| Workflow need (repo artifact) | ACP mechanism | Fit |
|---|---|---|
| Pre-mutation authorization (`AcpHostAdapter`, `/before-tool`) | `session/request_permission` — blocking when the agent chooses to invoke it | **Conditional.** ACP standardizes the permission interaction but does not require an agent to request permission before mutation. `authoritativePreMutation: true` therefore remains an agent/runtime integration claim exactly as `docs/HOST_ADAPTERS.md` requires. Each supported agent must prove that every relevant mutation is intercepted, or the integration stays advisory. |
| Contained shell execution (`/bash`, bubblewrap) | `terminal/*` client capability — hub can back delegated terminals with `WorkflowContainedProcess` | **Conditional.** Strong only when the specific agent delegates all relevant process execution to the client; ACP does not prevent direct process APIs. Bubblewrap remains the enforcement floor. |
| Workspace-bound file policy | `fs/read_text_file` / `fs/write_text_file` client capabilities | **Conditional.** Capability advertisement enables delegation but does not prohibit direct agent-process filesystem access. Per-agent conformance plus OS containment is required for an enforcement claim. |
| Session streaming to surfaces | `session/update` notifications (messages, tool calls, plans, mode changes, command lists) | Adequate for live projection when the specific agent emits the needed updates; ACP does not make this stream canonical durable conversation history. Persistence/replay fidelity remains a separate per-agent concern. |
| Cancellation | `session/cancel` | Adequate. |
| Session resume (W029) | `session/load` (restore + replay) and `session/resume` (restore without replay), both capability-gated | **Partial** — per-agent gap; see §12 question 5. |
| Plan/Act-style modes | `session/set_mode` + agent-advertised modes | Adequate. |
| Slash commands | `available_commands` updates | Adequate. |
| Task graph, evidence, verification, review gates (kernel) | **None — out of ACP's scope** | Stays hub-side by design; ACP is agent transport, not authority. |
| Token-economy MCP plumbing (lazy discovery, truncation, notification forwarding — currently patch seams) | None — agent owns its MCP stack; MCP servers are passed in `session/new` | **Gap.** Keeping these features over ACP requires a hub-side MCP proxy (hub advertises itself as the MCP endpoint, proxies lazily to the toolbox). New work, protocol-level. |

## 4. Agent ecosystem (ACP support)

**[R]** unless noted. Registry pages: `https://agentclientprotocol.com/get-started/agents` (partially verified **[D]**), `https://agentclientprotocol.com/get-started/registry`.

| Agent | ACP support | Mechanism | Notes |
|---|---|---|---|
| **Cline** | Native | `cline --acp` | Registry lists v3.0.61 — the same line this repo vendors (`https://docs.cline.bot/usage/acp`). Enables A/B testing patched-SDK vs stock-ACP on the *same* agent version. **Single-source claim; verify (§12.1).** |
| **OpenCode** | Native | `opencode acp` | Docs: `https://opencode.ai/docs/acp/`. Org moved `sst/opencode` → `anomalyco/opencode`. `/undo`,`/redo` unsupported over ACP. |
| **Gemini CLI** | Native | `gemini --acp` | ACP-mode docs: `https://www.geminicli.com/docs/cli/acp-mode/`. Product line reportedly transitioning to "Antigravity CLI" (June 2026); ACP mode survives but investment shifted — longevity risk (§12.6). |
| **Claude Code** | Adapter | `@agentclientprotocol/claude-agent-acp` | Zed-maintained, built on Claude Agent SDK; feature-rich (images, edit review, terminals, MCP passthrough, subagent transcripts). `https://github.com/agentclientprotocol/claude-agent-acp` |
| **Codex CLI** | Adapter | `@agentclientprotocol/codex-acp` | Translates ACP ↔ OpenAI's own `codex app-server` (`https://developers.openai.com/codex/app-server`). OpenAI declined native ACP; community-bridged. |
| **Goose** | Native | `goose acp`; `goose serve` (ACP over HTTP+WS) | Donated to Linux Foundation AAIF (April 2026). One of few with a network transport. |
| **GitHub Copilot CLI** | Native, **public preview** | `copilot --acp` (stdio or TCP) | Announced 2026-01-28 (`https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/`). Quirks: tool filters/effort set at server launch, not per session; some slash commands unavailable. |
| **Qwen Code** | Native | `qwen --acp`; experimental `qwen serve` (HTTP+SSE) | Gemini-CLI fork lineage. |
| **Kimi CLI → Kimi Code** | Native | `kimi acp` | Python CLI winding down; TS rewrite keeps ACP. |
| **Mistral Vibe** | Native | `vibe-acp` binary | Official ACP setup docs. |
| **Augment Auggie** | Native | `auggie --acp` | Caveat: "not all features available in interactive mode are supported in ACP mode." |
| **Factory Droid** | Native | `droid exec --output-format acp` | No session restore in Zed. |
| **Cursor CLI** | Native | per `cursor.com/docs/cli/acp` | — |
| **Pi** | Adapter | `pi-acp` | Community adapter. |
| **Amp** | Community adapter | `amp-acp` | Low adoption; not Sourcegraph-maintained. |
| **Crush** | **None** | — | Holdout; ships own HTTP/SSE server instead. |
| Others in registry | mixed | — | Junie, Kiro, OpenHands, Docker cagent, Hermes, Poolside, Qoder, Stakpak, VT Code, and a long tail of smaller agents. |

## 5. Client / universal-TUI landscape

**[R]** unless noted. Clients list: `https://agentclientprotocol.com/overview/clients`.

| Project | What it is | Mechanism | Maturity / license |
|---|---|---|---|
| **Toad** (`https://github.com/batrachianai/toad`) | The only credible **universal interactive terminal ACP client**: chat UI, embedded shell, diffs, concurrent sessions, resume, agent "app store" from the ACP Registry, `toad serve` web mode | ACP client (Python/Textual) | ~3.4k★, active since Jan 2026, **solo maintainer**, **AGPL-3.0 + commercial dual license**. Roadmap items blocked on ACP spec evolution (e.g., model selection). |
| **Martty** (`https://github.com/openma-ai/Martty`) | Interactive ratatui ACP TUI | ACP client (Rust) | ~73★, very early, MIT. |
| **acpx** (`https://github.com/openclaw/acpx`) | **Headless** ACP client for scripting/agent orchestration; NDJSON event output; policy modes approve-all/deny/ask | ACP client (TypeScript) | ~3.2k★, pre-1.0, MIT. Candidate as external conformance reference for a Workflow ACP client. |
| **Zed** | Reference ACP client (editor): permissions UI, fs/terminal client capabilities, MCP forwarding, session import/resume, registry install | ACP client (Rust/GPUI) | Production; canonical reference implementation. `https://zed.dev/docs/ai/external-agents` |
| **CodeCompanion.nvim** | Neovim ACP adapter, full chat + approvals in-editor | ACP client (Lua) | ~6.9k★, active, Apache-2.0. Proof small teams can implement the client surface. |
| **agent-shell + acp.el** | Emacs ACP client | ACP client (Elisp) | ~1.9k★, on MELPA; acp.el marks itself "not API stable". |
| **Vibe Kanban** | Kanban orchestration over CLI agents (worktrees, diffs, PRs) | Wraps vendor CLIs with **auto-approve flags** (`--dangerously-skip-permissions`, `--yolo`, …); no protocol-level permission seam | ~28k★ but **officially sunsetting** (`https://www.vibekanban.com/blog/shutdown`). Evidence against the CLI-multiplexing approach. |
| **Conductor / Crystal / Superset** | GUI terminal/worktree multiplexers | pty multiplexing of agents' own CLIs; approvals stay inside each agent's native TUI | Conductor proprietary; Crystal deprecated Feb 2026; Superset ~14k★, Elastic License. No unified authorization seam. |

**State of the art:** no mature, dominant universal interactive TUI over ACP exists. The niche is validated (Toad's traction) but unoccupied by a strong incumbent.

## 6. Alternatives evaluated

| Alternative | Assessment | Verdict |
|---|---|---|
| **Per-SDK enforced seams** — Claude Agent SDK `canUseTool` / `PreToolUse` hooks / `--permission-prompt-tool` (`https://code.claude.com/docs/en/agent-sdk/permissions`); Gemini CLI TOML policy engine + synchronous `BeforeTool` hooks (`https://github.com/google-gemini/gemini-cli` docs); Codex `app-server` server→client approval requests | All viable, all vendor-locked. Notably, these are exactly what the maintained ACP adapters already wrap. | Rejected as the *universal* layer; retained as fallback for non-ACP hosts (existing `TranslatingHostAdapter` pattern). For Claude/Codex, prefer consuming the maintained adapters over writing new SDK integrations. |
| **Headless CLI multiplexing** (stream-json wrappers, Vibe Kanban style) | No per-action authorization seam; forces auto-approve; human control only at diff-review stage. The generation is retreating (VK sunsetting, Crystal deprecated). | Rejected — architecturally incompatible with "nothing mutates without Workflow authorization". |
| **OpenCode server API as universal backend** (`https://opencode.ai/docs/server`) | Clean client/server split with a permission-response endpoint, but the API is OpenCode-shaped: it drives OpenCode only. OpenCode is itself an ACP *agent*, not a universal backend. | Rejected as universal layer. Note: `opencode acp` is a first-class spike target (§10). |
| **MCP as the session/authority layer** | MCP is tool exposure (agent-as-tool); wrong direction for interactive session authority and per-action human gating. | Rejected for sessions; MCP remains correct for the toolbox boundary. |
| **stdio Bus** (`https://stdiobus.com/`, spec v2.0.3) **[D]** | Single-threaded C11 daemon: process supervision + NDJSON/JSON-RPC routing with session affinity and backpressure. **Explicitly semantics-agnostic by spec**: "SHALL NOT validate JSON-RPC semantics" (§4.3), "SHALL NOT modify message content" (§4.2.3), semantics out of scope (§1.2). Its "deterministic" means deterministic *routing*, not domain authority. ~19★, 24 commits, Apache-2.0, single author. Ecosystem: `@stdiobus/mcp-agentic` (MCP bridge to ACP agents), `mcpx`, `skills`, workers-registry. | **Not a substitute and not a competitor.** It is the transport layer *below* the design under evaluation: it cannot authorize because it never inspects payloads. No adoption case for Workflow: the hub is authority-bound, not throughput-bound, and Node can supervise a handful of agent subprocesses without a C dependency. Its existence mildly validates the general shape (local daemon interposing between clients and agent processes over JSON-RPC) — Workflow's hub is the semantic/authority version of that shape. |

## 7. Fit with Workflow's existing architecture

Repo artifacts that already anticipate this direction:

- `src/adapters/acp.ts` — `AcpHostAdapter` already translates an **internal ACP-correlated shape** into `ProposedToolAction`, so the kernel-side contract is reusable. It is not currently an ACP v1 wire adapter: standard permission requests do not carry Workflow's `taskId`, the adapter's `capability`, or a `toolCall.name`, and its `{ outcome: "reject_once", reason }` deny control is not a valid v1 permission response. A hub ACP integration therefore needs a thin correlation/normalization layer plus a permission-response translator. On Workflow denial it may select an agent-provided rejecting `optionId`; if the request offers no rejecting option, the integration must fail closed (for example by cancelling/terminating the turn or session according to the agent's proven behavior), never fabricate a rejection option or misuse ACP's `cancelled` outcome as an ordinary denial. Supplying a usable rejecting option is therefore part of per-agent enforcement conformance.
- `docs/HUB.md` — "universal authority for every surface" thesis; surfaces fail closed without the hub.
- `docs/HUB_PROTOCOL.md` — SDK-neutral versioned contract; §6 allows additive evolution (session endpoints would be a compatible v2 addition).
- `docs/UI_INTEGRATION.md` — surfaces are projections; they never own canonical state.
- `docs/HOST_ADAPTERS.md` — per-SDK adapter pattern with conformance tests remains the fallback path for non-ACP hosts.

### The placement rule this evaluation converged on

**The ACP client belongs hub-side, not in the TUI.** Here "owns sessions" means Workflow owns ACP connections, subprocess lifecycle, surface attachment/routing, authorization state, and the mapping from Workflow sessions to opaque agent session IDs. The ACP agent still owns its conversation context and persistence unless Workflow separately reconstructs that state.

```
ACP agents (cline --acp, opencode acp, gemini --acp, claude/codex via adapters)
      ▲  ACP over stdio — hub is the client; hub spawns agents (ideally under bubblewrap)
      │
workflow-hub  ← owns session orchestration; permission policy = WorkflowApplication.authorize;
      │          fs/terminal delegation routes to containment; evidence/review gates unchanged
      │  hub protocol (v1 + additive session/prompt/stream/cancel endpoints)
      ▼
Surfaces: TUI, monitor, web, cron, connectors — projections only; zero ACP knowledge
```

Rationale: if the TUI owns the ACP connection, cron/headless/connectors must each reimplement session handling, and fail-closed authority splits across surfaces — the exact fragmentation `docs/HUB.md` was written to eliminate. Hub-side orchestration mirrors what already exists (`createWorkflowHubHooks` injects hooks into every hub-started session; ACP becomes the transport those sessions use). This placement does **not** make the agent stateless: crash recovery still depends on each agent's `session/load`/`session.resume` support or on a future Workflow-owned reconstruction mechanism.

Adding prompt/stream/cancel/session control also changes the hub's security surface. The current ordinary discovery token must not automatically become an unrestricted capability to attach to, prompt, cancel, or resolve permissions for arbitrary sessions. Any session extension to `HUB_PROTOCOL.md` must define surface/session attachment, workspace binding, and which principals may prompt, cancel, observe, and resolve permission requests before it is treated as an additive implementation detail.

## 8. What changes vs. the current vendor-patch strategy

- **Can stop being necessary for authorization/session control after conformance proof:** reaching inside Cline's process via patch seams (`beforeTool`, bash executor routing) may be retired for an ACP agent only after the specific launch mode proves equivalent mutation interception and containment. Native ACP support alone is insufficient. ACP capability negotiation reduces protocol/version drift; it does not certify enforcement coverage.
- **Does not automatically carry over:** the token-economy MCP plumbing (lazy discovery, 48k truncation, notification forwarding). Over ACP the agent owns its MCP stack; retaining these features needs a hub-side MCP proxy (§3 table). This is the largest hidden work item in the migration.
- **Unchanged:** kernel invariant (`model proposes → Workflow authorizes → …`), containment (bubblewrap — neither ACP nor SDK hooks stop a misbehaving agent *process* at OS level), persistence/recovery semantics, review gate.
- **Unique validation opportunity:** the vendored Cline pin (3.0.61) is also the ACP-registry version of Cline's native ACP support **[R — verify]**, so the *same agent version* can be run both routes (patched-SDK vs stock-ACP) and behavior-diffed before retiring any patch surface.

## 9. Risks and caveats

1. **ACP permission requests are cooperative, not mandatory interception.** The v1 protocol says an agent **MAY** call `session/request_permission`; native ACP support therefore cannot by itself justify `authoritativePreMutation: true`. Agents also ship auto-approve modes (e.g., Cline's per-session auto-approve toggle / `--auto-approve`). Launch configuration is part of the trust boundary, but forcing "ask" is sufficient only when the specific agent guarantees that all relevant mutations use that path. `enforced`/`advisory` reporting (`docs/HOST_ADAPTERS.md`) must reflect per-agent conformance evidence, not the transport.
2. **fs/terminal delegation is optional and non-exclusive.** Gemini's ACP mode reportedly proxies fs through the client **[R]**; adoption by the Claude/Codex adapters and others must be verified per agent before claiming client-mediated IO (§12.4). Even when advertised and used, these capabilities do not prevent the agent process from accessing OS APIs directly; containment must cover that residual path.
3. **Protocol-level gating ≠ OS-level containment.** A well-behaved agent honors denial; a buggy/malicious one can still write directly. Bubblewrap around the agent subprocess remains the enforcement floor. Consistent with `THREAT_MODEL.md`.
4. **Adapter quality asymmetry.** Codex is a translation layer over `codex app-server` (OpenAI declined native ACP); Claude is SDK-adapter-based; Copilot ACP is preview-grade with launch-time-only config; Gemini's product line is transitioning (Antigravity). Per-agent conformance testing (existing `test/acp-adapter.test.ts` pattern) becomes *more* important, not less.
5. **Protocol youth.** Wire v1 is stable, but v2 exists as a draft and features (e.g., model selection UX) are still landing via capability extensions. Build against v1; keep the adapter boundary thin; track the v2 migration guide.
6. **Toad license.** AGPL-3.0 + commercial: its *code* is not reusable inside Workflow under permissive terms; its *approach* is usable as prior art. Martty (MIT, Rust) and acpx (MIT, TS) are cleaner references.
7. **Supply-chain note.** Several agents moved orgs recently (OpenCode `sst`→`anomalyco`; Goose→AAIF; ACP itself off Zed Industries). Re-confirm provenance before adding any agent binary to the trusted launch set.
8. **Feature fidelity ceilings.** Checkpoints/rewind, Cline team tasks, per-agent chrome: uneven or absent in ACP. ACP smooths agent differences; it does not erase them.
9. **Session control strengthens the hub bearer capability.** A surface that can initiate prompts, attach to sessions, cancel work, or resolve permission requests has more authority than a passive projection. Session APIs need explicit attachment and authorization semantics rather than inheriting the ordinary discovery token by default.

## 10. Recommendation (subject to independent review)

Directionally: **adopt ACP as the preferred agent interoperability/session transport, hub-side, with SDK adapters retained as the fallback for non-ACP hosts and for ACP integrations that cannot prove complete interception.** This extends the existing adapter architecture rather than replacing its trust model. ACP events can feed the same kernel path after wire normalization/correlation; per-agent conformance determines whether that path is `enforced` or `advisory`, and OS containment remains the enforcement floor against direct process access.

Suggested sequencing:

1. Spike a hub-side ACP client against `opencode acp` (the operator's current daily driver — cheapest realistic target) and `cline --acp`, headless before choosing the long-term operator surface. Add the ACP-wire correlation/normalization and permission-option selection layer in front of `AcpHostAdapter` → `WorkflowApplication.authorize`, failing closed when a denied request provides no rejecting option. Use `acpx` as an external protocol reference.
2. Make the spike a security/conformance test, not just a connectivity demo: for each agent and launch mode, enumerate mutating tools and prove that each either blocks on Workflow authorization or is impossible outside Workflow because of containment. Include direct filesystem/process bypass attempts and auto-approve configuration. An agent that cannot meet this remains advisory or keeps its SDK seam.
3. Specify hub session-control principals before implementation: surface/session attachment, workspace binding, observe/prompt/cancel rights, permission-resolution rights, and behavior across hub/agent restarts. Then extend `HUB_PROTOCOL.md` with the resulting session endpoints.
4. Decide the token-economy question: hub-side MCP proxy vs. accepting feature loss per agent.
5. Evaluate a clean Workflow terminal surface against the hub session stream (stack-consistent, license-clean), using Toad/Martty only as prior art. Do not commit the patched Cline Ink terminal as the long-term base until this evaluation shows a material gap it cannot close.
6. Keep the patched Cline Ink terminal operational as the fallback/migration surface while the ACP spike and clean-surface evaluation run. Fall back to it only if the clean surface cannot reach daily-driver parity or the spike exposes a requirement the hub cannot yet satisfy.
7. Only then evaluate retiring patch seams, using the A/B and enforcement evidence from steps 1–2 and the surface decision from steps 5–6.

## 11. Spike evidence snapshot (2026-09-14)

Implemented the first three low-level slices behind the spike:

- `src/adapters/acp-wire.ts` — minimal ACP v1 wire parsing plus NDJSON stdio framing; focused tests cover multi-byte/split/malformed messages.
- `src/adapters/acp-permission.ts` — correlates real permission requests with Workflow-owned session/task/tool identity and returns either `selected(optionId)` for an agent-provided reject option or an explicit fail-closed signal when no usable reject option exists.
- `src/adapters/acp-subprocess.ts` — headless subprocess client covering `initialize`, optional `authenticate`, `session/new`, `session/prompt`, live `session/update` projection, cancellation, malformed output, and process-exit failure against `test/fixtures/fake-acp-agent.mjs`.

Verification boundary: the full suite is intentionally run with memory caps on this host. Latest full verification after the containment-integration slice (below): `NODE_OPTIONS=--max-old-space-size=768 npm test` passed 339 tests, with 7 gated real-agent probes skipped, 0 failed. `npm run typecheck` and `npm run lint` passed.

Tool-coverage matrix: the resolver now recognizes the complete Cline 3.0.61 approval-gated tool surface mirrored from `apps/vscode/src/sdk/sdk-tool-policies.ts` and `apps/cli/src/acp/tool-utils.ts` — read tools (`read_files` incl. `file_paths`/`paths` variants, `read_file`, `list_files`, `list_code_definition_names`, `search_files`, `search_codebase`), edit tools (`editor`, `replace_in_file`, `write_to_file`, `write_file`, `apply_patch`, `delete_file`), process tools (`run_commands`, `execute_command`), and fetch tools (`fetch_web_content`, `web_fetch`, `web_search`). Path tools map path subjects and fail closed without one; process tools must carry usable command metadata and expose only `cwd` as a subject — command text never becomes a subject because the kernel checks every subject with `pathWithinWorkspace` (command-shaped pseudo-subjects would be wrongly denied); unknown tools advertising mutation/process/network/credentials capabilities still fail closed before authorization.

Real-agent evidence gathered before stopping real probes:

| Agent / launch | Evidence | Current conformance implication |
|---|---|---|
| `opencode acp` 1.18.30 | `initialize` succeeded with protocol v1; advertised `loadSession`, session `close`/`fork`/`list`/`resume`, MCP HTTP/SSE, image/embedded-context prompts. `session/new`, a read-only prompt, and one bounded edit probe completed. The edit changed a disposable file from `before` to `after` and emitted `tool_call`/pending/in-progress/completed updates, but no `session/request_permission` was sent before mutation. | Viable live-session transport candidate; current launch mode is **not** authoritative pre-mutation interception. It must remain advisory unless a stricter launch/configuration proves complete permission coverage. |
| `cline --acp --auto-approve false` 3.0.61 with `CLINE_API_KEY`/`CLINE_PROVIDER=openrouter` | `initialize`/`session/new` succeeded after using the documented env-auth path. File path coverage: Cline sent permission requests for reads and edits; allow changed the file, deny left it unchanged. Process coverage: Cline sent permission requests before `run_commands`; allow executed `echo -n 'shell' >> shell-target.txt`, deny left the file unchanged. All observed requests supplied `allow_once`, `allow_always`, and `reject_once`. The Workflow resolver recognizes the complete Cline approval-gated tool surface: file tools map path subjects and fail closed without one, and process tools (`run_commands`/`execute_command`) validate command metadata while exposing only `cwd` as a subject. **Contained launch (2026-09-14):** the agent process itself ran under Bubblewrap (`launchContainedAcpAgent`, network `host`, scratch `HOME`) and completed `initialize`/`session/new`/`prompt`; permission interception still fired before all six observed actions; the allowed workspace write took effect; a host-home canary with a random unguessable secret stayed invisible despite read attempts and an active `find /` search; a `/tmp` escape write never reached the host. | Strongest current ACP candidate: pre-read/pre-edit/pre-process permission interception with usable reject options and denial honored, **plus** whole-process OS containment with workspace-only writes. fs/terminal delegation is proven *absent* (below), so containment is achieved by launching the agent inside the boundary. |

Local Cline auth investigation without opening a browser: `cline auth --help` supports `cline auth --provider openrouter --apikey ...`, and the operator has a local `~/.cline/data/settings/providers.json` (mode 0600; contents not read or copied). Cline's ACP `initialize` response advertised only `cline`, `cline-pass`, and `openai-codex` auth methods, not an OpenRouter ACP auth method, and a probe using existing provider state without `authenticate` still failed `session/new`. The current Cline ACP docs resolve the intended non-browser path: set `CLINE_API_KEY`, with optional `CLINE_PROVIDER` and `CLINE_MODEL`, in the ACP agent launch environment. With those supplied externally (`CLINE_PROVIDER=openrouter`), the Cline ACP handshake probe completed without printing the key. **Correction (2026-09-16, stock 3.0.62 PATH build):** that env-auth path is a vendored-surface capability, not a stock one — stock Cline in ACP mode is account-cloud-only (its `initialize` advertises no API-key auth method, and headless key sessions fail with `re-authenticate your Cline account`), so the vendored patched binary (`--acp --provider openrouter` + `CLINE_API_KEY`) is the only headless Cline path.

The immediate W035 conclusion is now asymmetric: OpenCode is a viable first ACP transport spike target, but its observed default ACP mode allowed an edit without an ACP permission request. Cline ACP with `CLINE_API_KEY`/`CLINE_PROVIDER=openrouter` and `--auto-approve false` demonstrated real pre-read/pre-edit/pre-process permission requests, usable `reject_once` options, allow-mode mutation, and deny-mode prevention — and, launched inside the Bubblewrap boundary, workspace-only filesystem effects under direct bypass attempts. Cline is therefore the leading ACP enforcement candidate.

Containment integration (2026-09-14): hub-backed ACP `terminal/*` routing is **unavailable for this agent generation** — Cline 3.0.61's ACP `initialize` ignores client capabilities and all tool execution stays inside the agent process (`apps/cli/src/acp/acpAgent.ts` builds `createCliCore` with `requestAcpToolApproval` as the only client callback; no `terminal/*` or `fs/*` call exists anywhere in its ACP source). The current ACP spec confirms terminal delegation is client-capability-gated and optional for agents. The enforced path is therefore launching the agent process itself under Bubblewrap: `LinuxBubblewrapContainment.spawn` (new streaming counterpart to the buffering `execute`, sharing one policy builder) plus `launchContainedAcpAgent`, which fails closed unless the backend reports an `enforced` isolation marker. `ProcessContainment.isolation` is now explicit (`enforced` vs `policy-only`) so a passthrough can never masquerade as a contained agent launch. One boundary repair was required: systemd-resolved symlinks `/etc/resolv.conf` into `/run`, which the sandbox does not bind, so host-network processes got `EAI_AGAIN`; the boundary now also ro-binds the resolved target. The remaining trade-off is deliberate: the contained agent runs with network `host` (model API egress) — the enforced properties are filesystem isolation and credential clearing, not network isolation.

The gated contained probe (`test/acp-cline-contained-probe.test.ts`) asserts host-filesystem invariants rather than model behavior: the allowed workspace command executed, the random-secret canary in the real home never appeared in session updates (even after the agent ran `find / -iname 'workflow-acp-canary*'`), and the `/tmp` escape file never existed on the host.

### Patched-SDK versus stock-ACP on the pinned 3.0.61 line (2026-09-14)

The patched build (`patches/cline-cli-v3.0.61-workflow.patch`) does not touch `apps/cli/src/acp/`, so its ACP mode behaves exactly like stock; the stock-ACP evidence above applies to both builds. The comparison is therefore between the patch's `workflow-bridge` integration and stock ACP on the same pinned agent line:

| Axis | Patched-SDK (workflow-bridge on 3.0.61) | Stock ACP (`cline --acp` 3.0.61) |
|---|---|---|
| Interception point | SDK `AgentHooks.beforeTool` → hub `POST /before-tool`; every tool call, in-process; bridge unavailable fails closed (`stop`) | ACP `session/request_permission` over stdio; only tools Cline routes through approval; coverage depends on the `--auto-approve false` launch flag |
| Process execution | hub `POST /bash` → `WorkflowContainedProcess` → per-command Bubblewrap (network `isolated` by default) | inside the agent process; containment only via whole-agent Bubblewrap launch, which requires network `host` for the model API |
| Filesystem scoping | kernel workspace policy on every `beforeTool`; ambient filesystem stays visible to the agent process itself | resolver path subjects → kernel workspace policy, **plus** whole-agent Bubblewrap filesystem isolation (ambient home hidden, proven by canary evidence) |
| Session/streaming | Cline native loop owns conversation; hub receives task sync via `afterTool` `team_task` | hub projects `session/update` live |
| Patch burden | pinned patch (`workflow-bridge.ts`, TUI integration) must be re-applied and re-verified per Cline release | stock binary, no patch |
| Runtime evidence | W023/W024: real `@cline/core` session on the same `AgentHooks`/`ShellExecutor` seam family (0.0.82) with commands routed through Bubblewrap and `git diff --check` independently verified; bridge endpoints runtime-tested server-side (`test/hub-guard-interception.test.ts`); patch units in the 3.0.61 checkout | W035: env-auth handshake (via the vendored build — stock is account-cloud-only in ACP mode, see the 2026-09-16 correction below), permission interception with allow/deny honored, complete gated-tool matrix, whole-agent contained launch with direct bypass attempts failing |

Decision-relevant asymmetries: patched-SDK can run per-command network-isolated containment and intercepts tools Cline never gates over ACP, at the cost of maintaining a pinned patch; stock-ACP needs no patch and gains filesystem isolation for the *entire* agent process, but its contained launch must allow network egress and its interception covers only Cline's approval-gated tools. ~~Both require the same env-auth (`CLINE_API_KEY`/`CLINE_PROVIDER=openrouter`).~~ **Corrected 2026-09-16:** only the vendored surface accepts env-key auth — stock Cline (3.0.62 PATH) is account-cloud-only in ACP mode. Stock-ACP needs an interactive account-cloud login and cannot run headless, so the gated MCP mount probe (`test/acp-cline-mcp-mount-probe.test.ts`) is retargeted at the vendored entry; its live runs (2026-09-16, twice reproduced) record a negative finding — `NO_MCP_TOOLS` against every scratch-home candidate config path — so hub-owned MCP-config delivery to a fresh scratch home is not honored by the vendored 3.0.61 ACP surface and the F1/G3 mounts stay deferred (see `docs/ACP_SURFACE.md` §4).

## 12. What was deliberately NOT recommended

- Building another ACP *agent* (Workflow is an authority, not an agent).
- Adopting stdio Bus or any transport router (§6).
- CLI-multiplexing/auto-approve orchestration (§6).
- Forking Toad (AGPL).
- Writing own Claude/Codex SDK integrations where maintained ACP adapters exist.

## 13. Open questions for the reviewing model (priority order)

1. Verify Cline's native ACP support and the registry version claim (v3.0.61) — `https://docs.cline.bot/usage/acp`, `https://agentclientprotocol.com/get-started/registry`. Single-source; load-bearing for §8's A/B claim.
2. Confirm per candidate agent that every relevant mutation actually invokes `session/request_permission` in the intended launch mode. ACP itself only says the agent **MAY** request permission, so this must be established by agent documentation and executable conformance tests. Also verify the agent always supplies a rejecting option that Workflow can select by `optionId`; absent that proof, denial must fail closed by stopping the affected turn/session and the integration cannot claim normal ACP permission-path enforcement.
3. For each candidate agent, can "ask before every mutation" be forced at launch, and are there known bypasses? (Cline auto-approve; Gemini approval modes; Copilot tool filters; OpenCode permissions over ACP.) Test direct filesystem/process behavior under containment rather than relying only on UI-visible permission events.
4. Which agents actually delegate fs and/or terminal to ACP client capabilities today (Gemini reportedly yes; Claude/Codex adapters? OpenCode? Cline?), and which mutation paths remain internal to the agent process?
5. Per-agent `session/load` and `session/resume` support — Workflow's resume semantics (W029) depend on the distinction between restore-with-replay and restore-without-replay, while agent conversation state remains agent-owned.
6. Re-verify Toad's license and independence claims; re-scan for any newer mature terminal ACP client missed by this research.
7. Review the ACP v2 draft for breaking changes affecting v1 clients — `https://agentclientprotocol.com/announcements/acp-v2-draft`.
8. Validate the multiplexer-retreat claims (Vibe Kanban sunset post, Crystal deprecation) — used as evidence in §6.
9. Assess the Gemini CLI → Antigravity transition's impact on `gemini --acp` longevity.
10. Sanity-check §7's placement rule and session-principal model against failure modes this document may have missed (e.g., hub as single point of session failure, stale surface attachment after restart, cross-workspace session access, and latency of hub-mediated permissions).

## 14. References

Protocol and governance:

1. `https://agentclientprotocol.com/protocol/overview` — communication model, method inventory **[D]**
2. `https://agentclientprotocol.com/protocol/v1/transports` — NDJSON-over-stdio transport **[R]**
3. `https://agentclientprotocol.com/protocol/v1/tool-calls` — permission request semantics **[R]**
4. `https://agentclientprotocol.com/protocol/v1/terminals` — terminal client capability **[R]**
5. `https://agentclientprotocol.com/get-started/agents` — agent registry page **[D]**
6. `https://agentclientprotocol.com/get-started/registry` — curated registry **[R]**
7. `https://agentclientprotocol.com/announcements/sdk-1-0-releases` — SDK 1.0 milestone **[R]**
8. `https://agentclientprotocol.com/announcements/acp-v2-draft` — v2 draft **[R]**
9. `https://www.npmjs.com/package/@agentclientprotocol/sdk` — TS SDK v1.4.0 **[R]**
10. `https://github.com/agentclientprotocol/registry` — registry repo **[R]**
11. `https://agentclientprotocol.com/overview/clients` — client list **[R]**

Agents:

12. `https://docs.cline.bot/usage/acp` — Cline native ACP **[R]**
13. `https://opencode.ai/docs/acp/` — OpenCode ACP **[R]**
14. `https://github.com/anomalyco/opencode` — OpenCode repo (org move) **[R]**
15. `https://www.geminicli.com/docs/cli/acp-mode/` — Gemini CLI ACP mode **[R]**
16. `https://github.com/agentclientprotocol/claude-agent-acp` — Claude adapter **[R]**
17. `https://github.com/agentclientprotocol/codex-acp` — Codex adapter **[R]**
18. `https://developers.openai.com/codex/app-server` — Codex app-server protocol **[R]**
19. `https://goose-docs.ai/docs/guides/acp-providers` — Goose ACP (both directions) **[R]**
20. `https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/` — Copilot CLI ACP preview **[R]**
21. `https://docs.github.com/copilot/reference/acp-server` — Copilot ACP reference **[R]**
22. `https://qwenlm.github.io/qwen-code-docs/en/users/integration-zed/` — Qwen ACP **[R]**
23. `https://github.com/MoonshotAI/kimi-cli` and `https://moonshotai.github.io/kimi-code/en/reference/kimi-acp` — Kimi ACP **[R]**
24. `https://github.com/mistralai/mistral-vibe` — Mistral Vibe ACP **[R]**
25. `https://docs.augmentcode.com/cli/acp` — Auggie ACP **[R]**
26. `https://docs.factory.ai/ide-integrations.md` — Droid ACP **[R]**
27. `https://cursor.com/docs/cli/acp` — Cursor CLI ACP **[R]**
28. `https://github.com/tao12345666333/amp-acp` — Amp community adapter **[R]**
29. `https://github.com/svkozak/pi-acp` — Pi adapter **[R]**
30. `https://github.com/charmbracelet/crush` — Crush (no ACP) **[R]**

Clients and alternatives:

31. `https://github.com/batrachianai/toad` — Toad universal ACP TUI **[R]**
32. `https://willmcgugan.github.io/toad-released/` — Toad announcement **[R]**
33. `https://github.com/openma-ai/Martty` — Martty TUI **[R]**
34. `https://github.com/openclaw/acpx` — acpx headless client **[R]**
35. `https://zed.dev/docs/ai/external-agents` — Zed reference client **[R]**
36. `https://github.com/olimorris/codecompanion.nvim` — Neovim ACP **[R]**
37. `https://github.com/xenodium/agent-shell` / `https://github.com/xenodium/acp.el` — Emacs ACP **[R]**
38. `https://github.com/BloopAI/vibe-kanban` / `https://www.vibekanban.com/blog/shutdown` — CLI multiplexing + sunset **[R]**
39. `https://github.com/superset-sh/superset`, `https://www.conductor.build`, `https://github.com/stravu/crystal` — multiplexers **[R]**
40. `https://code.claude.com/docs/en/agent-sdk/permissions` — Claude SDK permission seams **[R]**
41. `https://github.com/google-gemini/gemini-cli` (docs: policy-engine, hooks) — Gemini policy/hooks seams **[R]**
42. `https://opencode.ai/docs/server` — OpenCode server API **[R]**

stdio Bus:

43. `https://stdiobus.com/` — project overview **[D]**
44. `https://stdiobus.com/spec` — normative spec v2.0.3 (semantics-agnostic quotes in §6) **[D]**
45. `https://github.com/stdiobus/stdiobus` — repo (19★, 24 commits, Apache-2.0 at fetch time) **[D]**

Repo-internal references: `DESIGN.md`, `docs/HUB.md`, `docs/HUB_PROTOCOL.md`, `docs/HOST_ADAPTERS.md`, `docs/UI_INTEGRATION.md`, `docs/FEATURES.md`, `THREAT_MODEL.md`, `src/adapters/acp.ts`, `test/acp-adapter.test.ts`, `TASKS.md` (W005, W027–W031).
