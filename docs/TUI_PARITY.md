# TUI ↔ Web UI parity matrix

Terminal parity with the browser operator UI (`docs/web-ui-feature-tiers.md`
is the web roadmap; the web surface itself is in flight). Terminal parity
means presenting the same *semantics* terminal-natively — not reproducing
browser widgets. Each item carries its status and acceptance evidence;
unchecked items are intentional gaps, not implied support.

## Batch 1 (config options)

| Web item | TUI status | Evidence |
|---|---|---|
| Model/effort/mode pickers (composer-adjacent) | **Parity** — the `/`/Ctrl+P menu cycles every agent-advertised `configOption` (model, mode, thought_level, tool toggles) on the active session without rebuilding it | `test/tui.test.ts`, `test/acp-session.test.ts` (config cycling + `set_config_option` retention) |
| Settings popover for boolean options | **Parity** (menu form) — boolean options cycle in the same menu | `test/tui.test.ts` (options menu) |
| `session/set_mode` client-side when modes aren't configOptions | **Open** (web plans it too; no agent advertises modes-without-options yet) | — |

## Batch 2 (render what the projector drops)

| Web item | TUI status | Evidence |
|---|---|---|
| Plan updates → checklist | **Parity (compact)** — ACP `plan` updates project as `plan done/total — next: …` status rows; the web renders the full list, the terminal renders counts + next step (terminal-native form of the same semantics) | `test/acp-session.test.ts` (plan-update mode) |
| Typed tool cards with status/subjects | **Parity** — tool proposals/outcomes render with subjects and status markers; kind lives in the title | `test/tui.test.ts` (tool rows) |
| Thinking blocks (default collapsed) | **Parity (terminal form)** — `agent_thought_chunk` interleaves as dim `[thinking]` transcript rows; the web's collapse/expand control has no terminal equivalent beyond scrolling, so the TUI shows the compact dim form | `test/tui-tasklist.test.ts` (thinking rows) |
| Usage/cost readout (composer footer) | **Parity** — live `tokens · $cost` in the footer from the metering proxy | `test/tui-tasklist.test.ts` (usage meter) |
| `session_info_update` → title sync | **Parity** — projects as a status row (terminal has no session chrome to title) | `test/acp-session.test.ts` |
| Review verdicts + blocking reasons + claims (A3) | **Parity, TUI-first** — the hub serves run-gate observability on `/snapshot` and the Activity panel renders blocked runs, verdicts, and unverified completion claims | `test/tui-tasklist.test.ts`, `test/hub-snapshot.test.ts` |
| Review follow-ups (P2/P3 ledger) | **Parity, TUI-first** — open follow-ups in the Activity panel | `test/tui-tasklist.test.ts` |

## Tier 1 (protocol-supported, real server work)

| Web item | TUI status | Evidence |
|---|---|---|
| In-thread permission prompts (opt-in ask) | **Different by design** — the TUI resolves permissions through Workflow automatically; the resolver IS the asker. An interactive ask mode is a future option (`acp-workflow-resolver` decides) | `test/acp-permission-ingress.test.ts` |
| Capability toggles (process/network) | **Open** — the TUI grants the fixed set at composition; toggling capabilities is an application-layer change awaiting the same confinement gating the web plan requires | — |
| Workspace confinement | **Parity** — same application-level confinement on every surface | `test/application.test.ts` |

## Tier 2 (client-side value-adds)

| Web item | TUI status | Evidence |
|---|---|---|
| Completion notification | **Parity (terminal form)** — bell on turn completion | `src/ui/tui.tsx` (completion effect) |
| Copy / syntax highlighting | **N/A terminal-native** — selection/copy and 256-color are the terminal's job | — |
| Edit & resubmit | **Parity** — prompt history recall via Ctrl+Up/Ctrl+Down (last 50 prompts; the live draft is preserved while navigating and restored on return), resubmit by recall + Enter | `test/tui-tasklist.test.ts` (history recall) |
| Keyboard shortcuts (cancel, menu, state) | **Parity** — Ctrl+C cancel, Ctrl+P menu, Ctrl+W state, Ctrl+E export, Ctrl+Up/Down history | `test/tui.test.ts`, `test/tui-tasklist.test.ts` |
| Message queue while running | **Parity** — prompts submitted while a turn runs queue (bounded only by memory) and submit in order when the turn ends; cancellation clears the queue — a cancelled turn never auto-continues; failed turns still drain | `test/coding-session-queue.test.ts`, `test/tui-tasklist.test.ts` (You (queued) row) |
| Export transcript to markdown | **Parity** — Ctrl+E writes `workflow-transcript-<timestamp>.md` next to the session (operator action in the operator process, not an agent mutation; empty transcripts refuse by design) | `test/tui-tasklist.test.ts` (export) |
| Follow-the-agent (locations) | **Parity** — subjects render on tool rows | `test/tui.test.ts` |

## Deliberate divergences (stated, not gaps)

- The TUI keeps the coding conversation primary and Workflow supervision
  contextual (`PRODUCT.md`); the web composes richer chrome around the same
  canonical state.
- Enforcement claims are identical on both surfaces because both project the
  hub's authority — neither can show `advisory` as `enforced`.
- The monitor (`workflow-monitor`) attaches to the hub without an agent
  process: usage metering there would need hub-side per-session aggregation
  (open; the metering proxy records per-runtime metrics today).
