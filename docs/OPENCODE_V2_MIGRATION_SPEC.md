# OpenCode v2 HTTP API Migration & Control-Plane Qualification

**Status:** Proposed — 2026-09-20  
**Version identity:** The `/v2/` documentation namespace is an API-generation label, not yet a pinned OpenCode release/version claim. A release/version must be recorded by the qualification probe before any `enforced` claim.  
**Input:** OpenCode v2 HTTP API (`https://opencode.ai/v2/docs/api`), `llm-enhancements.md`,
`lherron/agent-control-plane` (external architecture reference; not a dependency),
`docs/TASK_TODO_LEDGER_PARITY.md`, `docs/superpowers/plans/2026-09-15-hub-owned-enforcement.md`,
`docs/superpowers/plans/2026-09-19-standard-tui-background-authority.md`  
**Decision:** Pause deeper C/D ACP integration until this boundary is approved.

## 1. Why this migration exists

The OpenCode v2 HTTP API documentation exposes a substantially larger server API than the v1 ACP composition Workflow has
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

## 2.1 Complete v2 operation inventory

The migration is not scoped to the headline session routes. The initial inventory from the v2 API
reference is:

- `server`: info; `location`: get/reload; `agent`: list/get; `plugin`: list/check/update
- `session`: list/create/stats/import/export/active/get/update/remove/fork/switch agent/switch model/move/prompt/command/skill/synthetic/shell/compact/wait/interrupt/background/revert/context/diff/inbox/instructions/generate/log/message/forms/environment/view
- `model`, `provider`, `generate`; `integration` list/get/connect/OAuth/command lifecycle
- `mcp` list/add/remove/connect/disconnect/resource catalog; `credential` update/remove/activate
- `project` list/update; `form` list; `permission` request/saved/session list/create/get/reply
- `filesystem` read/list/find/write; `command`, `skill`, `rpc`, `event`
- `pty` and `persistentPty` lifecycle/connect/snapshot; `shell` lifecycle/list/output
- `reference`, `worktree`, `vcs`, `debug`, `migration`, `websearch`, and `config`

Each operation must receive a Workflow owner or an explicit non-goal in the qualification matrix.
Endpoint existence alone is not implementation evidence.

## 2.2 Direct API authority and credential boundary

No OpenCode v2 endpoint may bypass the Workflow gateway/authority boundary. The stock TUI or any
v2 client receives only the distinct gateway credential; the upstream server credential remains
hub-owned. Direct access to permission, filesystem, shell, MCP, synthetic/prompt, compact, fork, and
lifecycle routes is a qualification failure unless the route is explicitly classified read-only and
its evidence/authority boundary is tested. Gateway tests must cover route classes, not only the known
permission reply route.

## 2.3 Observed v2.0.10 qualification snapshot

A temporary loopback `opencode serve` probe on 2026-09-20 observed:

- `/api/info` → `200`, `version: "2.0.10"`, loopback URL and process identity;
- `/api/session` → `200`, session records include `id`, `parentID`, model, cost, token counters,
  timestamps, project/location metadata;
- `/api/experimental/session/stats` → `200`, envelope `{ data: { range, sessions, subagents,
  prompts, steps, tokens, cost, tools.totals, activeDays, activity, models } }`; tool totals include
  `calls`, `succeeded`, `failed`, and `unfinished`;
- `/event` and `/global/event` → `200` but returned `text/html`; `/api/event` → `200` with
  `text/event-stream` when authenticated. The v2 qualification route is therefore `/api/event`;
  event identity and replay semantics remain unqualified until the stream is consumed and inspected;
- unauthenticated requests returned `401`; the probe used a temporary server password and did not
  persist it.

The normalized stats contract is pinned by `src/integrations/opencode-v2-stats.ts` and
`test/opencode-v2-stats.test.ts`. This snapshot is evidence of one local build only, not an enforced
per-version verdict.

## 2.4 Route qualification matrix (initial)

| Route class | Individual mutation operations | Default v2 target | Qualification evidence |
|---|---|---|---|
| Permission authority | `permission.session.create`, `permission.session.reply`, saved-permission update/remove | Workflow broker owns decision; OpenCode v2 transports the request | Live G1 permission allow/deny/reply probe; policy denial overrides operator allow |
| Session input/control | `session.prompt`, `session.command`, `session.synthetic`, `session.compact`, `session.fork`, `session.move`, `session.interrupt`, `session.background`, `session.remove` | Workflow gateway permits only explicitly authorized operator/agent actions | Route-class auth matrix; append-only log/replay; no task state advancement from input alone |
| Filesystem/mutation | `filesystem.write`, `session.shell`, `shell.create`, `shell.remove`, `worktree.create/remove`, `vcs.*` mutation equivalents | Workflow authorization + guard + containment before execution | G3 substitution/native fs probe; stale fingerprint/claim tests; containment probe |
| MCP/integration/config mutation | `mcp.add/remove/connect/disconnect`, `integration.*` connect/OAuth/command lifecycle, `config.experimental.update`, `plugin.update`, `location.reload` | Gateway auth plus Workflow credential/policy boundary; no direct agent mutation | Auth split test for each route family; credential/guard audit; pinned v2 probe |
| PTY/persistent PTY | `pty.create/update/remove/connect`, `persistentPty.create/shutdown/handoff/update/remove/connectToken` | Explicit operator capability; never implicit mutation authority | Capability/containment test and session identity audit |
| Read-only observation | `session.get/list/log/context/diff`, `vcs.get/base/status/branch/diff`, `filesystem.read/list/find`, `mcp.list/resource`, `session.stats` | Read-only projection; inputs remain untrusted evidence | Schema/bounds tests, replay/idempotency tests, evidence admission test |

