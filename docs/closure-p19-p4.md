<!-- Closure vehicle: opened 2026-09-30. Write-once — append dated supersession notes, never rewrite. -->

# Closure vehicle — P19 (issue #297) and P4 (issue #283) (2026-09-30)

**Source:** the operator's backlog review. Both parked issues remain stale-OPEN
although the implementation work landed on `origin/main`; the direct close route
is blocked for agent sessions by the workflow-guard's live-system policy (only
`WORKFLOW_GUARD_ALLOW_LIVE=1`, set before launch, overrides). This is the
merge-route vehicle: the PR's `Closes #297` / `Closes #283` footer closes both
issues on merge.

**No code, runtime, schema, or test change accompanies this record — docs-only.**
`npm run lint` and `npm run typecheck` are not applicable (no `src/`, `test/`,
or build file is touched). The durable evidence lives in the ledger fragments
and parked-table rows cited below; this file is the closure vehicle only.

Verified at closure time (read-only `gh`; worktree base `origin/main@61fe0614`,
the merge of PR #415):

```text
$ gh issue view 297 --json number,state,title
{"number":297,"state":"OPEN","title":"Parked P19: The affinity-routing implementation per the landed spec…"}
$ gh issue view 283 --json number,state,title
{"number":283,"state":"OPEN","title":"Parked P4: W111 — per-task attribution mechanism: turn-boundary deltas paired with the active-task pointer…"}
```

All six carrier merges are reachable from the worktree HEAD (which equals
`origin/main@61fe0614`):

```text
$ for c in 7799006b 65ab906c 5d72f218 77702361 61fe0614 1b076985; do
    git merge-base --is-ancestor "$c" HEAD && echo "$c REACHABLE" || echo "$c NOT reachable";
  done
7799006b REACHABLE
65ab906c REACHABLE
5d72f218 REACHABLE
77702361 REACHABLE
61fe0614 REACHABLE
1b076985 REACHABLE
```

---

## Issue #297 — P19, the affinity-routing implementation

**State at closure:** OPEN (stale; work landed). Per
`docs/AFFINITY_ROUTING_SPEC_2026-09-24.md` §8 (the implementation sketch: the
pure `affinityPin`, the one-slug narrowing, the settings axis, and the five
pins).

**Landed via PR #409** — `feat(routing): affinity-pin implementation (P19)`,
head commit `c6768cd7 feat(affinity): P19 affinity-pin narrowing + default-OFF
opt-in (#297)`, merged `2026-09-30T04:19:54Z` (merge `7799006b`):

```text
$ git log -1 --format='%H %s' c6768cd7
c6768cd7… feat(affinity): P19 affinity-pin narrowing + default-OFF opt-in (#297)
$ git log --oneline --ancestry-path c6768cd7..HEAD --merges | grep -i affinity-pin
7799006b Merge pull request #409 from ultus-net/feat/affinity-pin
```

The landed pieces:

- **`affinityPin(role, tier, configuredAliases) -> slug`** — returns the FIRST
  configured alias (restart-stable, CONFIGURED order, not resolved order).
- **The one-slug narrowing** before the `allowed_models` injection (OpenRouter
  lane only).
- **The default-OFF per-pool opt-in** (`WORKFLOW_OPENROUTER_AUTO_AFFINITY`).
- **The five pins** (determinism, DEGRADED-RESOLVER, re-pin, narrowing,
  unchanged-metering) in `test/affinity-pin.test.ts`.

**Landed via PR #414** — the independent verification record, head commit
`0b4e8117 docs(P15a): verify the as-found auto-lane downgrade + affinity re-pin
composition`, merged `2026-09-30T04:33:01Z` (merge `65ab906c`); its own body
records that it verifies "the as-found auto-lane downgrade + the affinity
re-pin composition (c6768cd7/PR #409)" with the combined focused battery at
100/100, lint + typecheck exit 0:

```text
$ git log -1 --format='%H %s' 0b4e8117
0b4e8117… docs(P15a): verify the as-found auto-lane downgrade + affinity re-pin composition
$ git log --oneline --ancestry-path 0b4e8117..HEAD --merges | grep -i p15-auto-downgrade
65ab906c Merge pull request #414 from ultus-net/feat/p15-auto-downgrade
```

**Durable records:** `docs/ledger/affinity-pin.md` (the P19 landed record,
red-first captured verbatim; green 11/11 + 70/70 across the five focused suites;
lint + typecheck exit 0 unpiped) and `docs/ledger/p15-auto-downgrade.md` (the
verification record). The parked-table row is `docs/PARKED_AND_LIMITATIONS.md`
P19 (`:48`, dated landed note 2026-09-30).

**Deferred boundary (recorded, not an open promise against #297):** the
per-role SETTINGS axis waits on W095 key-1's role→model map, which does not
exist yet — `role`/`tier` are accepted and logged, not selecting, and the
opt-in therefore rides the existing `autoLatest.aliases` per pool
(`docs/AFFINITY_ROUTING_SPEC_2026-09-24.md` §8 item 3; §9's per-role vs
per-session pin-input decision). That dependency is tracked by the W095
per-role end-to-end item, **issue #284** (Parked P5). The downstream affinity
measurement (P11, issue #290) is a separate live-run item, not part of #297's
implementation acceptance.

**Closure recommendation:** **close** — the §8 sketch's landed items (the pure
`affinityPin`, the one-slug narrowing, the default-off opt-in, and the five
pins) are implemented and the composition was independently verified; the
settings axis is a named, separately-tracked dependency, not an open promise.

---

## Issue #283 — P4, per-task attribution + the server-topology path

**State at closure:** OPEN (stale; work landed). The issue spans the
turn-boundary attribution mechanism and the server-topology split.

**Landed via PR #400** — `feat(hub): the reviewer lane's per-task sink + the
parked-table stray-line fix (P4)`, merged `2026-09-30T03:34:50Z` (merge
`5d72f218`): the reviewer ACP lane's per-task `taskUsage` sink wiring.

**Landed via PR #410** — `feat(p4): topology A1 surface-usage record path + P6
hub answer route (batch 13 carrier)`, merged `2026-09-30T04:20:13Z` (merge
`77702361`): the operator chose topology **Option A1** and the
provenance-stamped cross-process record path is built — the observability-only
ordinary-token `POST /usage/record` route validates a `TaskUsageSummary`-shaped
body plus a MANDATORY `recordedBy` provenance stamp (class-checked `surface:`
prefix) and appends to a SEPARATE surface-observation journal
(`recordSurfaceUsage`/`surfaceUsage()`, bounded FIFO 64, distinct from the
canonical `taskUsage`); a surface-supplied task id is never hub-authoritative
attribution (W153). `docs/ledger/topo-a1.md` is the landed record.

```text
$ git log -1 --format='%H %s' 77702361
77702361… Merge pull request #410 from ultus-net/feat/topo-a1
```

**Landed via PR #415** — `feat(p4): surface-usage observations in the run
detail view`, merged `2026-09-30T04:33:19Z` (merge `61fe0614`, the current
`origin/main`): the surface-usage view renders the recorded observations.
`docs/ledger/P4-surface-view.md` is the landed record.

**Landed via PR #411** — `docs: P4 A2/C topology migration decision brief`,
merged `2026-09-30T04:28:33Z` (merge `1b076985`):
`docs/P4_A2C_MIGRATION_BRIEF.md` is the next-step design input from the landed
A1 state, enumerating A2 (hub-bound via a hub-issued session id) and C
(hub-owned proxy metering) with their migration deltas, security/attribution
deltas, costs, and verification plans. `docs/ledger/P4-a2c-migration-brief.md`
is the record. The A2/C DECISION stays the operator's.

**Durable records:** the parked-table row `docs/PARKED_AND_LIMITATIONS.md` P4
(`:33`, dated notes through the topology A1 and A2/C brief, 2026-09-30) plus the
P4 ledger chain — `docs/ledger/P4-lane-wiring.md`, `P4-sink-view.md`,
`P4-interactive-sink.md`, `P4-reviewer-bind.md`, `P4-topology-split-brief.md`,
`topo-a1.md`, `P4-a2c-migration-brief.md`, `P4-surface-view.md`.

**Decision-gated residuals (recorded, not open promises against #283):** the
remaining A2/C hub-authoritative binding and the journal partitioning are named
in `docs/P4_A2C_MIGRATION_BRIEF.md` (Named residuals table, `:286-295`) and
`docs/PARKED_AND_LIMITATIONS.md` P4:

- **A2/C hub-authoritative binding** — A1 keeps the hub non-authoritative over
  surface-supplied ids (W153); A2 buys hub-owned attribution, C buys
  hub-authoritative metering. The choice is the operator's, recorded in the
  A2/C migration brief; the per-session stamp granularity
  (`surface:<surface-name>`, not `surface:<sessionId>`) awaits it
  (`docs/ledger/topo-a1.md:89-95`).
- **Journal partitioning** — the 64-slot surface journal's cross-lane eviction;
  a partitioned/larger journal remains a separate decision
  (`docs/ledger/P4-sink-view.md:112-125`, `docs/ledger/topo-a1.md:99-101`).

Other named residuals carried by the brief (webapp rendering of the surface
journal now landed via PR #415; the P6 ask path untouched; ink-tui's
hub-reachable monitor path has no surface-local turn boundary) stay as
registered boundaries. The `docs/P4_A2C_MIGRATION_BRIEF.md` §5 questions 2–5
remain open design inputs, not implementation commitments of #283.

**Closure recommendation:** **close** — the turn-boundary attribution
mechanism, the topology A1 provenance-stamped surface-observation path, the
surface-usage view, and the A2/C migration brief all landed and are reachable
on `origin/main`; the A2/C binding and journal partitioning are decision-gated
residuals recorded in the parked table and the brief.

---

## Record-completeness check

- #297 durable records:
  `docs/ledger/affinity-pin.md` + `docs/ledger/p15-auto-downgrade.md`
  + `docs/PARKED_AND_LIMITATIONS.md` (row P19) — present.
- #283 durable records: `docs/PARKED_AND_LIMITATIONS.md` (row P4) + the eight
  P4/topo ledger fragments + `docs/P4_A2C_MIGRATION_BRIEF.md` — present.
- Carrier merges `7799006b` (#409), `65ab906c` (#414), `5d72f218` (#400),
  `77702361` (#410), `61fe0614` (#415), `1b076985` (#411) — all reachable from
  `HEAD`/`origin/main`.
- The W095 role→model dependency is tracked at issue #284; the P11 affinity
  measurement is tracked at issue #290. Neither is claimed closed here.

**Records complete.** This vehicle is the merge-route closure only; the issues
close via the PR footer on merge.
