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

---

## Supersession (2026-10-13): golden-tree port

The dotfiles golden tree (`install/opencode/`) was substantially extended after W086 landed, so the vendored payload was widened from the three original kinds to the full tree. Dated addendum — the W086 record above stays as written.

- **Payload widened.** `assets/opencode-fleet/` now mirrors the whole `install/opencode/` tree plus the `install/lib/` rulers it symlinks into the live config dir: agents grew 4 → 6 (`executor-strong`, `screener` added; all bodies re-synced), commands 4 → 7 (`explain`, `tldr`, `rsi-campaign` added), and new kinds `instruction` (`AGENTS.md`, `STANDARDS.md`), `style/` (`coding-style.md`), `template` (`templates/rsi/*`), `skill` (`skills/code-cheatsheet/*`), and `lib` (`install/lib/**`, incl. `vendor/`). The companion docs were re-synced and now include `operator-actions.md` (the originals plus `lessons.md` still present). Manifest: 12 → 67 entries.
- **Root config is reference-only.** `config.jsonc`, `cli.json`, and `tui.json` are vendored under `host-config/` for review, but the kind is `referenceOnly` — excluded from comparison, install, and even an explicit `kinds` request. The host config document remains operator-owned; the installer and doctor still never write it.
- **Generator is recursive.** `scripts/generate-fleet-manifest.mjs` now walks `templates/`, `skills/`, and `lib/` recursively (so `templates/rsi/ledger.md`, `skills/code-cheatsheet/SKILL.md`, and `lib/vendor/LICENSE-opencode-src` are entries), and entry ids carry the file suffix (`agent:decompose.md`, not `agent:decompose`).
- **Install targets.** Config kinds install under the host config dir at `<kind-subdir>/<file>` (`agents/`, `commands/`, `style/`, `templates/`, `skills/`, `lib/`); `instruction` installs at the config-dir root. Docs stay install-if-missing into `docs/agents/`. Manifest file paths are validated as safe relative subpaths (fail closed on `..`/absolute), since nested files now exist.
- **Not ported (deliberate):** the dotfiles top-level bootstrap scripts (`install/10-system.sh`, `20-tools.sh`, `30-settings.sh`, `bootstrap.sh`) that APPLY the config at bootstrap time; and the dotfiles per-repo memory (`docs/agents/ledger.md`, `docs/agents/lessons/`, `findings/`, `proposals/`) which are repo-owned, not portable. (`install/lib/**` IS vendored verbatim, including the dotfiles installer helpers `common.sh`/`env-flag.sh`, because dotfiles symlinks the whole `install/lib` into the live config dir.)
- **Evidence:** `test/install-doctor.test.ts` (15/15, incl. new pins for the extra kinds, reference-only exclusion, safe-path validation, nested-target copy command), `test/e2e-doctor.test.ts` (10/10, row labels + provisioned tree updated), manifest drift guard (67/67).
- **Residual (stated):** the installer writes atomically via temp-file + `rename`, so a `workflow install fleet` into a dotfiles-managed `~/.config/opencode` (where the golden-tree entries are symlinks into `install/opencode/`) replaces a symlink with a regular file at the target. Comparison reads through symlinks, so a synced dotfiles tree reports `current` and nothing is written; only a drifted target plus `--force` detaches the symlink. Operators who keep the dotfiles symlink farm should use the dotfiles installer (`install/30-settings.sh`) for those paths, not `workflow install fleet`.

---

## Supersession (2026-10-17): re-sync to the frozen dotfiles snapshot (`e75115a`)

