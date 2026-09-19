# Completed and Superseded Work Archive

This file is the completed/superseded companion to `TASKS.md`.

## Process (mandatory)

- `TASKS.md` contains only active, pending, blocked, or explicitly in-progress roadmap work.
- When a W-item is complete, the full acceptance/verification evidence is moved here and the active roadmap keeps a one-line pointer: `Completed — see docs/TASKS_COMPLETED.md#W###`.
- Superseded work is not deleted. Its original decision, reason, replacement, and residual risk are recorded here.
- An item cannot be archived because a model or agent says it is done. It requires linked verification evidence, review status, and any accepted residuals.
- A later implementation must never silently reopen or rewrite an archived item; it creates a new W-item or a dated supersession entry.
- Completed archive entries are append-only. Corrections add a dated note rather than erasing history.

## Completed milestones recorded during the W072 session

### W046 — Per-prompt task decomposition

**Status:** Complete for the original scope; the canonical child-step ledger extension is W072.  
**Evidence:** `src/application/task-commands.ts`, `test/interactive-task-commands.test.ts`, `TASKS.md` W046, `docs/FEATURES.md:54`.  
**Residual:** model `plan`/native todo remains advisory until W072's kernel step ledger and G6 parity are complete.

### W072 Stage 1a–1e — Canonical kernel step ledger and native ACP todo bridge

**Status:** Implemented and independently reviewed; W072 remains in progress because all-surface enforcement,
append-only execution replay, G6 corpus parity, and v2 qualification remain open.  
**Evidence:** commits `426c590`, `d191615`, `03dad90`, `85bd1c8`, `34833e1`;
`test/step-ledger.test.ts`; focused verification 146/146 at the final review.  
**Delivered:** child steps, evidence-bound completion, no-silent-deletion, declared done conditions,
one active step, restore validation, `isRunComplete`, conditional `NO_ACTIVE_STEP`, native ACP todo bridge.

### W072 Corpus A — Retire superseded `workflow-fs-exec-mcp`

**Status:** Superseded product retired; G3 parity qualification remains a v2/control-plane obligation.  
**Evidence:** commits `f525b35`, `ea52a9e`; `docs/GUARD_CORPUS_MAP.md`; `docs/COMPLIANCE_REGISTER.md` DRIFT-004.  
**Replacement:** in-process ACP filesystem authorization; do not revive the removed `/before-tool` route.

### W072 Corpus E/F — Compaction and host-event fidelity residuals

**Status:** Accepted/probe-gated residuals, not silently treated as parity.  
**Evidence:** `docs/GUARD_CORPUS_MAP.md:34-49`, `docs/HOST_ADAPTERS.md`,
`docs/OPENCODE_SERVER_AUTHORITY.md`, `docs/COMPLIANCE_REGISTER.md`.

## Superseded/retired items

### Vendored Cline SDK runtime and patch

**Status:** Superseded/removed by W050 step 6.  
**Replacement:** stock `cline --acp` thin connector, probe-pending on pinned stock version.  
**Evidence:** `AGENTS.md`, `docs/HOST_ADAPTERS.md`, `docs/OPENCODE_QUALIFICATION.md`, `TASKS.md` W050.

### Standalone `workflow-fs-exec-mcp` G3 substitution product

**Status:** Retired 2026-09-19.  
**Reason:** it targeted the removed `/before-tool` route and could not be the v2 authority path.  
**Replacement:** in-process ACP filesystem server now; OpenCode v2 filesystem route qualification later.

## Required archive entry shape

```text
### W### — title
Status: Complete | Superseded | Accepted residual
Evidence: commits/tests/probes/reviews
Delivered: concise scope
Residual: explicit remaining risk or successor W-item
```