Any operation not classified in this matrix is **not qualified** for Workflow integration. The matrix
must be updated when the pinned OpenCode API adds an operation; an undocumented route is a qualification
failure, not an implicit read-only route.

## 2.5 Implemented route-class gateway qualification (2026-09-20)

The matrix is now executable. `src/integrations/opencode-v2-route-class.ts` is the single pure
classifier (method + pathname → route class → gateway disposition `forward` / `broker` / `deny`) and is
consumed by both the production gateway and the probes, so the tested contract is the enforced contract.

- **Read-only observation** (`GET`/`HEAD`/`OPTIONS` on a classified subtree — including `filesystem.read`,
  the `experimental/fs` spelling, `integration`, `command`, `rpc`, and the permission *read* routes) is
  forwarded.
- **Permission authority reply** is brokered; every other permission mutation is denied, and in enforced
  posture the reply route is broker-only for **every** verb (a non-POST verb fails closed rather than
  forwarding under the hub credential). Advisory posture still passes the POST reply through, unchanged.
- **Filesystem/shell/worktree/vcs mutation**, **MCP/integration/config/plugin/location mutation**, and
  **PTY** are denied — they must cross Workflow authorization/guard/containment, not a direct v2 client call.
- **Session input/control** the operator surface needs (`prompt`, `command`, `synthetic`, `interrupt`,
  `wait`, `background`, `inbox`, `message`, `instructions`, `generate`, `switch`, `skill`, session
  create/update/import) is forwarded because it cannot advance canonical state alone; destructive session
  lifecycle (`compact`, `fork`, `move`, `revert`, `remove`) is denied. There is deliberately **no session
  catch-all**: an unlisted session operation (e.g. a future `session.purge`) fails closed as `unknown`.
- **Anything unclassified fails closed** (`unknown` → `deny`); a read whose subtree is unrecognized is
  not implicitly safe. The classifier tracks the §2.1/§2.4 inventory; operation spellings the pinned
  release adds but this classifier does not yet enumerate (observed candidates: `file.content`, `find`,
  `path`, `session.abort/init/todo`) fail closed as `unknown` until classified and tested — the
  fail-closed direction is intentional, and the matrix must be extended before an enforced surface ships.

When `enforced`, the gateway forwards only routes whose disposition is `forward`; it answers any other
client request (`deny`, `unknown`, or a broker route reached without the broker hook) with `403` carrying
the route class, and never forwards it upstream under the hub credential. Advisory posture preserves the
historical pass-through and must not be labeled `enforced`.

**Evidence:** `test/opencode-v2-route-class.test.ts` (classifier cases, always run) and the route-class
gateway tests in `test/opencode-server-gateway.test.ts` (read-only forwarded, mutation/unknown/removed-
session/non-POST-reply denied without upstream reach, brokered POST reply intercepted, advisory
pass-through preserved). The gated live probe `test/opencode-v2-probe.test.ts`
(`WORKFLOW_OPENCODE_V2_PROBE=1`) now checks the server's unauthenticated `401` boundary across every route
class; a live gateway verdict still requires the pinned server + model-key probe family.

## 2.6 External architecture reference: `lherron/agent-control-plane`

The external `agent-control-plane` repository is a useful architecture reference, not a dependency.
Its current spec separates durable ACP session/input/job/interface stores, an API/control-plane facade,
HRC/agent execution, a wrkf-backed authoritative workflow engine, and normalized webhook events with
idempotent replay.

Workflow should borrow the separation and idempotency patterns where useful while preserving its own
kernel/application/guard authority. The external ACP facade must not become canonical task/step truth,
and Workflow must not delegate evidence, authorization, or plugin-retirement decisions to it.

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

The envelope is append-only and must be idempotent. Whether v2 supplies a stable event identity is
**unverified** until the pinned release probe inspects the actual event payload. If no stable identity
exists, Workflow must use a documented digest-bound fallback and treat duplicate/replay ambiguity as
an explicit residual; this is not assumed to be solved by the API documentation alone.

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

## 8. Upstream PR boundary

After v2 implementation and qualification, maintain an explicit upstream-candidate list before opening
any PR against OpenCode. Candidates may include only generic OpenCode/ACP improvements that are useful
without Workflow: protocol compatibility fixes, session lifecycle behavior, event/session-stats
normalization, generic filesystem/session identity hooks, public extension points, and their upstream
unit/probe tests or generated API artifacts.

These remain Workflow-owned and must not be proposed upstream as OpenCode behavior: canonical task/step
ledger state, Workflow authorization, guard policy ownership, evidence/review gates, containment,
credential custody, and plugin-retirement qualification. An upstream PR is blocked until the pinned v2
probe family, replay/idempotency tests, authorization-boundary tests, and independent five-axis review
are green. The PR body must list the exact upstream candidates, source evidence, and any Workflow-only
residuals.
