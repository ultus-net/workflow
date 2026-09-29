# Hub dashboard UI guide — layout expectations from shadcn-admin and paperclip

Date: 2026-09-29. Status: active guide. Branch: `docs/hub-dashboard-guide`.
Research sources: layout study of [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin)
(sidebars, page patterns, data tables) and [paperclipai/paperclip](https://github.com/paperclipai/paperclip)
(`DESIGN.md`, `ui/src/components/Sidebar.production.tsx`, `ui/src/App.tsx` route
table), both at their default branches, cloned 2026-09-29; against the hub's
current surface (`src/ui/webapp/**`, `src/integrations/hub-http.ts`,
`src/integrations/run-registry.ts`, `src/integrations/operator-posture.ts` at
main 6466634, post-#343).

This document records (1) the layout pattern the hub dashboard should converge
on, (2) the gap analysis of **built backend surfaces that render no UI** (or
render only inside chat panels), and (3) a tiered plan in the house style of
`docs/web-ui-feature-tiers.md`. References are studied, not vendored: no new
dependency is adopted here; assistant-ui remains the presentation layer
(`docs/OPERATOR_UI_DECISION.md`).

## Why these two references

**shadcn-admin** is the canonical *layout skeleton*: sidebar shell with grouped
nav, header with breadcrumbs and actions, and the standard page vocabulary
(overview cards, kanban, data table with filters + row actions, detail sheets,
sub-page settings with tabs). It answers "how does a dashboard look."

**Paperclip** is the canonical *domain model*: its `DESIGN.md` opens with
"Paperclip is an operational control plane: org charts, tasks, heartbeat runs,
budgets, approvals, audit logs. The user is an operator scanning state and
making decisions. Every screen should answer, in order: *what is happening,
does it need me, what do I do about it.*" It answers "what does an agent
control plane owe its operator" — the exact question for this hub. The repo
has already borrowed from it deliberately (W152's unified activity timeline
cites "the Paperclip borrow wave 3" in `src/ui/webapp/activity-timeline.tsx`).

## The operator-loop rule (paperclip, adopted)

Every page answers, in order:

1. **What is happening** — current state, projection-only, rendered verbatim
   from hub records (this repo's honest-subset rule, W165/W153).
2. **Does it need me** — attention surfaces surface *needs-decision* counts as
   badges (paperclip's Inbox/Decisions pattern), never as toasts for state
   already on screen (paperclip DESIGN.md §Contextual feedback).
3. **What do I do about it** — the action is at the point of scan: row actions
   in tables, affordances on cards, and the refusal rendered when an action
   cannot run (this repo's rendered-deny rule, W168-P2b).

Additional paperclip principles the hub should adopt wholesale:

- **Status is systematic.** One semantic status vocabulary (running / paused /
  blocked / awaiting-review / over-budget) used identically in badges, rows,
  cards, and the feed. An operator learns it once. Today the hub renders task
  states, run states, and freshness as free-form strings in several places.
- **Machine values look machine-made.** IDs, run keys, token counts, costs,
  and timestamps use one monospace treatment and one set of formatters
  (`presenters.ts` already owns `formatRelativeTime`/`formatTokens` — route all
  renderings through them; no per-view reformatting).
- **One name per concept.** The board calls provider items *cards*, the kernel
  calls its objects *tasks*, runs are *runs*. Copy must not blur them (the
  W153 attribution lesson: attribution comes from records, and words carry
  attribution).
- **Empty states say what to do first.** Each new view ships a named empty
  state ("no runs recorded yet — delegate a board task or fire a schedule"),
  never a silent blank. The existing degraded-state copy
  (`activity-timeline.tsx`'s "hub timeline unavailable (reason)") is the house
  pattern.
- **Density in service of scanning.** Rows beat chrome; hierarchy through
  position/size/weight, not borders. The board and future tables keep the
  quiet-card look of the current views.

## Layout: the shell

### Where the references agree

Both shells separate **navigation destinations** (pages) from **contextual
detail** (panels opened from a row/card, with origin memory so back returns to
the list). Both group nav into labeled sections and carry **badges for
attention state** directly in the nav.

- shadcn-admin: collapsible sidebar, groups (General / Pages / Other), badges
  (e.g. Chats "3"), sub-items under Settings; header holds breadcrumbs and
  per-page actions.
- paperclip: collapsible rail, labeled sections — unlabeled top group
  (Dashboard `liveCount`, Inbox badge + failed-run alert, Decisions
  attention badge, Status, Conference Room), **Work** (Tasks, Cases, Routines,
  Pipelines, Goals, Artifacts, Skills, Workspaces, Projects), **Company**
  (Org, Connectors, Timeline, Costs, Activity, Settings) — plus contextual
  sidebars for settings/agent/routine/skills detail.

### The hub's current shell

One top-bar slug nav (Chat, Agents, Board, Schedules, Projects, Usage,
Settings — `app.tsx` `AppView`), an enforcement badge and posture strip in the
header, and detail surfaces (invariants, evidence strip, activity timeline)
embedded as chat-view panels. This is chat-first by design (the chat view is
the operator's working surface; `docs/OPERATOR_UI_DECISION.md`), and nothing
here argues for a full shadcn-style rebuild. The gap is **capacity**: a
7-slug top bar cannot carry the runs/reviews/audit surfaces the backend
already owns, and detail surfaces that exist only as chat panels are invisible
to an operator who starts on another view.

### Target shell (superseded in shape — see the spec)

> **Superseded 2026-09-29** by
> `docs/superpowers/specs/2026-09-29-hub-dashboard-redesign-design.md`: the
> spec replaces top-bar navigation with the sidebar rail, makes the **Overview
> page the landing**, and sequences the work in five phases. The groupings and
> badge sources below still describe the target nav; the "keep the top bar"
> framing in this section does not survive the spec.

Keep the top bar for the working surfaces (Chat, Board, Agents), add a
collapsible **sidebar rail** grouped as:

- **(top group)** — Chat · Board · Agents — the working surfaces, unchanged.
- **Runs** — Runs (page, new) · Reviews (page, new) — the hub's produced work.
- **Automation** — Schedules · Projects — unchanged.
- **Insight** — Usage · Activity (the timeline, promoted from chat panel) ·
  Audit (page, new).
- **Config** — Settings (unchanged; its panels stay a dialog).

Nav badges ride existing polls: Agents count (sessions), Board in-review
count (`inProgress`/registry keys), Runs live count (registry active runs),
attention count for pending permission prompts (`usePermissions` already
polls at 1s). A badge must be *record-backed* — it renders a count the hub
reported, never a view-side guess (the W153 rule, applied to chrome).

Detail surfaces (run detail, review verdict, invariant row) open as a
**contextual panel** with origin memory (paperclip's
`rememberContextualSidebarOrigin` pattern): opened from a board card, back
returns to the board.

## Gap analysis: built, not rendered

Every row names the *record source* first — the UI may only render the subset
a record carries (the honest-subset rule). "Current UI" includes chat-only
panels, which an operator on another view cannot see.

### Tier 0 — built records with no UI element (render only)

| Built surface | Record source | Current UI | Missing element |
|---|---|---|---|
| **Run records** | run-registry run tasks via `/snapshot`; `RunOrigin` (schedule/provider-task attribution, W153) | schedule-origin rows only (runId + title + state, last 10) in `SchedulesView`; feed rows in the chat timeline | A **Runs page**: all registry runs (not schedule-lane only), one row per run — state, origin attribution, duration, work-product link — with a detail panel. The registry is the hub's core product; it is the least-rendered surface. |
| **Review outcomes** | `run-registry.reviewOutcomes()` (`HubReviewerResult`), `blockingReasons()`, surfaced via `/run/review` + timeline | feed rows only ("review", "gate" kinds) | A **Reviews page** (or Runs-page tab): five-axis verdict per review-gated run, blocking reasons verbatim, approval provenance. The repo's review discipline (five axes, anti-rubber-stamp) is currently invisible to the operator. |
| **Per-run cost/usage** | `RunUsageSummary` (requests, prompt/completion/total tokens, `costUsd`, cache read/create, `recordedAt`) via `runUsage()` | UsageView covers **session** usage only | Run rows on the Runs page render cost+tokens; UsageView gains a per-run section. `cacheReadTokens`/`cacheCreateTokens` render as the P12 record they are (0 on the OpenAI lane — the asymmetry is recorded, not hidden). |
| **Completion claims** | `recordCompletionClaim` / `completionClaims()` (runId, claim, verified-at-claim flag, observedAt) | feed rows only | Run detail shows the claim **with its verified-at-claim flag rendered** — the W114 honesty line (operator claims are not evidence) made legible per run. |
| **Reasoning-claim feed** | `reasoningClaims()` + `reasoningClaimMetrics()` (monitored/flagged/findings; recall + TTR explicitly `"unmeasured"`) | chat timeline only | Runs-page advisory section; the metrics line must render the unmeasured fields *as unmeasured* (the code's own comment forbids reporting them as measured). |
| **Budget incidents** | timeline `budget` kind rows (hub-side incidents) | chat timeline only | AgentsView budget cards already show posture; add the incident rows there (the session that went over its budget shows its incidents beside the card). |
| **Work-product detail** | `WorkProductLink` (provider, key, url, W165) + provider read state (W167 pills) | pills + link on board cards only | The W165-P1 design (provider-owned PR discovery, recorded in project memory) makes in-review reachable — when it lands, a work-product panel (state history from provider reads, the link's recorded url) hangs off the run/board card. |

### Tier 1 — built records with thin/partial UI (render better)

| Built surface | Record source | Current UI | Gap |
|---|---|---|---|
| Activity timeline | `/api/timeline` over kernel log + registry records | chat panel, all kinds interleaved | Promote to the Insight page: kind filters (kernel/review/gate/claim/usage/origin/budget — the `KIND_LABELS` set), retention line verbatim (in-memory, resets on restart). |
| Evidence records | `/api/evidence`, `/api/evidence-content` (bounded store, W158) | one strip in chat | Render evidence **under its task/run** (Rows stay verbatim: origin tag, signpost rule, bounded preview states). |
| Hub audit history | hub's registered ClientContribution audit trail (HUB.md §Route ↔ authority) | none | Audit page (Insight group): read-only contribution rows — route, workspace, verdict. This is the operator's answer to "what did the hub authorize" and currently exists only server-side. |
| Board card detail | board outcome + `workProducts` + `inProgress` + `boardRead` | card pills + delegate affordance | Card detail panel reusing the issue-detail surface (W167): thread + description + provider-read liveness, origin-honest. |
| Git surfaces | `/api/git`, `/api/git/diff`, `/api/worktrees` | inline in chat (DiffText) | The worktree list and branch render in the Board/Runs detail header (branch context for "what did this run touch"), not a new page. |

### Tier 2 — nothing built yet (do not build for this guide)

Live dashboards of remote hubs, multi-workspace switcher, notification
digests. The hub is loopback-only today; these are paperclip's multi-tenant
concerns, not ours.

## Patterns to copy, per reference

| Need | shadcn-admin pattern | paperclip pattern | Hub adoption |
|---|---|---|---|
| Nav shell | `src/components/layout/app-sidebar.tsx`, grouped `sidebar-data.ts` | `Sidebar.production.tsx` sections + badges | Collapsible rail beside the current top bar (groups above) |
| List pages (runs, audit) | `features/tasks` data table: column filters, row actions | `pages/Timeline.tsx`, `pages/audit` | Tables render record subsets verbatim; row actions call existing routes only |
| Detail from a row | tasks detail sheet | contextual sidebar with origin memory (`shell-navigation.ts`) | Panel with origin memory; no invented detail data |
| Attention state | nav badge (Chats "3") | Inbox badge + failed-run alert; Decisions attention count | Record-backed badges only |
| Status vocabulary | — | one status token set across badge/row/chart/log (DESIGN.md §5) | One status map in `presenters.ts` for task/run/freshness states |
| Empty states | `components/coming-soon.tsx` | every page names the first action | Named degraded/empty copy per view (house pattern already in `activity-timeline.tsx`) |
| Machine values | — | monospace token + shared formatters (DESIGN.md §6) | Route all ids/costs/tokens through `presenters.ts` formatters |

## Adoption notes (honesty constraints the UI may not shed)

1. **Projection-only.** Every new element renders a record the hub returned
   (`/snapshot`, `/api/timeline`, registry maps exposed via the web service).
   No view-side derivation of attribution, freshness, or linkage (W153/W165
   pins already enforce this on the board; the new pages inherit it).
2. **Named absence.** Runs/Reviews/Audit unavailable (no hub, or a hub
   predating the slice) render the named degraded state, never a fabricated
   empty list — the `recentRuns === undefined` copy in `schedules-view.tsx`
   is the pattern.
3. **Honest defaults on the metrics.** `recall`/`timeToResponseMs` render
   "unmeasured"; cache tokens render their recorded lane asymmetry; a claim's
   verified flag renders beside the claim.
4. **Fail-closed affordances.** Any action on the new pages (retry, re-run,
   cancel) routes through the existing guarded routes; an action whose
   preconditions the record does not support renders the refusal, not a
   disabled-by-tooltip guess (rendered-deny rule).

## Suggested implementation order (superseded)

> **Superseded 2026-09-29** by the spec's five-phase sequence
> (`docs/superpowers/specs/2026-09-29-hub-dashboard-redesign-design.md` §
> Sequencing): shell + Overview first, then Runs + detail panel, then Reviews
> + Activity + remaining Tier-1 surfaces, then Audit. The list below is kept
> for provenance only — do not implement from it.

1. **Runs page, read-only** (Tier 0): registry rows already flow through
   `/snapshot` → schedule `recentRuns` proves the shape; widen to all runs +
   origin/usage/claim columns. Verification: focused `webapp-surface` pin
   red-first, `presenters.ts` status map extraction in the same change.
2. **Review outcomes + blocking reasons** on the run detail (the five-axis
   verdict is already a structured record — it renders, not re-derives).
3. **Activity → Insight page** (promote `ActivityTimelinePanel`, add kind
   filters; chat keeps the panel).
4. **Audit page** (needs the web service to relay the hub's audit map — new
   read route, same guard pattern as `/api/evidence`).
5. **Sidebar rail** around the existing shell once ≥2 new pages exist (before
   that, two more top-bar slugs are honest).
6. **Work-product panel** after the W165-P1 discovery iteration D lands (the
   in_review shape it re-keys becomes reachable then).
