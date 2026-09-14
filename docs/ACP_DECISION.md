# ACP Decision: adopt stock-ACP Cline with whole-agent containment as the lead surface path

**Status:** Accepted — 2026-09-14
**Decision owner:** operator
**Evidence:** `docs/ACP_RESEARCH.md` (W032–W035), `docs/ACP_SURFACE.md` (W036), TASKS Phase 8

## Context

The spike proved an asymmetric field: OpenCode's default ACP mode edits files without sending `session/request_permission` (advisory transport only), while Cline 3.0.61 `--acp --auto-approve false` with `CLINE_API_KEY`/`CLINE_PROVIDER=openrouter` intercepts reads, edits, and `run_commands` with usable reject options and honors denial. Cline never delegates execution to client `terminal/*`/`fs/*` capabilities (source-verified), so enforcement is achieved by launching the agent process itself under Bubblewrap: permission interception intact, allowed workspace writes applied, random-secret host canary invisible despite an active `find /` search, `/tmp` escape writes never reaching the host (network `host` retained for model egress). The ACP session stream projects messages, reasoning, tool lifecycle, mode/model/auto-approve config, and cancellation — but not token usage, error detail, iteration boundaries, plan content, or slash commands.

## Decision

**GO.** Build the clean Workflow terminal surface over **stock-ACP Cline launched under whole-agent Bubblewrap containment** as the lead path. Patched Cline Ink (current `src/cli/tui.tsx` surface) remains the **fallback/migration surface**, not the base.

Gap dispositions from W036:

- **G1 token/cost visibility — DEFERRED** (operator, 2026-09-14). Not a launch blocker. An MCP server **cannot** track token usage: MCP observes tool calls, never model turns. Future paths, in order of preference: (1) route model egress through a hub-metered proxy reading provider `usage` fields from API responses — the contained launch already controls the agent's environment, so this is enforceable, not advisory; (2) read Cline's own session state from the hub-owned scratch `HOME` post-turn (requires verification of what Cline persists).
- **G2 commands/mentions — SATISFIED.** The operator uses commands only to change models/settings, which ACP `configOptions` (provider/model/auto-approve selects in the `session/new` result) covers natively.
- **G3 input/editor UX** — client-side build cost, accepted.
- **G4 session-resume fidelity** — a resume probe is required before relying on `loadSession`; not decision-blocking.
- **G5 thin error surfacing** — accepted as a debuggability cost.
- **G6 subagent projection** — accepted short-term.
- **G7 context/compaction — DEFERRED (same family as G1, covering both visibility AND control).** Context is managed and honored inside the agent. On the ACP path the hub cannot even configure the strategy: `cline --compaction` parses but is dropped before `runAcpMode` in 3.0.61 (verified in `apps/cli/src/main.ts`), so ACP sessions always run the Core default. Model choice stays hub-controllable via `CLINE_MODEL`/`configOptions`. Stabilized `usage_update` becomes visible when Cline upgrades its pinned ACP SDK (hub projection forwards unknown update types unchanged); compaction lifecycle signaling remains an RFD draft. No decision impact.

## Consequences

- New implementation phase (post-decision): build the clean surface (session lifecycle wiring into hub `authorize`, contained launch as the default spawn path, surface UI over the ACP projection), then migrate daily use off patched Cline.
- **SDK seam retention (explicit):** the SDK fallback is load-bearing insurance, not legacy. `src/adapters/cline.ts`, `src/integrations/cline-{plugin,runtime,session,shell-executor,tui-bridge}.ts`, their unit tests (`test/cline-*.test.ts`), the real-model integration regressions (`test/integration/cline-coding-session.mjs`, `cline-runtime.mjs`, `cline-resume.mjs`), the pinned patch `patches/cline-cli-v3.0.61-workflow.patch`, and its regeneration scripts (`scripts/build-cline-tui.mjs` — which runs as `pretest` on every suite run — and `scripts/bump-cline-tag.mjs`) are all retained and continuously exercised. If the ACP path hits a blocking limitation, the fallback must be a working tree, not an archeology project; patch re-pinning happens whenever the fallback needs a newer Cline, not only at migration time.
- OpenCode integration is capped at advisory transport unless a future launch mode proves complete permission coverage; its remaining conformance evidence (fs/terminal delegation, auto-approve exposure, contained bypass) is deferred unless reconsidered.
- Follow-ups: token-economy metering proxy (G1), resume-fidelity probe (G4), error-surfacing improvements (G5), OpenCode evidence completion (if reconsidered).

## Alternatives considered

- **Patched-SDK bridge as the base surface** — rejected as base (pinned patch must be re-applied and re-verified per Cline release; ambient filesystem stays visible to the agent process); retained as fallback.
- **OpenCode ACP** — rejected for enforcement: observed default mode mutates without permission requests; remains a viable advisory transport only.
- **Wait for Cline `terminal/*` delegation** — rejected: unimplemented in 3.0.61 with no committed timeline; whole-agent containment already satisfies the enforcement requirement.
