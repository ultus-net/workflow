# Workflow

Workflow is a **control plane for coding-agent hosts**. Models and host SDKs
are replaceable surfaces that propose work and observe results; Workflow is
the deterministic authority that owns task state, legal transitions, mutation
authorization, evidence requirements, and verification. A long-running
loopback hub (`workflow-hub`) serves every surface — interactive TUI, headless
CLI, zen, chat connectors, scheduled agents, teams, and desktop — through one
versioned, SDK-neutral protocol. The core invariant is:

```text
model proposes -> Workflow authorizes -> tool acts -> environment supplies evidence -> Workflow validates -> state may advance
```

Nothing mutates without Workflow authorization; nothing advances without
fresh evidence. Authorization fails **closed**: no hub, no mutations. Swapping
the host SDK means adding an adapter and a session driver — the kernel,
process, and tooling stay put.

See `docs/FEATURES.md` for the honest, per-feature status matrix (including
what is *not* built yet), `docs/HUB.md` for the hub design, and
`docs/HUB_PROTOCOL.md` for the versioned, SDK-neutral integration contract.

## Install

Requires Node 22+, pnpm (for mcp-toolbox), and (for containment) Linux with
bubblewrap.

```sh
npm run setup   # npm install -> build -> toolbox -> vendored cline -> npm i -g .
```

This installs the five bins (`workflow`, `workflow-tui`, `workflow-hub`,
`workflow-monitor`, `workflow-shell`) onto PATH and is safe to re-run.

## Commands

| Command | What it is |
|---|---|
| `workflow-hub` | the authority daemon every surface needs (discovery + token) |
| `workflow` | patched Cline TUI launcher; auto-spawns the hub when absent |
| `workflow-tui` | universal interactive TUI with explicit `cline`, `opencode`, or `acp` driver selection; fallback surface |
| `workflow-monitor` | Ink monitoring TUI over the hub's canonical snapshot; standalone local authority when the hub is unreachable |
| `workflow-shell` | interactive contained shell |

## Quickstart

```sh
workflow --cwd /path/to/project   # self-starts the authority hub
workflow-tui --driver acp --cwd /path/to/project  # universal fallback; standalone local authority
workflow-monitor                  # monitoring TUI over the live hub
workflow-shell                    # contained shell
```

The hub auto-starts the first time a surface resolves it (spawn candidates:
`workflow-hub` on PATH, else `<repo>/dist/cli/hub.js`) and stays detached for
reuse. Set `WORKFLOW_AUTOHUB=0` to restore strict fail-fast resolution, or run
the daemon manually with `workflow-hub` (source checkout: `npm run hub`). An
optional systemd user unit lives at `packaging/workflow-hub.service` for
fully-managed startup.

In the monitor TUI: `/` (or Ctrl+P) opens the Workflow options menu — digits
1-6 toggle **mode** (pedagogical gating), **speech** (caveman), **build**
(ponytail/YAGNI), **learner profile**, **symbol inspect**, and **workflow
details**; `q`/Esc closes. Ctrl+W toggles workflow details directly. Ordinary
letter and punctuation keys are left to the composer so prompts are never
changed by hidden first-character shortcuts.

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
`docs/OPERATOR_GUIDE.md` operations
