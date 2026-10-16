# W203: hub degraded/empty copy + the page-header subtitle line

Date: 2026-10-16. Status: **IMPLEMENTED (W203)**. Branch: `feat/w203-hub-copy-structure`.
Base: `27ba5e44`.

W201 (`docs/HUB_LAYOUT_IA_REWORK.md`) reworked the hub frame, rank, chrome, and
the rail, and started rule **R4** ("operator-facing copy for degraded states")
on the Board and Agents pages. A live render of `main` (Chromium over the repo's
own CDP harness, `test/fixtures/webui-demo-server.ts`, at 1728x1080, 2026-10-16)
shows R4 was not finished and one layout defect survived the frame pass. This
wave completes R4 and fixes the header line.

## The defects (evidence: live render + source, 2026-10-16)

1. **The Usage page leaks a raw env-var string as page content.** The degraded
   state renders `payload.reason` verbatim in the `.usage-setup` panel
   (`src/ui/webapp/usage-view.tsx:295`); the server string is
   `"OpenRouter analytics need a Management key — set
   WORKFLOW_OPENROUTER_MANAGEMENT_KEY (server-side only; it never reaches the
   browser)"` (`src/ui/web.ts:480`). This is the exact R4 class W201 fixed on
   Board (`board-view.tsx:86-97`: an operator lead line plus a `<details>`
   disclosure holding the variables). Usage was the one page left unreworked.

2. **The Usage attribution note is an eight-line run-on.** One `<p>` joins a
   long prose field with a semicolon-joined list
   (`usage-view.tsx:127-136`); rendered it is a wall of muted italic text
   (`usage.png`: "per-task attribution: not yet built — turn-boundary
   attribution ... they are not free, they are off-ledger."). The R4 shape
   (plain lead, demoted detail) applies.

3. **The posture strip echoes its own reason.** Every page renders
   `operator posture: hub unavailable (hub unavailable)`
   (`src/ui/webapp/posture-strip.tsx:99`), because the relay's fallback reason
   is literally `"hub unavailable"` (`src/ui/web.ts:114`). The phrase appears
   twice in one five-word string, on all 14 views.

4. **The page-header note floats as a right-aligned alert box.** A descriptive
   `<p class="sessions-empty-note">` inside `.sessions-view-head` is a
   `space-between` flex child, so it is pushed to the far right AND carries the
   shared empty-state box styling (border, background, `border-left: 3px`). Live
   measurement: the Schedules note renders at x=1142..1591 of a 1344px column
   with `background rgb(28,31,36)` and `border-width 1px 1px 1px 3px`. A page
   subtitle must not read as an alert. Sites: `schedules-view.tsx:110`,
   `:172`; `projects-view.tsx:84`; `routes-view.tsx:57`;
   `workspace-view.tsx:81`.

5. **The Routes empty state leaks an env var.** `routes-view.tsx:92` renders
   `no routes configured — set WORKFLOW_ASSISTANT_ROUTES to bind identities to
   routes`, the same R4 class as Board and defect 1.

## Scope

View and stylesheet changes only. **No relay, route, or wire string changes**:
every pinned HTTP contract (`test/web.test.ts` attribution pins,
`test/web-operator-surfaces.test.ts` reason pins) is untouched. The honest
server strings stay; the views demote them.

### R4 completion (copy + structure)

- **Usage degraded state** (`usage-view.tsx`): lead with a plain operator line,
  then a `<details class="usage-config-details">` disclosure
  (`<summary>why, and how to enable it</summary>`) carrying the server's reason
  string verbatim. Mirrors `board-view.tsx`.
- **Usage attribution** (`usage-view.tsx`): a short lead line plus a
  `<details>` disclosure (`<summary>what the metering trail does not cover</summary>`)
  holding the `perTask` sentence and the `unrecordedLanes` as a list. The
  payload fields and their pins are unchanged.
- **Routes empty state** (`routes-view.tsx`): an operator lead line plus a
  `<details>` disclosure naming `WORKFLOW_ASSISTANT_ROUTES`.

### Chrome copy (the echo)

- **Posture strip** (`posture-strip.tsx`): render `operator posture: <reason>`
  (label, one reason) instead of `operator posture: hub unavailable (<reason>)`.
  Loading copy unchanged.
- The parallel echoes in Runs/Reviews/Activity (`runs relay unavailable
  (<reason>)`, `hub timeline unavailable (<reason>)`) are the same class but
  pinned in three suites; they are a recorded follow-up, not this wave (see
  Follow-ups).

### Layout (the subtitle line)

- **Page-header note** (`styles.css`): one rule so a `.sessions-empty-note`
  that is a DIRECT child of `.sessions-view-head` renders as a full-width
  subtitle row under the title, with the empty-state box reset
  (`border: 0`, `background: none`, `padding: 0`, `max-width: none`,
  `flex-basis: 100%`). Control children (`Agents`' picker, `Board`'s `<code>`
  and meta spans) are unaffected.

## Acceptance

- Red-first: `test/webapp-degraded-copy.test.ts` (NEWLY REGISTERED in
  `test/ci-suites.txt` in sorted order) pins each defect:
  - the Usage degraded render leads with operator copy and puts the env-var
    string inside a `<details>` (never as a bare paragraph);
  - the Usage attribution render puts the lanes in a disclosure list;
  - the posture strip degraded render contains `hub unavailable` exactly once;
  - the Routes empty render demotes the env var into a disclosure.
- A source/CSS pin asserts the header-subtitle rule exists and targets
  `.sessions-view-head > .sessions-empty-note` (the box reset), so a later
  restyle cannot silently re-float the line.
- CDP re-render (the W201 harness) confirms: no page shows
  `hub unavailable (hub unavailable)`; the Schedules/Projects/Routes/Workspace
  header notes are no longer right-aligned bordered boxes; page roots still
  measure to `--measure` and the status bar still pins to the viewport bottom.
- `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npm run build` clean.
- `test/ci-suites-manifest.test.ts` passes (the new suite is registered).

## Not in this wave

- Runs/Reviews/Activity reason-echo copy (pinned in `webapp-runs.test.ts:266`,
  `webapp-reviews.test.ts:284`, `webapp-activity.test.ts:141`,
  `webapp-surface.test.ts:852`).
- The Audit boundary copy is verbatim by design (`audit-view.tsx:35`, pinned,
  and named by the redesign spec + `W177-audit-page.md`); it keeps its source
  path.
- Any Usage page rank/zone restructuring: this wave is copy and structure of
  the existing elements, not a new layout.

## Follow-ups

- The reason-echo class in Runs/Reviews/Activity.
- The Activity and Audit degraded states render a centered single line
  (`.activity-page-degraded { justify-content: center }`); whether a degraded
  page should center or lead its first line is its own decision.
