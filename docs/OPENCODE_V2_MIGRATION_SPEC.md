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
hub-owned. Direct access to permission, filesystem, shell, MCP, config/plugin, and session lifecycle
routes is a qualification failure unless the route's disposition comes from the executable route-class
matrix (§2.5) and its evidence/authority boundary is tested: read-only observation is forwarded, the
permission reply is brokered, session input/control the operator surface needs (`prompt`,
`synthetic`, `message`, …) is forwarded because it cannot advance canonical state alone, and
destructive session lifecycle (`compact`, `fork`, `move`, `revert`, `remove`) is denied. Gateway
tests must cover route classes, not only the known permission reply route.

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
  `abort`, `wait`, `background`, `inbox`, `message`, `instructions`, `generate`, `switch`, `skill`, session
  create/update/import) is forwarded because it cannot advance canonical state alone; destructive session
  lifecycle (`compact`, `fork`, `move`, `revert`, `remove`) is denied. There is deliberately **no session
  catch-all**: an unlisted session operation (e.g. a future `session.purge`) fails closed as `unknown`.
  (**2026-09-20, W080 reclassification:** `compact` moved to *forward* — operator-controlled session
  maintenance (a checkpoint summary that cannot advance canonical state), not destructive lifecycle;
  `fork`, `move`, `remove`, and the staged-revert family remain denied.)
- **Config reads are denied even though they are reads** (review P3): the v2 config payload carries
  provider credentials, so a raw forward would leak them; the hub serves redacted config itself. The
  api-optional spelling (`/config`) is denied the same way.
- **App-shell route class (2026-09-20, W074a):** the stock v2 web UI's static surface is an explicit,
  allowlisted class — `GET`/`HEAD` only, `forward`: exactly `/`, the hashed build output under
  `/_assets/`, icons under `/icons/`, plus `/site.webmanifest` and the unprompted `/favicon.ico`.
  Anything else under the root stays `unknown`/deny (no root catch-all), a `POST` on the shell path
  still fails closed as a mutation candidate, and dot-segment paths are refused before the allowlist
  is consulted. Motivation: project the stock opencode web UI through the gateway as a second
  operator surface with the hub credential split intact.
- **Dot-segment pathnames fail closed** (review P3): the gateway proxies the raw path upstream, so a
  `.`/`..` segment could classify as one route and resolve as another upstream; classification refuses
  them rather than normalizing.
- **Anything unclassified fails closed** (`unknown` → `deny`); a read whose subtree is unrecognized is
  not implicitly safe. The classifier tracks the §2.1/§2.4 inventory; operation spellings the pinned
  release adds but this classifier does not yet enumerate fail closed as `unknown` until classified
  and tested — the fail-closed direction is intentional, and the matrix must be extended before an
  enforced surface ships. (`session.abort` is now classified: operator stop-control, forwarded as
  session input. **2026-09-20:** the matrix was reconciled against the documented v2 inventory —
  see §2.7 — which replaced the earlier speculative spellings (`switch` was never a documented op)
  and classified the documented session operations (`agent`/`model` switch, the experimental
  `skill`/`wait` spellings, the staged-revert family, inbox PATCH) and the bare permission/worktree/pty
  reads.)

When `enforced`, the gateway forwards only routes whose disposition is `forward`; it answers any other
client request (`deny`, `unknown`, or a broker route reached without the broker hook) with `403` carrying
the route class, and never forwards it upstream under the hub credential. Advisory posture preserves the
historical pass-through and must not be labeled `enforced`.

**Evidence:** `test/opencode-v2-route-class.test.ts` (classifier cases, always run) and the route-class
gateway tests in `test/opencode-server-gateway.test.ts` (read-only forwarded, mutation/unknown/removed-
session/non-POST-reply denied without upstream reach, brokered POST reply intercepted, advisory
pass-through preserved). The gated live probe `test/opencode-v2-probe.test.ts`
(`WORKFLOW_OPENCODE_V2_PROBE=1`) now checks the server's unauthenticated `401` boundary across every route
class; a live gateway verdict still requires the pinned server + model-key probe family. The gated
live probe `test/opencode-webui-gateway-probe.test.ts` (`WORKFLOW_OPENCODE_WEBUI_PROBE=1`) qualifies
the app-shell class end to end against the pinned stock server through the **enforced** gateway
(live-verified on opencode v2.0.10, 2026-09-20: shell HTML + hashed bundle + manifest forward;
unauthenticated `401`; unknown root read and config read stay `403` fail-closed).

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

