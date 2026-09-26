<!-- Ledger fragment: extracted from TASKS.md at line 2103 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W091 - T1 promotion gate: `workflow install` becomes guard-visible (frontier G3 part 1) (2026-09-22)

**Objective:** close the guard-invisibility finding from the agents-research
assessment: from an agent seat, `workflow install fleet [--force]` — the
sanctioned deployment of the fleet payload into the live control plane —
was baseline-allow while the equivalent `cp` into a live root is
guard-tamper-denied. The T1 tier says promotion is an ASK (operator
approval), never agent-auto-allow.

**Where:** `mcp-toolbox/apps/workflow-guard-mcp/src/policy.ts`
(`isPromotionCommand`, command-position recognition post-unwrap).

**Acceptance criteria:**
- [x] `workflow install [fleet [--force]]` returns **ask** with policy
      `promotion-gate` (T1: operator approval required); wrapper forms
      (`timeout 30 workflow install fleet`) stay recognized.
- [x] Command-position discipline: `echo workflow install`,
      `grep 'workflow install' notes.md` stay allow (argument data is not
      execution — the LESS-0012 class).
- [x] Known limitation pinned (review-round-1 P2 corrected): indirection
      (`npx workflow install`), nested shells/eval (`sh -c '...'` — the
      recognizer does not recurse), and case variants are NOT recognized —
      for those forms the promotion is unguarded AT THE SHELL LANE; the W090
      fact-mode T0 deny covers only the agent performing equivalent writes
      DIRECTLY into declared live roots (the installer's own in-process
      writes are tool-invisible to the guard). Pinned with a
      symlink-into-live deny.
- [x] Ordering pinned (review-round-1 P3): segment-level denies win over
      the promotion ask in compound commands (`destructive && workflow
      install fleet` reports the destructive deny, not the ask) — the
      promotion ask is evaluated after the deny-class policies.
- [x] Seat behavior unchanged by design: channel-less seats collapse the
      ask to deny-with-remedy (fail-closed — agent-initiated promotion now
      requires the operator's keyboard, the T1 property); the ask channel
      itself is G3 part 2.
- [x] Verifier: promotion pin RED against the unmodified tree (48 pass/1
      fail — only the new promotion-ask test failing, the command-position
      and backstop guards green pre-change), GREEN after the port; the
      compound-attribution pin RED before the ordering fix (49 pass/1 fail),
      GREEN after (59/0 across policy+mcp+redirect); guard typecheck OK;
      **dist rebuilt** (the LESS-0010 stale-dist hazard); repo lint +
      typecheck exit 0.
- [ ] Queued (one change per iteration): G3 part 2 (the ask channel —
      routing the ask to a human surface through the seats),
      G2 part 2 (`trustedRole`), G5 branch-exit pins, G4 matched-surface
      field, ostree `/var`-home fix, dist-freshness pin, `npm pack`
      verifier debt (human-gated).
