<!-- Ledger fragment: opened 2026-09-30 as a post-freeze record (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### W111 - The per-task attribution DESIGN brief (Complete - the design input landed; implementation is a separate later iteration, issue #283 stays OPEN) (2026-09-30)

**Source:** parked row P4 (`docs/PARKED_AND_LIMITATIONS.md:33`, GitHub issue
#283), operator-approved 2026-09-24: "turn-boundary deltas paired with the
active-task pointer at boundary time (the UsageTurnTracker pattern); the
server-topology path needs new plumbing for per-session split." The W111
honest slice (landed 2026-09-24) explicitly queued the per-task rollup with
its dependencies (`docs/ledger/W111-web-ui-c4-the-backend-measured-cost-headline-the-per-session.md:36-41`).

**What landed (the brief):** `docs/W111_ATTRIBUTION_DESIGN_BRIEF.md` — docs-only,
no code.

- **Problem + recorded mechanism restated, dated and cited:** the cumulative-
  per-proxy / latest-turn-wins `runUsage` facts and the amux under-attribution
  lesson (`docs/ledger/W111-*.md:12-21`); the `UsageTurnTracker` precedent
  restated from source (`src/ui/usage.ts:34-58`; bound at
  `src/ui/tui.tsx:144-149,179`).
- **Design:** the boundary hook lives in each host lane's turn lifecycle (the
  ACP session transition; the hub scheduler `runTurn` finally block,
  `src/cli/hub.ts:388-413`), baselining at turn start and computing the delta
  at turn end; the task pointer is read from
  `application.activeTaskId()` (`src/application/workflow.ts:412-417`), NEVER
  inferred, absent → recorded absence; the additive `TaskUsageSummary` shape
  mirrors `RunUsageSummary` (`src/integrations/run-registry.ts:43-58`) and
  carries the P12 cache fields; the no-view-side-derivation rule is the design's
  governing rule (views sum recorded entries only).
- **Server-topology split:** the missing plumbing is named — no per-session
  identifier reaches the metering proxy on that lane; one shared proxy per
  `opencode serve` process (`src/integrations/opencode-server-runtime.ts:121-122`),
  the gateway's `sessionId` exists only for permission hooks
  (`src/integrations/opencode-server-gateway.ts:29,205,222`). The candidate
  mechanics are listed as open, not chosen.
- **Dependencies' state:** P12 cache-read split LANDED (fields exist
  `src/integrations/model-usage-proxy.ts:87-88`; landing note
  `docs/ledger/W109-*.md:144-159`; the OpenAI cached-subset refinement remains
  queued); signature-dedup moot without a persisted event ledger (the dependency
  named, `docs/agents/lessons.md:248`); the server-topology split unbuilt.
- **Implementation sketch + red-first pin plan + acceptance criteria** for a
  later iteration; **five open questions** separated from the decided parts
  (task→run mapping policy, concurrency/family granularity, restart baseline
  semantics, the server-topology plumbing choice, whether the brief's iteration
  includes the event ledger).

**Evidence:** docs-only; `npm run lint` exit 0 and `npm run typecheck` exit 0
unpiped (sanity — no src/test touched). Every claim in the brief is bound to a
file:line or ledger cite read in this worktree.

**Boundaries (remains):** the implementation (boundary hook, `TaskUsageSummary`,
route/UI) is queued for a separate iteration; the server-topology per-session
split and signature-dedup stay out of scope with their dependencies named;
issue #283 stays OPEN — the design PR refs it.
