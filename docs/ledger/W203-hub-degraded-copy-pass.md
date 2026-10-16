# W203: hub degraded/empty copy + the page-header subtitle line

Status: implemented, pending CI.

## Problem

W201 (`docs/HUB_LAYOUT_IA_REWORK.md`) reworked the hub frame, rank, chrome, and
rail, and started rule **R4** (operator copy for degraded states) on the Board
and Agents pages. A live render of `main` (`27ba5e44`) over the repo's CDP
harness at 1728x1080 showed R4 was unfinished and one layout defect survived:

1. The Usage page rendered the server's env-var string
   (`... set WORKFLOW_OPENROUTER_MANAGEMENT_KEY (server-side only; ...)`,
   `web.ts:480`) verbatim as page content (`usage-view.tsx:295`).
2. The Usage attribution note was one eight-line run-on paragraph
   (`usage-view.tsx:127`).
3. The posture strip read `operator posture: hub unavailable (hub unavailable)`
   on every view (`posture-strip.tsx:99`; the relay fallback reason is
   `"hub unavailable"`, `web.ts:114`).
4. A page-header note floated as a right-aligned bordered box, because a
   `.sessions-empty-note` inside the `space-between` `.sessions-view-head`
   inherits the shared empty-state box (border, fill, `border-left: 3px`).
   Measured at x=1142..1591 with `background rgb(28,31,36)` (Schedules).
5. The Routes empty state leaked `WORKFLOW_ASSISTANT_ROUTES` as page content
   (`routes-view.tsx:92`).

## What shipped

- **Usage degraded state** (`usage-view.tsx`): a new `UsageUnavailable`
  component. The analytics-not-configured case leads with operator copy and
  demotes the server string into `<details class="usage-config-details">`; a
  transport-only error (no `reason`) stays a plain line. The Workflow-side
  facts (headline, session rollup, attribution) render after it, unchanged.
- **Usage attribution** (`usage-view.tsx`): `UsageAttributionNote` is now a
  lead paragraph plus `<details class="usage-attribution-details">` holding the
  `unrecordedLanes` as a list.
- **Routes empty state** (`routes-view.tsx`): an operator lead line plus
  `<details class="routes-config-details">` naming `WORKFLOW_ASSISTANT_ROUTES`.
- **Posture strip** (`posture-strip.tsx`): renders `operator posture: <reason>`
  once; the reason is no longer prefixed and echoed.
- **Page-header subtitle** (`styles.css`): `.sessions-view-head >
  .sessions-empty-note` renders full-width (`flex-basis: 100%`) with the
  empty-state box reset (`border: 0`, `background: none`, `padding: 0`,
  `max-width: none`). Control children (the Agents picker, the Board `<code>`
  and meta spans) are unaffected because only the note direct child matches.

## Evidence

- `test/webapp-degraded-copy.test.ts` (NEWLY REGISTERED in `test/ci-suites.txt`
  in sorted order): 7/7. Pins the operator lead and the disclosure on the Usage
  degraded state, the transport-error passthrough, the attribution disclosure
  list, the posture strip rendering its reason exactly once, the Routes
  disclosure, and the CSS rule (`.sessions-view-head > .sessions-empty-note`
  with `flex-basis: 100%`, `border: 0`, `background: none`).
- CDP re-render (`test/fixtures/webui-demo-server.ts`, 1728x1080): no view shows
  `hub unavailable (hub unavailable)`; the Schedules/Projects header notes are
  plain full-width lines; the Usage page leads with operator copy and two
  disclosures; the Agents picker and Board header still float their controls
  right. Page roots still measure 1344/1120/740 at 1728/1280/900 and the status
  bar still pins to the viewport bottom (no frame regression).
- Related suites green: webapp-surface (49), webapp-shell (18), webapp-audit
  (5), webapp-activity (6), webapp-runs (23), webapp-reviews (14),
  webapp-incidents-strip (6), workspace-view (7), operator-posture (10),
  web-operator-surfaces (4), webapp-bundle (4), webui-e2e (1),
  ci-suites-manifest (5).
- `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npm run build` clean.

## Scope decisions

- **No relay, route, or wire change.** The server strings stay (pinned by
  `test/web.test.ts` and `test/web-operator-surfaces.test.ts`); the views demote
  them. The disclosure inherits the bare `<details>` pattern W201 used on Board
  (no marker styling).
- **Structure, not a new layout.** The Usage page keeps its existing elements and
  zone order; only the degraded/attribution elements change composite shape.
- **The Audit boundary copy is untouched.** It is verbatim by design
  (`audit-view.tsx:35`, pinned, and named by the redesign spec and
  `W177-audit-page.md`); it keeps its source path.

## Follow-ups

- Runs/Reviews/Activity still render `runs relay unavailable (<reason>)` and
  `hub timeline unavailable (<reason>)`; the same echo class, pinned in
  `webapp-runs.test.ts:266`, `webapp-reviews.test.ts:284`,
  `webapp-activity.test.ts:141`, and `webapp-surface.test.ts:852`.
- The Activity and Audit degraded states center their single line
  (`.activity-page-degraded { justify-content: center }`); whether a degraded
  page should center or lead is its own decision.
- Care-route withheld-set rendering stays gated on M4/M7 data
  (`integration-plan.md` §F item 4).