Append-only; the records above stay as written. The dotfiles golden tree advanced past the 2026-10-13 port point (`bb529efe`) through the October-2026 RSI/harness evidence pass (dotfiles PR #77, merged `e75115a`, 2026-10-17T05:33Z). The vendored payload was re-synced to that frozen, merged snapshot. Same port rule as 2026-10-13: mirror `install/opencode/**`, `install/lib/**`, and the flat companion docs verbatim, by byte copy (never hand-edit), then regenerate the manifest.

- **Re-synced content (verbatim).** Agents: `retrospective.md`, `reviewer.md`, `screener.md` (the last two had been divergent since the port). Commands: `retro.md`, `rsi-campaign.md`, `rsi-loop.md`. Instructions: `AGENTS.md`, `STANDARDS.md`. Reference-only `host-config/config.jsonc`. Docs: `lessons.md`, `operator-actions.md`, `reading-list.md` (737 → 1217 lines: the October evidence pass), `rsi-loop-playbook.md`, `task-decomposition.md`. `lib/`: 20 files added, 9 updated.
- **New `lib/` rulers.** `measure-compaction.cjs`, `measure-permission-friction.cjs`, `measure-permission-reach.cjs`, `port-secret-read-rules.cjs`, `reconcile-rulers.cjs`, `validate-commands.cjs`, `wildcard-match.cjs`, `vendor-host-wildcard.cjs`, `vendor/wildcard.match.ts`, plus their `test-*` fixture suites. `install/lib/**` is again a verbatim mirror (55 files; nothing vendored-only).
- **Divergent agents reconciled.** `reviewer.md` and `screener.md` now carry the `ported-secret-read-rules` block (`>>> ported-secret-read-rules ... <<<`). These are `read`-action permission rules; the runtime lane's normalize step (`normalizeFleetEntry`) strips only the unmappable `external_directory` action, so the read denies install intact. Plane-side honoring of the read plane is unprobed and stays under the existing **Partial** status.
- **Manifest:** 67 → 87 entries, regenerated by `scripts/generate-fleet-manifest.mjs`.
- **Evidence (the Workflow gates).** `test/install-doctor.test.ts` 16/16 (includes the manifest drift guard), `test/fleet-agent-install.test.ts` 12/12, `test/e2e-doctor.test.ts` 10/10, `test/security-assurance.test.ts` 9/9, `npm run typecheck` and `npm run lint` clean.
- **Attribution (not caused by this sync).** `test/acp-runtime-agent.test.ts` (15/16) and `test/opencode-server-runtime.test.ts` (6/8) fail identically on the clean base `35fede08` — verified by stashing this sync and re-running — so they are pre-existing and unrelated to the fleet assets.
- **Residual (stated): the vendored `lib/` authoring-time suites are layout-bound, and this port inherits the whole class.** `lib/` is vendored as a verbatim mirror per the 2026-10-13 rule, and its `test-*` suites plus two generators resolve paths that exist only in the dotfiles tree: a sibling `../opencode/*` (`install/lib` beside `install/opencode`), the repo `.githooks/pre-commit` (`../../.githooks`), and the vendor slice (`../../install/lib/vendor/*`). Under the vendored layout (`assets/opencode-fleet/lib`) none resolves. Measured: of the 26 vendored `test-*` suites, **13 pass and 13 fail**; at the base `35fede08` the 14 `test-*.cjs` suites then present were **10 pass / 4 fail** (`test-host-vendor`, `test-measure-tool-output`, `test-port-destructive-rules`, `test-validate-ledger` — all four fail on the same missing dotfiles paths, so the class predates this sync). This sync adds 9 suites that fail on that same class (8 new files, plus a flip of the pre-existing `test-effective-model`, whose updated CLI-default pin now asserts the default config path ends in `install/opencode/config.jsonc`). Every one of the 13 is a dotfiles-layout path assertion, never a wrong ruler body. The exact split (auditable): **pass (13)** `test-agent-model-pin`, `test-config-shape`, `test-host-fingerprint`, `test-index-read`, `test-measure-cap-family`, `test-measure-compaction`, `test-measure-failure-composition`, `test-measure-permission-friction`, `test-measure-readback-effect`, `test-reconcile-rulers`, `test-validate-config-fleet`, `test-validate-lessons`, `test-env-flag`; **fail (13)** `test-effective-model` (base flip), `test-host-vendor`, `test-measure-permission-reach`, `test-measure-tool-output`, `test-port-destructive-rules`, `test-port-secret-read-rules`, `test-validate-agents-actions`, `test-validate-commands`, `test-validate-config-coherence`, `test-validate-config-effects`, `test-validate-ledger`, `test-wildcard-vendor`, `test-hook-worktree-guard`. Nothing in this repo executes the vendored `lib/` (no hook, no `test/` or CI reference — `test/ci-suites.txt` lists only `test/*.test.ts`; the manifest pins bytes only), so the failures are latent, not a red gate. Disposition: the vendored bytes stay verbatim (the manifest pins them; the port rule is "install/lib/** vendored verbatim"). The durable fix belongs on the dotfiles side: make these rulers and their fixtures accept an explicit `--root`/`--config`/`--agents`/`--vendor` override (or resolve the golden tree relative to a single declared root) so they run from any layout, after which the port is re-synced. Recorded here rather than silently shipping 13 crashing suites.
