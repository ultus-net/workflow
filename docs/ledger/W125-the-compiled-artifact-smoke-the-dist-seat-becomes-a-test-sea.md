<!-- Ledger fragment: extracted from TASKS.md at line 4227 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W125 - The compiled-artifact smoke: the dist seat becomes a test seat (Complete - the W124 recorded residual closed: the real compiled bundle and the compiled launcher are executed by the suite, not only by the operator) (2026-09-24)

**Source:** W124's recorded residual — "the pin exercises the fallback
logic, not a built artifact." The W124 pins ran `resolveWebappEntry` over
simulated dist-shaped module URLs; no suite test had ever imported the
real compiled module or executed a compiled bin, and every webapp test
sat in the source seat (they load `../src/ui/webapp/bundle.js` under
tsx, where the sibling resolution is valid). The operator's manual UAT
(`npm run build && node dist/cli/workflow.js`) was the only compiled
runner — which is exactly how the W124 skew was found live. LESS-0048's
two-seats rule (a fix verified in one seat only is "Partial") made
executable; LESS-0012's dual-surface parity rule generalized from the
toolbox's in-process import to a compiled-smoke pin for the main dist.

**What landed:** `test/webapp-bundle-dist.test.ts` — two pins, both
self-healing via the W120 conditional-pin pattern generalized to the
main dist (`ensureBuilt`: a missing artifact is the rebuild's job, not
staleness — the same two-error-class split; any src file newer than the
artifact under test is stale; the mtime false-positive class is W120's
recorded deliberate fail-closed, the rebuild idempotent): (1) the
webapp-bundle pin imports the REAL `dist/ui/webapp/bundle.js` and
executes `buildWebappBundle()`, asserting js (the `composer-chips`
markup hook — a literal that survives minification) and css (the
`--accent` design tokens — the css side-effect import must resolve in
the dist graph); (2) the compiled-launcher smoke spawns
`node dist/cli/workflow.js doctor` end-to-end — the suite's first
compiled-bin execution — asserting the report renders with its checks
and that exit 0/1 are the only honest outcomes (warns and fail rows are
environment truth; a signal, a timeout, or any other status is a
compiled-runtime crash).

**Acceptance criteria:**
- [x] Red/green across the seat boundary: the pre-fix dist (the
      operator's UAT build, still on disk when this loop began) rejected
      `buildWebappBundle()` with the operator's live failure verbatim
      ("Could not resolve /var/home/hunter/Workflow/dist/ui/webapp/
      main.tsx"); the post-fix dist produced js=1,032,865 / css=53,304.
- [x] The self-heal exercised, not assumed: touching a src/ui/webapp
      mtime triggered the in-pin `npm run build` and the pins passed on
      the rebuilt artifact (the rebuild path runs green under the test
      runner).
- [x] Hold-outs 29/29: the four W124 pins, the source-seat web tests
      (incl. the /app.js bundle-serving check), the uncommitted W115
      poll pins.
- [x] lint + typecheck exit 0 — which surfaced six no-useless-escape
      lint errors in the W124 pin file's review-round regex (trunk lint
      was red despite LESS-0048's "lint exit 0" evidence; the gate was
      not re-run on the final commit state) — fixed here as the lint
      gate's own finding.
- [x] The round-1 fresh-eyes review (five axes) accepted; its P2 fixed
      pre-recording: the staleness walk omitted the build's CONFIG
      inputs (tsconfig.json, tsconfig.build.json, package.json,
      package-lock.json) — a config-only change with no src mtime bump
      would have skipped the rebuild, the walk-narrower-than-input-graph
      lie LESS-0049(4) declares, applied to the pin itself; the config
      inputs now ride the staleness comparison (6/6 pins + lint +
      typecheck re-run green after the fix). The reviewer's second P2 is
      recorded, not actionable: its sandbox had no shell, so the gate
      runs are operator-attested (its static inspection confirmed the
      structural claims).
- [x] The round-2 fresh-eyes review (the committed-state re-review the
      PR preflight's fingerprint rule demanded) accepted with one P2,
      fixed pre-recording: the bundle pin's staleness walk covered only
      src/ui/webapp while the bundle's real input graph could extend
      cross-tree (all cross-tree imports are type-only today — erased by
      esbuild — so the walk was correct by unasserted invariant), the
      walk-narrower-than-input-graph lie again; resolved STRUCTURALLY by
      widening both walks to all of src — the whole-dist remedy's true
      input graph (`npm run build` rebuilds everything, so the walk
      cannot be narrower than what the remedy consumes). The P3s
      recorded: ensureBuilt copies W120's shape (the W120 predicate is
      hardwired to the vendored-app layout); the doctor probe is
      deliberately non-hermetic — stated in the pin's comment with both
      probe bounds now verified in source (probeHub's and the gateway
      probe's 2s AbortSignals, hub-client.ts:49 / opencode-health.ts:43,
      plus the 120s spawn timeout); execFileSync("npm") is POSIX-shaped
      (the repo is Linux/bubblewrap-targeted).

**Residuals (recorded, not fixed):** the launcher smoke covers the
`workflow.js` dispatcher and doctor's compiled graph (arg parsing, hub
client, settings, fleet, probe verdicts, posture); the other nine bins
(`workflow-web`, `workflow-tui`, `workflow-hub`, …) carry the same
zero-execution gap until a per-bin smoke or a doctor-style sweep covers
them. The dist seat still presumes devDependencies (esbuild is a
devDependency — a packaged install cannot run the webapp bundle at all;
adjacent to the P6 npm-pack verifier debt, unchanged by this loop).
