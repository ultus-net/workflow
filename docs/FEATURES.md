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
| Spawn capability (default-deny subagent gating) | Complete | `src/adapters/acp.ts`, `src/application/host.ts` — `spawn` severity tops the escalation table; host metadata cannot relax it; enforced only via probe evidence (`docs/HOST_ADAPTERS.md`) |
| Enforcement-altering config-option gating | Complete | `src/integrations/acp-session.ts` — bypass/auto-approve family denied client-side before any wire call; agent-originated `config_option_update` rejected from retained config with a visible status |
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
| Hub-owned reviewer auto-launch on run completion | Complete | `createRunRegistry` reviewer seam (`src/integrations/run-registry.ts`) + production wiring (`src/integrations/hub-run-gates.ts`, `src/cli/hub.ts`) — contained ACP reviewer, contained git-diff sourcing, fail-closed verdict parsing; reviewer gate exercised live 2026-09-16 via the scheduled-turn probe chain (fire → contained ACP turn → review gate) |
| Hub-run test evidence (`test:<workspace>`) | Complete | requirement declared only when a real `WORKFLOW_TEAM_TASK_VERIFY_COMMAND` is configured (never the `true` default); `begin()` stales the workspace test subject so runs cannot inherit a predecessor's green tests; test-evidence gate exercised live 2026-09-16 via the scheduled-turn probe pass (real verify command; full chain fire → contained ACP turn → review gate + test evidence) |
| Subagent conformance probe | Complete | `test/acp-cline-subagent-probe.test.ts` (env-gated) ran live 2026-09-16 on the vendored pinned entry — **Red verdict recorded in `docs/HOST_ADAPTERS.md`: `spawn_agent` ran but neither the spawn tool call nor its permission reached the hub, so Cline stays `advisory`-capped/spawn-denied for spawn-inclusive workflows and is not labeled `enforced`**; re-run on every pinned version bump |
| OpenCode conformance probes (subagent, MCP mount, resume) | Complete | `test/acp-opencode-subagent-probe.test.ts`, `test/acp-opencode-mcp-mount-probe.test.ts`, `test/acp-opencode-resume-probe.test.ts` (env-gated; `--pure` launches measure the stock surface without operator plugins) ran live 2026-09-16 on 1.18.31 — **spawn Green (the `task` tool call projected and its permission reached the hub, so OpenCode is `enforced`-eligible per `docs/HOST_ADAPTERS.md` when the hub pins the ask config); hub-written MCP config mounts on both surfaces (project `opencode.json` and `XDG_CONFIG_HOME` — F1/G3 unblocked on OpenCode); `session/load` restores model context across restart (exact keyword recalled)**; re-run whenever the ambient `opencode` version changes (recorded in each probe's `agentInfo` evidence) |
| systemd user unit | Complete | `packaging/workflow-hub.service`; Linux/systemd only |
| Surface coverage: TUI, headless, zen, connectors, cron, desktop (`cline-hub`) | Complete | all resolve via env or discovery file, fail closed |
| Hub-native scheduler | Complete | `src/integrations/hub-scheduler.ts` — Vixie-semantics cron table at `~/.workflow/scheduler.json` (`WORKFLOW_HUB_SCHEDULES` overrides); fires review-gated contained runs; a rejected finish gate leaves the run VERIFYING (never fabricated); real-agent scheduled turn verified live 2026-09-16 (probe pass with a real `WORKFLOW_TEAM_TASK_VERIFY_COMMAND` test gate) |
| Advisory guidance for hub-composed prompts | Complete | `WORKFLOW_ADVISORY_STYLE` / `WORKFLOW_ADVISORY_NOTES` (one note per line) prepend honestly-advisory preamble text to every scheduled-run prompt (`advisoryGuidanceFromEnv` → scheduler `promptGuidance`); unset means prompts reach the turn unchanged |
| Per-run budget enforcement | Complete | token/cost caps from metering-proxy metrics; a violating event cancels the turn and the run fails with the budget as its recorded blocking reason |

## Surfaces & UX

| Feature | Status | Notes |
|---|---|---|
| `workflow` (patched Cline TUI launcher) | Complete | resolves the hub; refuses to start without it |
| `workflow-monitor` (Ink monitoring TUI) | Complete | task panel, activity panel, log-enriched transcript; `npm run tui:workflow` |
| Pedagogical modes (5 modes, checkpoints, learner profile, PRIMM) | Complete | `src/pedagogy/`; profile at `~/.local/share/workflow/learner-profile.json` |
| Learner-level skill gating (F2 surface wiring) | Complete | the TUI mode bar binds the mode's required-skill set (`levels.json` shared with skills-mcp, `SKILLS_MCP_DIR` override) to the active task's mutation precondition; switching modes re-binds, no-required-skill modes clear it, malformed maps refuse startup (`applySkillGating` in `src/pedagogy/skill-gating.ts`) |
| Response/build styles (caveman speech, ponytail YAGNI build) | Complete | **model-advisory** — the model can ignore them; live switch through the `/` or Ctrl+P options menu; summaries kept by design |
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
