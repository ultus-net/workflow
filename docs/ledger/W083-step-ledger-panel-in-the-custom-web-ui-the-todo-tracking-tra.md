<!-- Ledger fragment: extracted from TASKS.md at line 1697 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W083 - Step-ledger panel in the custom web UI (the todo-tracking track)

**Objective:** Surface the W072 kernel step ledger (roadmap → tasks → steps) in the
custom web UI's inspector Tasks section — the accepted tracking surface since
stock OpenCode v2 removed native `todowrite`/`todoread` (W072 addendum). The
surface reads the canonical ledger and drives operator-gated step transitions
through the application command port only; the kernel keeps validating legal
transitions and evidence-bound completion, so the panel can never self-certify
a step.

**Depends on:** W072 (step ledger invariants I-1…I-4, kernel + application API);
no kernel change.

**Acceptance criteria:**
- [x] `GET /api/steps` reads the workspace's canonical ledger through the
      application (`taskSteps`/`activeStepId`/the snapshot's task states) —
      never the raw TaskGraph; the panel's "active task" is the ledger-relevant
      fact (exactly one task IN_PROGRESS, else null), not the
      interactive-authorization pointer.
- [x] `POST /api/steps/start|complete|cancel` drive the operator-gated
      transitions through the application command port; kernel rejections
      surface verbatim as `409` with the structured
      `ILLEGAL_STEP_TRANSITION` / `STEP_EVIDENCE_REQUIRED` /
      `STEP_TASK_NOT_IN_PROGRESS` code and reason (fail-closed honesty, no
      client-side success invention). Plus `POST /api/steps/define` (append-only
      operator decomposition) carrying the bridge's explicit
      environment-evidence requirement — an empty requirement list would let a
      step complete with zero evidence and hollow out I-3.
- [x] The inspector Tasks section renders each task's step ledger (state chip,
      content, evidence-requirement count) with start/cancel/complete actions;
      the complete action states that completion is evidence-bound and shows
      the kernel's rejection reason instead of a silent failure.
- [x] Focused endpoint + SSR tests pin the read shape, the transition mapping,
      the rejection surfacing, and the append-to-existing-ledger round-trip;
      typecheck and lint clean. **Five-axis review APPROVED (2026-09-20,
      independent fresh-context reviewer): no P0/P1/P2; four P3 notes — the two
      actionable ones (dangling test comment; missing HTTP pin for
      append-with-existing-ledger) fixed in the follow-up commit; the two
      pattern-fidelity notes (unknown step id → sibling-style 400 catch-all;
      duplicate step contents share the `step:<content>` subject via the
      kernel's subject-equality matching — pre-existing kernel behavior, same
      shape as the native bridge) recorded for a future W-item.** 56/56 focused
      across the endpoint, SSR, settings-endpoint, kernel step-ledger, doctor,
      G5, and web-service suites.