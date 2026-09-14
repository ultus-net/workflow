# Universal TUI — staged convergence design

Date: 2026-09-14
Branch: feat/universal-tui
Origin: design discussion 2026-09-14 (staged convergence chosen over full replacement / docs-only)

## Goal

A single `workflow-tui` entry composes any host session driver and renders the
already-SDK-neutral `WorkflowTui` component — making the interactive surface
as replaceable as the kernel beneath it. The patched Cline CLI TUI remains the
primary polished surface until a documented ergonomics-parity checklist closes;
the universal TUI is the fallback that can become primary on evidence.

## Decisions

- **Staged convergence** (not full replacement): `workflow` keeps launching
  the patched Cline TUI today; `workflow-tui` is the universal fallback.
  "Primary" flips only when every parity item in `docs/TUI_PARITY.md` passes.
- **One authority per process**: unlike the read-only monitor, this TUI
  *drives* sessions, so this stage composes a standalone local authority for
  its workspace (same composition as monitor-standalone) and labels it
  `standalone (local authority)`. Hub-mediated session driving — making the
  universal TUI project and drive the hub's canonical state — is the
  documented convergence-final task, not part of this branch.
- **Fail closed, never silently fallback across SDKs**: an unavailable or
  uncomposable driver aborts with the exact composition error.

## Components

### 1. Driver registry (`src/cli/driver-registry.ts`)

Pure module: maps `--driver <name>` to a composer. `cline` wraps the existing
`createConfiguredClineRuntime(application, workspace)`; `opencode` composes
`new OpenCodeSessionDriver(createOpenCodeSessionClient(url))` over a small
fetch client (below). Unknown driver name → typed error listing valid names.
Registered drivers declare a `label` for the TUI connection chip.

### 2. OpenCode session client (`src/integrations/opencode-client.ts`)

Minimal fetch client implementing `OpenCodeSessionClient` against a running
OpenCode server (`create`, `prompt`, `abort`, `event.subscribe`). Endpoint
comes from `--opencode-url` or `WORKFLOW_OPENCODE_URL` (default
`http://127.0.0.1:4096`). Not a new dependency — plain `fetch` + SSE stream.

### 3. Universal entry (`src/cli/universal-tui.tsx` + `workflow-tui` bin)

Parse `--driver`/`--cwd`/`--opencode-url`; build the workspace application
(seed task, same as monitor standalone); compose driver via registry; render
`WorkflowTui` with the session and the `standalone (local authority)`
connection label. Dispose on exit.

### 4. Parity checklist (`docs/TUI_PARITY.md`)

Explicit convergence gates, each an ownable task with an acceptance test:
composer multi-line editing, session resume/history, transcript scrollback,
style dials, pedagogy gate, cancel keymap, hub-mediated session driving,
monitor parity. Primary-surface migration requires every item passing.

### 5. Docs

`README.md` command table gains `workflow-tui`; `docs/TUI_INTEGRATION.md`
records the staged-convergence rule (primary = Cline CLI patch until checklist
closes; per-SDK TUIs become optional surfaces afterwards).

## Testing

- Registry: arg parsing + unknown-driver error + fake composer wiring.
- Client: stub-fetch unit tests for create/prompt/abort/event error paths.
- Entry: not directly PTY-tested; its parts (registry, client, existing TUI
  tests) carry the coverage.
- Gates: lint, full suite, typecheck, build, secondary five-axis review.
