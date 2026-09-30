<!-- Ledger fragment: opened 2026-09-30 as the P4 server-topology-split decision brief (issue #283). Write-once — append dated supersession notes, never rewrite. -->

### P4 — W111 per-task attribution: the server-topology per-session split DECISION BRIEF (Complete — the design input landed; the operator's option choice stays OPEN; issue #283 stays OPEN) (2026-09-30)

**Source:** GitHub issue #283; parked row P4
(`docs/PARKED_AND_LIMITATIONS.md:33`). Predecessors: the W111 mechanism + design
brief (`docs/W111_ATTRIBUTION_DESIGN_BRIEF.md`), the lane wiring
(`docs/ledger/P4-lane-wiring.md`), the sink+view (`docs/ledger/P4-sink-view.md`),
and the interactive-sink seam (`docs/ledger/P4-interactive-sink.md`), which left
the process-separated interactive surfaces unwired because they hold no run
registry and no cross-process record path, and the server-topology per-session
split unbuilt (brief §2.4/§5 Q4).

**What landed (the brief; docs-only, no code):**
`docs/P4_TOPOLOGY_SPLIT_BRIEF.md`.

- **Problem + mechanism restated, dated and cited:** the two compositions that
  lack the record path — the in-process interactive surfaces
  (`src/cli/web-service.ts:57-63`; `src/integrations/acp-runtime.ts:254,330,425-427,497`)
  and the server topology's one-proxy-per-`opencode serve`
  (`src/integrations/opencode-server-runtime.ts:161-166,193,258`) — with the
  W111 boundary mechanism (`src/integrations/task-usage.ts:23-49,185-212`).
- **The sharp fact the brief adds:** the ACP turn boundary is surface-local;
  the hub cannot observe it, so EVERY option needs a surface-originated signal,
  and the options differ only in what that signal carries and who owns the
  attribution it feeds.
- **Three options, each with constraints, security deltas, cost, and a
  verification plan:** (A) a cross-process record path — the surface posts
  deltas to a new hub route, reusing the web service's existing token proxy
  (`src/ui/web.ts:76-112`); (B) a shared registry process — the journal's
  single-writer authority leaves the hub daemon; (C) a per-session id reaching
  the proxy so the hub attributes from its own read, which still needs A's
  boundary signal.
- **The W153 tension, foregrounded:** a surface-posted task id is
  client-supplied attribution (`src/integrations/run-registry.ts:99-108,122`;
  `docs/agents/lessons.md:488`), resolved either by a provenance-stamped record
  (A1) or by a hub-issued session id with a hub-side session→task bind (A2).
- **Common constraints table:** loopback-only, the same-UID loopback trust
  boundary and its two token classes (`src/integrations/hub-http.ts:189,204-213`),
  the `/run/*` authority routes and their forgeable-attribution pins
  (`src/integrations/run-controller.ts:32-35,43`), observability-never-state
  (`src/integrations/run-controller.ts:76-81`), and the bounded un-collapsed
  journal residual (`docs/ledger/P4-sink-view.md:112-125`).
- **Recommendation (trade-offs stated; the DECISION stays the operator's):**
  Option A1 (provenance-stamped cross-process record) as the smallest honest
  step, with Option C named as the target if the operator requires
  hub-authoritative attribution. The core trade-off: A buys a working record
  path cheaply but makes the attribution a labelled surface observation; C owns
  attribution end-to-end but cannot see the ACP boundary and so still needs A's
  signal at medium-high cost; B is not recommended (it moves the single-writer
  journal out of the hub daemon).
- **Implementation sketch per option + a shared red-first verification plan +**
  the five open questions (the attribution-authority standard, the session-id
  source, C's scope, the journal eviction fix, and the ask path).

**Evidence:** docs-only; `npm run lint` and `npm run typecheck` are **not
applicable** (no `src/`, `test/`, or build file touched). Every claim is bound
to a file:line or ledger cite read in this worktree.

**Boundaries (remains):**

- **The DECISION stays the operator's** — A1 vs A2 vs B vs C is not chosen here;
  the attribution-authority standard is an operator policy question (brief §6/§7).
- **The implementation is queued** for a separate iteration.
- **The server-topology per-session split stays unbuilt**; the missing plumbing
  is now enumerated as three options with costs, not merely named.
- **The ask path** (P6) is recorded as an adjacent consumer of the same
  cross-process seam, deliberately not committed by this brief.
- **Brief §5 Q2/Q3/Q5 and the journal eviction residual stay OPEN**; signature-
  dedup stays out with its persisted-event-ledger dependency named.
- **Issue #283 stays OPEN** — the design input landed; the operator's choice and
  the implementation remain.
