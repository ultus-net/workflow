<!-- Ledger fragment: extracted from TASKS.md at line 374 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W021 - Interactive containment smoke driver

**Objective:** Let an operator manually exercise the same Workflow authorization and Linux containment path without turning the existing task-navigation TUI into a shell.

**Depends on:** W020

**Acceptance criteria:**
- [x] A package command presents a terminal prompt for one command and visibly reports policy, containment, command output, and final task state.
- [x] Commands execute through `WorkflowContainedProcess` and the real Linux Bubblewrap backend rather than an uncontained child process.
- [x] The session grants writes only to a fresh temporary workspace, keeps networking isolated and credentials cleared, and removes the workspace on exit.
- [x] Successful execution records mutation and fresh environment evidence before the task reaches `VERIFIED`.
- [x] Automated CLI coverage proves the visible allow/enforced/output/verified flow.

**Verification:** focused interactive CLI test plus lint, full test suite, containment/E2E runtime checks, typecheck, build, diff check, and independent review.
