<!-- Ledger fragment: extracted from TASKS.md at line 1440 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W078 - `workflow doctor`: honest self-check of the operator's setup

**Objective:** One command that states the truth about the local setup — settings docs parse,
credential presence (booleans, never values), hub/gateway reachability, containment posture
(enforced vs policy-only), and per-surface probe verdicts from `docs/HOST_ADAPTERS.md` — surfaced
fail-loud, matching the honest-claims culture. Idea adopted from oh-my-openagent's `doctor`
(pattern only; SUL-1.0 upstream, no code).

**Depends on:** none.

**Acceptance criteria:**
- [x] `workflow doctor` checks: settings files parse (global + workspace overlay), credential
      presence per agent (presence booleans only), hub reachability (discovery + probe), server
      topology gateway reachability, containment backend report, and prints each surface's
      probe-PENDING verdicts with their gates. (**Complete 2026-09-21**: all six checks live in
      `src/cli/doctor.ts` — the containment backend report was the last missing piece (`checkContainment`:
      linux enforced-capable with bwrap present, a warn when the bwrap binary is missing since
      contained launches fail closed at spawn, and the typed policy-only passthrough on non-Linux,
      never claimed as enforced) and probe verdicts print from the register with their gates.)
- [x] Every check is pass/warn/fail with an actionable fix line; nothing silently passes.
      (**Verified 2026-09-21** against the report composition and its pins.)
- [x] Focused tests pin the report composition; typecheck and lint clean; five-axis review.
      (**Verified 2026-09-21**: `test/doctor.test.ts` (6) + the register suite; typecheck/lint
      clean; the five-axis review of 2026-09-21 covers the doctor surface — APPROVE recorded for
      this pass, including the register-driven gate catalog and the containment check.)

**Follow-up (2026-09-20, W078 follow-up — the machine-readable probe verdict register):**
the doctor reported probe gates from a hardcoded list that had already drifted (it named 8
families while the test corpus carries ~30 gate-style probe files), and the dated verdicts lived
only in prose — documentation and runtime claims had no shared record. The register makes the
verdict state durable and machine-checkable:

- [x] `docs/PROBE_VERDICTS.json` (schema v1, fail-closed validation in
      `src/integrations/probe-verdicts.ts`): one dated row per gate — host + version of record,
      probe file, gate env, date, result (`green`/`red`/`negative`/`pending`/`blocked`),
      enforcement posture the verdict supports, evidence write-up, and a required blocker for
      every `blocked` row (the missing operator environment/credential). Seeded with 42 rows
      covering every gated probe family: dated greens (OpenCode ACP 2026-09-16, goose 1.50.1
      2026-09-17, topology M1/webUI/compact on v2.0.10 2026-09-20, scheduled turn, vendored-Cline
      3.0.61 era), the Cline subagent Red, the goose subagent-hooks Negative, and the honestly
      blocked family (remote ACP bridge, model-key permission probes, open-model live, stock-Cline
      auth, azure metered) — item 5 of the operator's list now has a durable machine-readable home
      instead of prose-only blockers.
- [x] Bidirectional anti-drift pin (`test/probe-verdict-register.test.ts`): every register row's
      probe file must exist AND still name its gate, and every gate-style `WORKFLOW_* === "1"`
      probe file in the test corpus must have a register row — adding a gated probe without
      registering it, or renaming/removing a gate the register records, fails the suite. Fail-closed
      schema drift cases pinned (version, dates, enums, duplicate ids, deleted probe file,
      blocked-without-blocker).
- [x] Doctor reads the register (`checkProbeVerdicts`, replacing the stale hardcoded
      `checkProbeGates` list): renders the tally and which gates are armed right now, surfaces
      pending/blocked as a warn with the run-a-probe fix line, and fails loud on a corrupt or
      drifted register. Doctor's own pin (`test/doctor.test.ts`) updated to the register-driven
      composition.
- [x] Five-axis review for this follow-up slice. (**Done 2026-09-21: APPROVE** recorded by a
      fresh-context secondary reviewer across all five axes, no P0-P2 findings, six P3s — the
      register's `updated` stamp predating its newest row, optional-field typing, the doctor fix
      line for blocked rows, the corpus-scan heuristic limits, awkward fail wording, and a cheap
      non-gated unit pin for the server-runtime composition. **Fixed in this slice:** the stamp
      bumped and a validator rule added (`updated` can never predate the newest verdict date —
      fail-closed, test-pinned), optional `blocker`/`note` fields now type-checked fail-closed,
      the probe-path pattern widened to subdirectory probe files, the scan heuristic's documented
      limits stated in the anti-drift test, and the doctor fix line now routes blocked rows to
      their named blocker instead of an impossible "run the probe". **Accepted residuals:** the
      flat corpus scan stays (documented); the server-runtime composition spread is covered by the
      shared `meteredOpencodeConfig` pin plus the gated live probe rather than a dedicated
      non-gated unit.)

**Verification (2026-09-20, widened 2026-09-21):** `test/probe-verdict-register.test.ts` (5) +
`test/doctor.test.ts` (5) — 10/10; typecheck, lint, and build clean. Focused-run per the
operator resource directive (no full-suite run).
