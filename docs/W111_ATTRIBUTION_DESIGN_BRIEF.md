# W111 per-task attribution — design brief

**Date:** 2026-09-30 · **Status:** design INPUT only. Nothing here authorizes
a code change; the implementation is a separate later iteration, and the
operator-level choices in §5 stay open. · **Item:** parked P4
(`docs/PARKED_AND_LIMITATIONS.md:33`, GitHub issue #283); the landed honest
slice is W111 (`docs/ledger/W111-web-ui-c4-the-backend-measured-cost-headline-the-per-session.md`).

**Sources read for this brief (full or cited range):** the P4 row
(`docs/PARKED_AND_LIMITATIONS.md:33`); the W111 ledger fragment (all 66
lines); `docs/AMUX_RESEARCH_2026-09-23.md:188-199` (the amux C4 origin and
the attribution lesson); `src/ui/usage.ts` (`UsageTurnTracker`, all 68
lines); `src/ui/tui.tsx:144-149,179`; `src/integrations/model-usage-proxy.ts`
(the `ModelUsageMetrics` shape `:67-89`, the `onUsage` seam `:168,477,522`,
the per-event recording `:452-523`); `src/integrations/run-registry.ts`
(`RunUsageSummary` `:43-58`, `recordRunUsage`/`runUsage` `:190-191`,
`:255-261`, `:707-711`); `src/integrations/run-controller.ts:99-123`;
`src/cli/hub.ts:290-326,345-414`; `src/application/workflow.ts:375-417`;
`src/integrations/opencode-server-runtime.ts:108-160`;
`src/integrations/opencode-server-gateway.ts:29,205,222`;
`src/integrations/open-model-proxy.ts:166-186`;
`docs/ledger/W109-*.md:144-160` (the P12 landing note);
`docs/agents/lessons.md:245-248`.

## 1. The problem and the recorded mechanism (restated, dated, cited)

**The problem.** The usage page can state a backend-measured cost headline and
a per-session rollup, but it cannot answer "what did this TASK cost." The W111
exploration recorded why, verbatim (`docs/ledger/W111-*.md:12-21`): no
per-session/per-task identifier reaches the metering proxy (one constant
placeholder credential; the server-topology path collapses all sessions into
one shared proxy); the hub's `runUsage` is latest-turn-wins per run; the
reviewer and RSI lanes are recorded nowhere; no cache fields existed at the
time; no model labels; no transition timestamps or attention measures. The
bigger error direction is UNDER-attribution, not double-counting: a rollup
counting only recorded lanes would accuse the unrecorded ones of working
off-ledger (`docs/ledger/W111-*.md:18-21`, the amux lesson at
`docs/AMUX_RESEARCH_2026-09-23.md:195-196`).

The W111 iteration therefore landed only the honest slice: the headline, the
per-session rollup from the persisted readouts, and the attribution disclosure
naming the unrecorded lanes. It explicitly QUEUED the per-task mechanism
(`docs/ledger/W111-*.md:36-41`).

**The recorded mechanism.** "turn-boundary deltas paired with the active-task
pointer at boundary time — the UsageTurnTracker pattern"
(`docs/ledger/W111-*.md:36-39`; the P4 row, `docs/PARKED_AND_LIMITATIONS.md:33`).

**The precedent, restated.** `UsageTurnTracker` (`src/ui/usage.ts:34-58`) is a
deterministic, side-effect-free state machine over the session lifecycle:
a transition INTO `"running"` captures a baseline of the cumulative counters
(`:45-46`); a transition INTO `"completed"` computes the turn delta as
`current − baseline` (`:48-53`); `"failed"`/`"cancelled"` end the turn but
publish NO delta — "a partial bill is not an honest per-turn figure"
(`:28-31`, `:47-55`). The tracker's own doc says the cumulative-per-proxy
figures are what the metering proxy records and that per-turn figures are
computed at turn boundaries (`src/ui/usage.ts:4-7`). It is bound live into the
TUI header (`src/ui/tui.tsx:144-149,179`).

The precedent is deliberately only that: it computes a DISPLAY delta in one
surface, pairs no task, and persists nothing. W111 is the same boundary
arithmetic moved server-side, paired with the kernel's task identity, and
RECORDED.

## 2. The design

The design rule that governs everything below is the repo's recorded-only
discipline: **the server records the attribution; views render recorded facts
and never re-derive them.** This is the no-view-side-derivation rule. The TUI's
`UsageTurnTracker` derivation is the surface-local exception that predates the
rule; the per-task rollup must NOT follow it — a route that subtracts
cumulative counters is exactly the class of "self-derive agreement from
client-observed state" the amux C4 guard rejects
(`docs/AMUX_RESEARCH_2026-09-23.md:174-175`).

### 2.1 Where the boundary hook lives

There are two host lanes, and the boundary hook belongs in each lane's own
turn lifecycle — never in a surface.

| Lane | Boundary signal today | Where the hook composes |
|---|---|---|
| ACP / interactive TUI | session-state transitions observed by the UI (`src/ui/tui.tsx:179`; the state machine `running → completed`) | the ACP runtime's session lifecycle (`src/integrations/acp-runtime.ts`), as a subscriber alongside the existing reasoning-claim subscriber (`src/cli/hub.ts:366-368`) |
| Hub scheduler run | `runtime.session.submit(prompt)` resolves; the turn's `runtime.metrics?.()` is read at turn end (`src/cli/hub.ts:379,394-411`) | the scheduler's `runTurn` finally block (`src/cli/hub.ts:388-413`) |

Both lanes already own the right moment: at turn end the runtime has not yet
been disposed, and `runtime.metrics?.()` is the cumulative-per-proxy reading
(`src/cli/hub.ts:394-397`). The hook takes a baseline when the turn STARTS
(the `submit` / session-`running` edge) and computes the delta when it
COMPLETES (the `submit` resolution / session-`completed` edge), mirroring
`UsageTurnTracker.observe` exactly (`src/ui/usage.ts:43-56`).

The ACP interactive lane is the harder one: on a single long-lived runtime a
session runs many turns, so the boundary is the session state transition, not
process scope. The hub scheduler lane is process-scoped per turn today (a fresh
runtime per `runTurn`), so its "delta" is already the whole turn's metrics —
the pairing step adds the task pointer and a recorded shape, not the
arithmetic.

### 2.2 Reading the active-task pointer at boundary time

The pointer is read from the kernel-backed application: `application.activeTaskId()`
(`src/application/workflow.ts:412-417`). It is authoritative and throws when no
task is active or the active task is not `IN_PROGRESS` (`:413-416`) — the
design uses that throw as the signal for an UNATTRIBUTED delta, never as a
prompt to guess.

- **Never inferred.** The pointer is not derived from the prompt text, the
  run title, the open worktree, or the most recent task transition. It is the
  exact kernel state at boundary time. This is the same "never inferred" rule
  the run lanes already follow: `run-controller.ts:117` composes
  `taskId: fixedTaskId ?? (() => application.activeTaskId())` as a lazy read.
- **Where the application instance comes from.** In the hub scheduler lane,
  `runApplication = handles.resolve(workspace, runId)` (`src/cli/hub.ts:354`)
  yields a per-run application whose interactive task was activated at begin;
  in the ACP lane the surface already holds a `TaskCommandPort` wrapping the
  application's `activeTaskId()` (`src/application/task-commands.ts:40,59,162-164`).
- **Absent pointer → recorded absence.** When `activeTaskId()` throws, the
  delta is recorded with an explicit unattributed marker (the run-registry
  precedent of naming absence rather than fabricating a value —
  `src/integrations/run-registry.ts:67-72`). This is what keeps the amux
  under-attribution failure from recurring: unattributed spend is stated, not
  silently folded into an arbitrary task.

### 2.3 Computing and attributing the delta

At the boundary, for the active task `T`:

1. baseline `B` = the cumulative metrics captured when the turn started;
2. current `C` = `runtime.metrics?.()` at turn end (`ModelUsageMetrics`,
   `src/integrations/model-usage-proxy.ts:67-89`);
3. delta `D = C − B` per field, floored at zero (the `Math.max(0, …)` the
   precedent uses, `src/ui/usage.ts:50-51`);
4. append/record `{ taskId: T, ...D, recordedAt }` in a task-usage registry.

The recorded shape is ADDITIVE and mirrors `RunUsageSummary`
(`src/integrations/run-registry.ts:43-58`) field-for-field, including the P12
cache fields:

```text
TaskUsageSummary {
  readonly taskId: string;            // the kernel TaskId at boundary time, or the unattributed marker
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly cacheReadTokens: number;   // P12, rides the delta (model-usage-proxy.ts:87-88)
  readonly cacheCreateTokens: number; // P12
  readonly recordedAt: string;
}
```

Delta semantics carry the precedent's honesty rules forward: `failed`/`cancelled`
publish no delta (`src/ui/usage.ts:47-55`); the OpenAI chat-completions lane's
cache fields stay at their measured zero (the recorded lane asymmetry,
`src/integrations/model-usage-proxy.ts:75-89`).

**Recorded-only / no view derivation.** The task rollup the usage page later
renders is the sum of recorded `TaskUsageSummary` entries, exactly as the
per-session rollup sums persisted readouts today (`src/ui/web-sessions.ts:219`;
`src/ui/web.ts:382-391`). No route, component, or surface recomputes a delta
from cumulative counters. A task with no recorded entry renders as an absence,
never as zero spend.

### 2.4 The per-session server-topology split — the missing plumbing

The recorded failure is concrete: the server topology creates ONE metering
proxy per `opencode serve` process and every session it serves shares it
(`src/integrations/opencode-server-runtime.ts:121-122`, a single
`createProxy(...)` whose `metadata` is read process-wide). Requests from the
contained `opencode serve` to the model endpoint carry no session identity, so
all sessions collapse into one metrics object
(`docs/ledger/W111-*.md:13-15`).

**The missing plumbing, named:** there is no per-session identifier at the
metering boundary on the server-topology lane. The gateway knows a `sessionId`
for its permission hooks (`src/integrations/opencode-server-gateway.ts:29,205,222`),
but model traffic does not flow through that hook, and the proxy is not
session-aware. Until a session identifier reaches the proxy (or the proxy is
instantiated per session), the server-topology lane cannot split per session,
and per-task attribution on that lane is buildable only after this plumbing.

The candidate mechanics are recorded as open in §5; this brief does not choose
between them.

## 3. The dependencies' current state

### 3.1 The cache-read split (P12) — LANDED; W111 just has to carry it

P12 closed the W109 cached-token metering-fields gap: `ModelUsageMetrics`
carries `cacheReadTokens`/`cacheCreateTokens` first-class
(`src/integrations/model-usage-proxy.ts:87-88`), the anthropic lane meters them
from the values it already parsed (never re-derived, `:501-523`), and they sum
through the pool aggregate (`src/integrations/open-model-proxy.ts:166-186`),
the runtime aggregate, the hub's per-run `RunUsageSummary`
(`src/integrations/run-registry.ts:55-56`), both turn-end recordings
(`src/cli/hub.ts:319-320,407-408`), and the timeline. The dated landing note is
`docs/ledger/W109-*.md:144-159`.

**What remains for W111:** the per-task delta must carry the same two fields
(the additive shape in §2.3 does). The still-queued REFINEMENT is the
OpenAI-lane cached-subset split (`prompt_tokens_details`) —
`src/integrations/model-usage-proxy.ts:83-85`, restated at
`docs/ledger/W109-*.md:154-157` — which is a prerequisite for attributing the
OpenAI lane's cache reads per task, not for the mechanism itself.

### 3.2 Signature-dedup — moot without a persisted event ledger

The amux C4 origin lists "signature dedup (restarts don't double-count)"
(`docs/AMUX_RESEARCH_2026-09-23.md:188-191`). The recorded reason it is moot:
"a signature-dedup requirement is CREATED by introducing an event ledger —
record why a queued concern is moot today (no persisted trail exists to dedup)"
(`docs/agents/lessons.md:248`). Today the metering model is aggregate mutable
counters (`src/integrations/model-usage-proxy.ts:126-136`), not an event log;
there is nothing to dedup until a persisted per-event ledger exists. **Named
dependency: a persisted per-event usage ledger** (events carrying a signature),
which is NOT part of the W111 design and must not be invented by it.

### 3.3 The server-topology split

Missing plumbing, named in §2.4. This is the one dependency that is genuinely
unbuilt and lane-specific.

## 4. Implementation sketch (for a later iteration — no code here)

**Files (additive unless noted):**

- `src/integrations/run-registry.ts` — add `TaskUsageSummary`, `recordTaskUsage`,
  `taskUsage()` mirroring the `runUsage` trio (`:43-58,190-191,255-261,707-711`),
  with the same bounded-FIFO discipline (`:258-261`). Alternative: a new
  `src/integrations/task-usage-registry.ts` if the run registry should not grow.
- `src/cli/hub.ts` — the scheduler-lane boundary hook in `runTurn`'s finally
  block (`:388-413`), reading `runApplication.activeTaskId()` at the same
  moment the run usage is recorded today (`:394-411`).
- `src/integrations/acp-runtime.ts` — the interactive-lane baseline/delta
  around the session lifecycle (the acceptance point for the `running`/
  `completed` edges; keep the arithmetic pure and testable, as
  `UsageTurnTracker` is, `src/ui/usage.ts:31-32`).
- `src/ui/web.ts` / `src/ui/webapp/usage-view.tsx` — render recorded
  `TaskUsageSummary` entries; no derivation (`src/ui/web.ts:382-391` is the
  per-session precedent to extend).

**Pin plan (red-first), following the repo discipline:**

1. Red: a `TaskUsageSummary` with an active task is absent before the change
   (the new route/registry field), and the delta equals `current − baseline`
   once the hook lands.
2. Red: a `failed`/`cancelled` turn records NO delta (mirror
   `src/ui/usage.ts:47-55`).
3. Red: no active task → the recorded entry is an explicit unattributed
   absence, never a guessed task id.
4. Red: the view renders only recorded entries; a task with no entry is absent,
   never zero.
5. Hold-out: the OpenAI lane's cache fields stay zero on the delta (lane
   asymmetry unchanged).

