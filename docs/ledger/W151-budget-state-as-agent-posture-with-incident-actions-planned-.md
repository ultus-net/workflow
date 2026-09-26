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
