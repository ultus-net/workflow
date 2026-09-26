<!-- Ledger fragment: extracted from TASKS.md at line 143 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W007 - Build first end-to-end headless slice

**Objective:** Prove the contracts compose before committing to a real SDK or UI framework.

**Depends on:** W003, W004, W005, W006

**Acceptance criteria:**
- [ ] A test host proposes a bounded mutation for a `READY` task and receives a Workflow authorization decision.
- [ ] A blocked task cannot mutate through an enforced host.
- [ ] Post-action MCP/test evidence can advance `VERIFYING -> VERIFIED` only when requirements pass.
- [ ] A later relevant mutation invalidates that evidence and downstream readiness is recomputed.

**Verification:** One deterministic integration test exercises the full proposal -> authorization -> action observation -> evidence -> state transition flow.

## Checkpoint A - Core Safety Boundary

- [ ] Full test and typecheck gates pass.
- [ ] No concrete SDK, model provider, MCP implementation, or UI framework is imported by the kernel.
- [ ] Enforced versus advisory guarantees are observable in the public application state.
- [ ] Independent review finds no safety-boundary P0/P1 defects.

## Phase 2: Application API And First Real Host
