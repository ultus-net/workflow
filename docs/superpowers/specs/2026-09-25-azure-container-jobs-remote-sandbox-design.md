# Azure Container Jobs as Remote Agent Sandboxes — fork decision and design

**Date:** 2026-09-25 · **Status:** decision recorded — keep the stock OpenCode
harness, use the OpenCode SDK strictly as glue, and route the sandboxes as an
integration through the existing control-plane boundary. No code accompanies this
spec. · **Evidence base:** `AGENTS.md`, `docs/PROTOCOL_PLANES_2026-09-22.md`,
`docs/OPENCODE_REMOTE_ACP_SPEC.md`, `docs/RUNTIME_CONTAINMENT.md`,
`docs/OPENCODE_SERVER_AUTHORITY.md` (+ `test/opencode-server-attach-probe.test.ts`,
live green on v2.0.10 per `docs/HOST_ADAPTERS.md` §2.5), `docs/FEATURES.md` W071/W074;
OpenCode docs (`opencode.ai/docs/server`, `/doc` OpenAPI 3.1, `opencode run
--attach` / `opencode attach`); Microsoft Learn on Container Apps jobs (no ingress;
Manual/Schedule/Event triggers; `replicaTimeout` default 1800s; event-driven
scale-per-message). Requirements, not resolutions, in §9.

---

## 1. Motivation and scope

The operator wants disposable **Azure Container Apps jobs** as the compute backend
for legitimate OpenCode agents and subagents, with the operator surface unchanged:
the Workflow-owned headless `opencode serve` behind the W071/W074 authority gateway,
and its **stock** web UI as the primary operator surface. The mental model, in the
operator's words: *the headless server with the web UI sends legitimate opencode
agents and subagents to disposable containers*; the SDK is how Workflow's app and
Azure infrastructure **glue into** the served OpenCode surface. The upstream harness
(TUI + web UI + server) keeps updating from upstream; nothing here forks it.

**In scope:** the fork decision; the two concrete integration shapes (A: headless
turn-based worker via event-driven jobs; B: live-attached session via manual job +
outbound rendezvous); the SDK boundary; containment/evidence posture; probe plan.

**Non-goals:** building a custom harness, custom client UI, or custom server;
changing the kernel; any `enforced` claim before the probes in §8 are green.

**The one-line truths:**
- *The bridge/pod is only as authoritative as the remote API's pre-mutation
  interception* (echoing `docs/OPENCODE_REMOTE_ACP_SPEC.md` §1).
- *A container pod is containment, not control-plane interception.* Isolation and
  authorization are separate gates and must not be conflated
  (`docs/RUNTIME_CONTAINMENT.md`: `enforced` vs `policy-only` are type-level).
- *Workflow speaks server HTTP only to servers it launches and configures* — a job
  pod Workflow launches satisfies that rule and routes through the existing
  opencode-server topology rather than a new integration class
  (`docs/PROTOCOL_PLANES_2026-09-22.md` §2).

## 2. The recorded decision (fork closed)

There are three different meanings of "use their SDK". The boundary is fixed so it
is not re-litigated next session:

| SDK scope | Verdict | Why |
| --- | --- | --- |
| **Glue / automation** — drive sessions/events from dispatch, bridge, and probe seams | **USE** | It is exactly what the SDK is for; the server publishes OpenAPI 3.1 at `/doc` and the official clients are generated clients. Pin the generated client to the vendored opencode version in the same image; updates become bump-and-regenerate, not reconcile-the-client (the v2.0.10 provider-visibility caveat in `docs/HOST_ADAPTERS.md` §2.5 shows what hand-rolled costs). |
| **Custom client/UI** — replace the stock TUI/web surface with our own rendering of the serve API | **REJECT** | That is re-implementing the stock web UI we already gateway-forwarded and probe-qualified (W074a, `docs/FEATURES.md`). We would own prompt UX, diff rendering, permission UI, model switching — against every upstream change. Contradicts "harness updated upstream". |
| **Custom server/harness** — replace the opencode server itself | **REJECT** | Forfeits the tool engine, permission engine, MCP hosting, provider plumbing, replay. The worst cost/benefit of the three. |

**Routing, not re-implementation:** the job pod is a routable target *behind* the
existing boundary — "a server Workflow launches and configures". It registers into
the opencode-server topology the same way a local contained server does today;
authorization stays in `WorkflowApplication.authorize`, evidence validation stays
hub-owned, adapters still translate host events.

**Revisit triggers** (only these reopen the fork):
1. An operator surface the stock UI *cannot* express (custom approval flows,
   domain consoles, non-TUI interface) becomes a hard requirement.
2. Upstream server-API churn starts consuming more integration effort per release
   than maintaining a bespoke client would.
3. A headless automation console becomes the primary need (then the SDK lifecycle
   is already justified and the UI question never arises).

