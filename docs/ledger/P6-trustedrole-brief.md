<!-- Ledger fragment: P6's trustedRole decision brief (docs-only; no src, no test, no vendored-guard change). Write-once landed record — append dated supersession notes, never rewrite. Live status lives in the GitHub Project and docs/PARKED_AND_LIMITATIONS.md row P6. -->

### P6 - The G2 part 2 `trustedRole` supply decision brief (Complete - brief recorded; the decision remains the operator's, Q5 open) (2026-09-30)

**Source:** parked P6 (`docs/PARKED_AND_LIMITATIONS.md:35`, operator-approved
2026-09-24) = "W097's queued list", item 4 "G2 part 2 (`trustedRole`)".
Issue #285 (the last open P6 item). Dispatched as the P6 trustedRole-brief
subtask of the 2026-09-30 wave, branch `feat/p6-trustedrole-brief`, based on
`origin/main` @ `a06139d2`. Predecessor: `docs/P6_SEATS_ASK_DESIGN_BRIEF.md`
§5 / Q5 (2026-09-30) framed the question and deliberately did not decide it.

**What landed (docs only — no src, no test, no vendored-guard, no dist change):**

- `docs/P6_TRUSTEDROLE_BRIEF.md` — the DECISION INPUT, not the decision. It
  states precisely what supplying `trustedRole` changes, who asserts it, from
  which metadata, the trust boundary, and whether/how it could weaken the
  fail-closed posture; then the options, their residual risks, and a
  recommendation. Truth is pinned to file:line.

**Substantive findings the brief records (each cited in the brief):**

- **The field is deny-only.** `isReadOnlyRole`
  (`mcp-toolbox/apps/workflow-guard-mcp/src/policy.ts:54-58`) matches a closed
  token set (reviewer/planner/advisor/critic/explorer/scout/evaluator) by
  substring and can only ADD a deny on git/shell mutations (`policy.ts:141-147`)
  and `file_write` (`:194`); it cannot turn a deny into an allow. So supplying
  it cannot loosen any guard decision (`policy.ts:113-148`, `:186-195`).
- **The seat supplies none today.** `guardInputFromToolCall`
  (`src/integrations/mcp-toolbox-guard.ts:331-382`) is role-less; the
  enrichment seam fills only branch/live-root facts
  (`mcp-toolbox-guard.ts:106-132`, `:256-304`); the deferral is verbatim at
  `mcp-toolbox-guard.ts:253-254`.
- **The ACP permission resolver carries no trusted role.** Its request params
  (`src/adapters/acp-permission.ts:10-20`) and correlation
  (`acp-permission.ts:22-28`, assembled at `src/integrations/acp-session.ts:649-661`)
  carry session/task/tool/capability but NO role; the request's
  title/kind/rawInput/locations are the agent-influenced class
  (`src/adapters/acp-workflow-resolver.ts:121-128`). A literal "supply from the
  resolver's trusted metadata" has no trusted source and would require a new
  trusted input.
- **Options.** (i) leave unsupplied (status quo; fail-closed preserved; the
  guard role lane stays inert — but the one read-only seat today, the hub
  reviewer, is already read-only below the guard via `new Set(["read"])` at
  `src/cli/hub.ts:155` and `src/review/rubric.ts:88-92`); (ii) supply a new
  trusted composition-time role through the resolver (NOT from wire metadata),
  wider plumbing and a provenance-honesty risk; (iii) a narrower alternative —
  one trusted composition root, one designated read-only seat, a static literal
  role (dedicated guard provider or per-call fact), the shared provider
  unchanged.
- **Recommendation (the decision stays the operator's):** (i) is the correct
  default now; (iii) is the only non-fabricating forward path if the operator
  wants the lane live; do not implement (ii) as literally scoped. Core
  trade-off: honest provenance + no new trust surface (i) versus a
  defense-in-depth screen at the cost of a new trusted constant + a composition
  seam (iii).

**Verification status:** docs-only. `npm run lint`, `npm run typecheck`, and
`npm run build` are **not applicable** and are **not claimed** (stated in the
brief §7). No red-first pin exists or is fabricated; a future implementation
pins the role reaching `guardCheck` and a read-only role's mutation denying.

**Evidence:** `docs/P6_TRUSTEDROLE_BRIEF.md` (new); the dated note appended to
the P6 row (`docs/PARKED_AND_LIMITATIONS.md:35`); `git diff --stat` on branch
`feat/p6-trustedrole-brief` shows docs only. Issue #285's `trustedRole` (G2
part 2) item has its decision input recorded; the decision (Q5) stays OPEN and
is the operator's. G2 part 2 is not closed by this brief — the supply itself
remains unimplemented pending Q5.
