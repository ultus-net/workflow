<!-- Ledger fragment: extracted from TASKS.md at line 4510 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W129 - The help contract: every bin resolves --help before any side effect (Complete - W126's discovered-and-queued defect closed as a class; previously six bins started their surface on --help, one printed a token, one could start the agent) (2026-09-25)

**Source:** W126's discovered-and-queued defect —
`workflow-opencode-server --help` started the daemon instead of printing
usage. The survey for this loop showed it was a CLASS: only
`acp-remote.ts` resolved help correctly (parse → `help: true` → print
USAGE → return); `opencode-attach --help` proceeded into
`ensureDiscovery`, whose autostart path could START THE DAEMON;
`universal-tui --help` fell through to `composeDriver` and could START
THE AGENT; the module-level daemons (`hub`, `admin`) started on ANY
argv; `web-launch`, `ink-tui`, and `contained-shell` ignored the flag;
`rsi --help` was rejected as an unknown command.

**What landed:** the help contract — every bin resolves `--help`/`-h`
to a usage block and exit 0 BEFORE any composition:
- parser-level (the acp-remote pattern): `opencode-server`
  (`parseDaemonArgs`), `opencode-attach` (`parseAttachArgs`),
  `universal-tui` (`parseUniversalArgs`), `rsi` (`--help`/`-h` map to the
  help command). The `help?: true` field is ADDITIVE (present only when
  requested), so the existing parser deep-equal pins stay valid
  (driver-registry, opencode-server-launcher, pretrust-parsing-audit).
- pre-composition guards for the module-level daemons and script
  surfaces: `hub`, `admin`, `ink-tui`, `contained-shell`, and `web-launch`
  (the guard lives INSIDE `runWebLaunch` — see the round-1 review note
  below).
- the dispatcher: a leading `workflow --help`/`-h` prints the surface
  list and exits 0; a verb's own `--help` resolves at that surface's own
  seam — `web` inside `runWebLaunch` (shared by the in-process call and
  the script entry), `settings`/`doctor`/`install` in their dispatch
  branches (`helpExit`), and the spawned verbs (`tui`, `hub`) in their
  bins' guards.

**The captured red:** `node dist/cli/admin.js --help` (pre-fix) printed
"Workflow admin listening at http://127.0.0.1:4180" plus a FRESHLY
GENERATED admin token and served until a 5s timeout killed it (exit
124) — the module-level daemon started where usage belonged, and the
token printed for a command that should touch nothing. The agent-spawn
reds (universal-tui, opencode-server) were cited from source, never
executed during development (spawning an agent is outside the suite's
bounds).

**Acceptance criteria:**
- [x] Red/green: the live admin red above; post-fix 24/24 in the sweep
      file (expanded by the round-1 review: 9 W126 probes + 15 W129 rows
      × BOTH flags — the original 10-pin cut and its 19/19 count stand
      recorded in the round-1 bullet below), each pinning exit 0 + the
      usage marker + EMPTY stderr.
- [x] Regressions 58/58: the three parser suites whose deep-equals guard
      the additive help field, the web/W124 hold-outs, the W125/W127
      pins, and the three W128 e2e files.
- [x] lint + typecheck exit 0.
- [x] The dangerous paths named honestly: universal-tui's `--help` no
      longer composes the agent; opencode-attach's `--help` no longer
      reaches the autostart discovery path; opencode-server's `--help`
      no longer composes the guard or runtime.
- [x] The round-1 fresh-eyes review REVISE'd the first cut with a real
      P1: the claim `workflow web --help` routes to the bin's guard was
      FALSE — the dispatcher calls `runWebLaunch` IN-PROCESS, bypassing
      the runnable-script guard, so it started the service (same class:
      `settings`; P2: rsi's `--help` only resolved in argv[0], so
      `start … --help` could reach the verifier POST). Fixed
      pre-recording: web's guard moved INSIDE `runWebLaunch`; the
      in-process verbs (settings/doctor/install) guard in their dispatch
      branches; rsi resolves `--help`/`-h` anywhere (including the
      single-dash token the flags loop previously rejected). The pins
      now run BOTH flags per row and cover the in-process verb paths and
      rsi's non-leading help (24/24). LESS-0053's lesson gained the
      in-process-bypass clause.

**Residuals (recorded, not fixed):** the usage text is per-bin minimal
(the first-line banner + key flags), not exhaustive flag docs; help
resolves anywhere in WELL-FORMED argv — a malformed value pairing
(`workflow web --cwd --help`, `workflow-rsi --help start`) fails closed
with the value error before any side effect (the seam's hard line holds;
the anywhere-nicety leaks, recorded by the round-2 review as note-level).
