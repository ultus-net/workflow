# P4 topology A2/C migration — decision brief

**Date:** 2026-09-30 · **Status:** design INPUT only. Nothing here authorizes a
code change; the implementation is a separate later iteration, and the
operator-level choice among A1→A2→C stays OPEN (the DECISION is the
operator's — §5). · **Item:** parked P4
(`docs/PARKED_AND_LIMITATIONS.md:33`, GitHub issue #283), the successor to the
topology-split brief (`docs/P4_TOPOLOGY_SPLIT_BRIEF.md`) after Option A1
landed (`docs/ledger/topo-a1.md`).

**Sources read for this brief (full or cited range):** `docs/P4_TOPOLOGY_SPLIT_BRIEF.md`
(all 359 lines: the three options, the recommendation, the open questions);
`docs/ledger/topo-a1.md` (all 106 lines: what actually landed, the deviations,
the boundaries); `docs/ledger/P4-topology-split-brief.md`;
`docs/W111_ATTRIBUTION_DESIGN_BRIEF.md` §2.3/§2.4/§5
(`:150-185,271-298`); the landed seam
`src/integrations/task-usage.ts:176-259` (`SurfaceUsageObservation`,
`surfaceUsageSink`, `TaskUsageAttributor`); `src/integrations/surface-usage-client.ts:25-39`
(`createSurfaceUsagePost`); `src/integrations/hub-http.ts:300-316,955-995`
(the `/usage/record` route + `parseSurfaceUsage`); `src/integrations/run-registry.ts:218-227,314-323,783-793`
(the separate surface journal); `src/integrations/run-controller.ts:86-89`;
`src/integrations/workflow-hub.ts:234-235`; the four wired surfaces
`src/cli/acp-tui.tsx:65-69`, `src/cli/driver-registry.ts:89`,
`src/cli/ink-tui.tsx:178`, `src/cli/web-service.ts:70-94`; the proxy
composition sites `src/integrations/acp-runtime.ts:254,330,425-427,497`,
`src/integrations/opencode-server-runtime.ts:161-166,193,258`; the egress
seam `src/integrations/egress-credential.ts:19-20,61-77`; the session factory
`src/ui/web-sessions.ts:156-194,540`; the hub proxy/relay
`src/ui/web.ts:77-112`.

## 1. The current A1 state (the exact seam and its honest boundary)

**The seam that landed.** A process-separated interactive surface computes its
own turn-boundary delta with the same arithmetic the hub lanes use
(`TaskUsageAttributor`, `src/integrations/task-usage.ts:232-258`) and posts it
through `surfaceUsageSink` (`:215-221`), which stamps a `recordedBy` provenance
string and hands the observation to `createSurfaceUsagePost`
(`src/integrations/surface-usage-client.ts:25-39`). The client reads the hub
`discovery.json` at post time and relays to the observability-only
ordinary-token route `POST /usage/record` (`src/integrations/hub-http.ts:302-316`),
which validates the stamp's mandatory `surface:` prefix and the numeric delta
shape (`parseSurfaceUsage`, `:974-995`) and appends to a **separate** surface
journal (`recordSurfaceUsage`/`surfaceUsage()`, bounded FIFO 64,
`src/integrations/run-registry.ts:218-227,314-323,789-793`). `surfaceUsage`
rides `/snapshot` beside the canonical `taskUsage`
(`src/integrations/run-controller.ts:86-89`,
`src/integrations/workflow-hub.ts:234-235`). The four process-separated
surfaces are wired (acp-tui, driver-registry, ink-tui standalone,
web-agents+web-service); ink-tui's hub-reachable monitor path is named as
having no surface-local turn boundary and publishes nothing
(`docs/ledger/topo-a1.md:44-56`).

**The honest boundary.** A1 records a **labelled surface observation**, not
hub-authoritative attribution. The posted task id is kept apart from the
canonical rollups precisely because a client-supplied task id would violate
W153's "the client never supplies attribution"
(`src/integrations/run-registry.ts:99-108,122`; the brief's §2.1 A1). The hub
does not derive the task from its own record; it trusts the surface's task id
only as an observation and never merges it. Two landed deviations make the
boundary concrete:

- **The stamp names the SURFACE, not a session.** The brief sketched
  `recordedBy: "surface:<sessionId>"`; A1 lands `surface:<surface-name>`
  (`surface:web-service`, `surface:acp-tui`, …) because **no stable session id
  exists at the composition point** where the sink is built
  (`docs/ledger/topo-a1.md:89-95`). At the web service the `WebSessionManager`
  factory is not handed the session id (`src/ui/web-sessions.ts:160,540`; the
  callback is `(agent, resumeFrom, budgetOverride)`, and the sink is built in
  `src/cli/web-service.ts:84-91` before any session identity is available);
  the TUI surfaces hold one runtime per process.
- **The hub is not the attribution authority** (the exact statement in
  `docs/ledger/topo-a1.md:84-88`). A2/C are the only options that change that.

**The sharp fact carried forward.** The ACP turn boundary is surface-local:
only the surface's runtime observes the `running → completed` edge and holds
the cumulative `metrics()` reading (`src/integrations/acp-runtime.ts:425-427`;
`src/integrations/task-usage.ts:99-141`). The hub cannot observe an
interactive surface's boundary, so every option below keeps some
surface-originated signal; they differ in what that signal carries and who owns
the attribution it feeds (`docs/P4_TOPOLOGY_SPLIT_BRIEF.md:64-70`).

## 2. Option A2 — hub-bound via a hub-issued session id

A2 keeps A1's transport and replaces the **client-supplied task id** with a
**hub-issued session id**; the hub resolves session→task from its own
registration record and writes a hub-derived record. This is the cheapest form
of the hub-owning-the-binding standard (the brief's §2.1 A2).

### 2.1 Migration deltas from A1

| Concern | A1 today | A2 delta |
|---|---|---|
| Where the session id is minted | nowhere — no session identity at the sink | the **hub** mints it (a small mint route, or mint at surface→hub registration); the surface never chooses it |
| How the surface carries it | posts `taskId` + counters + `recordedBy: surface:<surface-name>` (`src/integrations/task-usage.ts:188-195`) | posts **counters + the hub-issued session id only**; the `taskId` field is removed from the wire shape, so there is no client attribution to distrust |
| How the hub derives attribution | treats the posted task id as a labelled observation in the separate journal (`src/integrations/run-registry.ts:314-323`) | the hub holds a **session→task registration record** (new) and resolves the task from it; the write becomes a **hub-derived** record (canonical `taskUsage`, not `surfaceUsage`) |
| Session plumb-through | the factory callback has no session id (`src/ui/web-sessions.ts:160,540`) | the manager mints/obtains the hub session id **before** composing the runtime and passes it through the factory into `surfaceUsageSink` (the web-service factory at `src/cli/web-service.ts:84-91`); the TUI surfaces mint one per process |
| Stamp granularity | `surface:<surface-name>` (`docs/ledger/topo-a1.md:89-95`) | per-session granularity becomes available; `recordedBy` may stay as the surface class label beside the resolved task |
| Route auth | ordinary-token (`src/integrations/hub-http.ts:302-316`) | unchanged class; the body gains the session id and loses the task id; a new mint route (ordinary-token) |
| Journal identity | separate `surfaceUsage` journal | a hub-derived binding can write the canonical `taskUsage`; the separate surface journal either retires or stays for genuinely surface-labelled records |

### 2.2 Security / attribution delta

- **The attribution trust changes hands.** A1 trusts the surface's task id as an
  observation; A2 removes the field, so a client can never present a
  task-derived attribution at all — the hub's session→task record is the only
  source. This is the W153 resolution the topology brief named for A2
  (`docs/P4_TOPOLOGY_SPLIT_BRIEF.md:103-107`).
- **A hub-issued, single-use session id (nonce discipline) replaces a reusable
  client-chosen id** (`docs/P4_TOPOLOGY_SPLIT_BRIEF.md:114-115`). An unknown,
  stale, or foreign session id must record `unattributed`, never a guessed
  task; the mint is unforgeable and non-transferable across sessions.
- **Blast radius stays the same class.** The route remains loopback,
  ordinary-token, observability-only: no state transition, no evidence, no
  authorization. A same-UID holder could still inject counters, exactly as it
  already can on `/run/begin` (`docs/P4_TOPOLOGY_SPLIT_BRIEF.md:108-115`).
- **New surface: the mint route and the hub-side map.** Both are new state the
  hub owns; the map's lifetime across a hub restart is an open question
  (`docs/P4_TOPOLOGY_SPLIT_BRIEF.md:339-340`).

### 2.3 Cost

**A1 + small.** One mint route (or a registration add), a hub-side
session→task map, and the session id threaded through the manager→factory→sink
path (`src/ui/web-sessions.ts:160,540`; `src/cli/web-service.ts:84-91`). No new
process, no proxy change, no new credential class. Higher than A1, far below C.

### 2.4 Verification plan

- **Mint/validate pins:** an unknown/stale/foreign session id records
  `unattributed`, never a guessed task; a valid session id resolves to the
  registered task.
- **No client attribution pin:** a request body that carries a `taskId` is
  rejected (the field is gone from the schema); the hub-derived record enters
  canonical `taskUsage`, not `surfaceUsage`.
- **Distinct-bind pin:** two sessions register different tasks and their
  records never interleave or fold into each other.
- **Absence honesty:** no hub → nothing recorded; a malformed body → 400.
- **Round-trip pin:** a completed interactive turn resolves through the hub's
  own map and renders on `/snapshot`.
- Red-first pins captured verbatim before the implementation, per the repo
  discipline.

## 3. Option C — hub-owned proxy metering (hub-authoritative end-to-end)

C unifies interactive traffic onto a **hub-owned** proxy (or makes each
per-runtime proxy hub-aware) carrying a per-session id in the credential, so
the hub's proxy splits metering per session and the hub records the attribution
from its **own** read (`docs/P4_TOPOLOGY_SPLIT_BRIEF.md:154-201`). This is the
direct fix for the server-topology collapse: `opencode serve` creates ONE proxy
per serve process and every session shares it
(`src/integrations/opencode-server-runtime.ts:161-166,193,258`), and the
interactive surfaces each compose their own proxy per runtime
(`src/integrations/acp-runtime.ts:254,330,425-427,497`).

### 3.1 Migration deltas from A1 (and from A2)

| Concern | A1/A2 today | C delta |
|---|---|---|
| Proxy ownership | the surface's own per-runtime proxy (`src/integrations/acp-runtime.ts:254,497`) | a **hub-owned** proxy for interactive sessions; the runtime launch path accepts an injected `{ proxyUrl, sessionCredential }` and skips its own `createModelUsageProxy` |
| Metering read | the surface reads `proxy.metrics()` at the boundary (`:425-427`) and posts counters | the **hub** reads its own proxy's per-session metrics; the surface posts no counters |
| Credential | one constant placeholder `METERED_PLACEHOLDER_KEY` (`src/integrations/egress-credential.ts:19-20`), recognized exactly at `checkEgressCredential:61-77` | a **session-scoped** hub-minted credential; the check validates the session-scoped value and fails closed on unknown/stale/foreign |
| Attribution ownership | A1: labelled surface observation; A2: hub-derived from its session→task map | hub-authoritative end-to-end: the hub owns the metering read *and* the session→task bind; the surface supplies no numbers at all |
| Boundary signal | the surface posts counters+task (A1) or counters+session id (A2) | the surface still posts the **"turn ended for session S"** boundary event — the hub cannot see the ACP turn boundary (`src/integrations/acp-runtime.ts:425-427`); this signal carries no attribution and no counters |
| Server topology | one proxy per `opencode serve`, sessions collapse (`src/integrations/opencode-server-runtime.ts:161-166,193,258`) | the per-session split lands at the proxy: two session ids → two independent metrics |

### 3.2 The session-scoped credential

- The hub mints a credential bound to a session (and the proxy it targets), so
  the proxy attributes a request only to the session that holds the credential.
- `checkEgressCredential` must accept the hub-minted, session-scoped value in
  addition to (or instead of) the constant placeholder
  (`src/integrations/egress-credential.ts:61-77`); an unknown/stale/foreign
  value fails closed exactly as a foreign key does today
  (`src/integrations/model-usage-proxy.ts:362-378`).
- **A leaked session id must not let one session read another's metering** —
  the proxy attributes only to the credential holder
  (`docs/P4_TOPOLOGY_SPLIT_BRIEF.md:185-191`).

### 3.3 The remaining need for the surface boundary signal

C splits *metering* per session, but the W111 record is a *turn boundary*, and
the hub cannot observe an interactive ACP turn boundary (§1). So **C still
needs A's surface signal** — a narrow "turn ended for session S" event to pair
each session's delta with the active-task pointer at the right moment. That
signal is not attribution and carries no counters; but it means **C = A's
transport + a hub-owned metering/attribution split**, not a replacement for A
(`docs/P4_TOPOLOGY_SPLIT_BRIEF.md:179-184`).

### 3.4 Cost

**Medium-high.** A runtime launch-path change across every interactive surface
(`src/integrations/acp-runtime.ts:254,497`) + a hub-owned proxy + session
mint/bind + the session-scoped credential class + A's boundary route. Reuses
the server-topology insight and the existing egress seam; the client counters
disappear.

### 3.5 Verification plan

- **Per-session split pin:** two session ids → two independent proxy metrics;
  the server-topology collapse no longer occurs at one proxy.
- **Credential validation pin:** unknown/stale/foreign → unattributed, never
  folded into another session or another session's metering.
- **Boundary-signal pin:** a completed turn records one delta against the
  hub-derived task; a `failed`/`cancelled` turn records none
  (`src/integrations/task-usage.ts:198-211`).
- **End-to-end offline pin:** a surface points at the hub proxy → `/snapshot`
  shows the per-task record, derived from the hub's own metering read.
- **Egress pins unchanged:** a foreign credential still fails closed
  (`src/integrations/model-usage-proxy.ts:362-378`).
- Red-first pins captured verbatim before the implementation.

## 4. The A1 → A2 → C migration path

The steps are **additive and ordered**: each reuses the previous, so choosing a
later step does not strand the earlier one.

| Step | What it buys | What it still trusts | Relative cost |
|---|---|---|---|
| **A1 (landed)** | a working cross-process record path; the four surfaces wired; attribution labelled as a surface observation | the surface's counters *and* its task id (kept as a labelled observation) | lowest (done) |
| **A2 (next)** | the hub owns the task binding (W153 satisfied); per-session granularity replaces `surface:<surface-name>`; no client-supplied task id | the surface's **counters** (still posted) | A1 + small |
| **C (target)** | hub-authoritative **metering** end-to-end: the hub reads its own proxy per session; the server-topology collapse is fixed; the surface posts no numbers | only the surface's **boundary timing** signal (the hub cannot see the ACP edge) | medium-high |

- **A2 is the cheapest way to reach hub-authoritative attribution** and it sits
  directly on the path to C: the session id minted in A2 is the same identity
  C binds the credential to.
- **C is a superset of A**: the boundary-signal route is reused; C adds the
  hub-owned proxy and the session-scoped credential on top.

## 5. Recommendation (trade-offs stated; the DECISION is the operator's)

**Recommended: if the operator's standard is "the hub, not the client, owns
the task binding," land A2 next as the smallest step that meets it; if the
standard is "the hub owns attribution end-to-end, including the metering
read," go to C.** A1's landed boundary already states which standard it does
not meet (`docs/ledger/topo-a1.md:84-88`); this brief does not overturn the
operator's A1 choice, it names the next step from where A1 landed.

**The core trade-off.** **A2 buys hub-owned attribution cheaply but still
trusts the surface's counters; C removes that trust by giving the hub its own
per-session metering read, at medium-high cost, and still cannot see the ACP
turn boundary so it keeps A's surface signal.** B (a shared registry process)
remains not recommended: it moves the journal's single-writer authority out of
the hub daemon, the opposite of the repo's posture
(`docs/P4_TOPOLOGY_SPLIT_BRIEF.md:129-152,243-245`).

Honest caveats, stated not hidden:

- **A2 does not fix the server-topology collapse.** Only C's per-session proxy
  split fixes the one-proxy-per-`opencode serve` collapse
  (`src/integrations/opencode-server-runtime.ts:161-166,193,258`). A2 fixes
  attribution ownership, not metering granularity on that lane.
- **C still needs the surface boundary signal**, so it does not eliminate A's
  route; it narrows what the route carries (a timing event, not counters).
- **The ask path (P6) is an adjacent consumer of the same seam** and a
  cross-process usage route should be scoped so it does not silently commit the
  ask route's separate design (`docs/ledger/P4-sink-view.md:100-110`).
- **The journal eviction residual is not fixed here**
  (`docs/ledger/P4-sink-view.md:112-125`); A2/C change the writer pressure and
  need a partitioned or larger journal, a separate decision.

**The DECISION stays the operator's** (verbatim, from the recorded discipline):
the operator chooses whether A1's provenance-stamped surface observation is
sufficient, or whether the hub must own the bind (A2) and the metering (C).
Nothing in this brief chooses it. The attribution-authority standard ("is a
provenance-stamped surface record acceptable, or must the hub own the bind?")
is an operator policy question (`docs/P4_TOPOLOGY_SPLIT_BRIEF.md:276-280`).

## 6. Non-goals and named residuals

**Non-goals for this brief:**

- No code, no schema change, no test. Docs-only. `npm run lint` and
  `npm run typecheck` are **not applicable** to this change (no `src/`,
  `test/`, or build file is touched), per the docs-only posture of the W111
  brief (`docs/ledger/W111-attribution-design-brief.md:44-45`).
- No operator-level choice made silently: §5 names a recommendation with its
  trade-offs; the DECISION stays the operator's.
- No claim that the server-topology lane is covered; its missing plumbing stays
  named until an option lands.
- No change to `/run/begin`'s no-client-attribution discipline, and no
  weakening of the verifier-only class.

**Named residuals (carried from A1, unchanged here):**

| Residual | Where recorded |
|---|---|
| The webapp does not yet render the surface journal (`surfaceUsage` rides `/snapshot` only) | `docs/ledger/topo-a1.md:96-98` |
| The 64-slot journal's cross-lane eviction (interactive writers add pressure; a partitioned/larger journal is a separate decision) | `docs/ledger/P4-sink-view.md:112-125`; `docs/ledger/topo-a1.md:99-101` |
| The ask path (P6) is untouched and is not committed by this seam | `docs/ledger/topo-a1.md:102-103` |
| ink-tui's hub-reachable monitor path has no surface-local turn boundary (recorded, not invented) | `docs/ledger/topo-a1.md:51-56` |
| The per-session stamp granularity (`surface:<surface-name>`, not `surface:<sessionId>`) awaits A2/C | `docs/ledger/topo-a1.md:89-95` |
| Issue #283 stays OPEN | `docs/ledger/topo-a1.md:104-106` |
