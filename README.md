# Workflow

Workflow is the universal authority for agent surfaces. A deterministic kernel
owns task state, evidence, and mutation authorization; a long-running
loopback hub (`workflow-hub`) serves every Cline surface — interactive TUI,
headless CLI, zen, chat connectors, scheduled agents, teams, and desktop —
through one versioned protocol. The core invariant is:

```text
model proposes -> Workflow authorizes -> tool acts -> environment supplies evidence -> Workflow validates -> state may advance
```

Nothing mutates without Workflow authorization; nothing advances without
fresh evidence. Authorization fails **closed**: no hub, no mutations.

See `docs/FEATURES.md` for the honest, per-feature status matrix (including
what is *not* built yet), `docs/HUB.md` for the hub design, and
`docs/HUB_PROTOCOL.md` for the versioned, SDK-neutral integration contract.

## Install

Requires Node 22+ and (for containment) Linux with bubblewrap.

```sh
npm install
npm run build            # library + CLI bins
npm run toolbox:install && npm run toolbox:build
npm run tui:cline:build  # vendored, patched Cline
npm i -g .
```

Publishing (`npm publish`) makes `npm i -g workflow` an automatic install in
the npm sense: bins link onto PATH and `postinstall` attempts the toolbox and
Cline builds, warning and skipping on failure rather than breaking install.

## Commands

| Command | What it is |
|---|---|
| `workflow-hub` | the authority daemon every surface needs (discovery + token) |
| `workflow` | patched Cline TUI launcher; fails closed without the hub |
| `workflow-monitor` | Ink monitoring TUI: task panel, live activity, log stream |
| `workflow-shell` | interactive contained shell |
| `workflow-pets` | terminal pet animations (disabled from the TUI; see `docs/PETS.md`) |

## Quickstart

```sh
systemctl --user enable --now workflow-hub   # or: workflow-hub &
workflow-monitor                             # monitoring TUI over a live session
workflow --cwd /path/to/project              # patched Cline TUI via the hub
```

In the monitor TUI: `m` cycles pedagogical modes, `,` and `.` switch speech
(caveman) and build (ponytail/YAGNI) styles, `p` opens the learner profile,
`?` inspects a symbol, Ctrl+W opens workflow details.

## What you get

- **Universal authorization**: one hub gates every tool call on every surface; scheduled runs get their own task and evidence.
- **Token economy**: lazy MCP tool discovery (schemas on demand), MCP result truncation, a compaction ↔ project-memory bridge, and optional terse styles. Streamed logs are UI-only and never reach the model.
- **Monitoring**: always-on task and activity panels plus a log-enriched transcript; every MCP server emits leveled logs and progress.
- **Pedagogy**: five modes from Learn-to-Code to Autonomous with checkpoint gating and a persistent learner profile.
- **Containment**: bubblewrap-isolated process execution on Linux.

## Architecture

`src/kernel/` — deterministic domain (no LLM/LSP/UI deps). `src/application/`
— command/query boundary (`WorkflowApplication`). `src/integrations/` — hub,
bridge, memory, styles. `src/pedagogy/` — tutor engine. `src/adapters/` —
host translations. `src/ui/` — Ink/browser projections. `mcp-toolbox/` — 12
vendored MCP servers. The vendored Cline lives in `.workflow-cline/` and is
managed via `patches/cline-cli-v3.0.61-workflow.patch` (see
`scripts/build-cline-tui.mjs`).

Security notes: Workflow policy is not itself a sandbox — containment is the
separate process boundary. `enforced` means authoritative pre-mutation
interception; `advisory` means it cannot be guaranteed. MCP output is
untrusted input; evidence admission validates shape, not truth. See
`THREAT_MODEL.md`, `docs/RUNTIME_CONTAINMENT.md`, and `docs/OPERATOR_GUIDE.md`.

## More docs

`docs/HUB.md` hub design · `docs/HUB_PROTOCOL.md` integration contract ·
`docs/FEATURES.md` honest feature status · `docs/TUTOR_AND_LEARNING_SPEC.md`
pedagogy spec · `docs/HOST_ADAPTERS.md` adapter conformance ·
`docs/MCP_INTEGRATION.md` / `docs/MCP_TOOLBOX.md` MCP boundaries ·
`docs/TUI_INTEGRATION.md` / `docs/UI_INTEGRATION.md` frontend rules ·
`docs/OPERATOR_GUIDE.md` operations · `docs/PETS.md` pets findings
