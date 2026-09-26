<!-- Ledger fragment: extracted from TASKS.md at line 1861 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W086 - Control-plane install: vendored fleet payload, doctor checks, plugin-free posture (2026-09-21)

**Objective:** make "the required agent prompts are in the installed config"
a verifiable property of the control plane instead of a manual copy step.
The OpenCode agent fleet (`decompose`/`executor`/`reviewer`/`retrospective`),
its slash commands (`/decompose` `/retro` `/review-diff` `/rsi-loop`), and
the companion repo docs they reference are vendored in-repo with a committed
sha256 manifest; an operator-invoked installer deploys them; the doctor
verifies the installed state and the enforcement posture, read-only, and
prints the sanctioned fix both ways (the installer or exact shell commands).

**Spec:** `docs/superpowers/plans/2026-09-21-control-plane-install-doctor.md`.

**Acceptance criteria:**
- [x] The fleet payload (agents, commands, the full companion docs folder)
      is vendored under `assets/opencode-fleet/` with a committed manifest;
      a focused drift-guard test re-runs the generator's logic and fails
      when manifest and assets disagree.
- [x] `workflow install fleet [--force]` deploys agents/commands into the
      host config dir with refuse-to-clobber (local edits survive unless
      `--force`) and installs docs into the workspace repo
      install-if-missing only — repo-owned living files (`lessons.md`) are
      never overwritten, force or not; writes are atomic; nothing deleted.
- [x] `workflow doctor` gains the fleet-payload check (missing = fail with
      both the installer command and the exact `cp` commands; drift = warn;
      a malformed manifest fails closed) and the guard enforcement-posture
      check (plugin-free posture stated honestly: hub-launched sessions are
      guarded at launch, raw host launches unguarded by design; a recorded
      host-config plugin entry is a warn with the parity-probe fix line).
- [x] The host config document (`opencode.jsonc`) is never written by the
      installer or the doctor — the doctor reads it and prints fragments;
      promotion into it stays an operator edit (tier boundary: the installer
      is the ask-gate for payload, the config surface stays operator-owned).
- [x] `npm run typecheck`, `npm run lint`, and the focused suites
      (`test/install-doctor.test.ts`, `test/doctor.test.ts`) pass.

**Residuals (recorded, not buried):** the raw-launch parity probe
(hub-guarded session vs plugin session) is not yet recorded — the posture
check claims hub-launch guarding only, never parity; the vendored docs are
verbatim operator-authored text including dotfiles-anchored sections
(adaptation in target repos is an operator editorial call); the dotfiles
side keeps `opencode.jsonc` + personal config and drops its fleet copies as
an operator follow-up (one source per artifact).
