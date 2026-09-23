# amux research: the control-plane comparison and the web-UI enhancement
# candidates for Workflow (W103 research)

**Date:** 2026-09-23 · **Status:** research recorded; the enhancement
candidates are QUEUED as proposal material — none are implemented or
directed yet · **Subject:** https://github.com/mixpeek/amux (492 stars,
~6,069 commits at fetch, MIT + Commons Clause, single Rust binary) ·
**Author:** RSI base-loop session (ses_f34e91c77ffekcRQkQKPCf5nLZ),
operator-directed ("a full deep research task… pillage some of their
ideas especially how we can enhance our webui for the control plane
itself"). Sources fetched live on 2026-09-23 (§8); the dashboard feature
inventory and enhancement list are the background research subagent's
deliverable, verified against the fetched sources. Every W-number
reference below is Workflow's own ledger; every amux reference is theirs.

## 1. What amux is

amux is "the open-source control plane for AI coding agents": one Rust
workspace (server 8824 + embedded SPA dashboard + CLI + core types),
single-writer SQLite with an event journal, SSE + delta sync, a
scheduler/orchestrator runtime. Workers are tmux sessions running Claude
Code / Codex / Gemini CLI / OpenCode / Ollama. Eight primitives: board,
workers, schedulers, filesystem, groups, memories, environment, messages.
An iOS app and PWA give phone access. The Python predecessor was fully
migrated to Rust (the boundary matrix reports `proxied: []`, asserted by
a composition test).

## 2. The deep comparison — same phrase, different layer

Both projects say "control plane for coding agents," but they mean
different layers:

| | **amux** | **Workflow** |
|---|---|---|
| Control mechanism | tmux terminal scraping — keystroke injection + screen observation; the agent is a black box | ACP wire protocol — structured, in-process composition; the hub is a protocol participant |
| Mutation authorization | None — board gates are API-level status semantics (`done` requires evidence *text*, `verified` a peer ack), advisory to the agent's real filesystem actions | Kernel-owned: legal transitions, mutation epochs, authorization fails closed, evidence freshness — the guard's deny/ask/redirect between proposal and mutation |
| Containment | None — a worker is a full-permission tmux session | Bubblewrap (enforced vs policy-only, type-level) |
| Credential custody / metering | Not present (bearer token + localhost; "never expose 8824") | Credential custody + metering proxy |
| Model's role | Owns execution end-to-end | Proposes; the deterministic authority decides |
| Self-modification | Self-pacing scheduling loops | The guarded RSI loop — self-modification inside the verified boundary |

**The convergence signal (§3 of the assessment):** amux's own README
concedes the architecture gap — "terminal scraping is the fallback, not
the plan: the `opencode` module defines the structured AgentProtocol
through which prompts, messages, cancellation, and state queries flow
directly, shrinking the scraper to a liveness check." That is Workflow's
ACP bet, stated from the other side. amux has not crossed yet (tmux is
the default backend today); Workflow's hub is already there. An
independent ~500-star project independently concluded that terminal
scraping is a dead end — third-party validation of the protocol bet.
Their gate UX also independently matches ours: "a 409 from a status gate
prints the checklist and the exact retry command instead of failing
silently" is Workflow's deny-with-redirect pattern.

## 4. The amux dashboard feature inventory (the pillage surface)

The developer dashboard is a single-page PWA served from the Rust binary;
a second React surface (business-ui) at `/business/` is a plain-language
operator view over the same server. Grouped:

- **A1 Fleet view**: one card per session — live status dot, last-output
  snippet, current token spend, the active task from the agent's plan
  strip; SSE (~2s) with a 10s heartbeat, clients stale after 18s and
  force-reconnect; refetch on focus if data >4s old; bulk "stop all idle
  agents" / "restart all errored"; iCal export of board due-dates.
- **A2 Peek panel / worker detail**: live terminal output with
  load-earlier pagination through full history; the agent's plan strip
  rendered live; a subagent transcript switcher; responsive tmux pane
  resize (measures real character width at any device size); quick-action
  chips (`/compact`, `/continue`, `/status`); saved messages replayed in
  one tap; a steering bar.
- **A3 Steering queue**: messages persist server-side, delivered at the
  NEXT TURN BOUNDARY — never mid-task (the phone-native pattern: queue a
  course-correction, put the phone away).
- **A4 Board**: kanban with drag-and-drop or tap-to-move; atomic claim
  (SQLite CAS, 409 on conflict) as claimed-by badges; auto-drain (idle
  sessions self-assign the next tagged card after `done`, pausable) with
  each `done` transition EVIDENCE-GATED (`--evidence-stdin`, else the
  board rejects the transition); custom status columns; clear-done
  archives (recoverable, returns the count); GitHub issue import; the
  per-card append-only log PATCH cannot touch; gates with resolution
  order card→type→worker→global; server-enforced reviewer identity
  (X-Amux-Session — the author cannot self-ack); staleness detection; WIP
  limit 1-in-doing.
- **A5 Memories/notes**: shared document store with a rich-text editor,
  pinned notes, trash + restore; global + per-session memory.
- **A6 Files**: explorer with syntax highlighting, markdown editor,
  drag-and-drop upload; spreadsheet preview (.xlsx rendered as sortable
  tables); the `.mdai` computed-files DAG (upstream-first resolution,
  cycle detection with honest errors, input-hash cache, run history).
- **A7 Scheduler/calendar**: plain-English recurring expressions (`daily
  at 9am`) or cron; view/edit/PAUSE/delete; manual trigger; a calendar
  tab layering user events + scheduled tasks + board due-dates.
- **A8 Messaging**: inter-session 1:1 with @mentions; peer discovery via
  the session list.
- **A9 Alerts/phone**: owner alerts (push/email/iMessage) with a
  threshold; iOS native app; PWA with state restore before first paint
  and offline queue replay.
- **A10 Logs/metrics/health**: filterable request log with category
  badges; the log-sweep contract's API (`/api/logs/analyze` pre-grouped
  errors with verdicts and a known-benign list, `/api/logs/stats` with
  p50/p95/max + trailing norms + sampling metadata, `/api/logs/writers`
  mutation-attribution, `/api/health/invariants` with
  `status.agrees_with_pane`); per-session token spend with input/output/
  cache-read split; `/api/health` returning `commit` AND `build` (source
  changed vs same process image).
