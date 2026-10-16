# W204: the status bar holds its own width (the usage/keybind overlap)

Status: implemented, pending CI.

## Problem

Continuing the W201 chrome pass (`docs/HUB_LAYOUT_IA_REWORK.md`, R1/R3): the
status bar's three flex groups did not clip. The middle group (`.status-bar-middle`,
`flex: 1`) holds the usage meter; the right group holds the branch and keybind
strip. As the viewport narrowed the right group kept its full intrinsic width,
the middle group shrank to 0, and the meter's nowrap children painted across the
keybind hints.

Measured over the CDP harness (`test/fixtures/webui-demo-server.ts`), overpaint
= meter right edge minus keybind left edge, in px:

| viewport | 1440 | 1366 | 1280 | 1240 | 1120 | 1024 | 900 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| overpaint | 0 | 0 | 3 | 41 | 157 | 249 | 154 |

At 900px the bar rendered `3d9k / 2 Ctrl ⌘0..1132 Ctrl + K palette`. Pre-existing
(the 900px media query dates to 2026-09-19); W201's measure/status-bar work did
not touch the intra-bar layout.

## What shipped

`src/ui/webapp/styles.css` only:

- `.status-bar .usage-meter` gains `min-width: 0; overflow: hidden` (the meter
  clips its own text instead of painting over a neighbor).
- A new `@media (max-width: 1280px)` hides `.status-bar-keys`; the keybind hints
  are duplicated in the composer hint line, so they yield to the live meter. The
  same `display: none` line is removed from the `@media (max-width: 900px)`
  block (the onset moved up to the measured collision point).

## Evidence

- `test/webapp-statusbar-layout.test.ts` (NEWLY REGISTERED in
  `test/ci-suites.txt`): 3/3; pins the meter rule text, the 1280px breakpoint,
  the meter-not-hidden negative, and the group separation.
- CDP re-render: at 1000px and 900px the bar shows agent, model, usage, and
  branch cleanly, no overlap. `npx tsc --noEmit` 0, `npm run lint` 0,
  `npm run build` clean.
- Related suites green: webapp-surface (49), webapp-shell (18), webui-e2e (1),
  webapp-bundle (4), ci-suites-manifest (5).

## Scope decisions

- **Stylesheet only.** No markup or data change; the groups and children are
  untouched.
- **`1280px` breakpoint.** Chosen from the measured onset (first overpaint at
  1281px), not a round guess.
- **The static hints yield, not the live meter.** The keybinds are duplicated in
  the composer hint line; the usage readout is the only live mid-turn signal in
  the bar.

## Follow-ups

- A tighter degradation ladder (drop the model name before the branch below some
  width) is its own decision.
- The composer hint line is the sole keybind surface below 1280px; whether it
  should carry the full set is its own decision.
