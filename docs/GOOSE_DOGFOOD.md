# GOOSE_DOGFOOD.md — W049 dogfood matrix record

Status: **Recorded 2026-09-17.** These are **agent-run smoke sessions**, not
operator sessions: an agent drove the matrix through the real production
runtime path (`createConfiguredAcpRuntime` with `WORKFLOW_ACP_AGENT=goose` —
the hub-written config, the skills mount, the loopback metering proxy, the
budget-guard composition, W047's surfacing), contained per the standard
launch. The operator's own daily-driver period still gates the backup-slot
takeover, W050's retirement decisions, and Checkpoint D. The
"both operator providers" arm stays open (no `AZURE_FOUNDRY_*` credentials in
the dogfood environment — same gap recorded for the W048 metered probe).

## Harness

`test/goose-dogfood-matrix.test.ts`, gated by `WORKFLOW_ACP_GOOSE_DOGFOOD=1`
(real model traffic). Goose 1.50.1, openrouter provider through the metering
proxy (`openrouter/auto`), one contained runtime per cell, scratch workspaces
under `/tmp`, logs preserved at `~/.dogfood-matrix.log` (first run) and
`~/.dogfood-rerun.log` plus `~/.dogfood-rerun{2..4}.log` (fix-verification
runs).

## Matrix results (final state)

| Cell | Exercise | Verdict | Evidence |
|---|---|---|---|
| 1 | Repo edit in a scratch git repo | **Green** | `README.md` edited end to end; the change landed in the workspace file |
| 2 | Shell/ops task through the permission surface | **Green** | `ops-check.txt` produced via a hub-gated shell call; the tool call projected hub-visibly into the session record |
| 3 | MCP participation (operator's real skills mount) | **Green (with finding)** | skills-mcp mounted via the runtime-composed `config.yaml`; `skills-mcp__list_skills` discovered and attempted; **the hub denied the call** (fail-closed: MCP tool names outside the recognized read surface are not auto-allowed) and goose honored the denial and adapted — the protocol flow is proven; read-policy for MCP tools is an operator policy decision, recorded below |
| 4 | Resume across a full contained runtime restart | **Green** (after fix 2) | phase 1 recalled the exact keyword `GOOSE-DOGFOOD-RESUME-9C21` (`result: "The code phrase you asked me to remember is: GOOSE-DOGFOOD-RESUME-9C21"`); session id `20260917_1` projected via W047 and resumed via `session/load` |
| 5 | Hub denial honored end to end (workspace boundary) | **Green** | the requested out-of-workspace write never landed (`escaped: false`) |
| 6 | W045 budget enforcement (cap `total≤1`) | **Green** | crossing cancelled the in-flight turn; the post-cap prompt was REFUSED with **zero additional model traffic** (`requestsBefore === requestsAfter === 3`, `queued: []`); state intentionally stays `cancelled` — the reason surfaces on the guard surface (the TUI `! budget exceeded` line), not the snapshot (design: `coding-session.ts` `#emit` drops events in the cancelled state) |

## Cost/visibility exercise (W044/W045)

- The metering proxy recorded every cell's real usage (first run, cell 1-2:
  8 requests / 32,947 tokens / $0.0038; per-cell ~5k tokens).
- `sessionBudgetMechanism` reported the OpenRouter per-key credit-limit
  backstop with no caps, and `local session-budget guard (total≤1)` with caps
  — the mechanism record switches exactly as composed.
- The budget guard's crossing → cancel → refuse sequence held with sticky
  violation semantics on the runtime path (cell 6).

## Product fixes the dogfood forced (the point of the matrix)

1. **Unknown ACP mutation tools: deny-and-adapt, not session-fatal.**
   `acp-workflow-resolver.ts` used to THROW on an unknown tool requesting a
   mutating capability, which `#failAll`-ed the whole session (observed live:
   goose 1.50.1's built-in `todo` tool killed phase 1 with
   `unknown ACP mutation tool: todo`). A well-formed permission request for
   an unrecognized tool is now DENIED — the tool never runs (fail-closed
   unchanged), the agent adapts, the session survives. Pins updated:
   `test/acp-cline-metadata.test.ts`, `test/acp-opencode-permission-shape.test.ts`.
2. **Goose's config root is workspace-keyed persistent state.**
   `createGooseRuntime` composed a fresh `config.<pid>.<uuid>` per launch AND
   deleted it on dispose — harmless for ephemeral composition, fatal for
   resume: goose's session store lives under `GOOSE_PATH_ROOT`
   (`Session not found: 20260917_1` across restarts). The dir is now
   `config.ws-<sha256-12(workspace)>` — stable across restarts, shaped to
   escape the stale-runtime pruner, never deleted by dispose or the
   launch-failure path. Honest concurrency limit: two simultaneous goose
   runtimes on the SAME workspace share the root (identical config.yaml
   bytes; the metering proxy is env-carried per launch; the store is
   per-session-id files). Pin: `gooseWorkspaceConfigTag` in
   `test/goose-agent-config.test.ts`.

## Findings recorded (no action taken beyond the record)

- **MCP read-policy**: `skills-mcp__list_skills` was denied by default
  authorization on the runtime path. For daily-driver use the operator will
  want read-class MCP tool policy decided explicitly (allow-list, ask, or
  deny) — a policy surface decision, not a defect. The W048 MOUNT probe's
  green (list_skills returning the probe skill verbatim) was earned under
  the probe's own authorization composition.
- **Assistant text channel**: goose delivers replies via the turn result
  (`snapshot().result`); streamed `agent_message_chunk` rows may be absent.
  Surfaces reading only the event stream must read both channels (the first
  dogfood run mistook this for silence; the harness now does too).
- **Subagent-internal coverage** (carried from W048, unchanged): spawning a
  granted subagent to exercise its internal PreToolUse surface still needs a
  live session — W050 input.

## Honest scope

- Agent-run sessions, 2026-09-17, goose 1.50.1, openrouter only.
- The azure_foundry arm pends `AZURE_FOUNDRY_*` credentials (operator).
- The operator's daily-driver period remains the gate for the backup-slot
  takeover (W049's full criterion), W050, and Checkpoint D.
- Re-run the matrix on every goose version bump, like the probe family.

**Supersession note (2026-09-18, W050 step 6).** The vendored-Cline SDK runtime,
its `.workflow-cline/` checkout, and its Workflow patch were removed on branch
`feat/w050-cline-removal` (not yet merged), together with the hub's
Cline-specific `/before-tool` and `/team-task` routes; the thin stock-ACP
connector is retained and probe-PENDING on stock 3.0.62. The W050 takeover and
Checkpoint D operator gates referenced above remain open, so prior statements in
this record are historical.
