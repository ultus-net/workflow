<!-- Ledger fragment: extracted from TASKS.md at line 2151 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W092 - The ask channel part 1: guard asks join the operator hold on the primary seat (frontier G3 part 2) (2026-09-22)

**Objective:** close the ask-collapse half of frontier G3 for the primary
transport: the opencode-server authority's `ask-me` mode already holds
policy-allowed asks for the operator (M3: parked holds, fail-closed timeout,
gateway-intercepted operator replies reconciled tighten-never-loosen) — but
the **guard's** `ask` short-circuited to deny before the hold could apply.
The change: in `ask-me` mode a guard `ask` joins the operator hold (mapped
to a held allow the operator answers — approve = the T1 ask answered,
reject/timeout = fail-closed tighten); in `auto-resolve` mode it stays a
documented deny (no operator is attached to answer). **Scope honesty
(review-round-1 P2): the authority path is complete and pinned, but the
stock daemon does not yet receive guard asks** — the only production
constructor (`src/cli/opencode-server.ts`) passes no guard provider, so
**daemon guard-wiring is the top queued item**; the W091 promotion gate is
the named producer once wired. The ask branch also generalizes beyond
promotion-gate by design (e.g. the network `external-side-effect` ask now
holds in ask-me mode instead of instantly denying).

**Where:** `src/integrations/opencode-server-authority.ts` (the `decide`
guard branch only). The other four seats' ask collapse is queued
(documented per-seat).

**Acceptance criteria:**
- [x] ask-me: guard `ask` is held (`pendingOperatorReplies` = 1); operator
      approve → delivered allow/once with the guard policy in the reason;
      operator reject → delivered reject; timeout → reject (fail closed).
- [x] auto-resolve: guard `ask` fails closed to deny with the ask
      provenance and the no-operator-channel statement; `pendingOperatorReplies`
      stays 0.
- [x] Guard deny is answered immediately, never held (both modes).
- [x] Verifier: W092 pins RED against the unmodified tree (27 pass/4 fail —
      all four hold-behavior tests), GREEN after the edit (31/0); held-out
      suites 51/0 (opencode-server-gateway, hub-guard-interception,
      guarded-process); repo lint/typecheck exit 0.
- [ ] Queued (one change per iteration): **daemon guard-wiring** (the stock
      `opencode-server` constructor passes no guard provider — the top item),
      the ask channel on the other four seats, the pending-ask surface in
      the operator UI (plane 3′), G2 part 2 (`trustedRole`), G5 branch-exit
      pins, G4 matched-surface field, ostree `/var`-home fix,
      dist-freshness pin, `npm pack` verifier debt (human-gated).
- [x] Residuals recorded (review round 1): a held guard ask blocks the SSE
      loop up to the hold window (delayed alarms, not false ones — the
      pre-existing serial-hold residual widens; noted in
      `docs/OPENCODE_SERVER_AUTHORITY.md`); the ask branch generalizes
      beyond promotion-gate (network `external-side-effect` asks now hold
      in ask-me); the guard-deny-never-held pin covers ask-me only (the
      deny branch is mode-independent by construction).
