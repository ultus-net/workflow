<!-- Ledger fragment: extracted from TASKS.md at line 5339 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W143 - The `workflow doctor` e2e (Complete - the verb's honest-output contract on the TSX lane: the uninstalled 8-check shape, the probe-verdict register tally byte-for-byte, and the exit-code matrix) (2026-09-25)

**Source:** the fourth wave of the operator's e2e-coverage direction
(report-only agent, LESS-0051 safety contract; TSX lane only — never
dist, no builds, no network). doctor had smoke-level coverage only
(compiled-bins-smoke); its rendering contract had no e2e.

**What landed:** `test/e2e-doctor.test.ts` (10 tests, green twice
consecutively, ~3.4-3.7s): the honest UNINSTALLED shape — all 8 checks
rendering 10 report rows (credentials expands to three), exit 1, fleet
the fail row on a fresh home (`0/15 entries current`, manifest-derived);
the register tally derived from the repo's real docs/PROBE_VERDICTS.json
(42 verdicts: 27 green / 1 red / 1 negative / 2 pending / 11 blocked)
matched byte for byte against the CLI output; the exit-code matrix —
provisioned (byte-identical fleet copy, fake agent binaries, canonical
upstream key env, fake cline on the child PATH) = 0; corrupt settings /
stale hub discovery / stale topology discovery each singly flip 0 → 1;
doc-drift and the guard-plugin posture stay warns at 0; crafted-state
overlays (global+workspace settings parse detail via --cwd, stale
discovery against a dead loopback port refusing instantly, guard-plugin
host config).

**Findings recorded (not fixed):**
- **F-1: the register seat is not CLI-reachable** — checkProbeVerdicts()
  is called with no options (src/cli/doctor.ts:344) and resolves its root
  from the module's own location (probe-verdicts.ts:76-83);
  runDoctor never forwards DoctorOptions.root; the fail-closed shapes
  (corrupt/missing register) are pinned at the programmatic seat via a
  tsx child, and the CLI-side proof the seat is the repo file is the
  tally match.
- **F-2: the armed count counts register ROWS, not distinct gates** —
  arming WORKFLOW_ACP_GOOSE_METERED (named by two rows, one green one
  blocked) renders "2 gate(s) armed now" naming one gate (doctor.ts:225,
  233); the test faithfully reproduces the quirk it records.
- **F-3 (cosmetic):** "1 agent prefs" / "1 servers" pluralization.
- **F-4: cline availability has no `*_BIN` seam** in listWebAgents
  (resolves ambient `which cline`, cline-launch.ts:62-74), unlike
  opencode/goose; a cline-free seat can only be crafted on PATH.

**Acceptance criteria:**
- [x] 10/10 green twice consecutively; lint + typecheck exit 0 with the
      file present.
- [x] The LESS-0051 safety contract: TSX lane only (never dist, no
      builds); no network (the only traffic is a dead loopback
      127.0.0.1:1 refusing instantly); every write confined to mkdtemp
      trees; no agent/PTY spawns; focused runs only.

**Residuals (recorded, not covered):** corrupt-register rendering
through the CLI verb (F-1's seat resolution — no env/cwd override; the
programmatic seat carries the fail-closed pins); the non-Linux
containment row (the machine is Linux with /usr/bin/bwrap present —
pinned to all three honest shapes instead).
