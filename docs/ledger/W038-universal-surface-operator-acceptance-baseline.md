<!-- Ledger fragment: extracted from TASKS.md at line 672 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W038 - Universal surface operator acceptance baseline

**Objective:** Exercise the clean W037 baseline with real operator workflows before further control-plane changes.

**Depends on:** W037

**Acceptance criteria:**
- [x] Exercise the supported universal drivers needed for daily use and record composition, prompt, mutation/denial, cancellation, and failure-surfacing results without silently changing drivers.
- [x] Confirm canonical task state, authorization level labels, containment claims, and session activity remain truthful during the exercised paths.
- [x] Record material parity gaps as explicit follow-up work rather than folding unrelated control-plane changes into the baseline.

W038 is complete (2026-09-15). The real `workflow-tui --driver acp` source surface launched through a PTY against Cline 3.0.61 + Bubblewrap, displayed `acp | standalone (local authority)` and `ENFORCED / native`, preserved ordinary first-character prompt input, and disposed cleanly. The real contained ACP probe passed with a workspace mutation while host-home canary and `/tmp` escape attempts remained contained; the real deny probe preserved the target after Workflow selected the agent's rejecting permission option. ACP session regressions cover cancellation and malformed-notification fail-closed behavior. Acceptance found and fixed two surface defects before moving on: assistant transcript entries were hard-coded as `Cline` instead of using the composed driver label, and plain-key empty-composer accelerators stole valid first prompt characters. The options menu is now explicit via `/` or Ctrl+P, ordinary composer characters are preserved, and regression tests pin both behaviors. Existing unchecked convergence items in `docs/TUI_PARITY.md` remain known product gaps rather than new W038 regressions.
