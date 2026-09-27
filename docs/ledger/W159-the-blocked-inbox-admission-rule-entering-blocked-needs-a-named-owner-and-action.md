<!-- Ledger fragment: opened 2026-09-27 as a post-freeze W-item (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### W159 - The blocked-inbox admission rule: entering blocked needs a named owner + action; agents may only name themselves (Planned - kernel-change-first, the borrowings spec's strongest unbuilt idea) (2026-09-27)

**Source:** the borrowings spec's blocked-inbox idea, queued by the operator across the wave sessions. Verified 2026-09-27 on main@5e5d7ef: the kernel derives BLOCKED purely from dependency readiness (`src/kernel/task-graph.ts:487-500` `#recomputeReadiness` — `ready ? "READY" : "BLOCKED"`; the transition table admits READY→BLOCKED only through that recompute, `src/kernel/task-graph.ts:17-22`), so a task blocked for a REASON (awaiting an operator decision, an external dependency, a named unblocker) has no canonical home: the reason lives in run-registry blocking reasons or prose, invisible to the kernel's own graph.

**The design (captured before code, per the kernel-change-first discipline):**

- Kernel contract: `WorkflowTask` gains an optional actor-initiated blocked record — `{ owner: ActorId, action: string, reason?: string, enteredAt: string }` — plus a legal transition `IN_PROGRESS|READY → BLOCKED` that REQUIRES the record (admission fails closed without a named owner + action).
- The self-naming rule: an agent-context caller may only set `owner` to itself (the W157 attribution's actor vocabulary is the join; a scheduler-origin caller names the schedule; the operator surface names the operator). Anything else is refused — an agent cannot volunteer another actor to unblock it.
- Exit stays evidence-gated: `BLOCKED → READY` keeps today's dependency-derived readiness AND requires either the named owner's action consumed (one-shot consumption, the W112 grant-lifecycle shape) or the dependency graph resolving on its own (the record then renders as stale context, not a live block).
- The blocked inbox on the surfaces (the W150 posture-strip pattern): a projection of actor-initiated blocked records grouped by owner, each row rendering the named action — the operator sees exactly who owes what.

**Acceptance criteria (not started):**
- [ ] The kernel refuses an actor-initiated BLOCKED without owner+action and refuses an agent-named foreign owner (focused pins on the transition table + the admission rule).
- [ ] The exit path consumes the named action one-shot; the dependency-derived exit stays automatic (pins both ways).
- [ ] The posture strip renders the inbox (owner-grouped, named actions, honest empty state).
- [ ] Kernel purity holds: the record is caller-supplied data, no clock reads, no actor vocabulary invented inside the kernel.

**Residuals (cut):** scheduled auto-unblock dates, cross-task owner delegation chains, a notification channel — none of the borrowings spec's cut lines move.
