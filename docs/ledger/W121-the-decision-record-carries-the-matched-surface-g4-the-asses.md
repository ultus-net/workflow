<!-- Ledger fragment: extracted from TASKS.md at line 3981 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W121 - The decision record carries the matched surface: G4, the assessment's F6 residual (Complete - matched threaded vendored -> server -> seat; absent-never-fabricated) (2026-09-24)

**Coordination provenance (the concurrent-agent relay, 2026-09-24):** the
W121 number was deliberately left unclaimed by the other agent's stream
(their W122 — the fail-closed-silence logging, my W118 residual (f) —
rides origin/fix/w122-budget-downgrade-logging with LESS-0045); this
iteration's lesson takes LESS-0046 accordingly, and the merge rule is
append-only in id order (LESS-0009) — either merge order leaves the id
sequence hole-free. The regions are independent: W121 is the vendored
guard core (mcp-toolbox/apps/workflow-guard-mcp/src + the seat), W122 is
the session-budget lane.

**Source:** the park file's P6 (the G4 matched-surface field) — the
agents-research assessment's F6 residual: the guard's structured record
carries rule ID + reason but the matched surface (path/command) is
embedded in reason text, not a separate queryable field (src/policy.ts's
decision type).

**What landed:**
- The vendored `GuardDecision` gains `matched?: string` — the concrete
  surface the rule matched (the command for shell/git lanes, the path
  for file/interpreter lanes, the toolName for mcp) — threaded through
  all four sub-modules (boundary/interpreter/git/shell deny returns) and
  policy.ts's own file_write/mcp sites (the composition sites return the
  sub-module objects directly, so matched propagates).
- Absent-never-fabricated: allows, the promotion-gate ask, the network
  ask, and secret-content carry NO matched (secret-content's surface is
  the content itself, not a queryable path/command; the reason carries
  it).
- The server's outputSchema + structuredContent carry it (conditional
  spread); the seat's `GuardDecision` normalization carries it (the
  vendored -> server -> seat chain complete).
- The interpreter lane's matched is the extracted payload path (the
  truthful in-scope variable — the executor's judgment over the spec's
  mis-scoped match[1], accepted).

**Acceptance criteria:**
- [x] Red/green: 3 deny pins red (the field absent), 91/91 after (6 W121
      pins: the protected-path/shell/read-only/interpreter matched + the
      allow/promotion-ask absent hold-outs); the seat suite 16/16 in the
      worktree; lint + typecheck exit 0.
- [x] The matched field is queryable per decision — the F6 residual's
      "embedded in reason text" closed for all five lanes.
- [x] The W120 freshness gate enforced the dist rebuild before hub-side
      verification (the dogfooding moment: the hazard W120 closed would
      have silently left this change unmounted).

**Residuals (recorded, not fixed):** the strict-recorder adjacency
(upstream #167) remains queued; the matched field's DISPLAY (the
webapp's guard-decision rendering) is not part of this slice — queued;
the seat's G2 part 2 (trustedRole) is a separate park entry (P6).