## 9. Documented v2 API inventory and the dual-lane integration decision (2026-09-20)

Fresh research against the brand-new official documentation (`https://opencode.ai/v2/docs/api/`,
OpenAPI 3.1, 136 operations / 245 schemas; machine-readable at `/v2/openapi.json`; verified live
against the pinned stock server **v2.0.10**). The legacy `opencode.ai/docs/server/` page still
documents the **v1** bare-path API (`/session`, `/global/event`) — the spelling family W071's
runtime was originally written against. Stock v2 serves the web UI as an SPA fallback on every bare
path and exposes the JSON API under `/api/*` only. **All new integration speaks v2 spellings.**

**Dual-lane decision (operator directive, 2026-09-20):** ACP remains the control lane — session
lifecycle, prompts, permission authority, turn flow. The documented v2 HTTP API is the **data
lane**, used wherever ACP lacks exposure: live MCP list (`GET /api/mcp`), per-session usage truth
(`GET /api/experimental/session/stats`), provider/model/agent enumeration (`GET /api/provider`,
`/api/model`, `/api/model/default`, `/api/agent`), the event stream (`GET /api/event`), and the
location-scoped fs/shell/vcs/worktree/reference surfaces. Hub-side consumption is in-zone (the hub
owns the spawned server and its credential on loopback); anything surfaced to external clients
crosses the enforced gateway under the §2.5 route-class dispositions — no API data reaches a client
except through a classified `forward`.

**Compaction research note (2026-09-20, W082 box 2 — completed against the pinned v2.0.10 binary
strings + the v2 docs):** v2 distinguishes two compaction kinds. **`native`** is provider-native
context management — the binary carries `AI SDK routes cannot replay native provider compaction
state`, i.e. replay/import cannot reconstruct it, so native compaction state is provider-local and
ephemeral from v2's perspective. **`summary`** is v2's own checkpoint summary, persisted
(`compactions` table, `compaction_idx`) and replayable. Per-model config drives both:
`compaction: { auto, keep: { tokens } }` with a compact threshold (`compactThreshold`) and a
reserved context buffer for the summarization turn (the binary's `keep.tokens` /
`reserved→buffer` projection; the v1-era `prune`/`preserve_recent_tokens` spellings survive only
in the V1-compat projection). **When it runs:** with `auto` enabled the session runtime compacts on its own —
`compactIfNeeded` fires on the session stream and emits `compaction-queued` plus the
`compaction.started/.ended/.failed/.interrupted/.unavailable/.delta` lifecycle events; this is
runtime behavior, NOT the HTTP route. **Manual compaction** is `SessionCompaction.compactManual`,
invoked by the `/compact` slash command ("compact older session context to free space") and by the
documented HTTP route `POST /api/session/{sessionID}/compact`; with nothing to compact it returns
`compaction.unavailable` ("Nothing to compact yet"). **The ACP-lane answer (the operator's actual
regression):** `opencode acp` wraps the same session runtime, so the ACP lane auto-compacts exactly
when the model's compaction config enables it — no plugin needed, and nothing for Workflow to
trigger there. What the operator hit was the failure mode when auto is unavailable/unconfigured:
context overflow surfaces as a `400` (`Context overflow: … Please start a new session or use
/compact to reduce context.`). The deterministic Workflow-side fix is therefore the manual
operator control over the documented route through the enforced gateway (W082 box 3, this slice);
the hub-side auto-trigger remains a separate deterministic gate (box 3 second half, still open).

