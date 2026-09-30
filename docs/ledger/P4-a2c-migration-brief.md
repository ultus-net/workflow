<!-- Ledger fragment: opened 2026-09-30 as the P4 topology A2/C migration decision brief (issue #283). Write-once — append dated supersession notes, never rewrite. -->

### P4 — W111 per-task attribution: the topology A2/C MIGRATION decision brief (Complete — the design input landed; the operator's A1→A2→C choice stays OPEN; issue #283 stays OPEN) (2026-09-30)

**Source:** GitHub issue #283; the successor to the topology-split brief
(`docs/P4_TOPOLOGY_SPLIT_BRIEF.md`) after Option A1 landed
(`docs/ledger/topo-a1.md`). Predecessors: the W111 mechanism
(`docs/W111_ATTRIBUTION_DESIGN_BRIEF.md` §2.3/§2.4/§5), the lane wiring
(`docs/ledger/P4-lane-wiring.md`), the sink+view (`docs/ledger/P4-sink-view.md`),
the interactive-sink seam (`docs/ledger/P4-interactive-sink.md`), and A1
(`docs/ledger/topo-a1.md`).

**What landed (the brief; docs-only, no code):**
`docs/P4_A2C_MIGRATION_BRIEF.md`.

- **The current A1 state and its honest boundary, restated with the exact
  seam:** `surfaceUsageSink` (`src/integrations/task-usage.ts:215-221`) →
  `createSurfaceUsagePost` (`src/integrations/surface-usage-client.ts:25-39`) →
  the ordinary-token `POST /usage/record`
  (`src/integrations/hub-http.ts:302-316`, `parseSurfaceUsage:974-995`) → the
  separate surface journal (`src/integrations/run-registry.ts:314-323`), with
  the two landed deviations named (the stamp names the SURFACE, not a session,
  because no stable session id exists at the sink's composition point —
  `src/ui/web-sessions.ts:160,540`; the hub is not the attribution authority).
- **A2 (hub-bound via a hub-issued session id):** the concrete deltas from A1 —
  where the id is minted (the hub), how the surface carries it (counters + the
  hub-issued session id only; the `taskId` field is removed from the wire
  shape), how the hub derives attribution from its own session→task
  registration record (the canonical `taskUsage`, not `surfaceUsage`), the
  session plumb-through through the `WebSessionManager` factory; the
  security/attribution delta (W153 satisfied, single-use nonce, unknown/stale →
  `unattributed`, same loopback ordinary-token blast radius); cost (A1 + small);
  and the verification plan.
- **C (hub-owned proxy metering, hub-authoritative end-to-end):** the deltas —
  the runtime launch path accepts an injected `{ proxyUrl, sessionCredential }`
  and skips its own `createModelUsageProxy`
  (`src/integrations/acp-runtime.ts:254,497`); the session-scoped credential
  replaces the constant placeholder
  (`src/integrations/egress-credential.ts:19-20,61-77`); the server-topology
  one-proxy-per-`opencode serve` collapse is fixed at the proxy
  (`src/integrations/opencode-server-runtime.ts:161-166,193,258`); the
  remaining need for the surface boundary signal (the ACP turn boundary is
  surface-local — `src/integrations/acp-runtime.ts:425-427` — so C still needs
  A's signal, narrowed to a timing event, not counters); cost (medium-high);
  and the verification plan.
- **The A1→A2→C migration path** and what each step buys: A1 landed (a working
  record path, attribution labelled); A2 (the hub owns the task binding, no
  client-supplied task id, per-session granularity); C (hub-authoritative
  metering end-to-end, the server-topology split fixed, the surface posts no
  numbers). The steps are additive; C is a superset of A.
- **Recommendation (trade-offs stated; the DECISION stays the operator's):**
  A2 next if the standard is "the hub owns the binding"; C if the standard is
  "the hub owns the metering read." Core trade-off: **A2 buys hub-owned
  attribution cheaply but still trusts the surface's counters; C removes that
  trust by giving the hub its own per-session metering read, at medium-high
  cost, and still cannot see the ACP turn boundary so it keeps A's surface
  signal.** B remains not recommended.
- **Non-goals:** no code/schema/test; docs-only (`npm run lint` /
  `npm run typecheck` **not applicable**); no silent operator choice; no
  server-topology coverage claim; no weakening of `/run/begin` or the
  verifier-only class.
- **Named residuals carried from A1, unchanged:** the webapp view of the
  surface journal; the 64-slot journal's cross-lane eviction; the untouched ask
  path (P6); ink-tui's no-signal monitor path; the per-session stamp
  granularity; issue #283 stays OPEN.

**Evidence:** docs-only; `npm run lint` and `npm run typecheck` are **not
applicable** (no `src/`, `test/`, or build file touched). Every claim is bound
to a file:line or ledger cite read in this worktree.

**Boundaries (remains):**

- **The DECISION stays the operator's** — A1 vs A2 vs C is not chosen here; the
  attribution-authority standard and the metering-authority standard are
  operator policy questions (brief §5).
- **The implementation is queued** for a separate iteration.
- **The server-topology per-session split stays unbuilt** until C (or an
  equivalent) lands.
- **The ask path** (P6) is recorded as an adjacent consumer of the same seam,
  deliberately not committed.
- **Issue #283 stays OPEN** — the design input landed; the operator's choice and
  the implementation remain.

> **Dated correction (2026-09-30, branch `feat/harvest-8`): the recorded
> line-cite P3s are acknowledged; constructs all resolved, numbers have since
> drifted.** The five-axis review of `feat/p4-a2c-brief` recorded three
> non-material P3s: a few file:line cites were off by 1-3 lines. Verified
> against this worktree, all three resolve to the correct construct:
> - `surfaceUsageSink` — cited here as `src/integrations/task-usage.ts:215-221`
>   (and in the brief); the function now spans `:233-239` (the ~15-line drift is
>   from the later `feat/p4-surface-view` `surfaceStamp` addition above it).
> - `METERED_PLACEHOLDER_KEY` — cited `:19-20`; it is defined at
>   `src/integrations/egress-credential.ts:20` (the cite's range includes it).
> - the W111 docs-only cite `:44-45` — the `Evidence: docs-only` line is at
>   `docs/ledger/W111-attribution-design-brief.md:46`.
> The write-once body above is left as authored (append-only convention); these
> lines are the correction. No code or pin changed.
