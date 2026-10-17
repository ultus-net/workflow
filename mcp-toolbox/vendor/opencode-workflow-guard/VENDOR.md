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

- This tree is the **provenance corpus of record** — the pinned upstream source
  the guard policy derives from. It is **not** the operative enforcement surface.
- The **operative guard** is the app port
  (`mcp-toolbox/apps/workflow-guard-mcp/src/`), and the hub/seat in-process copy
  (`src/integrations/guard-policy/`) is byte-identical to the port's ten
  portable policy modules, pinned by `test/guard-policy-drift.test.ts`. The
  vendored tree is **not** statically linked at runtime.
- The port is a **subset** of this corpus (the plugin's `src/lib/*` host-adapter
  modules — state, sqlite, project-memory, review, learning, v2-plugin — carry
  OpenCode-host and sqlite session-state concerns and are not portable). The
  per-policy disposition is recorded in `COVERAGE.json` and pinned by
  `test/guard-policy-corpus-coverage.test.ts`.
- **Residual #27 lanes PORTED (W214, 2026-10-17; issues #539/#540/#541).**
  This section previously recorded an honest gap: three upstream enforcement
  lanes were **absent** from the port. All three are now carried and
  dispositioned `ported` in `COVERAGE.json`:
  secret-file **read** denial (`secretFileReadIn` in the shell lane and the
  `read` action tool seat with the masked-`.env`-schema hint, `path-policy.ts`
  + `policy.ts`), the destructive-command scan over **written file content**
  (`extractEditContent` + `liveMutationIn` on a `file_write` payload,
  respecting `WORKFLOW_GUARD_ALLOW_LIVE`, `shell-policy.ts` + `policy.ts`),
  and the inline-interpreter **workspace-escape / secret-read** lanes
  (`outsideWritePathInPayload`, `secretPathInPayload`, `interpreter-policy.ts`,
  fail-closed on unresolvable/variable targets). The corpus-coverage test now
  pins the lanes **present** — a silent regression is the same inventory lie
  in the other direction. Behavioral evidence:
  `mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts` (the W214 block);
  disposition record: `docs/SECURITY_ASSURANCE.md` #27.

## Drift control

- Record the pinned commit here on every re-vendor.
- **Corpus ↔ port coverage:** `test/guard-policy-corpus-coverage.test.ts` pins
  every vendored `src/policies/*.ts` to a `COVERAGE.json` disposition, checks
  each named module exists in the port, and pins the security-relevant lanes
  above as **ported** (pre-W214 it pinned them absent — the same fail-closed
  discipline in both directions), so a vendored policy cannot be added,
  removed, ported, or unported without updating the recorded disposition. This
  replaces the earlier "a future drift test should..." placeholder.
- Byte-parity of the operative copy is pinned separately at the **port ↔
  in-process** boundary by `test/guard-policy-drift.test.ts`.
- Re-vendoring (`git archive` from the pinned ref) is verified by re-running the
  two tests above; a full byte-diff of this tree against the upstream ref is not
  automated here (the upstream checkout is outside the confined workspace).