## 3. Shape A — headless turn-based worker (event-driven jobs)

The natural fit for the Container Apps job primitive.

- **Trigger:** an Event job. One queue message (azure-queue or Service Bus) =
  one execution = one bounded agent/subagent run; `minExecutions: 0` scales to zero
  between tasks; `replicaTimeout` sized to the task budget.
- **Task spec:** carried in the message body (or a blob ref): repo ref + branch,
  the task message (a condensed prompt, like a subagent prompt today), declared
  expected evidence, budget cap, and permission posture. The hub (or the serverside
  dispatch seam) enqueues; the pod pulls.
- **Pod:** `npm ci` then run **stock** `opencode run` headless on a disposable
  checkout (clone/worktree). Workload identity grants only what the task needs;
  secrets come via Key Vault refs; no ambient credentials in the image.
- **Result:** branch + PR (or patch artifact) plus an evidence blob; the pod exits
  nonzero-transparently; the hub validates declared evidence before state advances.
- **SDK footprint:** zero in the pod (pure stock CLI — the strongest "harness
  upstream" property). The pinned SDK is used only on the dispatch/ingest side.
- **Cost model:** per-execution CPU/memory billing while running; nothing while
  idle.

## 4. Shape B — live-attached session (manual job + outbound rendezvous)

Only if live steering from the UI is required; it fights the job primitive.

- **Trigger:** a Manual job execution held open for the session's lifespan.
- **Reachability:** jobs have **no ingress** (no custom domains/TLS — verified
  against Microsoft Learn "Jobs restrictions"). The pod must therefore establish an
  **outbound** rendezvous/tunnel (SSH reverse tunnel, Tailscale/WireGuard, or a
  rendezvous relay Workflow runs) that makes its `opencode serve` reachable from the
  gateway.
- **Surface:** the stock TUI (`opencode attach`) or stock web UI reaches the pod's
  server through the existing gateway + authority broker; `permission.asked` is
  intercepted and answered via `WorkflowApplication.authorize` as today.
- **Constraints:** `replicaTimeout` must cover session length; idle sessions still
  bill; pods can be preempted under node resource pressure. A long-lived reachable
  sandbox is what Container App *services* exist for — if B becomes the primary
  model, revisit services with ingress instead of fighting jobs.

## 5. The SDK boundary in both shapes

- Generate the client from the running image's `/doc` spec, pinned to the exact
  opencode version in that image. Version coupling is the "harness updated
  upstream" guarantee; the SDK is a client, never authority.
- The SDK is used in: the dispatch seam (create session, enqueue), the bridge/broker
  seams (SSE event subscription, `permission.reply`), and health/session probes.
  It does **not** decide anything; `WorkflowApplication.authorize` does.

## 6. Containment, evidence, and honest posture

- A job pod is a stronger isolation boundary than the Bubblewrap backend, but
  isolation is not authorization. The `enforced` marker (`docs/RUNTIME_CONTAINMENT.md`)
  requires probe-backed **pre-mutation interception**; for remote pods that means
  the `permission.asked → authorize → reply` loop working across the transport —
  advisory until proven.
- Shape A's interception story is the queue round-trip + branch/evidence gate, and
  a human merge gate on the PR. Shape B's is the broker over the tunnel. Neither
  is `enforced` until the relevant probe passes.
- Evidence freshness (per `docs/SECURITY_ASSURANCE.md` discipline) stays hub-owned;
  a run that returns without declared evidence does not advance state.

## 7. Constraints that shape everything (verified)

| Surface | Constraint |
| --- | --- |
| Container Apps jobs | No ingress. Run-to-completion. `replicaTimeout` default 1800s, configurable. `parallelism`/`replicaCompletionCount` per execution. Event scale rules (queue/service bus/kafka/rabbitmq) with `maxExecutions`/`pollingInterval`. |
| Container Apps ingress (apps, not jobs) | Default idle request timeout **4 min** (premium ingress: configurable 4–30 min); standard request timeout 240s; WebSocket supported; session affinity available; documented SSE failures behind built-in ingress (reaped idle streams, buffered/hung `text/event-stream`) — fixes are affinity + server keepalive + raised idle timeout. These failures only appear behind the real ingress, never on localhost. |
| OpenCode server | Headless `opencode serve`; OpenAPI 3.1 at `/doc`; `opencode run --attach` / `opencode attach`; basic auth via `OPENCODE_SERVER_PASSWORD`; SSE event stream; permission reply before mutation. |
| Workflow | Server topology only launches/configures servers it owns; kernel purity rule (no LLM/IO/UI/SDK imports in `src/kernel/`); adapters never own state. |

## 8. Milestones and probes (gate, don't guess)

Two tracks. The **C-track** (control plane in Azure, §10) is what the operator
touches first; the **P-track** is the job fleet. Each milestone is a gated live
probe, not a claim.

**C-track:**
- **C0 — stock plumbing only:** bare `opencode serve` in a Container App with
  external ingress; local stock `opencode attach` over HTTPS from the operator
  machine; prove the event stream survives the ingress (idle timeout, session
  affinity, keepalive); record the working ingress config as the pinned recipe. No
  Workflow code involved yet.
- **C1 — Workflow behind the gateway:** hub + `opencode-server` daemon + gateway +
  broker in-container; `workflow-opencode` attaches through the gateway; the
  client/upstream credential split verified over the wire; broker SSE subscription
  and interception work through ingress. Posture stays `advisory`.
- **C1.5 — Easy Auth edge probe:** Entra ID authConfig with `excludedPaths:
  /api/*`; browser shell redirects and logs in; stock `opencode attach` still
  green through the excluded API lane with basic auth only; a spoofed
  `X-MS-CLIENT-PRINCIPAL` on an excluded path still fails the gateway's own
  credential check; the app-shell lanes reject unauthenticated requests at the
  platform layer.
- **C2 — durability drill:** state on an Azure Files volume; kill the replica
  mid-session, re-attach, and verify sessions recover or drain cleanly. Any
  `enforced` claim still waits on the P2 permission-loop probe — now over public
  ingress instead of a tunnel.

**P-track (job fleet):**

- **P0 — Shape A e2e on a throwaway repo:** queue message → job pod runs stock
  `opencode run` → evidence blob + branch. Gated live probe
  (`WORKFLOW_AZURE_JOBS_PROBE=1`), verdict recorded per `docs/HOST_ADAPTERS.md`
  discipline.
- **P1 — fail-closed checks:** no ambient credentials in the image (Key Vault
  refs only); private ACR with workload identity; no ingress exposed; `minExecutions 0`;
  budget cap enforced by `replicaTimeout` and session-budget watcher.
- **P2 — authorization seam:** dispatch from the served surface so a dispatched
  run is a Workflow-authorized task with declared evidence; Shape B's
  `permission.asked → authorize → reply` over the tunnel probed **with a model
  key** before any `enforced` claim.
- **P3 — lifecycle hardening:** job eviction/preemption handling, idle-billing
  watchdog for Shape B, retry/backoff on pod startup.

## 9. Relation to local stream-hygiene tiers (addendum, 2026-09-25)

Cross-checked against the operator's concurrent-session guidance (Tier 1:
same-branch sequential subtasks under tight subagent contracts; Tier 2:
worktree-per-stream with file-level cherry-pick integration; Tier 3: report-only
wave authors + collector):

