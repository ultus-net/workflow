# W201: hub layout + IA rework (the route-aware control plane)

Status: implemented, pending CI.

## Problem

The hub stopped being an OpenCode-plane-only surface: it now owns the assistant
dimension (the three routes `coding | tutor | care`, the identity binding, the
withheld set) and the shared `augur-workspace`. A live render (Chromium over the
repo's own CDP harness, `test/fixtures/webui-demo-server.ts`, at 1728x1080)
showed the frame had not kept pace:

1. **No content measure.** Every page spanned the full viewport; on a 1728px
   display the Overview stat tiles were ~300px wide each holding a two-word
   label and every section was a full-width box holding one italic line.
2. **No rank on the landing.** Every zone carried an identical border and
   padding, so `NEEDS YOU` (attention) read the same as `RECENT ACTIVITY`.
3. **Four chrome bands** stacked above the first row (header, posture strip,
   page, status bar).
4. **The content region did not fill**, so the status bar stranded mid-page
   (observed at y≈586 of a 1080px viewport) on the views rendered as direct
   children of `.shell-main`.
5. **Degraded states leaked developer strings** (Board rendered a bare env-var
   dump as page content, `board-view.tsx:87`).
6. **The rail buried the assistant dimension** under `Automation`.

## What shipped

`docs/HUB_LAYOUT_IA_REWORK.md` is the plan of record; this ledger records the
implementation.

- **R1, one measured frame** (`styles.css`): a `--measure: 84rem` token and one
  grouped rule giving every page root (`.overview`, `.usage-view`,
  `.activity-page`, `.audit`, `.sessions-view`, `.runs-view`, `.reviews-view`)
  `max-width`, `margin-inline: auto`, and `flex: 1`. Chrome stays full-bleed.
  A second rule measures the bare `.runs-absent` degraded paragraph. Verified
  numerically over CDP: page roots measure 1344px at 1728, 1120px at 1280, and
  740px at 900; `.status-bar` bottom equals the viewport height on every view
  and width (the stranding is gone).
- **R2, landing rank** (`overview-view.tsx`): the stat strip leads, Needs you
  follows with an `overview-attention` modifier, Live runs and Next fires share
  one `overview-secondary` band, Recent activity closes the page. An empty
  Needs-you zone gains `overview-empty-zone` and recedes. Records, named-absence
  strings, and derivations are unchanged.
- **R3, one chrome band** (`styles.css`): the posture strip loses its top rule
  and tightens to a slim row; `.shell-header:has(+ .posture-strip)` drops the
  header's own bottom rule so the pair reads as one band (and the header keeps
  its rule when the strip is absent).
- **R4, operator copy** (`board-view.tsx`, `agents-view.tsx`): the Board's
  unconfigured state leads with operator language and demotes the variables to
  a `<details>` disclosure; the Agents single-session note reads in plain
  words.
- **R5, rail IA** (`shell.tsx`): Routes and Workspace move out of `Automation`
  into a new `Assistant` group. `commandView` gained `/workspace`, which the
  rail and palette entries already referenced (a latent dead palette entry:
  `palettePageEntries` maps `APP_VIEWS` through `commandView`, and `workspace`
  had no slash command).

## Evidence

- `test/webapp-shell.test.ts` (NEWLY REGISTERED in `test/ci-suites.txt`): rail
  groups now include `Assistant`; the local `VIEWS` list is refreshed to carry
  `workspace`. This suite was absent from CI, which is why a stale pin had
  accumulated: `workspace` was added to `APP_VIEWS` by W197 but not to the
  test's local list, and `commandView("/workspace")` returned `undefined`,
  failing the palette order pin on clean `main`. Both are fixed here and the
  suite is now manifest-enforced.
- `test/webapp-surface.test.ts`: red-first pins for the Board disclosure, the
  Agents copy, and the Overview rank order (stat strip before Needs you before
  Live runs before Next fires, plus the two new modifiers).
- `test/webui-e2e.test.ts`: still boots console-clean in real Chromium.
- `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npm run build` clean.
- Related suites green: webapp-runs (23), webapp-reviews (14), webapp-activity
  (6), webapp-audit (5), webapp-presenters (11), webapp-card-panel (9),
  webapp-incidents-strip (6), webapp-palettes (5), workspace-view (7),
  ci-suites-manifest (5).

## Scope decisions

- **Rank, not restyle.** The palette token values, the AA invariants, the
  square edges, the mono/sans split, and every view's data contract are
  untouched. `--measure` is the only new token.
- **`--measure` at 84rem.** Chosen so the widest table view (Runs) keeps its
  columns comfortable while prose and single-line zones stop sprawling. It is a
  single token, so it is trivially retunable.
- **The degraded-state measure is scoped** to `.shell-main > .runs-absent` and
  `.shell-body > .runs-absent` so the in-table "no runs match the filters" line
  is not affected.
- **Two executors, one reconciliation.** The frame/rail slice and the
  landing/copy slice ran in parallel because their file sets are disjoint; the
  landing editor left a duplicated tail mid-edit, reconciled by hand before the
  verification pass.

## Follow-ups

- The collapsed rail still relies on the `title` attribute for its labels
  (recorded, unchanged). A hover/focus label affordance is its own decision.
- Care-route withheld-set rendering is still waiting on M4/M7 data
  (`integration-plan.md` §F item 4), as the redesign spec already records.
