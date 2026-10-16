# W204: the status bar holds its own width (the usage/keybind overlap)

Date: 2026-10-16. Status: **IMPLEMENTED (W204)**. Branch: `feat/w204-statusbar-overlap`.
Base: `d0ddeb5d`.

A chrome defect measured over the repo's own CDP harness
(`test/fixtures/webui-demo-server.ts`), continuing the W201 chrome pass
(`docs/HUB_LAYOUT_IA_REWORK.md`, rules R1/R3).

## The defect (evidence: live render, 2026-10-16)

The status bar's three groups are flex rows with `white-space: nowrap` and
`overflow: hidden` only on the bar itself. The middle group (`.status-bar-middle`,
`flex: 1`) holds the live usage meter; the right group holds the branch and the
keybind strip. As the viewport narrows the right group keeps its full intrinsic
width and the middle group shrinks to 0, but the meter's children do not clip,
so their text paints straight across the keybind hints.

Measured onset and magnitude (`meterRight` minus `keyLeft`, px):

| viewport | 1440 | 1366 | 1280 | 1240 | 1120 | 1024 | 900 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| overpaint | 0 | 0 | 3 | 41 | 157 | 249 | 154 |

At 900px the rendered line read `3d9k / 2 Ctrl ⌘0..1132 Ctrl + K palette`, and
below 900px the middle group collapsed to 0 width while still painting. The
900px media query's own comment states the intent ("who-is-driving left, usage
right") but the geometry did not hold.

## Fix (stylesheet only)

- `.status-bar .usage-meter` gains `min-width: 0; overflow: hidden` so the meter
  clips its own nowrap text instead of painting over a neighbor.
- New `@media (max-width: 1280px)` hides `.status-bar-keys`. The keybind hints
  are duplicated in the composer hint line (`app.tsx`, "Ctrl + P commands ...
  Ctrl + , settings"), so the static hints yield to the live meter (context
  fill, cost). The `@media (max-width: 900px)` block previously hid the same
  strip; that line moves up to the measured onset.
- The meter is never the hidden element: it is the operator's mid-turn signal.

## Acceptance

- `test/webapp-statusbar-layout.test.ts` (NEWLY REGISTERED in
  `test/ci-suites.txt` in sorted order): 3/3. Pins the meter rule
  (`min-width: 0`, `overflow: hidden`), the 1280px breakpoint that hides the
  keybind strip, the negative (the meter is not hidden there), and that the
  meter and the keybinds ride distinct groups.
- CDP re-render: at 1000px and 900px the bar renders agent, model, the full
  usage readout, and the branch with no overlap and no clipped text;
  `npx tsc --noEmit` exit 0, `npm run lint` exit 0, `npm run build` clean.
- Related suites green: webapp-surface (49), webapp-shell (18), webui-e2e (1),
  webapp-bundle (4), ci-suites-manifest (5).

## Not in this wave

- The 900px layout keeps the model name; a tighter breakpoint set (drop the
  model before the branch, etc.) is its own decision.
- No markup change: the groups and their children are unchanged.

## Follow-ups

- The composer hint line is now the sole keybind surface below 1280px; whether
  it should carry the full set is its own decision.
