<!-- Ledger fragment: opened 2026-10-06 as a post-freeze W-item backfill (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### W167 - Issue detail + external-reference liveness (read-only issue surface) (Complete) (2026-09-28)

**Source:** GitHub issue #319 (closed 2026-09-28); spec `docs/superpowers/specs/2026-09-26-paperclip-dashboard-borrowings.md:283` (W167 section); landed in PR #329 (merge 2026-09-28T01:13:45Z, commit `7cc61bef`, 2026-09-28).

**What landed:**

- `src/integrations/issue-detail.ts` (312 lines): the read-only hub-side issue read (thread + description, per-row shape guard, honest failure states) plus `ProviderReadLedger` (`createProviderReadLedger(now)`, `recordProviderReads`). `classifyProviderRead(status)` maps 401/403 -> `requires-auth` and everything else -> `unreachable`; `ProviderReadOutcome = "ok" | "requires-auth" | "unreachable"`.
- The liveness pills (Fresh / Stale / Requires-auth / Unreachable) derive ONLY from the recorded provider read, using the hub clock at record time (`boardLinkLiveness` / `presenters.ts`); a not-fresh link renders dashed; an unconfigured hub records nothing and therefore shows no pill. No attribution the records do not carry.
- Read-only: no write seam in the issue-detail path (operator-authored comments, if ever taken, are a separate dispatch class — not assumed here).

**Evidence:** `test/issue-detail.test.ts` 15/15 (fresh/stale per `BOARD_LIVENESS_TTL_MS`; the read-ledger isolated; attribute-free projection; requires-auth/unreachable classification). The hub-dashboard redesign later reuses this surface in the board card detail panel.
