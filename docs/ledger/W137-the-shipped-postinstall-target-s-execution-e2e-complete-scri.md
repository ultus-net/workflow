<!-- Ledger fragment: extracted from TASKS.md at line 5002 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W137 - The shipped postinstall target's execution e2e (Complete - scripts/prepare-tool.mjs driven in the packaged seat and through stub lanes; the workspace-upwalk mutation blast radius found) (2026-09-25)

**Source:** the third wave's prepare-tool agent. W128's packaged e2e
found the postinstall target shipped NOWHERE (fixed) and its shape pin
enforces presence; the hook's EXECUTION had never been tested.

**What landed:** `test/e2e-prepare-tool.test.ts` (5 tests): the LIVE
packaged seat (pack → extract → `node <extracted>/package/scripts/
prepare-tool.mjs`: exit 0 UNCONDITIONALLY; the built lane asserts the
toolbox install landed inside the installed tree + the vendored guard
seat's dist/server.js exists; the skipped lane (offline) asserts the
warn shape — exactly one class per run); the npm-repair rerun in the
same tree; and three stub-pnpm lanes (success → stdout EXACTLY
`prepare: toolbox ok\n`, argv EXACTLY ["--dir", <root>/mcp-toolbox,
"run", "build"], cwd = root, and a byte-identical second invocation;
exit 1 → exit 0 with the EXACT skipped message; missing pnpm → exit 0
with the ENOENT message). Finding (c) — the dead `existsSync` import in
the shipped script — FIXED in this loop.

**Findings recorded (not fixed):**
- **(a) The postinstall is heavyweight and network-dependent** — a
  consumer approving install scripts unknowingly installs the 391-entry
  vendored toolbox tree (~9.5s warm). Polish shape: a gate env (e.g.
  WORKFLOW_PREPARE_TOOL=1) or honest docs.
- **(b) THE WORKSPACE UPWALK MUTATION BLAST RADIUS** — the child pnpm
  resolves workspaces by walking UP from its cwd: when the target is not
  itself a workspace root, pnpm can mutate an ANCESTOR workspace's
  node_modules. OBSERVED during this agent's research (2026-09-25): the
  run pruned 135 stale entries from `/var/home/hunter/node_modules` (the
  operator's $HOME-level pnpm workspace — reconciled to its own lockfile,
  the same effect its own `pnpm install` would produce, but unintended).
  The PACKAGED seat is immune (the extracted toolbox IS a workspace —
  pinned), but the escape class is real; queued (remedy direction: refuse
  when the target is not a workspace root, or the (a) gate env).

**Acceptance criteria:**
- [x] 5/5 green twice (15.8-16.1s — the live lane's ~9.5s toolbox build
      dominates); lint + typecheck exit 0.
- [x] The packaged lane's writes confined to the extracted mkdtemp tree +
      a redirected-HOME store (with the ambient XDG/PNPM_HOME/NPM_CONFIG_*
      overrides stripped so HOME is authoritative — the round's P3); the
      repo's mcp-toolbox/scripts trees OBSERVED porcelain-clean around the
      live runs (the in-test canary is the mcp-toolbox/node_modules mtime).
- [x] The LESS-0051 safety contract: no agent/PTY spawns; the script's
      own pnpm child is short-lived (spawnSync-captured); all scratch
      under mkdtemp.

**Residuals (recorded, not fixed):** the two findings above; a hung
pnpm child could survive a parent timeout-kill (never observed); npm
12's install-scripts gate still means the hook does not run during a
real tarball install (this file drives it directly — W128's residual
stands).
