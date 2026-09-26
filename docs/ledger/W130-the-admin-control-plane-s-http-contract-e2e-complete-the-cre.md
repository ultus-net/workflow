<!-- Ledger fragment: extracted from TASKS.md at line 4586 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W130 - The admin control plane's HTTP contract e2e (Complete - the credential-custody surface's token gate, mutation validation, audit trail, and value-never-echoed rule are executable for the first time) (2026-09-25)

**Source:** the operator's standing e2e direction ("continue with e2e
testing setup"), landing on the stream's security surface: the admin
control plane holds the operator's secrets (credential custody), and
W126's sweep had only proved boot + teardown — the token gate, the
trusted-mutation refusal, the body validation, and the audit trail were
never exercised over the compiled seat.

**What landed:** `test/e2e-admin.test.ts` — the compiled
`dist/cli/admin.js` driven end to end (WORKFLOW_ADMIN_PORT=0 +
WORKFLOW_ADMIN_TOKEN as the env seam, redirected HOME so the credential
config lands in a tmp tree): the public page (200, CSP with
frame-ancestors 'none'), the token gate (anonymous → 401 "admin
capability required"; a WRONG token of the right length → 401 — the
timing-safe comparison path; unknown route → 404), the trusted-mutation
gate (an authed cross-origin PUT → 403 BEFORE the body is read), the
content-type (415) and body (400) validation, the happy path (store →
list METADATA ONLY — the secret value never echoed, asserted
field-by-field and against the whole process output — → revoke → the
definition deleted per credentials.ts:145), the audit trail's set/revoke
lines, and the clean SIGTERM shutdown (exit 0).

**Acceptance criteria:**
- [x] Green on the first run against the observed contract; the
      post-revoke pin tightened from a compound OR to the real semantic
      (revoke DELETES the definition — credentials.ts:145) after reading
      the source.
- [x] The value-never-echoed rule is a first-class pin: the listing's raw
      body never contains the secret (the channel-completeness check) and
      the parsed entry carries metadata only — plus the process-output pin.
- [x] 1/1 e2e green; lint + typecheck exit 0.
- [x] The LESS-0051 safety contract: no agent/PTY spawns, redirected
      HOME (the credential config isolated), ephemeral port,
      process-group SIGTERM with a SIGKILL backstop, no spawnSync for the
      daemon.
- [x] The round-2 review REVISE'd the after-hook with a verified blocker:
      the comment claimed node:test runs after hooks in REVERSE
      registration order — FALSE (the runner executes them in declaration
      (FIFO) order; verified against lib/internal/test_runner/test.js and
      nodejs/node#48736), so the revoke ran AFTER the home rmSync. Fixed:
      the registration order is now revoke → kill → rmSync (FIFO = the
      intended execution order), the comment states the verified truth,
      and the revoke's gating (storedCredential + a live server) is
      unchanged. The round-2 P3s: the revoke audit line is now bound to
      the credential id, the listing's raw body is checked whole for the
      secret (channel completeness), and the "field-by-field" wording
      corrected.

**Residuals (recorded, not fixed):** the audit's rollback path
(credentials.ts:146-149 — a failed onDefinitionsChanged) is unexercised;
the admin page's browser-side flows (the editor dialog) are pinned only
at the API contract level; the browser-style same-origin PUT variant is
unpinned (node fetch's no-Origin shape is the pinned trusted path).
**The keyring honesty (the round-1 review's P2):** the redirected HOME
confines only the credential CONFIG file — the secret MATERIAL is stored
by createSecretServiceStore through `secret-tool` into the operator's
LIVE system keyring; the e2e stores one w130-prefixed test credential
whose cleanup is the in-test DELETE plus an after-hook best-effort
revoke, and a failure between the PUT and the cleanup can orphan that
keyring entry. The surface is also MACHINE-GATED on secret-tool + an
unlocked keyring (without them the PUT 400s and the test fails closed —
visible, never skipped).
