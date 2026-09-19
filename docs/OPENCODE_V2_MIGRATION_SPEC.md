# OpenCode 2.0 Migration & Control-Plane Qualification

**Status:** Proposed — 2026-09-20  
**Input:** OpenCode v2 HTTP API (`https://opencode.ai/v2/docs/api`), `llm-enhancements.md`,
`docs/TASK_TODO_LEDGER_PARITY.md`, `docs/superpowers/plans/2026-09-15-hub-owned-enforcement.md`,
`docs/superpowers/plans/2026-09-19-standard-tui-background-authority.md`  
**Decision:** Pause deeper C/D ACP integration until this boundary is approved.

## 1. Why this migration exists

OpenCode 2.0 exposes a substantially larger server API than the v1 ACP composition Workflow has
currently modeled: durable sessions, session inboxes, fork/import/export, context and diff views,
compaction/wait/interrupt, permission requests/replies, MCP lifecycle, filesystem access, shell
lifecycle, events, worktrees, VCS, and session statistics.

The API expands the integration surface; it does **not** transfer Workflow authority to OpenCode.
Workflow remains the owner of canonical roadmap/task/step state, authorization, evidence freshness,
verification, guard parity, and plugin-retirement qualification.

The governing rule remains:

```text
OpenCode v2 proposes/executes host behavior
→ Workflow authorizes through the control plane
→ environment produces evidence
→ Workflow validates evidence and advances canonical state
```

## 2. API ownership map

| OpenCode v2 surface | Workflow use | Authority boundary |
|---|---|---|
| `session.list/get/create/update/remove` | Session registry, durable UI history, identity | OpenCode owns session transport metadata; Workflow owns task/step/evidence identity |
| `session.fork`, `session.import/export` | Recovery, handoff, branch-of-work context | Imported/forked context is untrusted observation until Workflow re-associates it with a canonical task |
| `session.prompt`, `session.command`, `session.synthetic` | Agent input, slash commands, controlled bridge messages | No synthetic input may advance canonical state; prompts remain advisory |
| `session.inbox.*` | Durable operator input, approval/wait delivery | Inbox state can wake/resume an agent, but cannot authorize a mutation by itself |
| `session.wait`, `session.interrupt`, `session.background` | Suspend/resume and bounded continuation | Continuation must remain Workflow-policy gated; no autonomous task selection from API state |
| `session.compact`, `session.context`, `session.log` | Context lifecycle, usage visibility, replay/debug evidence | Compaction is an observed event until ACP/v2 semantics are validated; it cannot silently rewrite the canonical ledger |
| `session.diff`, `vcs.*`, `worktree.*` | State-diff evidence, review projections, worktree facts | Diffs are evidence candidates; only Workflow verification admits them |
| `permission.*` | Native permission interception and operator decisions | Workflow policy can tighten/reject; operator replies never override policy denial |
| `mcp.*`, `skill.*` | Configured MCP catalog, skill discovery/delivery | MCP capabilities/evidence remain subordinate to Workflow authority; no server owns task state |
| `filesystem.*`, `shell.*` | Host operation delegation | Must cross Workflow authorization/guard/containment before mutation; direct v2 calls are not automatically trusted |
| `event.subscribe` | Durable execution-log ingestion | Events append to the execution log; replay/projection must be deterministic and idempotent |
| `session.stats` | Tool reliability, failure/circuit-breaker telemetry | Observability informs policy; it does not replace Workflow evidence |
| `agent.*`, `model.*`, `provider.*`, `config.*` | Capability/catalog projection | Configuration cannot downgrade Workflow enforcement or credentials policy |

## 3. Immutable ledger integration

OpenCode v2 enables the long-running-agent model described by the n8n article, but Workflow must keep
two separate durable artifacts:

1. **Plan ledger:** roadmap → canonical tasks → canonical steps/todos, immutable by the agent except
   through Workflow commands/bridge validation.
2. **Execution log:** append-only events for prompts, tool proposals, permission decisions, tool
   outcomes, evidence, state transitions, inbox approvals, compaction, and operator actions.

Canonical state must be reconstructable by replay. OpenCode session history is a source of host
observations, not the authoritative ledger. A v2 session import, fork, synthetic message, or compaction
must never directly mark a Workflow task/step complete.

Required v2 event envelope:

```text
logId, observedAt, sessionId, agentId, parentSessionId?, taskId?, stepId?,
kind, inputDigest?, outputDigest?, authority, result, mutationEpoch
```

