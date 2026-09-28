# Hub dashboard redesign — sidebar shell, Overview landing, and the produced-work pages

Date: 2026-09-29. Status: design approved in session, awaiting spec review.
Branch: `docs/hub-dashboard-guide`.
Companion research: `docs/HUB_DASHBOARD_UI_GUIDE.md` (the 2026-09-29 layout
study of satnaing/shadcn-admin and paperclipai/paperclip, and the gap analysis
of built-but-unrendered hub surfaces). Mockups: `.superpowers/brainstorm/`
(untracked), session 146971.

## Goal

Restructure the browser operator UI (`src/ui/webapp/**`) into the layout the
two references share — a grouped sidebar, one page per concern, record-backed
attention badges, and contextual detail panels — while keeping the hub's own
visual identity (the OpenCode-TUI-borrowed token system, `styles.css`, 50
palettes with AA correction). The redesign closes the gap the study recorded:
the run registry — the hub's core product — renders almost no UI today, and
review verdicts, per-run cost, completion claims, and audit-adjacent records
are visible only as chat-panel feed rows.

The operator loop every page answers, in order (paperclip `DESIGN.md`,
adopted): **what is happening** (projection-only state, rendered verbatim from
hub records) → **does it need me** (record-backed attention surfaces, never
toasts for on-screen state) → **what do I do about it** (actions at the point
of scan; refusals rendered, never guessed — the rendered-deny rule).

## Decisions (operator, 2026-09-29 session)