- **A11 Connectors**: paste API keys once; scope global/group/worker; a
  Test button verifying the connection before first run; agents receive
  credentials as env vars automatically.
- **A12 Browser automation**: shared Playwright browser over CDP with
  saved auth profiles, an AI-agent mode, and a server-side guard whose
  refusal text is enriched from the request log with a StartOrigin
  TRI-STATE (Found / NotFound / NotLooked — "we looked and found nothing"
  can never collapse into "we did not look").
- **A13 business-ui**: Home/Work/Approvals/Automations/Apps/Settings/Help
  over the same server, with documented boundaries: "a projection/
  transport adapter… not an execution engine or a security boundary —
  the server remains authoritative"; bounded snapshots (2,000 items) are
  "not an accounting ledger"; dollar ROI "stays unavailable until
  measured by the backend"; an approval response "means the core
  accepted the action, not that a postcondition has been verified"; a
  degraded (503) server keeps the page connected with an explicit
  warning; approvals with incomplete metadata or oversized/unrenderable
  payloads are NOT-APPROVABLE-WITH-REASON; "editing a frozen payload is
  not supported"; the surface "does not introduce a new generic
  safe-action mechanism."

## 5. Workflow's web-UI baseline (the honest inventory)

The hub webapp (`src/ui/webapp` + `web-service`/`web-launch`) is a
server-authoritative projection of the live `WorkflowApplication`: the
usage/metering pages, the tasks surface (kernel task transitions through
`/api/tasks`), the settings dialog (model routing with the per-workspace
overlay and the honest `clearsEverything` disable, MCP servers with
origin-scoped writes, capabilities), and the approvals surface
(mode/authority round-trips driven through the same-origin
trusted-mutation gate — the e2e suite asserts the authority's own state,
never local optimism). The trust posture is already correct: mutations
are server-side; the UI is a projection. What it does not yet have: a
fleet-status grid with per-run context, an evidence/invariants legibility
layer, per-task cost drill-down, a review-requirements approvals flow, a
steering/schedule surface, credential connector management with
test-before-run, or the operator-banner routing of dangerous truths.

## 6. Enhancement candidates (prioritized; each names the guard)

### P1 — evidence/metering/review legibility (highest value, lowest trust risk)

- **C1 Response-honesty metadata on every metering/query endpoint.** amux
  learned the hard way (a stale "8-day" norm that was really 35h produced
  a false 6.46× finding; a "0 5xx" all-clear covered 1.1% of traffic):
  every log/stats response carries `total_matched` (pre-limit count),
  `actual_window_h` ("read it and BELIEVE it"), `ignored_params`,
  `truncated`, `sampled`/`sample_stride`, and per-origin counts as a
  coverage tell. Proposal: make coverage metadata a required field set on
  Workflow's metering/query APIs and render it inline beside every number
  ("p95 vs an 85h norm, not 8 days"). Guard: the metadata comes from the
  hub server, never client-computed.
