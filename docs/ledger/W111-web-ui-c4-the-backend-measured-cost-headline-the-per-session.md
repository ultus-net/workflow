<!-- Ledger fragment: extracted from TASKS.md at line 3446 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W111 - Web-UI C4: the backend-measured cost headline + the per-session rollup + the lane-coverage disclosure (Complete - the honest slice; per-task attribution queued on the turn-boundary mechanism) (2026-09-24)

**Source:** the pain-point queue's item 9, candidate C4 (the amux
research doc), with its guard carried into the item text: cost display
never gates authorization client-side ("budget exhausted" is a hub
policy decision, not a UI disable) — the usage page is display-only and
adds no client-side disable (the budgetViolation already arrives as
DATA on /api/session).

**The exploration's design-changing facts (verbatim from the audit):**
no per-session/per-task identifier reaches the metering proxy (one
constant placeholder credential; the server-topology path collapses all
sessions into one shared proxy); hub `runUsage` is latest-turn-wins per
run; reviewer-lane and RSI-proposal-lane spend are recorded NOWHERE; no
cache fields exist (the W109 queued gap); no model labels; no
transition timestamps or attention measures. The bigger error direction
is UNDER-attribution, not double-counting — the amux attribution lesson
lands here: a rollup counting only recorded lanes would accuse the
unrecorded ones of being free.

**What landed (the honest slice, backend-measured only):**
- The usage route serves the Workflow-side facts REGARDLESS of the
  analytics key (they are this server's own measurements): (a) the
  headline — `verifiedTasks`/`totalTasks` from the kernel snapshot,
  `sessionCostUsd` from the persisted session readouts, the
  `verifiedTasksPerCostUsd` ratio only when computable, and
  `attention: "unmeasured"` stated explicitly (the run-registry
  precedent); (b) the per-session rollup table (the manager's
  `usageRollup()` — the persisted readouts only, sessions without usage
  excluded, never fabricated); (c) the attribution disclosure naming the
  UNRECORDED lanes verbatim (the amux attribution lesson: a rollup that
  counts only recorded lanes accuses the unrecorded ones of working
  off-ledger).
- The per-TASK rollup is QUEUED on its attribution mechanism
  (turn-boundary deltas paired with the active-task pointer at boundary
  time — the UsageTurnTracker pattern; the server-topology path needs
  new plumbing for per-session split). Cache-read split stays queued on
  the W109 gap; signature-dedup is moot without a persisted event
  ledger (named so the queue knows why).
- The no-key usage route now carries the Workflow-side facts alongside
  the honest analytics-unavailable reason (the W107 bare-route pin's
  no-coverage assertion is unaffected — coverage remains
  analytics-gated).

**Evidence:** red-first (the W111 route test: the headline/rollup/
attribution absent pre-change) then green — web 22, surface 29, the
step-ledger suite, the checker, and hub-runs (81/0 across the touched
files); typecheck/lint exit 0. En-route: the session registry's shape
(#sessions is an array of records) and two self-inflicted route bugs
(a hallucinated helper call) caught by the pins before any commit.

**Acceptance criteria:**
- [x] The headline is backend-measured only: verified count from the
      kernel snapshot, session cost from the persisted readouts, the
      unmeasured axes stated ("attention: unmeasured"), the per-cost
      ratio only when computable.
- [x] The per-session rollup excludes sessions without usage (never
      fabricated) and states its source.
- [x] The attribution disclosure names the unrecorded lanes — the amux
      attribution lesson applied to the metering trail itself.
- [x] The guard holds: no client-side gating added anywhere; the cost
      display is display-only.
- [x] The per-task attribution, cache-read split, and signature-dedup
      recorded as queued with their dependencies (not silently omitted).
