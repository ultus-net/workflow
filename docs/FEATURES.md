# Workflow Feature Status

Honest accounting of what exists, how complete it is, and where the caveats
live. Statuses: **Complete** (tested, wired, usable), **Partial** (works but
with documented limits), **Planned** (designed, not built), **Disabled**
(built but deliberately off).

Legend: each entry links its implementation and notes anything a user would
trip over.

## Authority & Policy

| Feature | Status | Notes |
|---|---|---|
| Deterministic task graph (states, dependencies, evidence, mutation epochs) | Complete | `src/kernel/`; no LLM/IO/UI deps |
| Application authorization (capability withholding, workspace binding) | Complete | `src/application/workflow.ts` |
| Process containment (bubblewrap) | Partial | **Linux only**; `src/containment/`; macOS/Windows run with policy gating but no process isolation |
| Persistence (versioned JSON store, exclusive lock) | Complete | restart recovery marks orphaned IN_PROGRESS as FAILED |

## The Hub (universal authority)

| Feature | Status | Notes |
|---|---|---|
| `workflow-hub` daemon (loopback authority, discovery file, atomic lock, single instance) | Complete | `src/integrations/workflow-hub.ts`, `src/cli/hub.ts` |
| Hub protocol v1 (discovery, `/health`, `/before-tool`, `/bash`, `/run/*`) | Complete | `docs/HUB_PROTOCOL.md`; conformance: `test/hub-protocol.test.ts` |
| Per-surface workspace binding | Complete | surfaces declare workspace per request |
| Dedicated task + evidence per scheduled run | Complete | `/run/begin`, `/run/finish` |
| systemd user unit | Complete | `packaging/workflow-hub.service`; Linux/systemd only |
| Surface coverage: TUI, headless, zen, connectors, cron, desktop (`cline-hub`) | Complete | all resolve via env or discovery file, fail closed |

## Surfaces & UX

| Feature | Status | Notes |
|---|---|---|
| `workflow` (patched Cline TUI launcher) | Complete | resolves the hub; refuses to start without it |
| `workflow-monitor` (Ink monitoring TUI) | Complete | task panel, activity panel, log-enriched transcript; `npm run tui:workflow` |
| Pedagogical modes (5 modes, checkpoints, learner profile, PRIMM) | Complete | `src/pedagogy/`; profile at `~/.local/share/workflow/learner-profile.json` |
| Response/build styles (caveman speech, ponytail YAGNI build) | Complete | **model-advisory** — the model can ignore them; live switch with `,` and `.`; summaries kept by design |
| Browser projection | Partial | `src/ui/web.ts` demo; does not have the monitoring panels |
| Pets | Disabled | `docs/PETS.md` |

## MCP Toolbox (12 servers)

| Feature | Status | Notes |
|---|---|---|
| Log + progress emission on every server | Complete | leveled `notifications/message`, `notifications/progress` with progressToken |
| Learner profile as subscribable resource | Complete | learning-mcp only: `workflow://learner-profile` |
| Notification forwarding into agent UI | Complete | vendored patch: MCP notifications → tool-update surface |
| Lazy tool discovery (`CLINE_LAZY_MCP_TOOLS=1`) | Complete | discover/call meta-tools; **limit:** hashed tool names (>64 chars) don't unwrap for subject extraction but still gate as mutation |
| MCP result truncation (48k middle-cut) | Complete | `src/extensions/mcp/manager.ts` in the patch |
| Self-service MCP persistence | Complete | `~/.workflow/cline_mcp_settings.json` |

## Context & Memory

| Feature | Status | Notes |
|---|---|---|
| Compaction ↔ memory bridge (recall at start, flush on completion) | Complete | bounded (2k) provenance-tagged recall; outcome `lesson` records |
| Streamed logs reach the LLM | Never | logs/progress are UI-only by design |

## Honest Gaps

| Feature | Status | Notes |
|---|---|---|
| **Review gate (subagent reviews diff before VERIFYING)** | **Planned** | pieces exist (`reviewer` evidence authority, review-accountability-mcp, agent teams) but **nothing drives a review today** — this is the largest missing confidence feature |
| Cross-platform containment (macOS Seatbelt, Windows) | Planned | containment is Linux-only; policy gating works everywhere |
| Web-UI monitoring panels | Planned | port of the Ink panels |
| Auto style-savings measurement | Planned | style token savings are model-dependent, currently unmeasured |
