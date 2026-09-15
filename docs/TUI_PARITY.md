# Universal TUI parity checklist

Convergence gates for making `workflow-tui` the primary interactive surface.
Each item has an acceptance test; the primary surface flips only when every
box is checked.

The cross-surface operator experience is defined in `docs/OPERATOR_UI.md`.
Terminal parity means presenting those semantics clearly, not reproducing
browser widgets or exposing the underlying event stream verbatim.

- [ ] Composer: multi-line editing, paste, and history recall (acceptance: PTY test).
- [ ] Session resume/history via SDK-native persistence (acceptance: resume after restart for each primary driver).
- [ ] Transcript scrollback with bounded memory (acceptance: component test).
- [ ] Style dials (speech/build) wired to every composed driver that supports them (acceptance: driver applies the selected addendum).
- [x] Pedagogy mode gate installed (acceptance: `test/tui.test.ts` proves mode changes replace the application pedagogy gate).
- [x] Cancel keymap aborts the active driver (acceptance: `test/tui.test.ts` proves cancellation reaches the coding session driver).
- [ ] Hub-mediated session driving: TUI projects and drives the hub's canonical state (acceptance: two surfaces share one authority).
- [ ] Monitor parity: `workflow-monitor` attaches to the same session (acceptance: joint smoke).
- [ ] Operator transcript: default output is intent + meaningful actions/results; opaque IDs, lifecycle churn, duplicate command echoes, and raw payloads are diagnostics (acceptance: component test).
- [ ] Persistent options menu: keyboard navigation and repeated setting changes do not close the menu; only explicit close/Escape dismisses it (acceptance: component test).

Unchecked items are intentional product gaps, not implied support. Until they
close, `workflow-tui` is a driver-selectable fallback and the patched Cline TUI
remains the primary interactive surface.
