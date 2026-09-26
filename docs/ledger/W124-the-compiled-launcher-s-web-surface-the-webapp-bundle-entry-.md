<!-- Ledger fragment: extracted from TASKS.md at line 4183 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W124 - The compiled launcher's web surface: the webapp bundle entry is layout-aware (Complete - the src-vs-dist skew closed; the operator's live failure reproduced and fixed) (2026-09-24)

**Source:** the operator's live failure during launcher testing (PR #116's
post-merge): `npm run build && node dist/cli/workflow.js` surface 1
failed esbuild with "Could not resolve
/var/home/hunter/Workflow/dist/ui/webapp/main.tsx" — the webapp bundle
seam resolved its entry as a SIBLING of the module file, which is true in
source mode (tsx runs src/ui/webapp/bundle.ts beside main.tsx) but broken
in the compiled layout (tsc emits dist/ui/webapp/main.js; a .tsx never
exists in dist). The LESS-0012 dual-surface parity rule (the src-vs-dist
skew returns as behavioral divergence between seats) applied to the
webapp bundle seam.

**What landed:** `resolveWebappEntry(moduleUrl)` in
src/ui/webapp/bundle.ts — LAYOUT-AWARE: the source sibling first, then
the src copy three directories up from a dist location (the
tsconfig.build rootDir/outDir math verified against the real layout),
then an error naming BOTH candidates (fail-closed, diagnosable);
`buildWebappBundle` calls it lazily with `import.meta.url` (not
module-load — the error surfaces where it is actionable). The compiled
launcher's web surface is the only affected path (source mode
`npm run web` was never broken).

**Acceptance criteria:**
- [x] Red/green: the pins red at module level (the export absent — the
      operator's tree reproduced the failure live), 4/4 after (the src
      sibling, the dist fallback, the named-candidates error, the real
      repo in both layouts); the fix's commit state verified (the
      reviewer's reflog P1 — the fix rode a mislabeled test(webapp)
      commit, split into properly-labeled commits and the
      fixture-mkdir/regex corrections re-applied on top).
- [x] The both-candidates regex per review (the pin asserts the ordered
      pair — the dist candidate, then " and ", then the src candidate; a
      message dropping either fails the pin).
- [x] The interim workaround recorded: `npm run web` (tsx mode) was never
      affected; the compiled path is what this closes.

**Residuals (recorded, not fixed):** the "real compiled layout" pin is a
simulated dist-shaped module URL — the operator's live
`node dist/cli/workflow.js` repro is the live verification; the
"real compiled layout" wording corrected to "a dist-shaped module URL"
per review (the pin exercises the fallback logic, not a built
artifact); the fixture prefixes all renamed to w124-* per review.
