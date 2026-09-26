<!-- Ledger fragment: extracted from TASKS.md at line 2237 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W094 - Daemon guard wiring: the ask-hold becomes reachable on the stock server (frontier G3 part 2, wiring) (2026-09-22)

**Objective:** close W092's top queued item: the authority's guard-ask hold
(W092) is implemented and pinned but the stock daemon constructor
(`src/cli/opencode-server.ts`) passed no guard provider, so guard asks never
reached the hold in production. Wire the vendored guard into the daemon
(hub-precedent fail-closed composition, `src/cli/hub.ts` "no guard → refuse
to run"): the daemon composes `createDefaultToolboxGuardProvider` with its
workspace and passes it to `createOpencodeServerAuthority`.

**Where:** `src/cli/opencode-server.ts` (main() composition + an exported
`createOpencodeServerGuard(workspace)` helper for the composition pin).

**Acceptance criteria:**
- [x] The daemon composes the guard fail-closed: a guard startup failure
      rejects main() (the daemon refuses to run guard-less — the hub's
      "no hub, no mutations" posture).
- [x] The composed guard is the production path: through the REAL vendored
      server, `workflow install fleet` asks `promotion-gate` (the W091 rule
      + W090 enrichment live in the daemon's guard) — pinned via the
      exported helper.
- [x] Module-level guard behavior on the authority is already pinned
      (W092: hold/approve/reject/timeout/auto-resolve); the daemon-level
      end-to-end pin (spawn + permission.asked → hold) is queued with the
      dist-freshness pin.
- [x] Verifier: composition pin RED (the helper did not exist) then GREEN;
      daemon/authority/gateway suites green; repo lint/typecheck exit 0.
      Review round 1 [REVISE] fixed: a live-artifact anti-drift pin now
      proves main() wires the guard into the authority (the production
      composition had no other automated verifier - deleting the guard pass
      from the authority options fails the pin); guard.close() added to ALL
      post-composition failure paths (runtime creation, enforced-ruleset
      refusal, gateway failure, uncaughtException reap) - the hub precedent
      mandates explicit reaping, child self-reaps-on-EOF is inferred
      semantics; the component-doc addendum superseded the stale
      does-not-yet-pass-a-guard-provider claim with the dated W094 landing
      note; the credential-less composition residual recorded (inert today -
      the vendored guard consumes only HOME; the daemon must compose the
      broker if guard credentials are ever configured). Review round 2
      [APPROVE].
- [ ] Queued (one change per iteration): daemon-level end-to-end ask pin,
      the ask channel on the other four seats, the plane-3′ pending-ask
      surface, G2 part 2 (`trustedRole`), G5 branch-exit pins, G4
      matched-surface field, ostree `/var`-home fix, dist-freshness pin,
      `npm pack` verifier debt (human-gated).