- **Shape A natively implements the Tier 2/3 mechanics.** One queue message = one
  disposable checkout = one stream; no shared-checkout pollution; the collector
  role is the hub's evidence validation. The wave-agent failure class (untracked
  test files, `.tmp-*` logs, and ledger edits landing on a shared checkout) is
  structurally absent — the pod's tree is discarded and only declared artifacts
  return.
- **Sandboxes do not replace Tier 1.** A pod costs cold-start latency and
  per-execution billing; small bounded subtasks (test-authoring with a
  create-one-file contract) stay local and cheap. Dispatch policy must route by
  size/duration: local Tier 1 under a threshold, job pod above it. Recording the
  threshold is an open question (§10).
- **The subagent-rooting constraint dissolves at P2.** Verified live (2026-09-25):
  a subagent's file access is rooted at its session's working directory — a
  reviewer spawned from the order-processing worktree could not read the Workflow
  repo, and the session had to be moved into the worktree before spawning. With
  hub-side dispatch (§8 P2), task routing moves into the control plane: the hub
  can start a job against any authorized repo ref without a rooted session. This
  is a motivation for the design, not only an isolation win.
- **The LESS-0061 "schema is the spec" delegation pattern becomes the queue
  message format.** The §3 task spec (repo ref + branch, message, declared
  evidence, budget, permission posture) is enforced by the hub validating the
  message structurally, not by prompt discipline.

## 10. Control plane in Azure — the third deployment piece (added 2026-09-25)

The operator goal: run the Workflow control plane (hub + gateway + contained
`opencode serve` + web UI) as a long-running Container App and attach the stock
TUI from the local machine (`opencode attach https://…` / `workflow-opencode`
pointed at the remote gateway). Motivation, stated: the laptop stops being the
bottleneck — builds, test runs, indexing, and many concurrent agent streams run on
Azure compute while the TUI stays a thin client; the upstream harness is unchanged
and keeps updating itself.

- **Resource-type correction:** the control plane is the Container **App** case
  (long-running, ingress-required) — the job case of §3/§4 is only the worker
  fleet. **Posture decided 2026-09-25: the operator accepted the always-on cost
  for the dev plane; `minReplicas=1` is the standing posture**, not a default
  pending review. The wake path survives as a fallback and diagnostic (below),
  not a cost optimization.
