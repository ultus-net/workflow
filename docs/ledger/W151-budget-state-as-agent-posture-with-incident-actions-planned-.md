<!-- Ledger fragment: extracted from TASKS.md at line 5559 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W151 - Budget state as agent posture with incident actions (Planned - Paperclip borrow wave 2; spec Wave 2) (2026-09-26)

**Source:** Paperclip costs/dashboard guides, mapped onto W045 session-budget guard state (mechanism, caps, sticky violation), W118 warn-tier stage, W111 usage views. Per-session budget bar with tier colorization (green under warn, amber at warn, red at abort), a paused-by-budget badge when the sticky violation is installed, and an incident card with two authority-gated actions: keep stopped (acknowledge) and raise cap and resume — dispatched as application-authority proposals, never direct mutations.

**Acceptance criteria:**
- [ ] Posture badge renders only from recorded tier state; no configured caps renders an honest "no local cap" state (not a fabricated 0%).
- [ ] Raise-cap and resume fail closed when the authority withholds the capability (test proves the denial renders).
- [ ] Tier boundaries derived from the same constants the guard enforces (no duplicated thresholds in the UI).

**Residuals (cut):** no three-layer budget scopes, month-rollover, finance ledgers, or provider quota windows — no subscription billing model exists here.

**Dated note (2026-09-27, deferred — the wave-1 PR carried W150 + W153's registry slice instead):** the
badge slice is NOT render-only from existing webapp state — the hub's
per-session budget state (mechanism + the sticky violation,
`src/ui/web-sessions.ts:461-465`) is served per-session on `/api/session`
and the sessions LIST route carries neither, so the badge needs a real
per-session budget data path in the webapp before it can render recorded
tier state honestly. Deferred with that plumbing scoped rather than
half-built: the projection side is already prepared
(`operator-posture.ts` accepts `budgetIncidents` and pins the decision rows
with W045 authority attribution), so the badge's data path is the remaining
work. Criterion 3's shared-constants rule is noted for that implementation:
tier boundaries must derive from the guard's own constants.

**Dated note (2026-09-27, wave-2 PR — the badge slice landed):** the
per-session budget data path + badge/bar/incident card landed. The sessions
LIST route (`/api/sessions`) now carries each session's recorded posture:
effective caps (env budget merged with the session's persisted raise), the
recorded usage readout, the live sticky refusal, and the tier derived by the
guard's OWN predicates (`sessionBudgetTier` in session-budget.ts — abort is
exactly `budgetViolation`, warn is exactly `budgetDowngradeActive` at the
W118 downgrade fraction, so no threshold constant lives in the UI; tier is
absent when no caps are configured and "unknown" when caps exist but the
usage axes are incomplete). The agents view renders the tier-colored bar, the
`paused: budget` badge exactly when the sticky refusal is recorded, and the
incident card: "raise cap and resume" dispatches a trusted operator mutation
(`POST /api/sessions/budget-raise` → the manager respawns the runtime under
the merged caps, persisted on the record so later spawns keep them) and its
denials render verbatim (no local guard, not paused, malformed raise, failed
respawn) — criterion 2 pinned at the manager, the route, and the render
levels. "Keep stopped (acknowledge)" is the EXPLICIT NO-OP the card states in
text: an acknowledge button that mutated nothing would be a fake action, and
persistent ack/dismissal state is cut per the spec's row-10 line. Residuals
still open: the HUB's /snapshot posture still passes no `budgetIncidents`
(the strip's budget-incident count keeps its honest "—" until the hub builds
per-session incidents from the session registries — a separate wave's
plumbing), and the new focused suites' `test:ci` inclusion still rides a
manifest-touching PR after the guard's preflight lockfile false positive is
fixed at source (the heuristic lives in the opencode-workflow-guard plugin
repo, not this repo's toolbox copy).
