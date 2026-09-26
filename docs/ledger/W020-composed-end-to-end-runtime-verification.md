<!-- Ledger fragment: extracted from TASKS.md at line 359 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W020 - Composed end-to-end runtime verification

**Objective:** Prove the built Workflow package can carry one realistic host proposal through policy authorization, Linux runtime containment, observable mutation, evidence admission, and final task verification.

**Depends on:** W019

**Acceptance criteria:**
- [x] The E2E runner imports the built package rather than source modules.
- [x] A Cline-shaped process event is normalized by the real host adapter and authorized by `WorkflowApplication`.
- [x] The authorized operation executes through the real Linux Bubblewrap backend with an explicit writable grant and produces an observable host artifact.
- [x] The observed mutation is recorded, fresh environment evidence is admitted at the resulting mutation epoch, and the task reaches `VERIFIED` through legal application transitions.
- [x] The E2E runner is exposed as a stable package command and fails rather than skips when its Linux/Bubblewrap prerequisite is unavailable.

**Verification:** `npm run test:e2e` plus the existing lint, test, containment-runtime, typecheck, build, package, audit, diff, and independent-review gates.
