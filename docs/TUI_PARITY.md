# Universal TUI parity checklist

Convergence gates for making `workflow-tui` the primary interactive surface.
Each item has an acceptance test; the primary surface flips only when every
box is checked.

- [ ] Composer: multi-line editing, paste, and history recall (acceptance: PTY test).
- [ ] Session resume/history via SDK-native persistence (acceptance: resume after restart for each primary driver).
- [ ] Transcript scrollback with bounded memory (acceptance: component test).
- [ ] Style dials (speech/build) wired to every composed driver that supports them (acceptance: driver applies the selected addendum).
- [x] Pedagogy mode gate installed (acceptance: `test/tui.test.ts` proves mode changes replace the application pedagogy gate).
- [x] Cancel keymap aborts the active driver (acceptance: `test/tui.test.ts` proves cancellation reaches the coding session driver).
- [ ] Hub-mediated session driving: TUI projects and drives the hub's canonical state (acceptance: two surfaces share one authority).
- [ ] Monitor parity: `workflow-monitor` attaches to the same session (acceptance: joint smoke).

Unchecked items are intentional product gaps, not implied support. Until they
close, `workflow-tui` is a driver-selectable fallback and the patched Cline TUI
remains the primary interactive surface.
