<!-- Ledger fragment: opened 2026-10-06 as a post-freeze W-item backfill (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### W166 - The blocked-inbox admission rule (the kernel BLOCKED transition contract) (Complete) (2026-09-27)

**Source:** GitHub issue #318 (closed 2026-09-28); spec `docs/superpowers/specs/2026-09-26-paperclip-dashboard-borrowings.md:274` (W166 section); the design fragment `docs/ledger/W159-the-blocked-inbox-admission-rule-entering-blocked-needs-a-named-owner-and-action.md`; landed in PR #325 (merge 2026-09-27T21:23:28Z, commit `54e307df`, 2026-09-27).

**What landed:**

- `src/kernel/contracts.ts`: `WorkflowTask` gains an optional `blocked?: BlockedRecord` (`{ owner, action, reason?, enteredAt }`), `owner` typed to the W157 transition-attribution actor vocabulary.
- `src/kernel/task-graph.ts`: entering `BLOCKED` requires a `BlockedRecord` (rejects absent/empty: `BLOCKED_RECORD_REQUIRED`); an agent may only name ITSELF as owner (`BLOCKED_OWNER_UNVERIFIED` / `BLOCKED_OWNER_MISMATCH`). The explicit `BLOCKED -> READY` exit consumes the named owner's action one-shot; a dependency-derived exit still applies when the recompute yields readiness; the record is retained as stale context, not dropped. `FAILED -> BLOCKED` retry stays recordless and ungated.
- `src/application/workflow.ts`: the authority threads the admission gate.
- Kernel-purity rule respected (no LLM/IO/UI/SDK imports in `src/kernel/`).

**Evidence:** `test/blocked-admission.test.ts` 20/20 (self-naming; absent record / absent attribution; one-shot action consumption; dependency-based exit; stale-context retention; `FAILED -> BLOCKED` recordless). **Honest boundary:** the board's `blocked` column projection and the UI unblock descriptor are a separate surface (the kernel contract is what this item landed).
