# Vendored: opencode-workflow-guard (policy corpus of record)

**Status:** vendored source of truth for the guard policy corpus. Supersedes the
earlier `mcp-toolbox/apps/workflow-guard-mcp/` port (an acknowledged incomplete
port) and the `opencode-workflow-guard` npm plugin (being end-of-lifed).

## Provenance

- **Upstream:** `https://github.com/ultus-net/opencode-workflow-guard`
- **Ref:** `origin/main`
- **Commit:** `8a11de70323342fd142e669d3f3bdc6616163a5d`
- **Version:** `1.15.5` (matches the npm `latest` dist-tag at vendoring time)
- **Vendored:** 2026-10-11
- **Method:** `git archive origin/main src test package.json README.md LICENSE
  ACKNOWLEDGEMENTS.md` piped into this directory (worktree-local extraction; the
  upstream checkout is outside the confined workspace).

## What was taken

- `src/` (42 TypeScript files, ~9,493 loc) — the full policy corpus:
  `src/policies/*` (boundary, changelog, completion, continuation, destructive,
  docs, file-claims, git, interpreter, mcp, planning, post-edit-validation,
  secrets, shell-safety, stale-write, tamper, todo) and `src/lib/*` (audit,
  checkpoint, custom-tools, evidence, guard-dispatcher, hygiene, learning,
  live-control-plane, project-config, project-memory, review, shell, sqlite,
  state, tool-lifecycle, tool-outcomes, types, utils, v2-plugin, v2-todo, verify,
  version, worktree).
- `test/` and the package metadata for reference.

## What this decides

- The **policy corpus of record is this tree**, not the mcp-toolbox port and not
  the plugin. The guard conversion (plan step C2) extracts the
  framework-independent policy core from here into `src/integrations/guard-policy/`.
- The vendored `src/lib/*` host-adapter modules (state, sqlite, project-memory,
  review, learning, v2-plugin) are **not** all portable: they carry the plugin's
  OpenCode-host and sqlite session-state concerns. Port only the
  framework-independent policy functions; leave host-coupled modules out unless a
  specific rule needs them.

## Drift control

- Record the pinned commit here on every re-vendor.
- A future drift test should assert the vendored tree matches the pinned ref.