**Auto-trigger decision addendum (2026-09-21, W082 box 3 second half — decided and landed):** the
hub-side automatic compaction trigger is **config-side**. Ownership decision (operator direction
2026-09-20, three candidates weighed): the **session runtime under hub-written config** is the
owner — this research note already established that the ACP lane auto-compacts exactly when the
model's compaction config enables it, so Workflow's deterministic lever is composing
`compaction: { auto: true }` into the hub-written per-runtime config (the same composition every
hub-owned surface rides), not owning a poller. **Hub scheduler: rejected** — cron is the wrong
shape for a threshold trigger and the hub daemon has no per-session visibility (separate process).
**Session manager: rejected** — its ACP `usage_update` view covers only live web-UI sessions, and
it cannot reach those sessions through the gateway anyway (store finding, below). **Topology
daemon monitor: recorded as the data-lane follow-up**, gated on a per-session usage-read probe
(per-session message tokens ARE documented in the v2 message payloads —
`GET /api/session/{id}/message` — so the source exists; the monitor is worthwhile only if the
config-side trigger proves insufficient for gateway-driven sessions). Implementation (2026-09-21):
settings `agents.<id>.autoCompact` (explicit boolean, default off, workspace-over-global, panel
toggle for opencode) composes `compaction: { auto: true }` in `meteredOpencodeConfig` for both the
ACP subprocess and the topology server config (the daemon resolves the same preference
fail-soft). Budget-guard-aware by construction: a compaction turn is a normal metered model turn
through the same loopback proxy the W045 interactive budget guard watches; the sticky refusal gate
bounds every later prompt; no bypass lane. No plugin hook composed anywhere. Probe evidence
(2026-09-21): `test/opencode-auto-compact-probe.test.ts` (`WORKFLOW_OPENCODE_AUTO_COMPACT_PROBE=1`)
live green on v2.0.10 — the composed config carries the block beside the pinned ask ruleset and
`/api/config` lists the hub-written document with `compaction.auto === true` parsed; the LIVE
auto-compact turn arm (a real overflow turn compacting) stays PENDING on a real model key —
register row `opencode-auto-compact-config-load` in `docs/PROBE_VERDICTS.json`. Store finding
recorded the same day: the web session registry's agent-session ids live in the ACP subprocess's
scratch-HOME session store while the gateway fronts the topology server's own store, so the manual
control's admit path is route-qualified and its session-level reachability for web-UI ACP sessions
is unprobed — the control surfaces the gateway's refusal verbatim, never a fabricated success.

**Matrix reconciliation (this dated change):** documented reads that were failing closed are now
`read-only`/`forward` — bare permission reads (`/api/permission/request`, `/api/permission/saved`;
the §2.5 text always claimed permission reads, the pattern diverged), `GET /api/worktree` (repo
metadata), `GET /api/pty` (list; connect/mutate stay denied). Documented session operations are
classified: `POST …/agent` and `…/model` switch and the experimental `skill`/`wait` spellings
forward (operator input); the staged-revert family (`revert/stage`, `revert/commit`) and the
destructive lifecycle (`compact`, `fork`, `move`, `remove`) deny; the documented inbox `PATCH`
(delivery decision) forwards while `DELETE` stays held back; import is denied through the gateway in
both spellings (foreign session data enters through the hub lifecycle, which owns provenance).
Tightenings: `PUT /api/session/{id}` was never documented (was incidentally forwarded) and now fails
closed; the speculative `switch` op is gone. Still **intentionally unclassified** (fail closed
until a need is shown and they are classified): forms (`create`/`reply`/`cancel`), session
`environment` (credential-bearing env injection), `view`, client-driven `websearch`, plugin
`rpc`, project `PATCH`, persistent-pty (prototype), and PTY/connect tokens.

Auth: the v2 client docs show `Authorization: Bearer <token>`; the server-password flow
(`OPENCODE_SERVER_PASSWORD`, Basic `opencode:<password>`) is live-verified on v2.0.10 and is what
the Workflow runtime and gateway compose. Both are honored by the pinned release.

**Evidence:** `test/opencode-v2-route-class.test.ts` (reconciled case table), the route-class
gateway suite, and the gated live probes (`WORKFLOW_OPENCODE_WEBUI_PROBE=1` app-shell verdict;
`WORKFLOW_OPENCODE_SERVER_ATTACH=1` M1 re-qualification, v2 spellings).

## 10. Limitations re-examined under the data lane (2026-09-20, operator directive)

The pivot to hub-owned enforcement made deliberate trade-offs that ACP's narrow surface forced.
The documented v2 API (§9) reopens several. Each prior concession, re-examined:

