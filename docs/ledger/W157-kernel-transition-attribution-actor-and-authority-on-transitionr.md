<!-- Ledger fragment: opened 2026-09-27 as a post-freeze W-item (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### W157 - Kernel transition attribution: actor and authority on TransitionRecord (Planned - the W152 attribution gap, split out per the borrowings spec) (2026-09-27)

**Source:** the Paperclip borrowings spec's Wave 3 (unified activity timeline) and its kernel-boundary risk note: "The dashboard waves must not ship attribution the kernel does not record; 'unattributed' rendered honestly beats attribution inferred in the UI", and "any actor-attribution gap [is] a kernel/record change first. The dashboard waves must not ship attribution the kernel does not record." Verified 2026-09-27: `TransitionRecord` (src/kernel/contracts.ts:72-76) carries only `{taskId, from, to}` — no actor, no authority basis, no observation time — so the W152 timeline slice renders kernel-transition rows with an explicit "unattributed" state, and this item is the record change that would let them name more.

**Objective:** the kernel transition record gains an OPTIONAL caller-supplied attribution `{ actor: "operator" | "agent" | "system"; authority: string; observedAt: string }` — supplied by the application layer at the transition call (the kernel stays pure: it records what it is told, fabricates nothing, and defaults to unattributed), never inferred from call-graph position.

**Acceptance criteria:**
- [ ] `TransitionRecord` carries the optional attribution block; absent stays absent (the unattributed state is legal and pinned).
- [ ] The application layer stamps the attribution it actually knows at each transition entry point (run begin/finish from the registry's caller context; operator CLI actions as operator; the reviewer's verdict transition as agent) — every site says where its attribution came from, in a comment.
- [ ] The W152 timeline projection consumes the new field when present and keeps rendering "unattributed" when absent (the W152 criterion-1 test keeps passing unchanged).
- [ ] Kernel purity holds: no IO, no clock reads in the kernel; `observedAt` is caller-supplied.

**Residuals (cut):** retroactive attribution of historical records (the transition log is in-memory and unattributed history stays unattributed); multi-actor authority models (single-operator model unchanged).
