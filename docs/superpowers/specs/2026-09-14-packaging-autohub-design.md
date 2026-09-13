# One-command install + self-starting hub

Date: 2026-09-14
Branch: feat/packaging-autohub

## Problem

Running Workflow today takes two terminals and a multi-step manual install:

1. Install: `npm install` -> `npm run build` -> `npm run toolbox:install` +
   `npm run toolbox:build` -> `npm run tui:cline:build` -> `npm i -g .`
2. Run: `npm run hub` in one terminal, `npm run tui -- --cwd <path>` in
   another, because the launcher resolves the hub through
   `~/.workflow/hub/discovery.json` and fails closed when it is absent.

Goal: one installer command, one launcher command (`workflow`). Fail-closed
semantics preserved; the hub remains the single shared authority for every
surface, matching `docs/HUB.md`.

## Decisions (from brainstorming)

- **Hub startup**: launcher auto-spawn (selected over systemd-only and
  systemd+fallback). The `packaging/workflow-hub.service` unit stays as an
  optional hardening path but is not required.
- **Install scope**: local installer only (no registry publish, no tarball
  distribution workflow).
- **Run UX**: `workflow --cwd <path>` self-starts the hub; hub lingers
  detached afterwards so monitor/shell/TUI attach to the same authority.

## Component 1: installer `npm run setup`

A new `scripts/install.mjs` invoked via the npm script `setup`. Steps, each
logged and aborting with a readable message on failure:

1. `npm install`
2. `npm run build`
3. `npm run toolbox:install` and `npm run toolbox:build` (prereq: `pnpm`
   resolvable; otherwise abort with a hint)
4. `npm run tui:cline:build`
5. `npm i -g .` (links the four bins; safe to re-run)

On completion it prints the four bins and the suggested `workflow --cwd <path>`
command.

## Component 2: auto-spawn in `src/cli/hub-client.ts`

`resolveWorkflowHub()` is replaced internally by a new `ensureWorkflowHub()`
implementation. `resolveWorkflowHub` keeps its signature; launchers need no
change.

Resolution order:

1. **Probe existing discovery**: unchanged fast path.
2. **Lock**: acquire `~/.workflow/hub/spawn.lock` via `openSync(path, "wx")`.
   `EEXIST` means another surface is spawning: poll the discovery file until
   the probe succeeds or the timeout expires, then return or throw. Locks
   stale beyond the spawn timeout (checked via `statSync(lock).mtime`) are
   treated as abandoned and retried.
3. **Resolve spawn candidate** (injectable for tests):
   - Prefer `workflow-hub` resolved from `process.env.PATH` (global install).
   - Else `<pkgRoot>/dist/cli/hub.js` (source checkout after `npm run build`)
     executed with the current `process.execPath`.
   - If neither exists, throw the fail-closed error unchanged.
4. **Spawn**: `spawn(cmd, args, { detached: true, stdio: "ignore" })` then
   `child.unref()`. The hub outlives the launcher and remains shared across
   monitor/shell/TUI surfaces, matching HUB.md's "only hub on the machine"
   intent. A log path (`~/.workflow/hub/hub.log`) is not written in v1;
   `stdio` ignores output.
5. **Wait + release**: poll discovery/probe every 250 ms up to 15 s
   (configurable via `WORKFLOW_AUTOHUB_TIMEOUT_MS`), release the lock, then
   return the resolved hub.
6. **Failure**: spawn error or timeout -> remove the stale discovery file and
   throw the original fail-closed error text, with a short note that auto-spawn
   was attempted. `WORKFLOW_AUTOHUB=0` restores strict fail-fast resolution
   without spawning.

No changes to the hub daemon, protocol, cline patch, monitor, or shell.

## Component 3: docs

- `README.md`: Install becomes `npm run setup`; Quickstart becomes a single
  `workflow --cwd <path>` command; note the auto-spawn behavior and
  `WORKFLOW_AUTOHUB=0` for admins who want strict fail-fast.
- `docs/HUB.md` (optional, small): one line mentioning launcher auto-spawn
  with lock semantics.

## Testing

- `hub-client` unit tests drive the lock/spawn-candidate seam: existing-hub
  probe, spawn-and-connect, EEXIST lock waiter, missing candidates, timeout,
  and `WORKFLOW_AUTOHUB=0` fail-fast.
- Installer is exercised manually during verification (full end-to-end on this
  machine).

## Out of scope

- npm registry publishing / renaming the package.
- Tarball distribution workflow.
- systemd install automation (the unit stays manually installable).
- Removing or rewriting the hub daemon's in-process interfaces.
