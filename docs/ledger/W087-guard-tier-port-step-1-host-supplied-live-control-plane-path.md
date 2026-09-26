<!-- Ledger fragment: extracted from TASKS.md at line 1905 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W087 - Guard tier port step 1: host-supplied live control-plane paths (T0/T2) (2026-09-21)

**Objective:** replace the vendored guard's filename-segment guard-tamper
matching with a runtime-consumption fact when the host can supply it, so the
live control plane (T0) stays denied while config-shaped versioned drafts
(T2: dotfiles `.config/opencode`, worktrees) are allowed. This removes the
live false positive where `cp <dotfiles draft> <repo draft>` was blocked on the
destination segment (F3, memory `ec383547`; live repro record `290ec890`).

**Where:** `mcp-toolbox/apps/workflow-guard-mcp` (the vendored portable guard
core), guard-tamper path only.

**Acceptance criteria:**
- [x] `guard_check` accepts an optional host-supplied `liveConfigPaths`; when
      present, guard-tamper denies only targets resolving under a declared live
      root (symlink-aware) and allows config-shaped paths elsewhere; when
      absent, the legacy fail-closed segment matching is unchanged.
- [x] Default-mode upstream adversarial pins (`.opencode/`,
      `~/.config/opencode/`, `workflow-guard.jsonc`) remain green; the new
      test covers draft-allow, live-deny at both ends, and symlink-into-live.
- [x] Guard app build/typecheck clean, `node --test --import tsx
      test/*.test.ts` 49/49, `npm run toolbox:verify` EXIT=0 (Server Card
      regenerated).
- [x] Declared live roots are normalized (absolute required; `~`/`$HOME`
      expanded); any relative or unresolved root rejects the whole fact set so
      classification falls back to fail-closed segment matching rather than
      trusting partial facts.
- [ ] T1 ask-gate for promotion into live paths and the `opencode.jsonc`=ask
      nuance (next step of the tier port).
- [ ] Host-side wiring that supplies `liveConfigPaths` from the hub/launcher,
      including the in-use OpenCode plugin (proposal on record).

**Residuals (recorded, not buried):** with a supplied fact, segment matching is
fully replaced, so a host that declares an incomplete or wrong (but well-formed,
absolute) live-root set is fail-open for the undeclared config paths
(workspace-boundary and protected/secret checks still apply). This is an
intentional EXTENSION beyond upstream, not a parity port.
