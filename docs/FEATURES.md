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
| Process containment (bubblewrap on Linux) | Partial | `src/containment/platform.ts` — **policy-only passthrough on non-Linux, with a visible warning and an explicit `policy-only` result marker**; full isolation remains Linux-only |
| Cross-platform graceful degradation | Complete | `selectContainment()` — no silent fallback; `ContainedProcessResult.enforcement` distinguishes `enforced` from `policy-only` at the type level |
| Persistence (versioned JSON store, exclusive lock) | Complete | restart recovery marks orphaned IN_PROGRESS as FAILED |

## The Hub (universal authority)

| Feature | Status | Notes |
|---|---|---|
| `workflow-hub` daemon (loopback authority, discovery file, atomic lock, single instance) | Complete | `src/integrations/workflow-hub.ts`, `src/cli/hub.ts` |
| Hub protocol v1 (discovery, `/health`, `/before-tool`, `/bash`, `/run/*`) | Complete | `docs/HUB_PROTOCOL.md`; conformance: `test/hub-protocol.test.ts` |
| Per-surface workspace binding | Complete | surfaces declare workspace per request |
| Dedicated task + evidence per scheduled run | Complete | `/run/begin`, `/run/finish` |
| Review gate (5-axis rubric, cross-run adversarial reviews) | Complete | `/review/rubric`, `/run/review`; cross-run + ≥3-axis anti-rubber-stamp, kernel-enforced via `reviewer` evidence; ported from opencode-workflow-guard |
| systemd user unit | Complete | `packaging/workflow-hub.service`; Linux/systemd only |
| Surface coverage: TUI, headless, zen, connectors, cron, desktop (`cline-hub`) | Complete | all resolve via env or discovery file, fail closed |

## Surfaces & UX

| Feature | Status | Notes |
|---|---|---|
| `workflow` (patched Cline TUI launcher) | Complete | resolves the hub; refuses to start without it |
| `workflow-monitor` (Ink monitoring TUI) | Complete | task panel, activity panel, log-enriched transcript; `npm run tui:workflow` |
| Pedagogical modes (5 modes, checkpoints, learner profile, PRIMM) | Complete | `src/pedagogy/`; profile at `~/.local/share/workflow/learner-profile.json` |
| Response/build styles (caveman speech, ponytail YAGNI build) | Complete | **model-advisory** — the model can ignore them; live switch with `,` and `.`; summaries kept by design |
| Style-savings measurement (`npm run style:eval`) | Complete | `src/cli/style-eval.ts` — per-style output deltas from cumulative driver usage |
| Browser projection | Partial | `src/ui/web.ts` demo; does not have the monitoring panels |

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
| **Review-gate polish: P2/P3 findings → follow-ups ledger, monitor shows verdicts** | **Planned** | follow-up storage exists in review-accountability-mcp; verdict surfacing in the Activity panel not wired |
| Cross-platform isolation (macOS Seatbelt, Windows) | Planned | policy-only passthrough ships now; native isolation tiers remain open |
| Web-UI monitoring panels | Planned | port of the Ink panels |
