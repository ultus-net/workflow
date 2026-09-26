<!-- Ledger fragment: extracted from TASKS.md at line 3951 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W119 - The abort tier sees every lane: the guard's usage snapshot aggregates the open-source pool (Complete - the W118-era blindness residual closed) (2026-09-24)

**Source:** the W118-era recorded residual (park P15 (c); the W118
item's residuals; PR #112's fresh-eyes round-1 P2):
composeSessionWithBudget wired the W045 budget guard with the OpenRouter
proxy's metrics only — the open lane's traffic was invisible to the
abort tier while the W118 downgrade activates on exactly that traffic.

**What landed:** `composeSessionWithBudget` gains an optional
`additionalUsage` snapshot; the field-wise `aggregateUsage` helper
(latestPromptTokens stays the primary lane's — display-only, no cap
reads it); the open-model-pool runtime site wired
(`openPool.metrics()`, the pool's cross-family aggregate); the
cline/goose sites unchanged and recorded (their only lane IS the
OpenRouter proxy — complete by construction); the azure direct path
unchanged (no local metering — the pre-existing honest statement).

**Acceptance criteria:**
- [x] The governed-lane pin: the violation reason echoes the AGGREGATED
      total ("total tokens 2100 > cap 1000" — primary 100 + pool 2000)
      through the real session semantics (submit -> event -> cancel ->
      sticky refusal).
- [x] Absent additional usage the snapshot is exactly as before (the
      helper returns `a` when `b` is undefined; the pre-W119 callers
      unchanged — pin (b) is the regression hold-out, green before AND
      after, NOT a red: the honest prediction correction).
- [x] 31/31 across session-budget (13) + open-model-proxy (6) +
      mutation-budget + opencode-server-budget + hub-rsi; lint +
      typecheck exit 0.
