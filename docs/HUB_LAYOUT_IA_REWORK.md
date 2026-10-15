# Hub layout + IA rework: the route-aware control plane

Date: 2026-10-16. Status: **IMPLEMENTED (W201)**. Branch: `feat/w201-hub-layout-ia`.

This rework keeps the hub's visual identity (the OpenCode-TUI token system,
`styles.css`, the 50 AA-corrected palettes, square edges, mono chrome / sans
prose) and its view internals. It changes the **frame** the views sit in, the
**rank** of the landing zones, the **rail's information architecture**, and the
**operator-facing copy** of the degraded/empty states. No new dependency, no
Tailwind/shadcn/router, no restyle of a view's internals.

## Why now

The hub's role has shifted: it is no longer an OpenCode-plane-only surface. It
now owns the assistant dimension (the three routes `coding | tutor | care`, the
identity binding, the withheld set) and the shared `augur-workspace`. Recon
against a live render (Chromium over the repo's own CDP harness,
`test/fixtures/webui-demo-server.ts`) shows the frame did not keep pace.

## The defects (evidence: live render at 1728×1080, 2026-10-16)

1. **No content measure.** Every page spans the full viewport. On a 1728px
   display the Overview stat tiles are ~300px wide each holding a two-word
   label, and each of the four sections below is a full-width box holding one
   italic line. Source: `.overview` (`styles.css:3197` area) has padding but no
   `max-width`; the same is true of `.sessions-view` (`styles.css:750-755`),
   `.runs-view` (`:3479`), `.reviews-view` (`:3553`), `.activity-page`
   (`:3205`), `.audit` (`:3671`), `.usage-view` (`:1048`).

2. **No rank on the landing.** `.overview section` (`styles.css`) gives every
   zone an identical border and padding, so `NEEDS YOU` (attention) reads the
   same as `RECENT ACTIVITY` (informational). An empty pane carries the weight
   of a populated inbox.

3. **Four chrome bands stack above the first row.** `shell-header` →
   `posture-strip` → page → `status-bar`. `.shell-header` (`:94`) and
   `.posture-strip` (`:3165`) are two separate bordered bands.

4. **The content region does not fill; the status bar strands.** Overview,
   Routes, Workspace, Usage, Activity, Audit render as direct children of
   `.shell-main` (a flex column) without `flex: 1`, so they size to content and
   the `status-bar` floats mid-page (observed at y≈586 of a 1080px viewport).
   `.shell-body`-wrapped views (Board, Runs, Reviews, Chat) do not have this
   bug. `.sessions-view` carries `flex: 1` (`:750`) and is fine; `.overview`
   does not.

5. **Degraded/empty states leak developer strings.** Board's unconfigured state
   renders a bare env-var dump as page content
   (`board-view.tsx:87-90`: `WORKFLOW_GITHUB_REPO`, `WORKFLOW_GITHUB_TOKEN`, …).
   Agents renders "This server runs a single session — session management is
   unavailable" (`agents-view.tsx`). Overview's posture mark reads
   "state unavailable: per-session budget state, orphaned-run detection".

6. **The collapsed rail is unlabeled.** `shell.tsx` hides rail labels when
   collapsed or under 600px (`styles.css:271-272`, `:2880`), leaving 13
   unlabeled glyphs with only a `title` affordance.

## Target

The hub is a **route-aware control plane**: ops state first (runs, reviews,
schedules, authority), the assistant dimension as a first-class section, and
one measured reading column so the operator scans rather than saccades.

### R1 — one measured page frame

- New token `--measure: 84rem` (1344px) in `:root`.
- New shared rule: every page root carries `width: 100%`,
  `max-width: var(--measure)`, `margin-inline: auto`.
- Every page root also carries `flex: 1; min-height: 0` so the content region
  fills the viewport and the `status-bar` pins to the bottom on every view.
- Full-bleed chrome stays full-bleed: `shell-header` and `posture-strip` span
  the viewport; only page content is measured.

### R2 — the landing answers the operator loop in order

The Overview keeps its five record-backed zones but ranks them:

1. **Needs you** (attention) leads, first after the stat strip, with the
   accent-worthy weight (a leading marker, not a heavier border color that
   breaks the palette invariants). When empty it recedes to a quiet line.
2. **Stat strip** stays at top as the scannable summary.
3. **Live runs**, **Next fires** sit in one two-column secondary band at
   `--measure` width (informational, side by side, not stacked full-width).
4. **Recent activity** closes the page, full width of the measure.

Rule: an empty zone renders its named first action in muted prose; it does not
carry the same bordered box as a populated zone. No view-side derivation — the
records and their named-absence copy are unchanged, only the rank.

### R3 — one chrome band

Merge the posture strip into the header band as a compact inline summary on
wide viewports: the header carries the page title on the left and the posture
counts + enforcement badge on the right, one border, one row. Below 1100px the
posture counts wrap to their own line under the header (the current behavior).
The posture strip's records and degraded copy are unchanged.

### R4 — operator-facing copy for degraded states

- Board unconfigured: lead with operator language ("No task provider is
  configured for this hub."), then the required variables as a **secondary
  disclosure** (a `<details>`/labelled list), never as page content. The
  env-var names stay (they are the fix), but demoted.
- Agents single-session: plain operator language, e.g. "This hub runs one
  agent session at a time — open Chat to work in it."
- Overview/degraded marks keep their honest named absence but in plainer words.

### R5 — rail IA for the route-aware plane

Regroup `shellRailSections` (`shell.tsx`) so the assistant dimension is
first-class rather than buried in `Automation`:

- **(top)** Overview.
- **Working** — Chat, Board, Agents (unchanged).
- **Runs** — Runs, Reviews (unchanged).
- **Automation** — Schedules, Projects.
- **Assistant** — Routes, Workspace (promoted out of Automation; the route ->
  identity -> withheld configuration and the shared workspace).
- **Insight** — Usage, Activity, Audit (unchanged).
- **(bottom)** Settings.

Collapsed-rail legibility: keep the glyph, and make the `title` affordance the
documented path (unchanged behavior, now recorded) — no new tooltip system.

## Non-goals

- No new dependency, router, or CSS framework.
- No change to the palette token values, the AA invariants, square edges, or
  the mono/sans split.
- No change to a view's data contract or its projection-only discipline.
- No change to a view's internals beyond the copy and rank named above.

## Verification

- Live render via `test/fixtures/webui-demo-server.ts` + `test/fixtures/cdp-client.mjs`
  at 1728×1080 and 1280×800 for every route: content measured, status bar
  pinned, chrome one band, empty states legible.
- Red-first pins in `test/webapp-shell.test.ts` (rail groups, measure class on
  the frame) and `test/webapp-surface.test.ts` (copy changes; the env-var dump
  demoted to a disclosure).
- `test/webui-e2e.test.ts` still boots console-clean.
- Focused suites only: `node --import tsx --test test/<file>.test.ts`; lint +
  typecheck exit 0. Never `npm test` (the operator resource directive).
