# What the Workflow hub dashboard should borrow from Paperclip

Date 2026-09-26 · Status: research input, operator direction pending

## Evidence base

**Paperclip sources fetched for this document** (all claims below cite one of these):

- `ROADMAP.md`, `DESIGN.md`, `doc/CLI.md`, `doc/AGENT-ARTIFACTS.md`, `doc/observability.md` — fetched from `raw.githubusercontent.com/paperclipai/paperclip/master/...`
- `ui/`, `ui/src`, `ui/src/pages` directory inventories via the GitHub contents API (`api.github.com/repos/paperclipai/paperclip/contents/ui[...]`)
- Hosted docs: the index at `docs.paperclip.ing`, plus the pages for The Dashboard, Blocked Inbox, Approvals, Costs & Budgets, Activity Log, Work Timeline, Artifacts, and Heartbeats & Routines

**Workflow side:** verified in the local worktree (`src/ui/webapp/`, `src/integrations/`, `src/integrations/hub-http.ts`) and `TASKS.md` (W045 at `TASKS.md:740`, W073 at `:1061`, W074 at `:1156`, W111 at `:3413`, W118 at `:3846`); the seven-item operator mapping was taken as given and deepened rather than re-derived. The azure remote-plane spec was **not** fetched in this pass; Easy Auth implications are flagged conditionally in the risks section only.

## What Paperclip is, in its own words

"An operational control plane: org charts, tasks, heartbeat runs, budgets, approvals, audit logs. The user is an operator scanning state and making decisions. Every screen should answer, in order: *what is happening, does it need me, what do I do about it.*" ([DESIGN.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/DESIGN.md))

That stance is adjacent to Workflow's, but the authority model is not: Paperclip is a management plane for autonomous "companies" where a CEO agent proposes hires and strategies for board approval ([Approvals guide](https://docs.paperclip.ing/guides/day-to-day/approvals/)), agents wake each other, and multiple humans share the board ([ROADMAP.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/ROADMAP.md)). Workflow's dashboard is a projection over a deterministic kernel with a single human authority. Everything below is filtered through that difference: borrow the *scanning and triage surfaces*, cut the *delegated management machinery*.

## Mapping table

