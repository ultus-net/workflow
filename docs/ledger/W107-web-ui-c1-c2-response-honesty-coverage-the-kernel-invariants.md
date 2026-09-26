<!-- Ledger fragment: extracted from TASKS.md at line 3097 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W107 - Web-UI C1 + C2: response-honesty coverage + the kernel invariants panel (Complete - the amux P1 candidates landed observability-only, guards honored) (2026-09-23)

**Source:** the pain-point queue's item 8 — the amux research doc's P1
candidates C1 and C2 (docs/AMUX_RESEARCH_2026-09-23.md §6), with their
trust-boundary guards carried into the item text as the doc required:
C1's guard — the coverage metadata comes from the hub server, never
client-computed; C2's guard — invariant evaluation stays kernel-side,
and the UI may not self-derive agreement from client-observed state.

**C1 — what landed:** every `/api/usage` response now carries a
server-computed `coverage` object assembled from facts the server
already holds: the requested `days` param verbatim (`requestedDaysParam`)
plus `ignoredParams` when a value outside the whitelist was silently
coerced (the pre-change behavior: `days=14` silently became a 7-day
query — now stated), the actual queried window (ISO pair), per-source
`{rows, limit, truncated}` tells (the proxy's `metadata.truncated` was
read and then DROPPED by the handler before this), the day-
granularity availability (`queryDaily` silently returned an empty
series when the granularity was unavailable — now an explicit
`granularityAvailable: false` tell), and `creditsAvailable`. Unknown
fields stay ABSENT (never fabricated) — fakes and sources that do not
know a fact yield absent keys, and the bare (no-analytics) route
carries no coverage at all. The webapp renders the coverage line
inline beside the numbers (window · per-source rows/limits/truncation
· the empty-series tell · ignored params).

**C2 — what landed:** a pure kernel evaluator
(`src/kernel/invariants.ts` — no IO, no UI; the kernel owns task
state, transition legality, and evidence freshness) over the graph
state producing rows `{id, label, verdict: passed | failed |
could-not-discriminate, judged, failures?}` for three invariants:
`state-legality` (judged: all tasks), `verified-evidence-fresh`
(judged: verified tasks — the kernel demotes verified tasks on
mutation by construction, so the row's honest job is disclosing the
judged population: "N judged, 0 failures" is an all-clear only
because N is stated), and `evidence-record-shape` (judged: evidence
records; the FAILED branch discriminates corrupt persisted inputs).
Empty populations render could-not-discriminate — never a silent
pass. The application relays it (`WorkflowApplication.invariants()` +
`GET /api/invariants`); the webapp mounts an InvariantsPanel in the
operator's panels column rendering verdicts with the judged
population and the could-not-discriminate distinction ("judged
nothing, so it says nothing about the fleet").

**Evidence:** red-first — the kernel tests failed compile-level (the
evaluator did not exist), the webapp surface test on the missing
panel module, and web.test.ts ran 19 pass / EXACTLY the two new W107
tests failing with zero collateral; green — 64/0 across
task-graph-invariants (8) + web.test.ts (21) + webapp-surface + the
security-assurance checker (7), plus the held-out task-graph suite
9/0 and webapp-presenters unchanged; typecheck exit 0 (the branded-id
helper fixes: a test helper's parameter type intersected with a
branded id cannot accept a plain string — Omit the branded field from
the Partial instead); lint exit 0.
   CORRECTION (review round 1, 2026-09-23): this item's earlier draft
claimed the pre-change handler "dropped" the proxy's
`metadata.truncated` — FALSIFIED by the reviewer against base source:
`query()` mapped `metadata.truncated` into `AnalyticsResult.truncated`
faithfully, the base handler relayed byModel/byDay whole (truncated
inside them), and the base UI already rendered byModel truncation;
only byDay truncation went carried-but-never-rendered. The genuine
pre-change anti-patterns this iteration closed: silent days coercion
(no disclosure), silent empty series on unavailable granularity,
undisclosed limits/window, and the byDay truncated tell carried but
never rendered. Recorded as the correction, not hidden.

**Acceptance criteria:**
- [x] Every /api/usage response carries server-computed coverage;
      unknown fields absent, never fabricated; ignored params stated
      instead of silently coerced.
- [x] The coverage line renders inline beside the numbers in the
      webapp; the truncated and empty-series tells are visible.
- [x] Invariant evaluation lives in the kernel (pure); the UI relays
      and never self-derives agreement.
- [x] Every invariant row states its judged population; empty
      populations render could-not-discriminate, never a silent pass.
- [x] The C1/C2 guards from the amux doc carried into the item text
      and honored by construction.
