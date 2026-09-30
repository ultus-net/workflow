<!-- Ledger fragment: opened 2026-09-30 as the P4 topology Option A2 record (issue #283). Write-once — append dated supersession notes, never rewrite. -->

### P4 — W111 per-task attribution: hub-bound attribution via a hub-issued single-use session id (Option A2) (Landed — the hub mints the session id and resolves session→task from its OWN registration record, writing the CANONICAL `taskUsage`; the record wire carries no task id. Attribution is now hub-derived, W153 satisfied more strongly than A1's labelled observation) (2026-09-30)

**Source:** GitHub issue #283; the operator chose "A2 next, defer C"
(`docs/P4_A2C_MIGRATION_BRIEF.md` §A2; §5 leaves the operator-level choice to
the operator). Predecessor: Option A1 (`docs/ledger/topo-a1.md`) — the
provenance-stamped cross-process record path that kept a surface-supplied task
id as a labelled OBSERVATION in a separate journal.

**What landed (branch `feat/topo-a2`):**

- **The mint route.** `POST /usage/session`
  (`src/integrations/hub-http.ts`) in the ordinary-token class (never
  verifier-only): it validates a non-empty `taskId` and returns a
  hub-**minted** opaque `sessionId` from the run registry's new
  `registerSurfaceSession` — `randomBytes(16).toString("hex")`. The surface
  never chooses the id. Observability-only: no state transition, no evidence,
  no authorization. Absent capability → 404.
- **The session→task registration record.** `run-registry.ts` gains a
  hub-owned bounded (FIFO 64) session map with a 5-minute TTL. The bind is the
  hub's OWN record; the surface supplies the task only once, at mint, and the
  record write never re-supplies attribution.
- **The hub-bound record branch.** `POST /usage/record` now has two branches.
  When the body carries a `sessionId`, the hub calls the registry's new
  `consumeSurfaceSession`, which **resolves** the id to its registered task,
  **consumes** it (single-use, deleted before the write), and writes the
  CANONICAL `taskUsage` journal. An unknown/expired/already-used/spoofed id
  returns false → **400** and is never written (fail closed). A body that
  carries a `taskId` beside a `sessionId` is **rejected** (the A2 wire has no
  client attribution); the shared `parseSurfaceUsageCounters` validates the
  numeric shape and is reused by the A1 parser.
- **The A1 fallback is unchanged.** A body with **no** `sessionId` takes the
  exact A1 path (mandatory `surface:`-prefixed `recordedBy`, `taskId` observed
  into the separate surface journal). "A surface with no session id falls back
  to the labelled A1 surface observation."
- **The client.** `surface-usage-client.ts` gains
  `createSurfaceUsageSessionPost` (A2) alongside the unchanged
  `createSurfaceUsagePost` (A1): at a completed turn it mints a session id bound
  to the delta's task, then posts **only** the counters plus that id to
  `/usage/record` — the `taskId` field is dropped from the record wire. No hub →
  no mint, no record; transport/mint failure is swallowed (never thrown into a
  live turn boundary).
- **The four process-separated surfaces now attribute CANONICALLY** (each
  composes `laneTaskUsageSink(usage, createSurfaceUsageSessionPost())`):
  `src/cli/acp-tui.tsx`, `src/cli/driver-registry.ts`, `src/cli/ink-tui.tsx`
  standalone, and `src/cli/web-service.ts` (via `web-agents`). Their A1
  `surface:<name>` / `surface:web-service:<sessionId>` stamps are no longer sent
  (see deviations).
- **Hub composition.** `workflow-hub.ts` passes `runs.registerSurfaceSession`
  and `runs.consumeSurfaceSession` through the post-#330 capabilities object
  (fields, never positionals).

**The mint/resolve shape (as landed):**

```text
POST /usage/session   { taskId }                    -> 200 { sessionId }   (hub-minted, single-use, TTL 5m)
POST /usage/record    { sessionId, ...counters }    -> 200 {}              (hub resolves session->task, writes CANONICAL taskUsage, consumes id)
POST /usage/record    { sessionId, taskId, ... }    -> 400                 (A2 wire carries no client attribution)
POST /usage/record    { sessionId: unknown|used }   -> 400                 (fail closed; never canonical)
POST /usage/record    { recordedBy, taskId, ... }   -> 200 {}              (A1 fallback: labelled surface observation, unchanged)
```

**Pins (red-first):** `test/surface-usage.test.ts` gains 8 A2 pins (16 total):
a hub-minted id resolves to the registered task and writes canonical
`taskUsage` (and NOT the surface journal); an unknown/spoofed id is rejected and
never canonical; single-use is enforced (a replayed id 400s and never
double-writes); a `taskId` beside a `sessionId` is rejected; distinct sessions
bind distinct tasks and never fold; the session client mints then relays only
counters + id (taskId absent from the record wire); the session client fails
closed with no hub. The pre-existing A1 pins remain green (the fallback path).

**Evidence (verbatim):**

- Red-first, the new test against the unmodified `src`:
  `node --import tsx --test test/surface-usage.test.ts` →
  `# SyntaxError: The requested module '../src/integrations/surface-usage-client.js' does not provide an export named 'createSurfaceUsageSessionPost'`
  / `not ok 1 - test/surface-usage.test.ts` / `# tests 1 / # pass 0 / # fail 1`.
- Green: `test/surface-usage.test.ts` **16/16**. Focused battery, two batches:
  surface-usage + task-usage + web-service + e2e-web-service + web-agents +
  web-agents-endpoints + acp-runtime-agent + usage-tracker = **48/48 pass**;
  hub-snapshot + hub-runs + web.test + board-delegate + hub-run-gates =
  **77/77 pass**. **125/125 focused, 0 fail, 0 skipped.**
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Deviations from the brief's sketch, stated:**

- **The task bind originates at the surface's one-time registration, not from a
  hub-active-task read.** A hub daemon has no cross-process authority over a
  browser/TUI session's task (the A1 path already accepted the surface's task
  id as an observation for exactly this reason), so a pure "hub reads its own
  active task at mint" would mis-bind the web service's placeholder task. The
  honest A2 win is on the RECORD path: the wire carries no task id, the nonce is
  hub-minted and single-use, and the hub writes canonical attribution from its
  own record. Per-record attribution spoofing is eliminated; registration-time
  spoofing (same-UID, ordinary token) is the same class the brief already
  accepts for `/run/begin` (`docs/P4_A2C_MIGRATION_BRIEF.md` §2.2).
