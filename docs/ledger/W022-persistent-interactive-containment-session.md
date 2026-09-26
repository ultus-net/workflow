<!-- Ledger fragment: extracted from TASKS.md at line 389 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W022 - Persistent interactive containment session

**Objective:** Allow multiple manual commands in one containment smoke session without weakening terminal Workflow task states.

**Depends on:** W021

**Acceptance criteria:**
- [x] The prompt accepts multiple commands until the operator enters `exit` or `quit`.
- [x] Every command independently crosses Workflow authorization, real Bubblewrap containment, mutation/evidence admission, and a terminal `VERIFIED` task state.
- [x] Each command uses a distinct Workflow task rather than reopening a terminal verified task.
- [x] The session shares only its temporary writable workspace; network isolation and cleared ambient credentials remain unchanged.
- [x] Automated CLI coverage proves two commands are independently allowed, contained, observed, and verified before clean exit.
- [x] A denied or nonzero command remains unverified and does not terminate the persistent session.
  - Dated note (2026-09-25, W132): the W126/W132 compiled-bin e2e found the contract violated on the GUARD-deny lane — the vendored guard's denial threw out of the unguarded per-command loop and killed the session (the nonzero lane held). Repaired in W132 (contained-shell.ts catches the denial per-command and reports Task: FAILED; the session survives — pinned in test/e2e-contained-shell.test.ts).

**Verification:** focused persistent CLI test plus lint, full test suite, containment/E2E runtime checks, typecheck, build, diff check, and independent review.

## Phase 6: SDK-Driven Coding Workflow

The product target from this point is not a richer containment demo. It is an interactive coding harness that can progressively replace the current OpenCode workflow while preserving Workflow's deterministic safety and verification boundaries.

The existing responsibility split remains fixed:

- The agent SDK/host owns model interaction, streaming, conversation/context handling, and its native tool-call lifecycle.
- Workflow owns canonical task/dependency state, authorization, capability policy, evidence, verification, persistence/recovery, and runtime-containment requirements.
- Host SDK schemas remain in host adapters. Model/provider types do not enter the kernel.
- The standalone Workflow TUI is the primary operator surface; host-native and browser surfaces remain replaceable adapters/proofs rather than sources of canonical state.
- `contained-shell` remains a diagnostic/runtime smoke surface. It is not the target coding UX and must not become a second hand-built agent runtime.
