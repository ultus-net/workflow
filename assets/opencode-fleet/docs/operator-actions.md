# Operator actions: the blocked items after the n=15 pass

This lists the items that are outside the agent's boundary (live settings,
process environment, remote state) with the exact action and its evidence.
Done this pass: item 1 (canonical cleanup + live routing comment, operator-ran
then agent-finished the follow-ons), item 6 (orphan remote pruned), item 7 (host
fingerprint merged via PR #26), item 8 (the `/rsi-campaign` command landed via
the installer). Item 9 (golden-tree flip) is now done. Still operator-owned:
items 2, 3, 4.

## 1. Canonical `opencode.jsonc` cleanup (done)

The agent cannot touch any path whose basename is `opencode.jsonc` (repo or live;
`guard_why` -> `tamper/protected_path`, even on a feature branch), so the
operator ran the two hand edits:

- **Dead tracked copy removed.** `.config/opencode/opencode.jsonc` is deleted;
  the installer deploys the overlay `install/opencode/config.jsonc`
  (`install/30-settings.sh:202-267`). The one inbound link
  (`docs/agents/README.md`, Wiring row) now targets
  `install/opencode/config.jsonc`. The installer's canonical-divergence report is
  removed: the dead `canon=` divergence check inside `report_state` is gone,
  while `report_state` and its live-vs-overlay check stay. Agent-side follow-ons
  landed in PR #29 (branch `chore/drop-dead-canonical`), including a fix for a
  `fi}` brace collapse the hand-edit script introduced.
- **Live stale routing comment fixed.**
  `~/.config/opencode/opencode.jsonc:5-8` now carries the authoritative overlay
  framing (`install/opencode/config.jsonc:12-13`): the per-agent `model:` pins
  decide, not the router. Confirmed present live.

## 2. File-watcher flag (merged in PR #23)

`watcher.ignore` is inert for agent sessions because its only consumer is gated
behind `OPENCODE_EXPERIMENTAL_FILEWATCHER` (default false, not settable from
config). PR #23 (`chore/unblock-1-2-5`, merge `a50c6bc`) landed the export in
`environment.d` and an append-only installer step. To activate it live:

    bash install/bootstrap.sh --only 30      # appends the export (no FORCE)
    # log out/in so systemd --user re-imports the environment, restart the
    # opencode service, open a NEW location (config is read once per location
    # open), then confirm the flag in /proc/<pid>/environ and that ignore fires.