- **Launcher plane-awareness (decided 2026-09-25, rides C1):** even under the
  always-on posture the plane can be unreachable (revision restart, manual
  scale-in, network). The launcher (`workflow` / `workflow-opencode`) probes
  gateway health before attaching and, when unreachable, classifies the state
  before acting:
  - **Asleep** (plane resource exists, replicas at zero) → **attempt the wake
    automatically**, not as a menu offer: visible one-line notice of the action,
    Management API PATCH `minReplicas` 0→1 with the operator's `az` credentials,
    bounded health-poll timeout, then attach.
  - **Broken** (resource missing, replica crash-looping, revision error, ingress
    gone) → do not attempt a wake that cannot succeed; report the honest state
    with next steps instead.
  - **No `az` cli session** → skip the wake attempt and state exactly why
    ("log into `az cli` to enable plane wake"); never hang, never guess.
  Fail-closed, probe-gated, operator-verdict-per-step — the same discipline as
  the launcher's existing doctor/discovery seams. The scheduled-runs caveat
  below still holds for any future sleep, but no cost-driven doorbell is planned.
- **Topology matches the existing security model:** hub, `opencode-server` daemon,
  contained serve, and gateway run in one container speaking loopback to each
  other — today's loopback-only containment posture, with the container as the
  boundary. Ingress exposes only the gateway route-class matrix and the web UI.
  Provider credentials stay Azure-side (Key Vault refs); the operator machine holds
  only the client credential. The W071 client/upstream credential split maps 1:1
  onto remote operation.
- **SSE is the load-bearing risk:** both the TUI attach and the authority broker
  ride the event stream. Verified 2026-09-25 (Microsoft Learn + field reports):
  ingress default idle timeout 4 min, 240s request timeout, and documented cases
  of `text/event-stream` hanging or being reaped behind built-in ingress. The
  standard fix is session affinity + server keepalive + raised idle timeout —
  and it only fails behind the real ingress, which is why C0 exists.
- **State must survive the replica:** `~/.workflow` and opencode storage on an
  Azure Files volume mount; a replica restart must not orphan live sessions
  (drain/resume is the C2 drill, not an assumption).
- **Edge identity layer — Easy Auth (added 2026-09-25):** platform-enforced
  Entra ID authentication in front of the plane, layered as three gates that must
  not be conflated: Easy Auth answers *who can reach the plane at all*; the
  gateway route-class matrix + credential split answers *which routes/credentials
  may pass*; `WorkflowApplication.authorize` answers *may this tool call mutate*.
  Config: `authConfigs.globalValidation.unauthenticatedClientAction:
  redirectToLoginPage` (Entra ID) with **`excludedPaths: /api/*`** — browser UI
  shells get the redirect flow; the stock TUI keeps basic-auth-only attach
  unchanged because it never meets Easy Auth (gating `/api/*` would strand the
  stock client — it has no Entra ID flow). Known tradeoffs recorded: the browser
  double gate (Entra cookie + gateway basic auth) is accepted initially;
  teaching the gateway to trust `X-MS-CLIENT-PRINCIPAL` is the classic
  header-spoofing footgun and is only safe while the exclusion list stays exactly
  `/api/*` — revisit trigger, not day-one build. Upstream gap noted: ACA Easy
  Auth does not emit MCP Protected Resource Metadata
  (microsoft/azure-container-apps #1736) — irrelevant while toolbox MCP servers
  stay loopback-internal, a wall if any MCP surface ever goes remote-facing.
- **Topology consequence:** one ingress port per app makes the **gateway the
  single front door** for both UI shells and all API lanes — one Easy Auth
  config, one exclusion list, one route-class matrix to probe. workflow-web is
  served behind the gateway as an additional route class, not a second app.

## 11. Open questions (requirements, not resolutions)

1. Which trigger/queue (Storage Queue vs Service Bus) and what cost ceiling per
   run?
2. Session data location if a pod's session must survive the pod exit (Azure Files
   volume on the OpenCode data dir vs disposable session)?
3. Repo transport into the pod: fresh clone of a branch vs snapshot of the current
   worktree + uncommitted context?
4. Does the web UI stay reachable only from the operator's machine, or must an
   external operator reach it (affects Shape B rendezvous and auth)?
5. Ownership of the dispatch seam: hub-side, or a broker behind the served opencode
   server surface?
6. The Tier-1/pod routing threshold: what task size/duration justifies a job pod
   over a local contained subtask?
   *(Resolved 2026-09-25: off-hours scale policy — always-on `minReplicas=1` is
   the standing posture; launcher plane-awareness replaces any doorbell.)*