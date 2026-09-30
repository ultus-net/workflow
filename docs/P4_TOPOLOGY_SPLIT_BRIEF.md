# P4 server-topology per-session split — decision brief

**Date:** 2026-09-30 · **Status:** design INPUT only. Nothing here authorizes a
code change; the implementation is a separate later iteration, and the
operator-level choice among the options in §2 stays OPEN (the DECISION is the
operator's — §7). · **Item:** parked P4
(`docs/PARKED_AND_LIMITATIONS.md:33`, GitHub issue #283); the decided mechanism
and lane wiring are landed (`docs/W111_ATTRIBUTION_DESIGN_BRIEF.md`;
`docs/ledger/P4-lane-wiring.md`, `docs/ledger/P4-sink-view.md`,
`docs/ledger/P4-interactive-sink.md`).

**Sources read for this brief (full or cited range):** the W111 design brief
§2.4/§5 (`docs/W111_ATTRIBUTION_DESIGN_BRIEF.md:166-185,271-298`); the P4
ledger fragments (`docs/ledger/P4-interactive-sink.md`,
`docs/ledger/P4-sink-view.md`, `docs/ledger/P4-lane-wiring.md`); the W111
honest-slice ledger
(`docs/ledger/W111-web-ui-c4-the-backend-measured-cost-headline-the-per-session.md:12-21,36-41`);
`src/cli/web-service.ts` (all 109 lines); `src/ui/web-agents.ts` (all 140
lines); `src/ui/web.ts:54-198` (the hub discovery read + `hubPost` proxy);
`src/integrations/hub-http.ts:194-296` (the auth classes and the
`/run/begin|review|finish` routes); `src/integrations/run-controller.ts:25-53`;
`src/integrations/run-registry.ts:99-129` (the W153/W165 client-never-supplies
comments); `src/integrations/task-usage.ts` (all 212 lines: the
`TaskUsageAttributor`/`TaskUsageSink`/`TaskUsageSummary` seam);
`src/integrations/acp-runtime.ts:254,330,425-427,497,548-549` (per-runtime
proxy + `metrics()`); `src/integrations/opencode-server-runtime.ts:127-166,193,258`
(one proxy per `opencode serve`); `src/integrations/model-usage-proxy.ts:190-201,362-378`
(the proxy owns the upstream key, loopback-only, egress check);
`src/integrations/egress-credential.ts` (all 77 lines: the constant
`METERED_PLACEHOLDER_KEY` and `checkEgressCredential`);
`docs/ledger/W153-schedules-as-routines-with-per-schedule-run-lineage-and-orig.md:3-40`
(the origin-attribution record); `docs/agents/lessons.md:488` (the
attribution-provenance lesson).

## 1. The problem and the recorded mechanism (restated, dated, cited)

**The problem.** The W111 mechanism records a per-task `TaskUsageSummary` at a
host lane's turn boundary (`src/integrations/task-usage.ts:23-49,185-212`) into
the hub's run-registry journal. It composes only where the runtime, the active
task pointer, and the journal writer meet in ONE process. Two compositions do
not meet that condition:

1. **The process-separated interactive surfaces.** `src/cli/acp-tui.tsx`,
   `src/cli/ink-tui.tsx`, `src/cli/driver-registry.ts`, and
   `src/ui/web-agents.ts`/`src/cli/web-service.ts` each build an in-process
   `WorkflowApplication` (`src/cli/web-service.ts:57-63`) and an in-process ACP
   runtime with its **own** metering proxy
   (`src/integrations/acp-runtime.ts:254,330,425-427,497`), in a process
   separate from the hub daemon. They hold **no run registry** and there is no
   record path to the hub's journal
   (`docs/ledger/P4-interactive-sink.md:11-23,85-92`).
2. **The server topology.** The hub's `opencode serve` lane creates ONE
   metering proxy per serve process (`src/integrations/opencode-server-runtime.ts:161-166,193,258`)
   and every session it serves shares it; no per-session identifier reaches the
   proxy, so all sessions collapse into one metrics object
   (`docs/W111_ATTRIBUTION_DESIGN_BRIEF.md:166-182`).

**The recorded mechanism** is "turn-boundary deltas paired with the active-task
pointer at boundary time — the UsageTurnTracker pattern"
(`docs/PARKED_AND_LIMITATIONS.md:33`; `docs/W111_ATTRIBUTION_DESIGN_BRIEF.md:44-63`).
The pointer is never inferred and absent → a recorded absence
(`src/integrations/task-usage.ts:42-62,116,140`).

**The sharp fact this brief adds.** The *boundary* is surface-local: only the
surface's ACP runtime observes the `running → completed` session edge and holds
the cumulative `metrics()` reading (`src/integrations/acp-runtime.ts:425-427`;
`src/integrations/task-usage.ts:99-141`). The hub cannot see an interactive
surface's ACP turn boundary. Therefore **every** option below needs *some*
surface-originated signal; the options differ in what that signal carries and
who owns the attribution it feeds.

## 2. The options

### 2.1 Option A — cross-process record path (the surface posts deltas to a hub route)

The interactive surface computes the boundary delta locally (it already can:
`TaskUsageAttributor` + `runtime.metrics?.()` +
`application.activeTaskId()`), then POSTs it to a new hub authority route
(e.g. `POST /usage/record`). The hub appends it to the same `recordTaskUsage`
journal the scheduler/RSI/reviewer lanes write, which `/snapshot` already
projects (`src/integrations/run-controller.ts:76-81`).

The transport precedent already exists: the web service reads the hub's
`discovery.json` and forwards ordinary-token POSTs through `hubPost`
(`src/ui/web.ts:76-112`); the browser "never holds a hub token" and the hub
"stays the single writer" (`src/ui/web.ts:54-61`). The TUI surfaces would need
the same discovery read (they do not hold it today).

- **Constraints.** Loopback-only (the hub listens on `127.0.0.1`,
  `src/integrations/hub-http.ts:186-191`). The route lands in the ordinary-token
  class (`src/integrations/hub-http.ts:207-213`) — a same-UID surface class, not
  the verifier-only class, because it records observability, never evidence and
  never authorizes mutation. It must be observability-only (bounded FIFO
  journal, no state transition). The surface must run the delta arithmetic it
  already owns; no new arithmetic.
- **The W153 tension (the crux).** The `TaskUsageSummary.taskId` the surface
  would post IS attribution, and W153's recorded rule is "the client never
  supplies attribution" (`src/integrations/run-registry.ts:99-108,122`;
  `docs/agents/lessons.md:488`). Two honest resolutions, both operator choices
  (§7): **A1 (provenance-stamped)** — the record carries a surface provenance
  label (`recordedBy: "surface:<sessionId>"`) and the hub treats surface records
  as *observed-by-surface*, rendered verbatim with the provenance named, never
  silently merged with hub-authoritative rollups; **A2 (hub-derived binding)** —
  the surface posts only its own counters plus a **hub-issued session id**, and
  the hub maps session→task from a hub-side registration record (an add the hub
  does not have today). A1 is smaller; A2 is the only form where the hub, not
  the client, owns the attribution.
- **Security deltas.** A new loopback, ordinary-token write route that accepts
  numbers. A same-UID holder could inject usage records (inflate/deflate cost),
  but that is the same blast radius the ordinary token already grants
  `/run/begin` (`src/integrations/hub-http.ts:239-273`); the route grants no new
  privilege because it never moves canonical state. Mitigations: observability-
  only + bounded journal + provenance stamp + malformed-body 400 + fail-closed
  when no hub. If A2 is chosen, a hub-issued, single-use session id (nonce
  discipline) replaces a reusable client-chosen id.
- **Cost.** Lowest of the three: one hub route, one client-side sink, the
  `TaskUsageSummary` schema already exists. No new process, no new credential
  class, no proxy change.
- **Verification plan.** (1) Route pins: auth class (ordinary token accepted,
  verifier-only routes unchanged), malformed body → 400, absent hub → the
  surface records nothing (no fabricated journal), body with a foreign provenance
  string rejected. (2) Round-trip pin: a surface sink publishing one completed
  delta lands exactly one entry in the registry's `taskUsage()` and renders on
  `/snapshot`. (3) Failed/cancelled surface turn posts nothing (the ACP honesty
  rule, `src/integrations/task-usage.ts:198-211`). (4) A1: a surface record
  renders with its provenance label and is never presented as hub-derived. A2:
  an unknown/stale session id records `unattributed`, never a guessed task.

### 2.2 Option B — a shared registry process

A long-lived registry/authority process owns the journal; the hub lanes and the
interactive surfaces both write to it over a local IPC/socket. The surfaces gain
a registry client instead of a per-process absence.

- **Constraints.** The journal's single-writer authority moves **out of** the
  hub process — the opposite of the repo's "hub stays the single writer"
  posture (`src/ui/web.ts:54-61`). Requires discovery + lifecycle + auth for the
  socket, and fail-closed behavior when it is absent. Touches every composition
  root (hub, all four surfaces, and the registry's own call sites).
- **The W153 tension.** Same as A, but the shared process *could* hold the
  session→task map authoritatively (the A2 shape) while keeping the surface
  signal narrow. That is its one structural advantage.
- **Security deltas.** A new local IPC surface with its own trust model; more
  fail-closed paths to reason about; the authority that owns mutation-adjacent
  state now spans processes, widening the TCB relative to a single hub daemon.
- **Cost.** Highest: a new process's lifecycle, discovery, credential, and a
  write-authority split, plus the journal's eviction/partition semantics
  (already a named residual, `docs/ledger/P4-sink-view.md:112-125`).
- **Verification plan.** Registry-process lifecycle (start/stop/absent →
  fail-closed), single-writer discipline pin (two writers cannot interleave a
  torn entry), cross-process integration pin (a surface write reaches the hub's
  `/snapshot` projection), and the same provenance pins as A.

### 2.3 Option C — a per-session id reaching the proxy, so the hub attributes

Unify interactive traffic onto a **hub-owned** proxy (or make each per-runtime
proxy hub-aware) carrying a per-session id in the proxy credential/header, so
the hub's proxy splits metering per session and the hub — which holds the
registry — records the attribution from its **own** read. This is the direct
fix for the server-topology collapse described in §1.2 and the same insight
applied to the interactive surfaces.

- **Constraints.** The interactive surfaces today compose their OWN proxy per
  runtime (`src/integrations/acp-runtime.ts:254,497`), point their agent at
  `proxy.url` (`:330`), and read `proxy.metrics()` (`:425-427`). Routing them at
  a hub proxy requires: the hub to run/own a proxy for interactive sessions; the
  runtime launch path to accept an injected proxy URL + a session-scoped
  credential instead of always creating its own; and the hub to mint the session
  id and hold the session→task binding. The egress discipline changes shape:
  today `METERED_PLACEHOLDER_KEY` is one constant
  (`src/integrations/egress-credential.ts:19-20`) and `checkEgressCredential`
  recognizes exactly that constant (`:61-77`); a per-session credential means the
  check must validate a hub-minted, session-scoped value (and fail closed on
  unknown/stale/foreign).
- **The W153 tension — strongest fit.** The hub never trusts a client-supplied
  task id: it attributes from its own proxy's per-session metering plus its own
  session→task bind. The surface supplies a session id (hub-minted) and, where
  needed, a boundary timing signal — not attribution.
- **The unresolved half.** Option C splits *metering* per session, but the W111
  record is a *turn boundary*. The hub cannot observe an interactive ACP turn
  boundary (§1), so C still needs a surface boundary signal (a "turn ended for
  session S" event) to pair the delta with the pointer at the right moment.
  That signal is not attribution and can be narrow; but it means **C = A's
  transport + a hub-owned metering/attribution split**, not a replacement for A.
- **Security deltas.** The hub's proxy becomes shared across processes: the
  egress boundary stays at the proxy (token-bound egress unchanged,
  `src/integrations/egress-credential.ts:10-16`), but the single constant
  placeholder becomes a session-scoped credential class; issuance and validation
  are new code. A leaked session id must not let one session read another's
  metering (the proxy must attribute only to the session that holds the
  credential).
- **Cost.** Medium-high: runtime launch-path change across the surfaces + a
  hub proxy + session mint/bind + a boundary signal (which is A's route). Reuses
  the server-topology insight and the existing egress seam.
- **Verification plan.** Proxy per-session split pin (two session ids → two
  independent metrics); credential validation pin (unknown/stale/foreign →
  unattributed, never folded into another session); a boundary-signal pin
  (a completed turn records one delta against the hub-derived task, a
  failed/cancelled turn records none); an end-to-end offline pin (surface points
  at the hub proxy → `/snapshot` shows the per-task record); and the egress
  pins unchanged (foreign credential still 403, `src/integrations/model-usage-proxy.ts:362-378`).

## 3. Constraints common to every option

| Constraint | Where it binds |
|---|---|
| **Loopback-only** | The hub, the web service, and both proxies bind `127.0.0.1` (`src/integrations/hub-http.ts:186-191`; `src/integrations/model-usage-proxy.ts:190-201`). No option may widen to a non-loopback listener. |
| **Trust boundary = same-UID loopback** | The ordinary token lives in `discovery.json` and is readable by any same-UID surface (`src/ui/web.ts:76-92`); the verifier token is separate (`src/integrations/hub-http.ts:189,204-213`). Ordinary-token routes may be observability-only; verifier-only stays reserved for consequential actions. |
| **The existing `/run/*` authority routes** | `/run/begin` accepts no client origin/work-product attribution (`src/integrations/hub-http.ts:239-273`; `src/integrations/run-controller.ts:32-35,43`); `/run/review` and `/run/finish` are verifier-only (`:207-213`). A new usage route must not weaken these. |
| **W153 — the client never supplies attribution** | `src/integrations/run-registry.ts:99-108,122`; `docs/agents/lessons.md:488`. Any option that carries a task id across the process boundary must resolve this (A1 provenance stamp, A2/B/C hub-derived binding) or it reintroduces forgeable attribution. |
| **Observability, never canonical state** | The journal is observability only (`src/integrations/run-controller.ts:76-81`); no option may let a usage record move kernel state or satisfy evidence. |
| **Bounded, un-collapsed journal** | The 64-slot shared journal's cross-lane eviction is a named residual (`docs/ledger/P4-sink-view.md:112-125`); any new writer increases that pressure and must not pretend entries are latest-per-task. |

## 4. Security deltas (summary)

- **A** — one new ordinary-token, loopback, observability-only route; no new
  privilege class; A2 needs a hub-issued session nonce. Blast radius unchanged
  from `/run/begin`.
- **B** — a new local IPC authority spanning processes; widens the TCB; the
  journal's single-writer ownership leaves the hub daemon.
- **C** — the hub's proxy becomes cross-process; a per-session credential class
  replaces the constant placeholder; the session id must be unforgeable and
  non-transferable across sessions; the egress boundary itself is unchanged.

## 5. Cost comparison

| Option | New processes | New credentials | Launch-path change | Reuse | Relative cost |
|---|---|---|---|---|---|
| A (cross-process record) | none | A1 none / A2 a session nonce | surface gains a hub POST sink | the existing `hubPost` proxy + `TaskUsageAttributor` + journal | **lowest** |
| B (shared registry) | one registry daemon/socket | IPC auth | every composition root | the journal shape only | **highest** |
| C (per-session proxy) | none (hub proxy) | session-scoped proxy credential | every interactive runtime's proxy composition | egress seam + server-topology insight | **medium-high**, and still needs A's boundary signal |

## 6. Recommendation (trade-offs stated; the DECISION is the operator's)

**Recommended: Option A, in its A1 provenance-stamped form, as the smallest
honest step — with Option C named as the target if the operator requires
hub-authoritative attribution.**

The core trade-off: **A buys a working record path cheaply but makes the
attribution a surface observation you must label as such; C is the only option
where the hub owns attribution end-to-end, but it cannot see the ACP turn
boundary and so still needs A's surface signal, at medium-high cost.** B is not
recommended: it moves the single-writer journal out of the hub daemon, the
opposite of the repo's recorded posture, for a provenance advantage C already
provides more cheaply.

Why A1 is the honest minimum:

- It reuses two landed facts exactly: the web service already relays
  ordinary-token POSTs to the hub and the browser never holds a token
  (`src/ui/web.ts:54-112`), and the boundary arithmetic already exists
  (`src/integrations/task-usage.ts:185-212`).
- Every option needs a surface-originated signal (§1), so A adds no new kind of
  trust, only a new route.
- Naming the provenance (`recordedBy: "surface:<sessionId>"`) satisfies the
  no-view-side-derivation rule: the view renders the recorded fact and its
  source, never a re-derived or hub-implied attribution.

The honest caveats, stated not hidden:

- **A1 does not make the hub the attribution authority.** If the operator's
  standard is "the hub, not the client, owns the task binding," A1 is
  insufficient and A2 (hub-issued session + hub-side bind) or C must be chosen.
  This is the operator's call, not this brief's.
- **C is a superset of A**, so choosing C later does not strand A's route: the
  boundary-signal route is reused; C adds the hub-owned proxy and the
  session-scoped credential on top.
- **The ask path is an adjacent consumer of the same seam.** The P6 ask hold is
  in-process in these surfaces and also needs a cross-process answer route
  (`docs/ledger/P4-sink-view.md:100-110`); a cross-process usage route should be
  scoped so it does not silently commit the ask route's separate design.
- **The journal eviction residual is not fixed here** (`docs/ledger/P4-sink-view.md:112-125`);
  adding the interactive writers increases cross-lane pressure and needs a
  partitioned or larger journal, a separate decision.

**The DECISION stays the operator's** (verbatim, from the recorded discipline):
the operator chooses among A1, A2, B, and C, and the attribution-authority
standard ("is a provenance-stamped surface record acceptable, or must the hub
own the bind?") is an operator policy question. Nothing in this brief chooses
it.

## 7. Implementation sketch (per option; no code in this brief)

**A1 (recommended minimum).**

- `src/integrations/hub-http.ts` — a new observability-only route
  `POST /usage/record` in the ordinary-token class: validate a
  `TaskUsageSummary`-shaped body + a non-empty `recordedBy`, append to the
  registry's journal via a new `recordTaskUsage` seam on `HubRequestContext`.
- `src/integrations/task-usage.ts` — an additive `surfaceUsageSink(post)` that
  wraps `laneTaskUsageSink` with the cross-process POST (deferred reading stays
  lazy), stamping `recordedBy`.
- `src/ui/web-agents.ts` / `src/cli/web-service.ts` / `src/cli/acp-tui.tsx` /
  `src/cli/ink-tui.tsx` / `src/cli/driver-registry.ts` — pass the surface sink
  to the runtime's `AcpRuntimeOptions.taskUsage`, reusing the web service's
  discovery read (`src/ui/web.ts:76-92`).
- `src/ui/webapp/runs-record.ts` — carry the `recordedBy` provenance through the
  `/api/runs` projection; the view renders it verbatim.

**A2.** A1 plus a hub-issued session nonce: a small mint route (or mint at
surface→hub registration), a hub-side session→task map, and a `recordedBy`
replaced by the hub's own attribution resolved from the session id.

**B.** A `src/integrations/shared-registry-*` process + client: discovery,
socket, auth, and a write path from both the hub lanes and the surfaces; the
journal's `recordTaskUsage`/`taskUsage()` move behind the process boundary with
fail-closed absence.

**C.** `src/integrations/acp-runtime.ts` — an optional injected
`{ proxyUrl, sessionCredential }` that skips its own `createModelUsageProxy`
(`:254,497`); `src/integrations/egress-credential.ts` — a session-scoped
credential decision alongside the constant placeholder
(`checkEgressCredential`, `:61-77`); `src/integrations/opencode-server-runtime.ts`
— the per-session split at the single proxy (`:161-166`); plus A's boundary
route to pair each session's boundary with the hub-derived task.

## 8. Verification plan (shared acceptance criteria)

- [ ] The chosen option records a completed interactive turn's delta into the
      hub's journal and renders it on `/snapshot`, and records nothing for a
      `failed`/`cancelled` turn.
- [ ] Attribution authority is explicit: either the record carries a
      `recordedBy` provenance label (A1) or the hub derives the task from its own
      binding (A2/C); no client-supplied task id is presented as hub-derived.
- [ ] Absence is honest: no hub → nothing recorded (never a fabricated entry);
      unknown/stale session → `unattributed` (never a guessed task).
- [ ] The existing `/run/*` authority routes and their forgeable-attribution
      pins are unchanged; the new route is loopback-only and observability-only.
- [ ] The egress boundary is unchanged: a foreign credential still fails closed
      (`src/integrations/model-usage-proxy.ts:362-378`).
- [ ] Red-first pins captured verbatim before the implementation, per the repo
      discipline.

## 9. Open questions (deliberately NOT decided here)

1. **The attribution-authority standard**: is a provenance-stamped surface
   record acceptable (A1), or must the hub own the task binding (A2/C)? This is
   the operator's policy choice and the brief's central open question.
2. **The session-identity source**: hub-minted nonce (A2/C) vs. a surface-local
   id (A1), and its lifetime across a hub restart.
3. **Option C's scope**: does the interactive traffic move onto the hub proxy
   wholesale, or only the metering split at the existing per-runtime proxies?
4. **The journal's eviction/partition fix** (the named residual,
   `docs/ledger/P4-sink-view.md:112-125`) — does it land with the new writers?
5. **The ask path**: does the same cross-process seam carry the P6 ask answer
   route, or are they deliberately separate? (Not committed here.)

## 10. What this brief does NOT do

- No code, no schema change, no test. Docs-only. `npm run lint` and
  `npm run typecheck` are **not applicable** to this change (no `src/`, `test/`,
  or build file is touched; state that rather than run them, per the docs-only
  posture of the W111 brief, `docs/ledger/W111-attribution-design-brief.md:44-45`).
- No operator-level choice made silently: §7 names a recommendation with its
  trade-offs; the DECISION stays the operator's (§6).
- No claim that the server-topology lane is covered; its missing plumbing stays
  named until an option lands.
- No change to `/run/begin`'s no-client-attribution discipline, and no weakening
  of the verifier-only class.