**Acceptance criteria:**

- [ ] The boundary hook composes in both the ACP and hub-scheduler lanes at the
      turn edge, and only there; the arithmetic is pure and unit-testable
      without a live proxy.
- [ ] The task pointer is the exact `application.activeTaskId()` at boundary
      time; absent → recorded absence, never inferred.
- [ ] The recorded shape carries the P12 cache fields through the delta.
- [ ] The view derives nothing: it sums recorded entries and renders absences.
- [ ] `failed`/`cancelled` publish no delta.
- [ ] The server-topology per-session split is either built or explicitly
      excluded with the missing plumbing named (no silent coverage claim).

## 5. Open questions (decisions a design review or the operator must make)

These are OPEN and deliberately not decided here.

1. **Task→run mapping policy.** The run lanes auto-activate an interactive task
   on every begin, and that activation is deliberately unattributed because the
   site cannot know its actor (`src/application/workflow.ts:399-405`). Should a
   scheduled run's spend attribute to that auto-activated interactive task, or
   to the run's own `run:<id>` task (`src/cli/hub.ts:355`)? This is an
   operator-level attribution-policy choice.
2. **Multiple concurrent turns / one proxy.** The open-model pool runs one
   proxy PER FAMILY (`src/integrations/open-model-proxy.ts:123-186`), so a
   single session's traffic can land on several proxies; and the ACP lane can
   interleave turns. Is per-task attribution expected to be exact under
   concurrency, or is the honest output a per-(task, proxy) record summed with
   the family granularity residual stated? (The W118 residual is the recorded
   precedent, `src/integrations/model-usage-proxy.ts:193-196`.)
3. **Restart / baseline epoch semantics.** Metered counters are per-process and
   the persisted readout is merged with a baseline on restart
   (`src/ui/web-session-channel.ts:25-41`). How does a task's baseline behave
   across a hub restart mid-turn?
4. **The server-topology plumbing choice** (§2.4): per-session proxy instance,
   gateway-injected session header consumed by a session-aware proxy, or the
   opencode server's own per-session stats. Each has a different cost and
   trust boundary; the choice is not made here.
5. **Does W111 also introduce the persisted event ledger?** Signature-dedup
   depends on it (§3.2). If not, signature-dedup stays explicitly out of scope
   with the dependency named.

## 6. What this brief does NOT do

- No code, no schema change, no test.
- No operator-level attribution policy chosen silently (all in §5).
- No claim that the server-topology lane is covered; its missing plumbing is
  named.
- The per-task rollup and signature-dedup remain queued; issue #283 stays open.