- **`recordedBy` is dropped from the A2 canonical record.** The canonical
  `TaskUsageSummary` carries no provenance field; adding one would change the
  canonical journal's shape, which the task forbids ("pre-existing writers
  unchanged"). The surface label therefore no longer rides the A2 path at all
  (the four surfaces' `surface:<name>` / per-session stamps are no longer sent).
  Session identity lives only in the hub's consumed session map.
- **Single-use means a mint per completed turn.** The client mints immediately
  before each record (two loopback requests per completed turn); the hub's
  session map holds at most 64 entries and expires each at 5 minutes.

**Boundaries (remains):**

- **A2 does not fix the server-topology collapse.** Only Option C's per-session
  proxy split does (`src/integrations/opencode-server-runtime.ts`); A2 fixes
  attribution ownership, not metering granularity on that lane
  (`docs/P4_A2C_MIGRATION_BRIEF.md` §5).
- **The surface's counters are still trusted** (the brief's core trade-off);
  only C gives the hub its own metering read.
- **The 64-slot canonical journal's cross-lane eviction is unchanged and the A2
  writers add pressure** — a partitioned/larger journal remains a separate
  decision (`docs/ledger/P4-sink-view.md:112-125`).
- **The ask path (P6) is untouched** and is not committed by this seam.
- **Issue #283 stays OPEN** — A2 landed; Option C (hub-owned proxy metering) and
  the server-topology per-session split remain.
