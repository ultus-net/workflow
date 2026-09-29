<!-- Ledger fragment: P16's decision brief (docs-only; no src, no test change). Write-once landed record — append dated supersession notes, never rewrite. Live status lives in the GitHub Project and docs/PARKED_AND_LIMITATIONS.md row P16. -->

### P16 - The branch-exit/branch-pointer unification decision brief (Complete - brief recorded; the decision remains queued, the operator's call) (2026-09-30)

**Source:** parked P16 (docs/PARKED_AND_LIMITATIONS.md:45, issue #295) —
W099's "deliberately NOT done" decision ("allowlist all pure exits vs make
switch symmetric", docs/ledger/W099-g5-branch-exit-consistency-pins-complete-pins-landed-asymmet.md:26–29)
plus the W100 position (docs/BRANCH_EXIT_POLICY_2026-09-23.md,
frontier-ACCEPT at round 3). The 2026-09-30 wave's brief subtask
(session ses_f10ec0011ffc5Kg0ri8Xaw442B).

**What landed (docs only — no src, no test, no dist change):**
- `docs/P16_BRANCH_EXIT_UNIFICATION_BRIEF.md` — the decision INPUT, not
  the decision. It restates the recorded position with dated file:line
  citations (the W099 pins → the W100 decision statement §4 → the §7/W101
  landing), presents the options AS RECORDED — (A) allowlist pure exits
  (the recorded position, LANDED as W101 2026-09-23), (B) symmetric switch
  forms (recorded REJECTED in the policy doc's §5, presented with its
  rejection reasons), (C) the `localBranches` seat fact (implied by the
  policy doc §5's last bullet, "queued separately") — and for each gives
  the behavior delta, the pin-flip enumeration from the actual test cells,
  the security-posture delta (fail-closed direction), the migration/compat
  surface, the cost, and an executable implementation sketch (files, pin
  supersessions, verification plan). Recommendation: Option A stands
  (zero further code); the trade-offs are stated honestly and the brief
  says verbatim that the decision is the operator's.
- The brief's status correction (evidence-backed, and mirrored as an
  append-only dated note on the P16 row itself): the P16 row's
  "implementation not started" was STALE when the row was written
  (2026-09-24, W116) — the recorded position's implementation landed as
  W101 on 2026-09-23 (the protected-target gate in
  mcp-toolbox/apps/workflow-guard-mcp/src/git-policy.ts:186–477, the
  parity-log entry at the guard's docs/policy-coverage.md:286, the W101
  ledger fragment, the policy doc's §7 addendum). What P16 still queues is
  the residual decision scope: the pure-exit spelling asymmetry (the
  position doc's rows 3 vs 4 — `switch <branch>` allowed,
  `checkout <branch>` denied on a protected seat) and the separately-queued
  `localBranches` fact.
- `docs/PARKED_AND_LIMITATIONS.md` row P16 — the dated pointer note
  appended (brief exists; decision remains queued; the landed-state
  correction), formatted after the P15/P18 partial-landed note pattern.

**Pin-flip enumeration (the brief's §3):** the W099 set = 12 active cells
+ 1 W101-superseded cell across 4 policy tests
(mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts:752–801) + 1
redirect pin (test/redirect.test.ts:41–49). Option A flips 0 further (the
one required flip — `checkout -B <feature>` on a protected branch
deny→allow — already happened in W101 with its dated supersession note at
policy.test.ts:785–790). Option B flips 1 classification cell
(`git switch feat/g5` on main, policy.test.ts:769) + the redirect
guidance's "or switch to" clause (src/redirect.ts:21). Option C flips 1
deny cell (`checkout feat/g5` on main, :776–778) into fact-qualified
allows and adds the seat-fact surface. The W101 block's 17 pin tests are
inverted by no option.

**Evidence:** docs-only delta (the brief + the row note + this fragment);
`npm run lint` and `npm run typecheck` exit 0 unpiped on the branch tip;
no src/test/dist file touched (the guard core's landed state is cited, not
modified). The decision itself remains queued — the brief is the input;
the operator decides.
