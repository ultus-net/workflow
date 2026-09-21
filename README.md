# Workflow

Deterministic control plane for coding-agent hosts.

## Core contract

```text
model proposes -> Workflow authorizes -> tool acts -> environment supplies evidence -> Workflow validates -> state advances
```

- Kernel owns task state, dependencies, evidence freshness, mutation epochs, and legal transitions.
- Application owns authorization, capability withholding, workspace confinement, and task correlation.
- Host adapters translate ACP/OpenCode/goose/Cline events; adapters do not own workflow state.
- MCP servers provide capabilities or evidence; MCP servers do not own task state.
- `advisory` means the host cannot guarantee pre-mutation interception.
- `enforced` requires probe-backed authoritative interception.
- Unknown or stale safety state fails closed.

## Current qualification state

- Browser UI: OpenCode/ACP lead surface; task, step, evidence, and review state remain Workflow-owned.
- OpenCode v2: migration and qualification plan in `docs/OPENCODE_V2_MIGRATION_SPEC.md`.
- Workflow Guard retirement: blocked until Phase-G criteria, G6 corpus parity, and Checkpoint D pass.
- Step ledger: W072 kernel Stage 1 implemented; native todo bridge maps host todos to canonical steps.
- Step completion: requires declared evidence; native todo `completed` never self-certifies work.
- v2.0.10 local probe: `/api/info`, `/api/session`, `/api/experimental/session/stats`, and authenticated `/api/event` pass.
- OpenCode event replay identity remains probe-pending.

## Install

Requirements:

- Node.js 22+
- pnpm for `mcp-toolbox`
- Linux + Bubblewrap for enforced containment

```sh
npm run setup
```

Installs:

- `workflow` — launcher: browser operator UI over a shared hub (verbs: web / tui / settings / hub / doctor / install fleet)
- `workflow-tui` — universal ACP/TUI surface
- `workflow-hub` — authority daemon
- `workflow-web` — browser operator UI service (the `workflow web` surface, runnable standalone)
- `workflow-admin` — credential admin control plane
- `workflow-monitor` — hub snapshot monitor
- `workflow-shell` — contained shell
- `workflow-opencode-server` — OpenCode server topology daemon
- `workflow-opencode` — attach the official OpenCode TUI through the hub gateway
- `workflow-rsi` — RSI loop trigger client (start/status/cancel via the hub)

## Commands

```sh
workflow --cwd /path/to/project
workflow-tui --driver acp --cwd /path/to/project
workflow-monitor
workflow-shell
```

`workflow doctor` states the local setup honestly (settings, credentials, hub, topology, containment, probe verdicts, the vendored fleet payload, and the guard enforcement posture). `workflow install fleet` deploys the vendored OpenCode agent fleet (`workflow install fleet --force` to overwrite locally modified agent/command files).

Useful environment:

- `WORKFLOW_AUTOHUB=0` — disable automatic hub startup.
- `WORKFLOW_NO_BROWSER=1` — serve UI without opening a browser.
- `WORKFLOW_ACP_AGENT=opencode|goose|cline` — select ACP agent kind.
- `WORKFLOW_OPENCODE_ENFORCEMENT=enforced` — request enforced OpenCode server posture; live probes must pass before the claim is valid.

## Browser UI

- Default URL: `http://127.0.0.1:4173`.
- Managed unit: `packaging/workflow-web.service`.
- Full-page Settings with MCP catalog and agent preferences.
- OpenCode-style command palette: Ctrl/Cmd+P.
- Two-region layout: chat + inspector.
- Inspector: Context, configured MCP catalog, Tasks, Connections, Evidence, History, Changes, Worktrees.
- OpenCode-style edit diffs: line numbers, add/delete colors, patch statistics.
- Todo/plan output remains advisory; canonical Tasks and Steps remain authoritative.

## Verification

```sh
npm run typecheck
npm run lint
node --import tsx --test test/step-ledger.test.ts
npm test
```

Full verification is a release gate. Gated live-agent probes require their documented environment flags.

## Architecture

- `src/kernel/` — deterministic task graph, evidence, transitions; no LLM/UI/SDK imports.
- `src/application/` — authorization and command/query boundary.
- `src/adapters/` — host event translation and classification.
- `src/integrations/` — ACP, hub, OpenCode server, guard, metering, persistence.
- `src/ui/` — web/TUI projections; no canonical workflow state.
- `mcp-toolbox/` — policy, evidence, memory, review, skills, and intelligence MCP products.
- `docs/TASKS_COMPLETED.md` — append-only archive for verified completed/superseded work.

## Security boundaries

- Workflow policy is not a sandbox; Linux Bubblewrap is the process boundary.
- MCP output is untrusted input; evidence admission validates shape, authority, subject, freshness, and epoch.
- Provider credentials remain hub-side; agents receive only the configured placeholder boundary.
- Read the current claims and residuals in `THREAT_MODEL.md`, `docs/SECURITY_ASSURANCE.md`, and `docs/HOST_ADAPTERS.md`.

## Documentation

- `TASKS.md` — active roadmap and acceptance criteria.
- `docs/TASKS_COMPLETED.md` — completed/superseded archive process.
- `docs/COMPLIANCE_REGISTER.md` — strict drift and parity obligations.
- `docs/PLAN_VS_REALITY_AUDIT.md` — plan/code drift baseline.
- `docs/TASK_TODO_LEDGER_PARITY.md` — task/step ledger specification.
- `docs/OPENCODE_V2_MIGRATION_SPEC.md` — v2 API ownership and qualification.
- `docs/FEATURES.md` — honest feature status.
- `docs/GUARD_CORPUS_MAP.md` — plugin-to-control-plane parity map.
