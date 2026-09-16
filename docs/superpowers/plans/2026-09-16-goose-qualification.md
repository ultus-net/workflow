# goose qualification as a third lead-agent kind and staged Cline-seam replacement candidate

## Goal

Qualify goose (AAIF, v1.50.x line) as a third `WORKFLOW_ACP_AGENT` kind on the stock-ACP lead path — `WORKFLOW_ACP_AGENT=goose` beside `opencode` (default) and `cline` (vendored fallback) — and establish, with live probe evidence only, whether it can also serve as the operator's general-purpose contained agent (sysadmin/DevOps plus development workloads) and as a staged replacement candidate for the vendored-Cline SDK seam.

Motivation and research record: `docs/GOOSE_RESEARCH.md` (2026-09-16). The hub's dependency stack is now foundation-governed (AAIF: goose, MCP, AGENTS.md; ACP v1 stable), goose's only interface is ACP, and its hooks surface is the first credible stock replacement for the one capability that keeps the Cline patch seam load-bearing.

## Decisions

- **Third agent kind, no new adapter.** `AcpAgentKind` gains `goose`; spawn profile `goose acp` (stdio) in `KNOWN_SPAWN_TOOLS`; per-runtime config composed under `GOOSE_PATH_ROOT` (the goose equivalent of the OpenCode `XDG_CONFIG_HOME` composition — probe-verified). `AcpSessionDriver`, permission routing through `WorkflowApplication.authorize`, the metering proxy, `AcpFsServer` (wired; goose executes its own file tools, so no fs delegation is expected — the Cline enforcement posture plus hooks), and whole-agent Bubblewrap apply unchanged. `WORKFLOW_ACP_AGENT` validation message grows the third value.
- **Enforcement posture: interception + hooks + containment, not fs delegation.** Launch shape: `GOOSE_MODE=approve` so mutating tools cross `session/request_permission`; the hub's guard dispatcher and bwrap remain the hard backstops because goose's write classification is LLM-interpreted best-effort (research §3.1). The B3 fail-closed probe invariants carry over verbatim: an ungated mutation trips the probe; a projected-but-unasked spawn trips the probe.
- **Spawn posture is fail-closed absent.** goose disables subagents in approve mode (research §5), so under enforcement a goose lead cannot self-spawn; the hub stays the conductor. The probe asserts absence-or-denial, and that nothing spawns unprojected — scoped honestly in the HOST_ADAPTERS matrix (this is a different Green than OpenCode's permission-gated spawn).
- **Six gated probes, mirroring the OpenCode family** (`WORKFLOW_ACP_GOOSE_*=1`, fail-closed skips, evidence logged, matrix rows scoped Green/Red per probe — no aggregate claims):
  1. `PERMISSION` — approve mode over ACP: every mutating tool call reaches `request_permission` with usable reject options and denials honored (the pivotal enforcement probe given LLM-classified write detection).
  2. `SUBAGENT` — no unprojected spawns under approve mode; delegate tool absent or denied.
  3. `MOUNT` — hub-written per-runtime config under `GOOSE_PATH_ROOT` mounts the skills-mcp stdio extension; the contained agent reports `list_skills` verbatim (F1/G3 single delivery path).
  4. `RESUME` — `session/load` after a full contained restart: transcript replay and model-context restore (G4).
  5. `METERED` — contained turn completes with only the placeholder credential inside the boundary while the loopback proxy records traffic; `usage_update` channel(s) confirmed (G1/G7 — goose emits usage on its custom notification at minimum).
  6. `HOOKS` — PreToolUse deny works under containment (exit-2 and JSON block forms), `on_failure: block` fails closed, `PreToolUseResult` observability fields are projectable, and the subagent-internal coverage question resolves (research §7.3). This probe is the Cline-seam decision input.
- **Hub-owned config is the only config.** The composed runtime carries: provider via `GOOSE_PROVIDER__HOST`/`GOOSE_PROVIDER__API_KEY` (placeholder + proxy), `GOOSE_MODE=approve`, `GOOSE_TELEMETRY_ENABLED=false`, extension allowlist, no external-subagent extensions, no native `.agents/skills` in the workspace (skills arrive only through the skills-mcp mount), and optionally a project-scope policy plugin under `<workspace>/.agents/plugins/` once the hooks probe proves the deny path. Plugin discovery under scratch-HOME containment is verified by the hooks probe.
- **Staged Cline-seam criteria (explicit — the seam is NOT retired by this qualification).** goose replaces the vendored-Cline seam only when: (a) the hooks probe proves deny + fail-closed under containment; (b) subagent-internal tool calls demonstrably fire `PreToolUse` hooks — if they do not, goose closes nothing the seam uniquely provides and the seam stays for exactly that reason; (c) a daily-driver period on the general-purpose/ops workload. Until then the Cline seam keeps its "working tree, not an archaeology project" status per `docs/ACP_DECISION.md` and stays continuously exercised.
- **Out of scope, recorded:** `goose serve` (HTTP/WS) — the remote-transport axis sits outside whole-process bwrap containment and is a THREAT_MODEL follow-up (enforcement would shift to ACP permissions + network boundaries); recipes/schedules as hub surfaces; ACP v2 features.

## Contracts

- Probes live in `test/acp-goose-*-probe.test.ts`, gated by env, following the family's conventions (env-gate refusal, mkdtemp workspaces, SIGKILL cleanup, ambient-PATH version recorded in `agentInfo` evidence, end_turn gate on completion assertions, first-digit-run count parsing).
- Runtime composition in `src/integrations/acp-runtime.ts` + `src/integrations/opencode-agent-config.ts`'s config-writer pattern extended for goose: config directory under the per-runtime root, stale-runtime pruning parity, mount failure composes to no-mount (fail-closed, TUI no-op semantics).
- HOST_ADAPTERS matrix gains goose rows; docs claims trace to logged probe evidence per the conformance-matrix rules (Green per probe, never aggregate).
- No kernel changes; no new `TranslatingHostAdapter` (ACP adapter already conformance-covered); new high-blast-radius goose tools (developer suite, computer controller) get guard classification before any enforcement-coverage claim per `docs/HOST_ADAPTERS.md`.

## Follow-ups

- Pin policy: probe against the installed goose version, record it in evidence, re-run the family on version bump (weekly release cadence makes this the first pinned-version-sensitive agent — consider a `GOOSE_PROBE_VERSION` pin or a version-diff check).
- Decide the reviewer-agent runtime: goose headless (`goose run -t`) is a candidate for the hub-owned reviewer role in the scheduled VERIFIED chain.
- Skills parity: goose 2.0's native skills surface vs the skills-mcp single delivery path — after the mount probe, evaluate whether the vendored corpus (PR #13 lifecycle) serves goose sessions identically.
- Remote transports (`goose serve`, ACP HTTP/WS RFD): THREAT_MODEL entry for network-boundary enforcement before any remote-agent support.