| Prior limitation / concession | Why it existed | Data-lane status | Disposition |
| --- | --- | --- | --- |
| "ACP exposes no live MCP list" (inspector honesty line) | ACP carries no MCP inventory | `GET /api/mcp` through the gateway gives live per-server state | **Solved** — `GET /api/settings/mcp/live` + settings panel (`9bd1cf4`) |
| Usage truth only from the hub's metering proxy; per-session stats absent | ACP exposes usage only via the metering proxy | `GET /api/experimental/session/stats` returns server-side activity/usage/tool-reliability | **In progress** — W079 (Usage page read through the gateway); the proxy remains the budget-enforcement point |
| `agents.*.thoughtLevel` persisted with **no launch consumer** (routing-knobs honest copy) | No launch path carried reasoning effort | v2 config documents per-model `settings.reasoningEffort` **and variants** (`opencode.ai/v2/docs/models`) | **Solvable now, probe-gated** — map `thoughtLevel` → `settings.reasoningEffort` in the launch-config writer (v2 shape), verify on a live turn before touching the UI copy |
| Config-defined providers invisible in `/api/provider` + `/api/model/default` ignores the config model (§9) — metered-model resolution risk | v2 provider visibility follows credential activation | `POST /api/session` accepts an explicit `model: Model.Ref`; credential/integration connect + activate routes exist | **Solvable path identified** — probe the credential-activation flow; until then, pin the metered model explicitly on session create rather than trusting defaults |
| Interactive-TUI sessions unmetered ("the hub never sees those runtimes") | TUI sessions ran in their own process | In the server topology the TUI attaches to the hub-owned server; stats cover every session server-side | **Solvable in the server topology**; ACP interactive sessions stay proxy-metered until the chat-lane consolidation |
| Chat lane (PWA) on per-session ACP runtimes; consolidation parked | Unmetered-default risk + provider visibility | Explicit model refs on session create remove the worst failure mode | **Partially unlocked, still parked** — full consolidation gated on the provider-visibility probe (W080-adjacent) |
| Auto-compaction lost in the plugin→hub pivot | Plugin hooks could trigger compaction in-process | `POST /api/session/{id}/compact` + provider `native`/`summary` compaction config | **W082 decided and landed (2026-09-21; route decision 2026-09-20)** — compact re-classified deliberately in §2.5 (forward, operator-controlled maintenance); the PWA manual compaction control rides the enforced gateway; the hub-side auto-trigger is **config-side** (settings `agents.<id>.autoCompact` → `compaction: { auto: true }` in the hub-written config for the ACP subprocess and the topology server; §9 addendum records the owner decision — runtime-under-config, scheduler/session-manager rejected, topology-daemon monitor the gated data-lane follow-up); no prompt-side loop and no plugin hook; the live auto-compact turn arm stays PENDING on a real model key (register row `opencode-auto-compact-config-load`) |
| fs/shell/pty deny classes through the gateway | Containment: mutations cross Workflow authorization | The API exposes them to *its own* clients | **Keep** — the data lane changes nothing about the mutation boundary |
| Skill delivery gated (native host skill injection off) | Injection boundary discipline | `GET /api/skill` is list-only; no write surface | **Keep, unchanged** — W078 scoping lands with the delivery decision |
| Session resume via ACP `session/load` | Probe-proven | `experimental/session/export\|import` exist as data transfers | **Keep**; note export/import as a future migration tool only |
| PWA transcript is ACP-advisory | ACP update stream is the only transcript source | `/api/event` SSE carries richer tool/provider state | **Candidate (observability only)** — transcript enrichment through the gateway; advisory posture unchanged |
| "No ACP/hub surface injects project-memory recall" (durable-state inventory) | No injection boundary existed | `instructions/entries` is now a per-session durable write surface | **Parked, deliberately** — a durable-state injection boundary requires the attestation discipline (DRIFT-015) before anything writes there; rejected as a todo-pivot (§9 addendum) |

**Rules going forward:** (1) a concession is retired only with probe evidence on the pinned
version — documentation is a lead, not a verdict; (2) data-lane reads cross classified gateway
routes (§2.5) even when the hub could read in-zone; (3) enforcement never moves to the data lane —
the metering proxy, guard, and containment stay where they are.
