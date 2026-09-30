<!-- Ledger fragment: opened 2026-09-30 as the P4 topology Option A1 record (issue #283). Write-once — append dated supersession notes, never rewrite. -->

### P4 — W111 per-task attribution: the provenance-stamped cross-process record path (Option A1) (Landed — a process-separated surface's boundary delta reaches the hub's journal as a provenance-stamped OBSERVATION; the hub-authoritative binding (A2/C, §5 Q4) stays OPEN) (2026-09-30)

**Source:** GitHub issue #283; the operator chose topology Option A1
(`docs/P4_TOPOLOGY_SPLIT_BRIEF.md` §2.1/§6/§7). Predecessors: the W111
mechanism (`docs/W111_ATTRIBUTION_DESIGN_BRIEF.md` §2.3), the lane wiring
(`docs/ledger/P4-lane-wiring.md`), the sink+view
(`docs/ledger/P4-sink-view.md`), and the interactive-sink seam
(`docs/ledger/P4-interactive-sink.md`), all of which left the four
process-separated interactive surfaces unwired because they hold no run
registry and no cross-process record path.

**What landed (branch `feat/topo-a1`):**

- **The observability-only hub route.** `POST /usage/record`
  (`src/integrations/hub-http.ts`) in the ordinary-token class (never
  verifier-only): it authorizes like `/run/begin`, validates a
  `TaskUsageSummary`-shaped body plus a mandatory `recordedBy` provenance
  stamp, appends to the run registry's SEPARATE surface journal, and returns
  `{}`. It grants no new privilege: no state transition, no evidence, no
  authorization — observation only. Absent capability → 404 (withheld, never
  faked); malformed body → 400.
- **The provenance stamp is mandatory and class-checked.** `recordedBy` must
  carry the `surface:` prefix, so a client can never claim a `hub`-class
  attribution. The posted task id is stored as a labelled surface OBSERVATION,
  never merged into the canonical `taskUsage` rollups (the W153
  client-never-supplies-attribution principle).
- **A separate surface journal.** `run-registry.ts` gains
  `recordSurfaceUsage`/`surfaceUsage()` backed by its own bounded (FIFO 64)
  append journal, distinct from `recordTaskUsage`/`taskUsage()`. `gateObservability`,
  `/snapshot`'s `gateObservability` and `runs` blocks, and the controller type
  (`run-controller.ts`) carry `surfaceUsage` beside `taskUsage`; the hub
  composition (`workflow-hub.ts`) passes `runs.recordSurfaceUsage` as a bridge
  capability (the post-#330 field extension point, never a positional).
- **The surface sink + client.** `task-usage.ts` gains
  `SurfaceUsageObservation`/`SurfaceUsageSummary` and `surfaceUsageSink(usage,
  recordedBy, post)` — `laneTaskUsageSink` plus the provenance stamp. The new
  `surface-usage-client.ts` `createSurfaceUsagePost` reads the hub
  `discovery.json` (the shared `hub-discovery.ts` read, now also used by
  `web.ts`'s proxy) at post time and relays the observation; no hub → nothing
  recorded, and a transport failure is swallowed (never thrown into a live turn
  boundary).
- **The four process-separated surfaces wired** (each computes its own boundary
  delta via the existing `TaskUsageAttributor` and posts it):
  - `src/cli/acp-tui.tsx` → `surface:acp-tui`
  - `src/cli/driver-registry.ts` → `surface:driver-registry`
  - `src/ui/web-agents.ts` + `src/cli/web-service.ts` (the web service composes
    the sink per session) → `surface:web-service`
  - `src/cli/ink-tui.tsx` standalone runtime → `surface:ink-tui`
- **The no-signal surface named (not invented).** `ink-tui`'s
  hub-reachable path is a pure monitor over the hub's `/snapshot` and composes
  no ACP runtime of its own, so it has no surface-local turn boundary to
  publish; its standalone runtime is wired, but the standalone case is
  precisely the no-hub case the client fails closed on. This is recorded, not
  papered over.

**Pins (red-first):**

- `test/surface-usage.test.ts` (8 new pins): a posted delta is recorded as a
  provenance-stamped surface observation; a spoofed task id lands in the
  surface journal and NEVER the canonical `taskUsage`; the stamp/class prefix
  and the delta shape are validated (400) and nothing malformed is recorded;
  the withheld capability 404s; `/snapshot` projects the surface journal with
  its stamp beside the canonical lane; `surfaceUsageSink` stamps `recordedBy`;
  the client fails closed with no hub and relays to a discovered hub.

**Evidence (verbatim):**

- Red-first, `src/` stashed against the new test:
  `node --import tsx --test test/surface-usage.test.ts` →
  `# SyntaxError: The requested module '../src/integrations/task-usage.js' does not provide an export named 'surfaceUsageSink'`
  / `not ok 1 - test/surface-usage.test.ts` / `# tests 1 / # pass 0 / # fail 1`.
- Green after the implementation: `test/surface-usage.test.ts` 8/8.
- Focused battery, run in two batches: surface-usage + task-usage +
  web-service + e2e-web-service + web-agents + web-agents-endpoints +
  acp-runtime-agent + usage-tracker = **40/40 pass**; hub-snapshot + hub-runs +
  web.test + board-delegate + hub-run-gates = **77/77 pass**. **117/117
  focused, 0 fail, 0 skipped.**
- `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Boundaries (remains):**

- **The hub is not the attribution authority.** A1 records a labelled surface
  observation; Option A2 (hub-issued session nonce + hub-side session→task
  bind) and Option C (per-session id reaching the hub's proxy) stay OPEN — only
  they make the hub own the binding (`docs/P4_TOPOLOGY_SPLIT_BRIEF.md` §2.1 A2,
  §2.3, §5).
- **Deviation from the brief's stamp shape, stated:** the brief sketched
  `recordedBy: "surface:<sessionId>"`; this lands `surface:<surface-name>`
  (`surface:web-service`, `surface:acp-tui`, …) because no stable session id
  exists at the composition point where the sink is built (the web service's
  `WebSessionManager` factory is not handed the session id; the TUI surfaces
  hold one runtime per process). The provenance names the SURFACE, which is the
  labelling requirement; per-session granularity awaits A2/C.
- **The webapp does not yet render the surface journal.** `surfaceUsage` rides
  `/snapshot`'s gate-observability and runs blocks (projection complete); a
  dedicated webapp view was not added in this slice.
- **The 64-slot journal's cross-lane eviction residual is unchanged**
  (`docs/ledger/P4-sink-view.md:112-125`) and the interactive writers add
  pressure; a partitioned/larger journal remains a separate decision.
- **The ask path (P6) is untouched** — this route does not commit its separate
  cross-process design (`docs/P4_TOPOLOGY_SPLIT_BRIEF.md` §6 caveat).
- **Issue #283 stays OPEN** — the record path now exists and is wired, but the
  hub-authoritative attribution choice and the server-topology per-session
  split remain.