| # | Paperclip feature | Paperclip source | Workflow seam | Verdict |
|---|---|---|---|---|
| 1 | Dashboard overview cards: agents enabled/running/error/paused, tasks in progress, month spend vs budget, pending approvals; activity pulse feed | [Dashboard guide](https://docs.paperclip.ing/guides/day-to-day/dashboard/) | `src/ui/webapp/app.tsx` header; projection from `src/integrations/hub-http.ts` `/snapshot` + registries | **borrow** — a single operator-posture strip; nothing equivalent exists today |
| 2 | Approvals queue (pending/all tabs, approve/reject/request-revision, decision notes); budget approvals resolved from budget controls, not the approval detail | [Approvals guide](https://docs.paperclip.ing/guides/day-to-day/approvals/), [CLI.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/CLI.md) (`approval approve/reject/request-revision`) | `src/integrations/hub-run-gates.ts`, run registry reviews + decisions (`hub-http.ts` `/run/begin\|review\|finish`, `/review/rubric`) | **borrow (unify)** — reviews and decisions exist; they are scattered across panels |
| 3 | Budget posture: 80% warning / 100% auto-pause, budget incidents with "Keep paused / Raise budget and resume", paused-by-budget badge, four-metric budget control plane | [Costs guide](https://docs.paperclip.ing/guides/day-to-day/costs/), [Dashboard guide](https://docs.paperclip.ing/guides/day-to-day/dashboard/) | W045 `src/integrations/session-budget.ts` (`sessionBudgetFromEnv`, sticky refusal gate, per-`/api/session` `budgetMechanism`), W118 warn-tier stage (`opencode-server-budget.ts`), W111 `src/ui/usage.ts` / `usage-view.tsx` | **partially exists; borrow** — tiers and caps exist; the incident/posture surface does not |
| 4 | Activity log: every mutation with actor ("Board Operator" vs agent), action, entity, before/after, permanent record, attribution filters | [Activity Log guide](https://docs.paperclip.ing/guides/day-to-day/activity-log/) | `src/ui/webapp/app.tsx` History panel over kernel transition log + run registry | **borrow (attribution), skip** export/permission tiers |
| 5 | Work timeline: Gantt-style lanes per actor, handoff/overlap reading, 7-day default window, explicitly "a reading surface, not a replacement for the records" | [Work Timeline guide](https://docs.paperclip.ing/guides/day-to-day/work-timeline/) | run registry intervals + `src/integrations/schedule-registry.ts` / `off-peak.ts` (overnight scheduled runs) | **defer** — low concurrency in Workflow today; useful only once schedules accumulate history |
| 6 | Blocked inbox: blocked status requires an unblock owner + action text; six severity chips; agents may only name themselves as unblock owner | [Blocked Inbox guide](https://docs.paperclip.ing/guides/day-to-day/blocked-inbox/) | kernel legal transitions + `src/application/workflow.ts` authority; Tasks inspector panel | **borrow the admission rule (kernel-level), project the chip in the Tasks panel** |
| 7 | Work products / artifacts shelf: uploaded artifacts vs `workspace_file` refs, receipted uploads (idempotency key, SHA-256, byteSize), type-filtered shelf, in-place previews | [doc/AGENT-ARTIFACTS.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/AGENT-ARTIFACTS.md), [Artifacts guide](https://docs.paperclip.ing/guides/day-to-day/artifacts/) | Evidence + Changes inspector panels (OpenCode-style diffs already exist; `src/ui/webapp/diff-text.tsx`) | **borrow the inspectable-output shelf over existing evidence; skip** uploads and annotation systems |
| 8 | Routines: scheduled trigger creates a run with `originKind` attribution, run history per routine, last-run status, run-now with overrides, plain-English cron | [Routines guide](https://docs.paperclip.ing/guides/projects-workflow/routines/), [CLI.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/CLI.md) (`routine list/runs/run`) | W074 `src/integrations/schedule-registry.ts` (`/schedule/save` noted at `TASKS.md:1791`), `hub-scheduler.ts`, `src/ui/webapp/schedules-view.tsx` | **partially exists; borrow** the per-schedule run lineage and origin attribution |
| 9 | Watchdogs, recovery actions, auto-create recovery tasks | [ROADMAP.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/ROADMAP.md), [CLI.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/CLI.md) (`run watchdog-decision --decision continue`) | orphaned-run recovery (run registry + `durable-state-attestation.ts`; recover-or-discard, fail-closed) | **partially exists; borrow** the surfacing, **skip** automatic recovery |
| 10 | Inbox tabs with dismissals (`inbox dismiss`, item keys like `run:<run-id>`) | [Blocked Inbox guide](https://docs.paperclip.ing/guides/day-to-day/blocked-inbox/), [CLI.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/CLI.md) (`inbox dismiss`) | none | **skip** — dismissal is hidden state; UI-owned canonical state is forbidden, kernel ack work has no demand |
| 11 | Org charts, CEO agents, company import/export, multiple human users, multi-tenant cloud, Postgres | [ROADMAP.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/ROADMAP.md), [CLI.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/CLI.md) (`company export/import`, postgres rejection only in test-drive) | none | **skip** — contradicts single-operator deterministic model (see cut lines) |
| 12 | Design-language principles: triage-first screen ordering, one semantic status token set (running/paused/blocked/awaiting-approval/over-budget), monospace machine values, no redundant toasts, late terminal outcomes refresh silently | [DESIGN.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/DESIGN.md) | `src/ui/webapp/styles.css`, `theme.ts`, `failure-copy.ts`, `presenters.ts` | **borrow as conventions** for all five waves |
| 13 | Single aggregated dashboard projection endpoint (`dashboard get --company-id`) | [CLI.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/CLI.md) | `hub-http.ts` `/snapshot` | **already exists** (equivalent shape; extend, don't add a second endpoint) |
| 14 | Observability discipline: closed attribute allowlists, no user content in spans, "observability must not change the sync control flow" | [doc/observability.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/observability.md) | metering proxy (`model-usage-proxy.ts`), W044 usage surfacing | **already exists in spirit**; keep the rule for any new hub metrics the dashboard projects |

## Proposed waves (each item: behavior → data projected → cut line → acceptance criteria)

All five waves are projection work unless a row says otherwise. Every panel reads hub/kernel-owned state; every action routes through the application authority (`src/application/workflow.ts`) and fails closed. The UI never owns canonical state.

### Wave 1 — operator posture strip and unified decision inbox
(Borrows mapping rows 1, 2, and 9)

**Behavior.** A fixed header strip in `src/ui/webapp/app.tsx` above the two-region layout, answering Paperclip's three questions in order. Four counts: runs awaiting review/decision, open budget incidents (any tier crossing, W045/W118), orphaned runs needing recover-or-discard, schedules whose last run failed. Below it, one decision list merging today's scattered surfaces: run-gate reviews, recorded review decisions, budget incidents, orphaned-run recovery. Each row shows actor, authority basis, and one action link into the existing panel. Paperclip's analog is the pending-approvals card plus the Approvals page's pending/all split ([Approvals guide](https://docs.paperclip.ing/guides/day-to-day/approvals/)); the closest single-screen pattern is their four overview cards plus activity pulse ([Dashboard guide](https://docs.paperclip.ing/guides/day-to-day/dashboard/)).

**Data projected.** Run registry state, review-gate state (`hub-run-gates.ts`), budget violation/abort-tier state (already served per-session via the web session channel's `budgetMechanism` and violation fields, W045), orphaned-run recovery candidates (run registry + `durable-state-attestation.ts`), schedule-registry last outcomes. Either extend `/snapshot` or add one read route; do not add a second aggregation endpoint (Paperclip's `dashboard get` maps to `/snapshot`, which already exists).

**Cut line.** No board concept, no multi-actor feeds, no dismissal/ack state (row 10), no request-revision loop (Workflow's gates are pass/fail with evidence, not proposal-counterproposal cycles), no notification plumbing. Orphaned runs stay recover-or-discard, fail-closed; Paperclip's automatic recovery policies and auto-create-recovery-tasks are explicitly not taken because they mutate state without fresh operator or evidence authority ([ROADMAP.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/ROADMAP.md)).

**Acceptance criteria (house style).**
1. Red-first focused test: the posture strip renders counts computed only from registry state, and renders a fail-closed empty/degraded state when a registry is absent.
2. Zero mutations on render; every list row's action is a link into an existing panel (no new write routes).
3. The decision list covers reviews, decisions, budget incidents, and orphaned runs with actor attribution, verified by a focused test on the projection function.
4. `npm run lint`, `npm run typecheck`, and the focused webapp tests pass; full suite is not run.

### Wave 2 — budget state as agent posture with incident actions
(Borrows row 3)

**Behavior.** In the agents view (`src/ui/webapp/agents-view.tsx`) and the W111 usage view: a per-session budget bar with the tier state colorized the way Paperclip does it (green under warn tier, amber at warn, red at abort), and a `paused: budget` badge when the sticky violation is installed. An incident card offers the two Paperclip actions, renamed to Workflow vocabulary: keep stopped (acknowledge) and raise cap and resume, each dispatched as an application-authority proposal, never a direct mutation ([Costs guide](https://docs.paperclip.ing/guides/day-to-day/costs/)).

**Data projected.** W045 session-budget guard state (mechanism, caps, sticky violation), W118 warn-tier stage state, metering proxy recorded usage. All of this is hub-owned; the violation already surfaces on `/api/session`.

**Cut line.** No company/project/agent three-layer budget scopes (Workflow budgets are per-session and per-schedule-run), no month-rollover semantics, no finance ledger, billers, or provider quota windows (no subscription billing model exists here), no "budget override approval" type: the raise-cap action is an ordinary authority-gated mutation.

**Acceptance criteria.**
1. The posture badge renders only from recorded tier state; a session with no configured caps shows an honest "no local cap" state, not a fabricated 0%.
2. Raise-cap and resume actions fail closed when the application authority withholds the capability; a focused test proves the UI renders the denial rather than a disabled-looking success path.
3. The bar's tier boundaries are derived from the same constants the guard enforces (no duplicated threshold constants in the UI).

### Wave 3 — unified activity timeline with actor/authority attribution
(Borrows row 4)

**Behavior.** Upgrade the History panel into one chronological feed: kernel transitions, run begin/review/finish, review verdicts, budget tier crossings, schedule fires. Each row names the actor (operator, agent, system) and the authority basis (kernel transition or authorization record), with before/after where the record carries it. Paperclip's rule that the activity log shows structural changes while comment threads show reasoning maps cleanly onto Workflow: the feed shows transitions; the driving chat region shows what the agent said ([Activity Log guide](https://docs.paperclip.ing/guides/day-to-day/activity-log/)).

**Data projected.** The kernel transition log and run registry records, append-only, via existing read routes. If the transition log lacks an actor/authority field on some event types, that is a kernel/application record change first, UI second; the UI must not synthesize attribution it was not given.

**Cut line.** No CSV export, no `audit:view_agent_actions` permission tiers, no "responsible user" (single operator), and no "permanent" retention claim: Paperclip promises a permanent record; Workflow's docs must state what the hub actually persists and for how long, and the panel copies that claim verbatim rather than inflating it.

**Acceptance criteria.**
1. Every rendered row's actor and authority fields come from the underlying record; a test proves rows with missing attribution render an explicit "unattributed" state instead of a guess.
2. The feed is append-only from existing records: a test proves no feed mutation path exists.
3. Retention wording in the panel matches the hub's actual persistence behavior (asserted in the same focused test).

### Wave 4 — schedules as routines with tracked auditable output
(Borrows row 8)

**Behavior.** `schedules-view.tsx` gains per-schedule lineage: last-run outcome, count of runs it caused with links, next fire, and a "Recent runs" filter that answers "did my schedules fire while I was away?" Every run row anywhere in the dashboard carries origin attribution "fired by schedule S" when a schedule caused it. Paperclip achieves this with `originKind = routine_execution` on the produced work ([Routines guide](https://docs.paperclip.ing/guides/projects-workflow/routines/)); W074 already has list/save/delete/run-now, so the gap is the origin link and per-schedule history, not the trigger mechanics.

**Data projected.** `schedule-registry.ts` records plus run registry origin refs. If the run registry does not yet record a schedule-origin field, the change lands in the hub-owned registry first (`schedule-registry.ts` / `run-registry.ts`), and the view projects it. This is the one wave with a small non-UI component, and it must stay inside the hub integration layer, not the kernel.

**Cut line.** No webhook triggers, no variable templating, no concurrency/catch-up policies, no revision history with restore, no comment-on-instructions, no cron-picker editor (the W074 cadence form stays). Plain-English cadence rendering is cheap and may ride along, but is not the acceptance criterion.

**Acceptance criteria.**
1. A schedule's view shows its caused runs and their outcomes, sourced from hub records; a focused test proves the join is registry-sourced, not UI-computed from timestamps.
2. Run-now remains the only manual trigger path and continues to produce a registry-recorded run with origin attribution.
3. Deleting a schedule keeps its historical runs attributed to a tombstoned origin rather than dangling (asserted in the test).

### Wave 5 — work products over evidence, and the RSI lineage view
(Borrows row 7 and the operator's item 2)

**Behavior (two panels, one wave).**
- *Artifacts over evidence:* the Evidence and Changes inspector panels gain an artifact strip: screenshots render as inline previews, test outputs render as text, each linked to the run and evidence record that owns it. Paperclip's distinction to honor: durable inspectable outputs (their uploaded artifacts) versus in-workspace signposts (their `workspace_file` refs). Workflow's analog: evidence records the environment captured are first-class; paths inside a worktree are signposts and must not be presented as durable artifacts ([doc/AGENT-ARTIFACTS.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/AGENT-ARTIFACTS.md), [Artifacts guide](https://docs.paperclip.ing/guides/day-to-day/artifacts/)).
- *RSI lineage view:* the self-improvement surface gains the objective → iteration → verdict → commit-ref chain, projected from `self-improvement-registry.ts` records (W073 data already exists). One row per iteration, verdict and commit ref clickable into the run record.

**Data projected.** Kernel evidence records (freshness already kernel-owned) and `self-improvement-registry.ts` records. No new evidence write path; if screenshots or test outputs are not currently recorded as evidence, the honest first step is recording them at capture time in the existing evidence pipeline, not inventing an upload channel.

**Cut line.** No agent-initiated uploads (Paperclip's `register_deliverable`/attachment pipeline is a different trust model: agents pushing files into the control plane; Workflow's evidence is environment-captured), no anchored document comments with stale/orphaned anchor states, no workspace file browser (scope and credential-exposure risk; worktrees plus containment already cover inspection), no cross-task stacks.

**Acceptance criteria.**
1. An evidence record with an image renders a preview in place; one without previewable content renders a plain record with its freshness state. No silent fallback rendering.
2. The RSI lineage view renders the full chain for a registry objective and shows an honest empty state when a verdict or commit ref is absent (no placeholder fabrication).
3. A test proves the artifact strip refuses to render a bare filesystem path as if it were a durable artifact.

## Deferred, not borrowed

- **Work timeline Gantt (row 5).** Worth building only after Wave 4 accumulates overnight schedule history; with today's concurrency it would mostly show empty lanes. Paperclip's own framing ("a reading surface, not a replacement for the records") is the right constraint if it is ever built ([Work Timeline guide](https://docs.paperclip.ing/guides/day-to-day/work-timeline/)).
- **Command palette.** Listed in Paperclip's docs nav ([docs index](https://docs.paperclip.ing)) but not fetched in this pass; unverified, so no recommendation.
- **Unblock-owner descriptor (row 6), data half.** The strongest idea in the Blocked Inbox guide is the admission rule: entering blocked requires unresolved blockers, a pending approval, or a named owner plus action. That is a kernel transition contract change with UI projection, and deserves its own W-item rather than riding the dashboard waves. The security property worth keeping: agents may only name themselves as the unblock owner, never drop items into the operator's attention feed ([Blocked Inbox guide](https://docs.paperclip.ing/guides/day-to-day/blocked-inbox/)).
- **Org charts, CEO agents, hire/strategy approvals, company simulation, import/export, multi-user, multi-tenant cloud, Postgres (row 11).** All cut. They assume delegated management (a CEO agent proposing work for a board) and shared multi-actor authority; Workflow's kernel owns legal transitions and the operator is the single authority. Postgres and the company bundle portability solve problems Workflow does not have.

## Design conventions to adopt across all waves

From [DESIGN.md](https://raw.githubusercontent.com/paperclipai/paperclip/master/DESIGN.md), none of which conflict with the projection rule:

- Status is systematic: one semantic set for running / paused / blocked / awaiting-review / over-budget, used identically in badge, row, chart, and log. Paperclip tokens its statuses; the webapp's `styles.css`/`theme.ts` should get one status token set before Wave 1 adds new badges.
- Machine values look machine-made: ids, costs, token counts, timestamps in monospace with shared formatters, never per-screen formatting. `src/ui/webapp/presenters.ts` is the natural home.
- No toast for state already visible on the screen; a terminal outcome delivered long after the fact refreshes state silently; expected cancellation is neutral, not an error. Directly applicable to the inbox and budget actions.

## Risks and honesty notes

- **Projection-only rule.** Every borrowed surface reads hub/kernel-owned state and dispatches actions through the application authority. Any panel that starts holding its own state (dismissals, optimistic approvals, synthesized attribution) has become a rival authority; the Wave 1 acceptance criteria pin this with tests.
- **Management vs driving split.** Paperclip's UI is the management plane over autonomous agent companies; Workflow's stock UIs (OpenCode TUI/browser driving surfaces) remain the surfaces where work is driven. The hub dashboard observes and dispatches proposals; it must not grow into a second place where tasks are authored and agents are commanded, or the hub stops being the single authority the launchers resolve against.
- **Kernel boundary.** The blocked-descriptor idea and any actor-attribution gap are kernel/record changes first. The dashboard waves must not ship attribution the kernel does not record; "unattributed" rendered honestly beats attribution inferred in the UI.
- **Honest-claims discipline.** Paperclip documents promise real-time refresh and permanent records. Workflow's dashboard must state its actual refresh mechanism (whatever `/snapshot` polling is today) and actual retention, and any new surface starts `Partial` with its gaps recorded in `TASKS.md`, not silently promoted to Complete.
- **Easy Auth / remote plane.** The azure remote-plane spec was not consulted in this research pass, so nothing here is an Easy Auth claim. Conditional note for the operator: waves 1 and 2 concentrate operator-consequential actions (review decisions, budget raises) into one surface; that raises the value of a compromised non-loopback session. If the dashboard is ever served beyond `127.0.0.1`, the existing hub token/verification model must gate the new action dispatch, and fail-closed behavior under missing authority is part of the Wave 1 and Wave 2 acceptance criteria above.
- **Vocabulary guard.** No Paperclip terms (hire, CEO, board, company, heartbeat) leak into Workflow copy; per DESIGN.md's own one-name-per-concept rule, Workflow's existing terms (runs, schedules, reviews, evidence, objectives) stay canonical.

## Source list (all fetched 2026-09-26)

- https://raw.githubusercontent.com/paperclipai/paperclip/master/ROADMAP.md
- https://raw.githubusercontent.com/paperclipai/paperclip/master/DESIGN.md
- https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/CLI.md
- https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/AGENT-ARTIFACTS.md
- https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/observability.md
- https://api.github.com/repos/paperclipai/paperclip/contents/ui · `/contents/ui/src` · `/contents/ui/src/pages` (page inventory: `Dashboard.tsx`, `Approvals.tsx`, `Inbox.tsx`, `Costs.tsx`, `Routines.tsx`, `Artifacts.tsx`, and tests co-located per page)
- https://docs.paperclip.ing (index)
- https://docs.paperclip.ing/guides/day-to-day/dashboard/
- https://docs.paperclip.ing/guides/day-to-day/blocked-inbox/
- https://docs.paperclip.ing/guides/day-to-day/approvals/
- https://docs.paperclip.ing/guides/day-to-day/costs/
- https://docs.paperclip.ing/guides/day-to-day/activity-log/
- https://docs.paperclip.ing/guides/day-to-day/work-timeline/
- https://docs.paperclip.ing/guides/day-to-day/artifacts/
- https://docs.paperclip.ing/guides/projects-workflow/routines/

Workflow side verified locally: `src/ui/webapp/` (app, agents-view, schedules-view, usage-view, invariants-panel, diff-text, failure-copy, presenters), `src/integrations/hub-http.ts` (`/health`, `/snapshot`, `/run/begin|review|finish`, `/review/rubric`, `/bash`; takes ScheduleRegistry and SelfImprovementRegistry), `session-budget.ts`, `opencode-server-budget.ts`, `schedule-registry.ts`, `hub-scheduler.ts`, `run-registry.ts`, `self-improvement-registry.ts`, `durable-state-attestation.ts`, `model-usage-proxy.ts`, `src/ui/usage.ts`; `TASKS.md` W045/W073/W074/W111/W118 entries.

---

## Amendment (2026-09-27, operator direction — supersedes one risk note, extends the roadmap)

Three operator decisions taken during the board iteration (W161) amend this
spec. Dated, append-only; nothing above is rewritten.

1. **The "Management vs driving split" risk note is SUPERSEDED.** The
dashboard is a first-class seat for every management capability the hub's
application authority exposes — authoring runs, reviews, budget actions,
schedules, RSI loops, permission answers, shell lanes. That is what makes
Workflow the primary UI over the opencode CLI. What still holds, unchanged:
the dashboard never OWNS canonical state (every action dispatches through
the same authority-gated routes the CLI uses), denials render honestly, no
optimistic mutations, no paperclip vocabulary in the copy.

2. **Token classes stay split (W133).** Verifier-credential actions
(`/schedule/run-now`, `/rsi/start`) remain CLI-only (operator choice
2026-09-27); the browser never holds the verifier credential. A dashboard
re-auth flow may be revisited later; it is not promised here.

3. **Paperclip's UI is the capability roadmap; Workflow's theme is the only
styling path.** The upstream page inventory (Dashboard, Approvals, Costs,
Routines, Artifacts, Projects, Issues board, Issue detail) is the checklist
the dashboard converges on. All borrowed surfaces style only through the
existing tokens (`theme.ts`, `theme/resolve.ts`, the W155 status token set,
`styles.css` custom properties, `presenters.ts` formatters) — no upstream
CSS, colors, or fonts ever import. The board's 7-column target
(backlog/todo/in_progress/in_review/blocked/done/cancelled, per
`KanbanBoard.tsx`'s `boardStatuses`) lands column-by-column as each
column's backing authority becomes hub-owned (`in_progress` ← delegation
run linkage; `in_review` ← PR work-products; `blocked` ← the W159 admission
rule). Until a column's authority exists, the board renders the honest
subset (open/closed) rather than a label-guessed column.

First dispatch-class addition under amendment 1: **delegate from a board
card** — dispatch a run proposal via the application authority, with a
rendered-deny test — the next iteration after the read-only board (W161,
which landed the provider seam `src/integrations/task-provider.ts`, the
`/board/tasks` read route, the `/api/board` relay, and the Board view).

Board research input (fetched 2026-09-27, cited claims): Paperclip's board
is `KanbanBoard.tsx` rendered by `IssuesList.tsx` (no standalone board page)
— one column per status enum value via a pure projection, per-status server
queries with a 200-per-column cap, server-owned ordering (no per-card rank),
delegation via assign/checkout/release API verbs (checkout atomically
exclusive via `expectedStatuses`), work products carrying PR state, and
external-reference pills with `Fresh/Stale/Requires auth/Unreachable`
liveness. Its UI-local state (`IssueViewState`) is view-preference only —
the model for any board affordances we borrow.

---

## Work-item breakdown (2026-09-27, from the amendment + the board research)

One change per iteration, each with its own registered prediction
(RSI-loop discipline). Ids W162+ are provisional next-free numbers
(W161 = the landed read-only board); ids are confirmed at each item's PR.
Every item: projection-only, authority-gated dispatch, fail-closed, honest
states, Workflow vocabulary only. Land order respects the dependency chain;
the column set grows only as each column's backing authority becomes
hub-owned (amendment 3).

### W162 — delegate from a board card (the amendment's first dispatch-class addition)
- **Behavior.** A card action opens a delegation proposal (run id, workspace,
  task prompt prefilled from the issue's title + a reference to the issue
  url) and dispatches through the hub's run-begin path — the same
  authority-gated route the CLI uses. Refusals render verbatim (rendered-deny
  test), never a disabled-looking success.
- **Data.** The run's origin attribution gains a provider-task kind (the
  runOrigins pattern, W153) linking run → (provider, issue key, url). The
  `in_progress` column becomes hub-owned: open issues with an active linked
  run, joined by the raw-id contract — never a timestamp heuristic.
- **Cut** (per the research): no checkout/claim locks, no wake-on-assign, no
  agent self-claim — Workflow runs start via the application authority.
- **Accept.** Rendered-deny pin (capability withheld → denial rendered);
  linkage registry-sourced, not UI-computed (the W153 pin pattern); focused
  suite + lint + typecheck green.

### W163 — column convergence + volume honesty
- **Behavior.** GitHub's provider-owned `state_reason`
  (completed / not_planned / duplicate / reopened) splits `closed` into
  done / cancelled — provider-owned signal, no label guesses; no column
  appears before its authority exists. Per-column caps with honest
  "showing N of M received" bookkeeping; per-column page-size and density
  view-preferences stay UI-local (the `IssueViewState` model, persisted per
  browser, never task state).
- **Data.** Hub-side ETag conditional requests (If-None-Match / 304) on the
  provider read so overlapping tabs share one upstream read (LESS-0061's
  recorded residual); cache TTL recorded honestly.
- **Accept.** state_reason mapping pinned; cap/count honesty pinned; the
  304 path pinned; no UI-owned task state (pinned by construction: prefs
  live outside the board outcome).

### W164 — the project container
- **Behavior.** The "open a project" record the operator asked for: a
  hub-owned project binding a provider-stable repo identity (fullName +
  provider id, credential-free — paperclip's `ProjectRepository` pattern),
  a status, a budget envelope (riding the existing W045/W118 budget
  machinery), and workspace binding(s). The dashboard lists projects and
  scopes the board (and later schedules/usage) per project.
- **Cut.** No org charts, no goals layer (RSI objectives exist), no
  multi-user membership.
- **Accept.** The identity record provably carries no credential (pin by
  value); per-project scoping pinned; single-authority dispatch preserved.

### W165 — work products and the in_review column
- **Behavior.** Run → PR linkage recorded hub-side; cards render the PR
  state read-only from the provider; `in_review` appears when the linkage +
  provider PR state exist (never from label guesses).
- **Accept.** Linkage registry-sourced; absent linkage renders "unlinked"
  honestly; PR state renders verbatim with its liveness stated.

### W166 — blocked: the W159 admission rule, implemented
- **Behavior.** The landed design fragment becomes a kernel transition
  contract: entering BLOCKED requires unresolved blockers, a pending
  approval, or a named owner + action; agents may only name themselves as
  the unblock owner. The board's `blocked` column projects the kernel
  record.
- **Accept.** Kernel-level admission tests; the UI renders the unblock
  descriptor from the record, never synthesized.

### W167 — issue detail + external-reference liveness
- **Behavior.** A read-only issue surface (thread, description) and
  external-reference pills with the Fresh / Stale / Requires auth /
  Unreachable liveness model on provider links. Operator-authored comments,
  if taken, are operator-token dispatch through the authority (amendment 1
  class) — decided at this item's proposal, not assumed.
- **Accept.** Liveness renders honestly (dashed when not fresh, per the
  research); no attribution the records don't carry.

### W168 — Azure DevOps provider behind the same record shape
- **Behavior.** The ADO work-item adapter (`provider: "azure_devops"`, PAT
  env, org/project declaration) mapping System.Title/State/Tags/AssignedTo
  onto `ExternalTask`; the same BoardOutcome contract and fail-closed pins.
- **Accept.** The ADO state → column mapping table pinned per work-item
  template (per-template states land on the one column enum); credential
  never rides any payload (pin by value).

**Carried P3s** (LESS-0061) ride their nearest item: the DOM-level
reason-propagation pin rides the next browser-e2e wave (with W162/W163);
nothing else is orphaned.