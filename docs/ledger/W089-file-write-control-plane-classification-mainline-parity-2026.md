<!-- Ledger fragment: extracted from TASKS.md at line 1990 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W089 - File-write control-plane classification (mainline parity) (2026-09-22)

**Objective:** close the file-write enforcement hole in the vendored guard
core: upstream's edit/write handler classifies targets with `isProtectedPath`
(the guard-config vocabulary — plans-file exemption, realpath awareness,
W087-style live-root facts), but the vendored `file_write` path consulted
only the system/secret check, so a host enforcing `guard_check` verdicts
would allow a file write to replace the guard's own configuration.
Assessment correction bundled: PR #158 (`c377cb9`) is **not merged into
upstream main** (side branch `origin/fix/worktree-fingerprint` only) — the
parity target stays mainline; the W088 parity log carries the dated
correction.

**Where:** `mcp-toolbox/apps/workflow-guard-mcp/src/policy.ts` (file_write
path loop), `src/interpreter-policy.ts` (write-target loop,
`liveConfigPaths` threaded), `src/boundary-policy.ts` (export only).

**Acceptance criteria:**
- [x] `file_write` targets classified with `isGuardConfigurationPath`
      (deny `guard-tamper`): `.opencode/**` (incl. non-markdown payload
      files — mainline has no markdown exemption), root
      `opencode.json(c)`/`workflow-guard.jsonc`, `.config/opencode/**`,
      user-level absolute paths; plans FILES and ordinary workspace files
      (incl. token-substring `docs/.opencode-notes.md`) stay allow.
- [x] Live-root facts apply to writes: declared-root writes deny (T0),
      dotfiles drafts allow (T2), symlink-into-live denies.
- [x] Interpreter payloads writing guard-config paths deny
      (`interpreter-guard-tamper`, tilde + relative forms); benign
      interpreter writes unchanged.
- [x] Upstream precedence: the tamper classification runs before the
      system/secret checks (needed on this ostree host where `/home`
      realpaths under `/var` — the pre-existing `/var` rule would otherwise
      mask the classification; that false-positive class is recorded as a
      queued candidate, not fixed here).
- [x] Verifier: W089 pins RED against the unmodified tree (43 pass/3 fail —
      exactly the new tests), GREEN after the port (55/0 across
      policy+mcp+redirect); guard typecheck OK; repo lint/typecheck exit 0.
- [ ] Queued (one change per iteration): ostree `/var`-home
      false-positive class in `checkProtectedPath` (mainline has no `/var`
      rule); boundary deny-reason cause attribution (#172/#173);
      `npm pack --json` verifier debt (human-gated).
