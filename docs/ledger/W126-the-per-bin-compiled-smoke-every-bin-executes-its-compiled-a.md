<!-- Ledger fragment: extracted from TASKS.md at line 4314 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W126 - The per-bin compiled smoke: every bin executes its compiled artifact (Complete - the nine-bin zero-execution residual closed; the sweep's first red closed a live defect: the standalone monitor died on first render) (2026-09-24)

**Source:** W125's recorded residual — the launcher smoke covered the
`workflow.js` dispatcher + doctor, and "the other nine bins carry the
same zero-execution gap." Each bin's first compiled execution in the
suite.

**What landed:** `test/compiled-bins-smoke.test.ts` — a per-bin sweep,
every probe SAFE by construction (no agent or daemon outlives the probe;
every homedir write lands under a redirected HOME; no browser opens; no
PTY is ever allocated; the monitor never auto-spawns a hub —
`WORKFLOW_AUTOHUB=0`): five fail-fast probes (tui refuses an unknown
driver at the composition seam BEFORE any driver spawn; shell boots its
banner and exits cleanly on stdin EOF; attach fails closed with the
actionable remedy under `--no-autostart`; the opencode-server rejects
unknown arguments BEFORE any guard/runtime composition; rsi prints its
usage), and four daemon probes that start, wait for the startup banner,
SIGTERM, and pin the TEARDOWN exit the surface's own handler produces
(web 0, hub 0 with the W120-fresh vendored guard seat, admin 0,
ephemeral ports throughout). The shared compiled-dist freshness gate
moved to `test/fixtures/compiled-dist.ts` (a third inline copy was the
round-1 cleanliness P3, preempted).

**Discovered and fixed — the sweep's first live defect:** the monitor's
standalone fallback (no hub) died on first render with "no active
workflow task selected" — the mode bar installs its gate on mount
(tui.tsx's mount effect calls `onModeChange` unconditionally) and
`applySkillGating` reads the active task, but the standalone seed was
never activated (universal-tui survives because its session start
activates; the monitor never starts a session; the operator's hub is
always running, so this path was never exercised live). Fixed:
`ink-tui.tsx` standalone calls `application.startInteractiveTask()`
before rendering. What remains in a non-TTY seat is ink's own honest
limit (`Raw mode is not supported`) — the monitor probe pins it as the
environment truth it is.

**Discovered and queued (not fixed):** `workflow-opencode-server --help`
returns args without exiting (parseDaemonArgs) — the flag STARTS THE
DAEMON instead of printing usage. The fix is its own item (help must
print and exit before composition).

**Acceptance criteria:**
- [x] Red/green across the sweep: the monitor's first red was the live
      crash (the defect above); after the fix, its remaining red is ink's
      honest raw-mode boundary — pinned as the environment truth it is.
      9/9 bins green.
- [x] Every probe is safe by construction: no agent spawns, redirected
      HOME (fresh tmp per probe), ephemeral ports (port 0 / hub bridge
      port 0), controlled SIGTERM with the surface's own teardown exit
      pinned.
- [x] Hold-outs 29/29 (web + W124); lint + typecheck exit 0 (after
      fixing the strict-mode exitInfo finding typecheck itself caught).
- [x] The hub probe self-heals the vendored guard seat (the W120 gate's
      own remedy) before composing.
- [x] The PR preflight's manifest/lockfile check caught a PRE-EXISTING
      drift the W127 build-script edit surfaced: the lockfile's root bin
      map still recorded `workflow → dist/cli/web-launch.js` (a stale
      pre-restructure entry) while the manifest carries the real ten-bin
      map; the lock-only install synced it and dropped a drifted optional
      peer row — recorded as the preflight's own finding (no dependency
      changes: the audit stays 426 packages, 0 vulnerabilities).
- [x] The round-3 fresh-eyes review (committed-state) accepted with three
      P3s, all fixed pre-recording: the freshness gate now covers the
      prebuilt emitter script (a script-only edit rebuilds — the gate's
      walk previously missed scripts/build-webapp-bundle.mjs); probeDaemon
      spawns detached and kills the child's PROCESS GROUP (the
      broken-teardown scenario the hub probe exists to catch cannot orphan
      the hub's guard child — the kill-group pattern of
      opencode-attach's terminateProcessGroup); the hub probe's pnpm
      remedy failure now names the actionable fix (and the repo's own
      preserve-caught-error lint rule caught the missing cause
      attachment). The reviewer's honest residue is recorded: its sandbox
      could not read the ledger/lessons tails or four CLI sources, so
      those claims are operator-attested (its verified set — the six
      safety seams it traced — held fully).

**Residuals (recorded, not fixed):** universal-tui's real-driver path
remains unexercised (it spawns an agent — out of the default suite's
bounds by the operator resource directive); the opencode-server `--help`
latent bug is queued (above); a headless monitor snapshot mode (ink
Static) is a possible future surface, not queued.
