<!-- Ledger fragment: extracted from TASKS.md at line 4396 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W127 - The packaged seat: the webapp bundle is prebuilt into dist (Complete - the W125 recorded limitation closed: the packaged install serves the operator UI without esbuild and without src) (2026-09-24)

**Source:** W125's recorded residual — "the dist seat presumes
devDependencies (esbuild is a devDependency — a packaged install cannot
run the webapp bundle at all)." A packaged install ships `dist/` only:
no `src/` (so W124's three-up fallback entry is absent) AND no
devDependencies (so runtime esbuild bundling fails — worse, the STATIC
esbuild import failed the compiled module's LOAD itself).

**What landed:** `scripts/build-webapp-bundle.mjs` — the build emits
`dist/ui/webapp/prebuilt.js` + `prebuilt.css` beside the compiled module
(options mirroring bundle.ts's runtime build; the npm build script gains
the step); `bundle.ts` serves the prebuilt artifacts when present (the
dist seat, and therefore the packaged seat) and falls back to the
runtime build otherwise (the source seat keeps that path); the esbuild
import went LAZY so the prebuilt seat never loads the devDependency at
all. Two new pins: the runtime fallback executed by the REAL compiled
module (the W124 resolution, no prebuilt beside it), and the packaged
seat — dist/ui/webapp copied WITHOUT src and WITHOUT node_modules —
serving the prebuilt bundle verbatim.

**Acceptance criteria:**
- [x] Red/green: the packaged pin's first red was the missing prebuilt
      artifacts (copyFileSync ENOENT — the build emitted none); the
      static-import hazard it guards is the module-load mechanism
      ("Cannot find package 'esbuild'") the lazy import removes by
      design. Post-fix: the packaged seat assembles and serves verbatim;
      the fallback pin proves the W124 resolution still executes in the
      compiled seat.
- [x] The dist seat now serves the prebuilt artifact in ~6ms (the
      runtime esbuild build took ~100ms) — the compiled launcher's web
      surface gets faster in the same change.
- [x] Hold-outs 29/29; lint + typecheck exit 0; 13/13 across the
      compiled-seat files (9 bins + 2 W125 + 2 W127).
- [x] The W125 residual updated: the "presumes devDependencies"
      limitation is closed; the npm-pack verifier debt (P6, human-gated)
      remains adjacent and untouched.

**Residuals (recorded, not fixed):** the prebuilt options and the
runtime options are two sets that must stay in sync (the mirroring is
comment-bound, not enforced); the packaged seat's OTHER flows (fleet
install, hub composition from a packaged tree) remain unmeasured —
adjacent to the P6 npm-pack verifier debt, still human-gated.