- **C2 "All-clear must say what it judged" invariants panel.** amux's
  `/api/health/invariants` (`status.agrees_with_pane` — a card said idle
  while the pane was mid-turn) mandates reporting pass/fail WITH the
  judged population ("3 pass, 0 fail over THREE lanes out of ~50") and
  warns that simultaneous flips across many lanes mean suspect the
  DETECTOR, not the fleet. Proposal: a Workflow invariants panel showing
  each invariant with pass/fail + judged population + source + age, and a
  rendered distinction between "could not discriminate" and "passed."
  Guard: invariant evaluation stays kernel-side; the UI may not
  self-derive agreement from client-observed state.
- **C3 Evidence-gated transitions with refusal legibility.** amux's
  auto-drain refuses `done` without evidence; VERIFY.md's mantra is
  "paste the command AND its result line," with `none: <reason>` escapes
  stored verbatim and COUNTED (an escape, not a blind spot). Proposal:
  on the tasks page, a withheld transition renders WHY (which gate in the
  resolution chain, which evidence is stale/missing) with the exact
  artifact needed, and a path to attach host-produced evidence through
  the hub's authorized flow. Guard: NEVER a UI textarea accepting
  operator/agent prose as kernel-gate evidence — Workflow's evidence must
  be environment-supplied and kernel-validated (amux's own paste model is
  claim-shaped; VERIFY.md admits it: "a command with no result is a
  claim").
- **C4 Per-task cost drill-down with cache-read split and intent-based
  attribution.** amux: per-session/day token spend with input/output/
  cache reads, model labels, signature dedup (restarts don't
  double-count), and a product metric of "verified tasks completed per
  unit of human attention, time, and cost" — NOT tokens. Proposal: the
  usage page gains per-session→per-task rollup, cache-read/retry
  visibility, and a headline aligned to that metric, backend-measured
  only. Also steal their attribution lesson: mutating METHOD ≠ WORK —
  classify writes by intent (report endpoints vs task work) or metering
  accuses idle observers of working off-ledger. Guard: cost display never
  gates authorization client-side ("budget exhausted" is a hub policy
  decision, not a UI disable).
- **C5 Approvals with full-metadata review requirements.** amux
  business-ui: incomplete metadata, oversized previews, or uninspectable
  attachments make an approval NOT-APPROVABLE-WITH-REASON (never
  approvable-with-warning); an explicit "I have reviewed the full
  payload" confirmation; one-time grants with expiry/ownership/consumption
  checks; a degraded hub keeps the page connected with a warning.
  Proposal: Workflow's approvals page renders the complete proposal
  payload with that confirmation discipline. Guard: the approval UI is a
  display-and-submission surface; no affordance bypasses the application
  layer's authority.

### P2 — fleet/operational surfaces (route everything through the kernel)

- **C6 Fleet status grid with task context and honest status semantics.**
  Session cards with status, last output, active task, SSE live; PLUS the
  Workflow differentiator amux lacks: containment mode (`enforced` vs
  `policy-only`) visible per card. amux's own AF-784 is the design
  warning — a dead pane reported `idle`/`running:true` and "the fleet is
  idle" is the one shape nobody investigates — so statuses must
  distinguish running / waiting-on-human / waiting-on-approval /
  dead-with-exit-status / stale, each labeled with its SOURCE (kernel vs
  adapter report). Guard: no presentation-side inference of "green."
- **C7 Task drawer: append-only log + gate chain + dependencies.** Per
  task: the immutable event log (who/what/when/evidence-hash),
  the gate chain rendered in resolution order, blocking-dependency
  visualization, and linked review verdicts naming all five axes
  (anti-rubber-stamp: <3 axes flagged). Guard: no UI log editing; no
  force-bypass button; waivers are hub decisions producing new evidence.
- **C8 Steering + scheduled prompts, hub-mediated.** Queue text hub-side
  for delivery at the next authorized turn boundary; a scheduler page
  (create/pause/trigger) where every manual trigger is an authorized hub
  action; natural-language requests become durable backlog items.
  Guard: no raw terminal injection around the hub — the send path stays
  in the application layer's authorized verb set (amux's tmux
  send-keys model is exactly what Workflow's architecture routes around).
- **C9 Connectors page with scoping + test-before-run.** Scope selector,
  server-side test probe with last-result timestamp, secrets
  write-only, and an explicit display of which sessions/capabilities
  resolve to which credential. Guard: the UI cannot widen an agent's
  capability set (withholding stays the authority's).
- **C10 Dangerous-fact routing: warnings where people already look.**
  amux's hook-staleness detector logged the right warning 128 times into
  a log nobody tails; the fix moved detection to session-start. Proposal:
  a persistent operator banner in the web UI for out-of-date probes per
  pinned agent version, open P2/P3 review follow-ups, degraded
  `advisory` surfaces, and residual-risk deltas — clicking through lands
  on the evidence. Guard: the banner is derived from recorded state; it
  never suppresses or marks anything passed.
- **C11 Known-benign/noise ledger for triage.** amux's sweep keeps an
  explicit known-benign list with reasoning preserved in place ("the 400
  IS the pass signal") and the triage rule "one card per finding with
  the verbatim query + numbers; nothing found = no message." Proposal:
  an append-only annotations layer over guard-audit/metering pages so
  future reviewers inherit judgments that can themselves be audited.
  Guard: annotations never mutate or hide the records; filters are
  presentation-only and visibly labeled.

### P3 — polish/reach

- **C12 PWA plumbing**: steal the health-passthrough rule (service worker
  passes health requests to the network so the cache can't fake health)
  and the resume semantics regardless of phone-first ambitions. Offline
  MUTATION replay does NOT map — offline-queued Workflow mutations would
  have to re-validate against current kernel state/epochs; simplest
  honest choice: queue reads, discard mutations, tell the user.
- **C13 Memory browser**: read-only projection with provenance
  (who/when/supersession chains). Memory is context, never authorization.
- **C14 Calendar feed**: only if/when the kernel gains due-dates — never
  invent presentation-only dates that look like state.
- **C15 A second operator-mode skin**: the business-ui pattern (same
  hub, simplified projection, explicitly "not a security boundary") for
  Workflow's pedagogy layer — with the same refusal to add a new
  generic safe-action mechanism.

## 7. The do-NOT-steal list (each maps to a Workflow invariant)

1. **Client-side identity impersonation**: amux's dashboard hardcodes the
   session name (`_bwSession = 'amux'`), so human browser actions are
   recorded as agent-lane actions — an open frustration (AF-183) with a
   live path for an agent to destroy a human's signed-in session.
   Workflow: operator actions carry human identity; reviewer identity
   stays server-enforced.
2. **Force-bypass as a UI button**: amux's `force-bypass-logged` is
   reachable from tooling; any one-click past a gate conflicts with
   fail-closed authorization. Waivers are hub decisions producing new
   evidence, never UI shortcuts.
3. **Client-trusted gate state**: checkbox = verified is the trap; amux's
   own business-ui README is the citation against it ("the server remains
   authoritative… does not introduce a new generic safe-action
   mechanism").
4. **Presentation-owned state**: custom board columns from the UI
   conflict with "statuses mean what they say" (docs/FEATURES.md) —
   legal transitions are fixed; a kanban projection of kernel states is
   presentation, not kernel-drift.
5. **Paste-narrative-as-evidence**: evidence must be
   environment-supplied and kernel-validated (see C3's guard).
6. **Bulk evidence-erasing affordances**: amux's clear-done archived 957
   cards in one call and an audit using the archived view reported 48
   missing cards when the real number was 1 — bulk UI operations may
   filter views, never reclassify evidence out of the authoritative set.
7. **Monolithic single-file client with no deploy-integrity guard**: the
   APP_VER/service-worker CACHE desync shipped "code nobody's browser
   will fetch" — keep a structured frontend, versioned assets, and the
   health-passthrough rule (that part IS worth stealing).
8. **Coverage-blind all-clear rendering**: a sweep checking 1,494 rows
   against 129,940 reported "0 5xx" — encode the anti-pattern into
   review (C1's guard).
9. **Alert fatigue without triage**: a maintained benign-list and
   "nothing found = no message" discipline, or operators learn to ignore
   the banner.
10. **Append-only single-file text ledgers edited by many writers**: amux
   hit "every PR conflicts with every other" and an unrecoverable
   half-entry (AEAB-40) — Workflow's ledgers stay record-per-entry in
   the store, never a hot text blob.

## 8. Sources (fetched 2026-09-23)

README (github.com/mixpeek/amux); docs/guide.md (board system);
amux.io/guides/agent-to-agent-orchestration/;
docs/rust-migration/server-boundary.md (the ownership matrix + the
legacy-port retirement instrument); SECURITY.md; the background
research subagent's sweep (REST API reference, roadmap epic #46 with
sub-issues #47–#60 incl. the verification-gates and capability-permission
designs, running-10-plus-agents, the compare pages, log-sweep.md,
VERIFY.md, frustrations.md (~238KB, truncated at AF-183), features/
changelog (changelog JS-rendered — not captured), business-ui README,
the dashboard static tree). Source-quality caveats: the changelog page
is client-rendered; frustrations.md truncation; amux docs contain drift
(the architecture section still says "Python server" post-migration).

## 9. Disposition

The candidates in §6 are QUEUED proposal material — they become web-UI
W-items only on the operator's direction, prioritized C1–C5 first
(evidence/metering/review legibility), each carrying its trust-boundary
guard into the item text. §7's do-not-steal list is itself a deliverable:
each item is a Workflow invariant that this comparison independently
validated. No code or UI change in this research doc.