1. **Landing = Overview.** The hub opens on the Overview page; Chat remains the
   working surface, one nav item away. `docs/OPERATOR_UI_DECISION.md` records
   chat-first as the 2026-09-15 product decision — that doc gets a dated
   supersession note (chat's role unchanged; the landing changes). History
   marked, not deleted.
2. **Visual implementation = keep the current approach.** Custom CSS + the
   theme/palette token system; no Tailwind, no shadcn/ui, no router library.
   Evidence for the call: the layout work is net-new shell + new pages written
   once either way, while Tailwind/shadcn adoption would add a restyle pass
   over ~8,000 lines of existing view TSX plus a token-translation layer to
   re-map 50 palettes onto shadcn's vocabulary. New chrome written against the
   existing tokens inherits all palettes with zero extra work.
3. **Scope = everything in `docs/HUB_DASHBOARD_UI_GUIDE.md`** (Tier 0 + Tier
   1), delivered as the phased sequence below. Desktop-first; deep responsive
   behaviour is out of scope.
4. **Shell shape = Approach A** (sidebar rail + pages + contextual panels) over
   B (extended top bar) and C (A + full reference chrome). C's ⌘K palette and
   rail-docked palette switcher are stretch goals, not commitments — hash
   routing + slash commands deliver most of the value.

## Design principles adopted from the references

- **Projection-only.** Every element renders a record the hub returned. No
  view-side derivation of attribution, freshness, linkage, or badge counts
  (the W153/W165 pins generalize: attribution comes from records; chrome may
  not guess).
- **Named absence.** Every degraded or empty state says why or names the
  first action ("no runs recorded yet — delegate a board task or fire a
  schedule"). Never a fabricated empty list; never a blank pane. The existing
  degraded copy in `activity-timeline.tsx` and `schedules-view.tsx` is the
  house pattern.
- **Status is systematic.** One semantic status vocabulary — extracted into
  `presenters.ts` as one status map for task, run, and freshness states —
  used identically in badges, rows, cards, and feeds. An operator learns it
  once.
- **Machine values look machine-made.** IDs, run keys, token counts, costs,
  timestamps render through the `presenters.ts` formatters (`formatRelativeTime`,
  `formatTokens`) in one monospace treatment; no per-view reformatting.
- **One name per concept.** Kernel *tasks*, provider *cards*, *runs*, *work
  products*. Copy does not blur them.
- **Badges are record-backed.** A nav badge renders a count the hub reported;
  no view-side estimation.
- **Empty states ship with the view.** Each new page names the first action.

## Shell architecture (Section 1, approved)

**New file `src/ui/webapp/shell.tsx`** owns the three regions (rail / header /
content). `app.tsx` (2,950 lines) sheds its shell markup; every hook and every
existing view file stays as-is.

- **Rail** — grouped nav: unlabeled working group (Chat, Board, Agents) →
  **Runs** (Runs, Reviews) → **Automation** (Schedules, Projects) → **Insight**
  (Usage, Activity, Audit) → Settings at the bottom. Overview sits at the top.
  Collapses to an icon rail (extends the existing hand-rolled SVG glyph set);
  collapsed state persists via the guarded-localStorage pattern
  (`issue-view-state.ts` precedent). "+" New thread moves into the chat page
  header (a chat action, not a global one).
- **Header** — per-page: page title, page-level actions, the existing
  `EnforcementBadge`; `PostureStrip` remains directly under it, content width.
- **Routing** — `AppView` gains `overview | runs | reviews | activity | audit`.
  Plain hash sync (`#/runs`), defaulting to `#/overview` with no hash; no
  router dependency. Slash commands gain `/overview /runs /reviews /activity
  /audit` (existing `/agents /schedules /board /usage /settings /chat` keep
  working).
- **Contextual detail panel** — one generic right-side panel in the shell; run
  detail, board card detail, and review verdict render inside it. Origin
  memory in `sessionStorage` (paperclip's `rememberContextualSidebarOrigin`,
  simplified): opened from the Board, back returns to the Board. Close = Esc
  or the close affordance; focus returns to the invoking row/card.
- **Badges (record-backed sources, all existing polls):** Board = registry
  `inProgress` keys already on the board payload; Runs = live count from
  `/snapshot` run tasks; attention = pending permission count
  (`usePermissions`, 1 s poll); Agents = session count (`useSessions`).

## Overview landing (Section 2, approved)

Five zones, all fed by data that already flows (no new backend surface):

1. **Stat strip** — live runs (`/snapshot` run tasks), in-review/in-progress
   count (the registry-sourced keys the board payload already carries),
   pending permissions (`usePermissions`), recorded spend (sum of per-run
   recorded `RunUsageSummary.costUsd`, labelled "recorded" — an aggregation
   of recorded values, never a live meter).
2. **Needs you** — parked permission prompts + review-gated runs awaiting
   verdict; each row links to its surface.
3. **Live runs** — running/recent run rows with status dots.
4. **Next fires** — the existing schedules poll (`formatScheduleFire`).
5. **Recent activity** — the timeline feed.

## Runs page + run detail (Section 2, approved — the flagship gap)

**Runs page** — every registry run, one row each (not schedule-lane only):
run id (monospace), origin attribution (`RunOrigin`: "fired by schedule S" /
provider-task, rendered verbatim), state, work-product link, recorded cost,
start/duration **only where the relay's record carries a time** — a record
without one renders "no recorded time" (the timeline house rule); the view
never derives duration from kernel transitions (projection-only). Filters:
origin, state. Empty state names the first action. Row click opens the detail
panel.

**Run detail panel** — header (run id, state, origin, workspace, start time);
tabs Summary · Timeline · Evidence · Review · Cost:

- **Summary** — usage labelled *recorded* (requests/tokens/cost; cache read +
  create rendered with their recorded lane asymmetry named — 0 on the OpenAI
  chat-completions lane, and the view says so), completion claim with its
  **verified-at-claim flag beside it** (the W114 honesty line made legible),
  work-product reference with provider-read liveness (W167 pill states).
- **Timeline** — the run's registry + kernel rows.
- **Evidence** — the task's evidence records under their run: origin tag
  (hub/`record`/workspace-path signpost), bounded content previews with every
  non-ready state named (loading / absent-evicted / unavailable).
- **Review** — five-axis verdict + blocking reason verbatim; reasoning-claim
  monitor metrics with `recall` and `timeToResponseMs` rendered as
  `unmeasured` (the registry's own comment forbids reporting them measured).
- **Cost** — the per-run `RunUsageSummary` in full.

**Data contract — new relay `/api/runs`** in `src/ui/web.ts`, same guard
pattern as the existing `/api/evidence` relay: relays the run-registry
projection (all run rows; origin; work-product link; review outcome +
blocking reason; completion claims; per-run usage; reasoning-claim findings +
metrics). Runs page, Reviews page, Overview tiles, and the detail panel all
read this one lane. A hub that predates the relay renders the named-absence
state.

## Reviews page (Section 2, approved)

One row per review-gated run: run id, origin, verdict (approved/failed/
pending), axes named by the verdict, blocking reason verbatim when the run
sits VERIFYING, recorded time. Row click opens the same detail panel on the
Review tab. The page exists so review discipline — five axes, anti-rubber-
stamp — is *browsable*, which is currently impossible.

## Activity page (Section 2, approved)

The W152 unified timeline (`ActivityTimelinePanel` + `/api/timeline`)
promoted from the chat panel to a page with kind filters (kernel / review /
gate / claim / usage / origin / budget — the existing `KIND_LABELS` set). The
retention statement copies the projection's line verbatim (in-memory; resets
on hub restart). The chat panel stays — the page adds filtering and scannability.

## Audit page (Section 2, approved, honestly scoped)

Renders the **recorded** authorization-adjacent lanes — the three the hub
actually keeps:

1. **Provider-read ledger** (W167 `recordProviderReads`): every provider read
   the hub recorded, with freshness states (today only pills on board cards).
2. **Kernel transition / gate log** (the timeline's kernel + gate rows).
3. **Review provenance** (`src/review/provenance.ts` fingerprinted records).

**Named absence at the page level:** operator permission decisions
(allow/deny) are resolved in-memory (`src/ui/permission-broker.ts`) and are
**not durably recorded** — the page states this boundary verbatim rather than
implying completeness. Recording permission outcomes hub-side is a recorded
follow-up, out of scope here. Relay: new `/api/audit` in `src/ui/web.ts`
(read-only; the three lanes; named absence when the hub predates it).

## Error handling

Enumerated degraded states (all rendered, all named): hub unavailable (keep
last-known rows + "the next poll retries"); hub predates a relay (named
absence with the reason the transport reported); empty tables (first-action
copy); evidence content not ready (loading / evicted / unavailable — the
existing `EvidenceContentPreview` states); provider-read pills not fresh
(dashed, per W167). Every refusal from an action routes through the existing
guarded POSTs and renders the structured refusal (`TaskRefusal` pattern).

## Testing strategy

- Red-first pins in the `test/webapp-surface.test.ts` style for each new
  page's contract: named-absence copy, badge sources, honesty renderings
  (claim flag, `unmeasured` metrics, cache asymmetry, audit boundary line).
- The status-vocabulary extraction into `presenters.ts` is pinned so all
  views (old and new) share one map.
- Focused suites only (`node --import tsx --test test/<file>.test.ts`); lint +
  typecheck exit 0. Never `npm test` (AGENTS.md operator resource directive).
- New relay routes get focused route tests mirroring the existing
  `/api/evidence` relay tests (guard behaviour + named absence).

## Sequencing (approved: everything, phased)

One branch family, one PR per phase so each is independently reviewable:

1. **Shell + Overview** — `shell.tsx`, hash routing, badges, collapsed rail,
   Overview landing; existing views re-homed; OPERATOR_UI_DECISION.md dated
   supersession note.
2. **Runs + detail panel** — `/api/runs` relay, Runs page, detail panel with
   tabs, status-vocabulary extraction in `presenters.ts`.
3. **Reviews + Activity + remaining Tier-1 surfaces** — Reviews page; timeline
   promoted to Activity page with kind filters; board card detail panel
   (reusing the W167 issue-detail surface); budget incident rows beside the
   AgentsView budget cards (from the posture poll's existing incident
   records); workspace-level branch/worktree strip on the Board header from
   the already-polled `/api/git` + `/api/worktrees` (workspace-level live
   state — never presented as a per-run record).
4. **Audit** — `/api/audit` relay + page with the stated boundary.
5. **Stretch** — ⌘K command palette, rail-docked palette switcher (only if
   phases 1–4 leave appetite; not committed).

## Out of scope

- Deep responsive/mobile behaviour (desktop-first; the PWA shell keeps working
  but narrow-screen patterns are a later concern).
- Hub-side recording of permission decisions (named-absence boundary instead;
  recorded follow-up).
- Tailwind, shadcn/ui, a router library, or any new runtime dependency.
- Multi-hub / remote dashboards (the hub is loopback-only today).
- Any change to view internals beyond re-homing (no restyling of existing
  views in this effort).

## Related docs

- `docs/HUB_DASHBOARD_UI_GUIDE.md` — the layout study + gap analysis this
  spec implements.
- `docs/OPERATOR_UI_DECISION.md` — receives the dated supersession note in
  phase 1.
- `docs/FEATURES.md` — statuses move to Complete only with linked evidence.