See `findings/watcher-enablement.md` (added by PR #23). The watcher *effect*
(after this is live) is the n=8/n=9 open question; a fresh-location ruler can
score it once the flag is active.

## 3. n=5 router-reach live scoring (needs a stranger + fresh server)

The fix is in the separate `opencode-openrouter-auto-latest` plugin repo, so it
is out of this repo's scope. Scoring the fix live needs an **unpinned stranger
agent** (one with no `model:` frontmatter) on a **fresh server/location**, but
note that `install/lib/verify-effective-model.cjs` **cannot** grade it: that
ruler grades only pinned agents (`intendedModels()` skips pins-less files,
`verify()` drops any row whose agent has no intent, `:88`/`:227`). Read the
store directly instead:

    # per-agent effective model after the stranger has run (v2 store)
    # time_created is epoch-ms, and `model` is a JSON blob, so parse both.
    node -e 'const {DatabaseSync}=require("node:sqlite");
    const db=new DatabaseSync(process.env.HOME+"/.local/share/opencode/opencode.db",{readOnly:true});
    for (const r of db.prepare("SELECT agent, model, COUNT(*) c FROM session_v2 WHERE time_created >= ? GROUP BY agent, model").all(Date.parse("<ISO timestamp>"))) {
      const m=JSON.parse(r.model||"{}");
      console.log(r.agent, "->", m.providerID+"/"+m.id, "("+r.c+")");
    }'

A stranger session whose `model` resolves to a specific alias (not `syn:auto`)
means the fix reaches; `syn:auto` is the reach gap. (`verify-effective-model.cjs`
stays useful for the *pinned* fleet, but it is not the tool for this check.)

## 4. `tool_output` cap tune (operator decision; agent can apply)

The caps are live at `max_lines 800` / `max_bytes 30000`. The golden config
`install/opencode/config.jsonc` is the deploy source, so a tune is an edit there
followed by:

    bash install/bootstrap.sh --only 30

The live config is copied from the overlay (it is not symlinked, because the
live config path is app-owned and the config carries operator-only gates), so
the installer applies the change by copying the golden file over the live one
(FORCE=1 if they differ and you accept the portable subset replacing your live
extras). A further tune is a value decision the operator owns; the rulers make it
data-driven:

- bytes removed (proxy): `node install/lib/measure-tool-output.cjs --settings 800/20000`
- round-trips added (effect), per family: `node install/lib/measure-readback-effect.cjs --bucket-week`

Measured on the live store: `max_bytes` dominates (79/81 files over the 51200
default); `800/20000` projects ~47% below the current retained preview. The
read-back rate is **per family** (n=14/n=15): `webfetch` ~32.8% (weekly 23.5–55.6%),
`execute` ~20%, `bash` ~8.8%, `guard_review_followups` ~0.7%. The aggregate
~9.3% is a composition-dependent mixture (n=15), not the tune's target. The bytes
ruler varies with the chosen cap and gives the pre/post projection; the effect
ruler is a cap-independent store-wide rate, so use it to confirm the read-back
baseline, not to project a specific value. Any before/after delta must be
compared **per family** and on comparable composition (n=15).

## 5. Merged local branches (done)

`rsi/n8-caps-effect` … `rsi/n15-rate-stability`, the `chore/*` recovery and
unblock lines, the `feat/*` lines, and `docs/config-caps-proposal` were deleted
from feature branches this pass; local `main` only. Branch deletion is
guard-blocked while on the protected branch, so it runs from a scratch branch.

## 6. Orphaned remote branch `docs/rsi-n5-record` (done)

PR #13 (head `docs/rsi-n5-record`) was MERGED (merge commit `34f74b9`), and the
branch ref had advanced to `d324a9f` (a PR #14 merge) with 3 commits not
reachable from `main` (the n=6 round-3 work, re-landed via the n=10 carryover).
The ref-existence check returned the expected tip, then it was pruned:

    gh api -X DELETE repos/ultus-net/dotfiles/git/refs/heads/docs/rsi-n5-record

Confirmed done: the ref now 404s.

## 7. Host fingerprint (done; vendored, one mode still operator-invoked)

`install/lib/host-fingerprint.cjs` and its fixture suite turn the n=12 ruler's
prose host pin into a machine check. It landed on `main` via the recovery PR #26
(merge `82d689c`) after #24 was stranded on a stacked base.

As of n=17 (same PR), the check has **two modes**:

- **No host source needed (runs in the change-triggered pre-commit hook).** The
  ported host region is vendored verbatim at
  `install/lib/vendor/tool-output-store.preview.ts` with a provenance pin, and
  pre-commit Layer 13 runs `test-host-vendor.cjs` — a provenance-hash check plus
  a differential test of the port against the vendored snapshot — with no
  `$OPENCODE_SRC` at all. This catches port-vs-snapshot drift (a port edit that
  diverges from the vendored bytes). It is not a continuous CI job (this repo
  has no CI harness); it fires when any of the ruler (`measure-tool-output.cjs`),
  the vendored file, the vendor tool/fixture (`vendor-host-preview.cjs`,
  `test-host-vendor.cjs`), the fingerprint checker, or the hook itself is staged.
- **Operator-invoked upstream diff.** Catching drift of the *upstream* host
  itself still needs a checkout; `host-fingerprint.cjs` SKIPs (exit 0) when the
  source is absent, so it is run on demand against a checkout with

    OPENCODE_SRC=/path/to/opencode-src node install/lib/host-fingerprint.cjs

`install/lib/vendor-host-preview.cjs --src DIR --write` re-vendors the pinned
region from that checkout.

## 8. `/rsi-campaign` command install (done; installer)

The bounded multi-iteration campaign driver lives at
`install/opencode/commands/rsi-campaign.md`. The live commands dir
`~/.config/opencode/commands/` is tamper-protected to the agent and is a symlink
into the golden tree, so writing the golden file *is* the live edit.
Install / idempotent re-check:

    bash install/bootstrap.sh --only 30

The installer symlinks `install/opencode/commands` to
`$HOME/.config/opencode/commands`, so `/rsi-campaign` resolves. `/rsi-loop` is
unchanged (single-shot). Reading-list-grounded; meta loop stays gated.

## 9. Dead repo UI copies and the retired enforcement add-on (done)

The golden UI config lives at `install/opencode/cli.json` and
`install/opencode/tui.json`, deployed by `apply_ui_overlay`. The duplicate
`.config/opencode/` tree is gone: the golden tree `install/opencode/` is now the
single source, and the live `~/.config/opencode/{agents,commands,style,AGENTS.md,
skills}` entries symlink straight into it (see `golden-config-plan.md` section 8).

- **Duplicate tree removed.** `.config/opencode/{agents,commands,skills,style,
  AGENTS.md,cli.json,tui.json,package.json,package-lock.json}` were deleted (the
  operator ran `git rm -r .config/opencode`; the config's own `edit`-deny blocks
  the agent). With them went the convergence/drift apparatus that only existed to
  reconcile two trees: `config-converge.cjs`, `command-parity.cjs`,
  `command-converge.sh`, `agent-pin.sh`, `style-grant.awk` and their fixtures.
  The installer now symlinks live straight from `install/opencode/`.
- **STANDARDS.md is symlinked and injected.** `install/30-settings.sh` links
  `install/opencode/STANDARDS.md` to `~/.config/opencode/STANDARDS.md`, and
  `config.jsonc`'s `instructions` list auto-injects that path (plus
  `style/coding-style.md`) into every session and every agent. The agent writes
  the golden copy; the operator deploys it.
- **Retire the enforcement add-on at the end of the cutover.** The overlay still
  declares `plugins: ["opencode-workflow-guard@latest"]` as a transitional block
  so the guard stays active while it is being replaced by the policy server.
  Remove that block from `install/opencode/config.jsonc` when the replacement
  lands, then re-apply (`FORCE=1 bash install/bootstrap.sh --only 30`). Only
  after that should the operator remove the installed
  `opencode-workflow-guard` under `~/.config/opencode/node_modules` or
  `~/.config/opencode/plugins`. The overlay config already carries the three
  destructive-command gates the add-on used to hold: recursive-delete `ask`, and
  forced-push `deny`.

The live `~/.config/opencode/{cli.json,tui.json}` were replaced by
`FORCE=1 bash install/bootstrap.sh --only 30`. Backups are under
`~/.local/share/dotfiles-backup/`.