The envelope is append-only and idempotent by `(sessionId, eventId)` where v2 supplies a stable event
identity; otherwise Workflow derives a digest-bound fallback and records that limitation.

## 4. C/D redesign against v2

### Corpus C — failure/circuit-breaker parity

Do not infer failures only from ACP `tool_call_update`. Prefer v2's event/session statistics and the
Workflow execution log:

- count policy denials by `(sessionId, taskId, stepId, policyClass)`,
- count repeated tool failures separately from policy denials,
- reset only on an observed successful relevant action,
- expose an operator reset/inspection route through Workflow,
- never deny read-only inspection solely because the mutation circuit is open,
- keep the threshold and classification in WorkflowApplication, not OpenCode or a prompt.

Qualification requirement: reproduce the plugin's threshold behavior with v2 event fixtures and a live
pinned-agent probe; ordinary tool failures must not accidentally freeze all mutation or read activity.

### Corpus D — claims, fingerprints, and subagent budgets

Use v2 session identity and parent/child session metadata as the hierarchy anchor:

- `session.list(parentID=...)` establishes the parent/child relation,
- Workflow owns the mutation budget; v2 only supplies identity/observations,
- `filesystem.read`/session tool events produce a Workflow `ReadFingerprint`,
- a mutation proposal carries the matching fingerprint and an exclusive Workflow file claim,
- `session.fork` gets a new ledger identity and budget relationship; it does not copy authority blindly,
- stale/missing fingerprints fail closed,
- `session.remove`/disconnect releases claims only after Workflow records the lifecycle event.

### Native todo bridge

The native OpenCode todo/todowrite representation is a compatibility projection. The bridge must:

1. accept a v2 tool/event representation;
2. validate IDs/content/status and map to canonical child steps;
3. reject silent active-step deletion;
4. never treat `status=completed` as evidence;
5. bind the step to an evidence requirement and leave it open until Workflow evidence passes;
6. surface bridge rejection as a v2 session status/inbox event, not kill the session;
7. support a later `workflow-task-mcp` migration without changing the kernel ledger contract.

## 5. Qualification and retirement gates

OpenCode v2 adoption does not change Phase G. The plugin stays the enforcement seat until all are true
for a pinned v2 version:

- G1 native permission/deny path passes live;
- G2 guard corpus passes through the v2 authority path;
- G3 substitution or native filesystem path is live and pinned;
- Policy 1/10/24 parity includes the canonical step ledger, evidence-bound checkoff, immutable plan
  ledger, append-only execution log, circuit breaker, fingerprints, and parent-owned budgets;
- G6 adversarial tests pass with no hidden deltas;
- W071 moves from advisory to enforced only after the required permission/ruleset/bypass probes;
- Checkpoint D is operator-signed with the honest delta list.

No v2 API feature may be marked Complete merely because its endpoint exists. Each integration needs:
unit tests, replay/idempotency tests, authorization-boundary tests, and a pinned-agent probe where
host behavior is involved.

## 6. Migration sequence

1. **Inventory/contract:** generate a v2 operation inventory and map each route to a Workflow owner or
   an explicit non-goal.
2. **Read-only observation:** wire `event.subscribe`, `session.log`, `session.context`, `session.diff`,
   and `session.stats` into an append-only observation fixture; no mutation behavior changes yet.
3. **Authority boundary:** route `permission.*`, `filesystem.*`, `shell.*`, and MCP mutations through
   Workflow authorization/guard and containment; reject direct bypass paths.
4. **Ledger bridge:** move native todo bridge and C/D contracts onto v2 identities/events; add replay and
   crash/restart tests.
5. **UI parity:** use v2 session/context/diff/inbox APIs for the OpenCode-influenced web surface while
   keeping canonical Tasks/Todo/evidence distinct and labeled.
6. **Qualification:** run G1/G2/G3/G6 and W071 probes; update `HOST_ADAPTERS.md`, `FEATURES.md`,
   `GUARD_CORPUS_MAP.md`, and `COMPLIANCE_REGISTER.md` with linked evidence.
7. **Retirement:** only then demote/retire `opencode-workflow-guard` for the pinned version.

## 7. Explicit non-goals

- OpenCode v2 does not become the canonical task/step ledger.
- OpenCode native todos do not self-certify evidence or completion.
- The Workflow UI does not display MCP/LSP data as "connected" unless v2 supplies a verified source.
- Session replay/import/fork does not bypass Workflow authorization, evidence freshness, review, or
  containment.
- C/D implementation continues against v1 ACP only if a separately approved compatibility fix is needed;
  otherwise v2 is the target integration surface.
