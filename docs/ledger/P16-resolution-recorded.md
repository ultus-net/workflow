<!-- Ledger fragment: opened 2026-09-30 as the P16 resolution record (issue #295). Write-once — append dated supersession notes, never rewrite. -->

### P16 — the branch-exit/branch-pointer unification: resolution recorded (Closed — the recorded position STANDS; the residual scope closed as documented) (2026-09-30)

**Source:** parked P16 (`docs/PARKED_AND_LIMITATIONS.md` row P16, issue
#295). The decision input is
`docs/P16_BRANCH_EXIT_UNIFICATION_BRIEF.md` (the brief, 2026-09-30) and its
ledger fragment `docs/ledger/P16-branch-exit-decision-brief.md`; the queuing
sentence is W099's "deliberately NOT done" (`docs/ledger/W099-g5-*.md:26–29`);
the recorded position is the W100 policy doc
(`docs/BRANCH_EXIT_POLICY_2026-09-23.md`, frontier-ACCEPT at round 3).

**What landed (the decision):** docs-only — no src, no test, no dist change.
On 2026-09-30 the operator accepted the landed position:

- **The recorded position (Option A, landed as W101 on 2026-09-23) STANDS.**
  No further code change is authorized by this resolution; the brief's
  recommendation (take no further code change, brief §4) is the resolution.
- **The residual P16 scope is CLOSED as documented.** The pure-exit spelling
  asymmetry (`git switch <branch>` allowed vs `git checkout <branch>` denied
  on a protected seat — the policy doc's rows 3 vs 4, pinned by W099) stays
  **PINNED AS-FOUND**: a deliberate, recorded position, not drift.
- **The separately-queued `localBranches` seat fact (Option C) is NOT
  built.** Option B and Option C remain recorded in the brief (their
  pin-flip enumerations, rejection reasons, and trade-offs) as the re-open
  reference should the asymmetry ever be revisited.
- The P16 row carries the append-only dated resolution note and its
  status/approval cells are updated; the item leaves the parked queue per
  the file's rule (the operator resolved it), history preserved, nothing
  deleted. The brief carries a dated "Resolution recorded" note (§7).

**Evidence:** docs-only delta (the row note, the brief's §7 resolution note,
and this fragment); `npm run lint` and `npm run typecheck` are not applicable
(no compiled artifact touched). The landed state is the W101 protected-target
gate already on `main` — and is cited here, not modified: the gate in
`mcp-toolbox/apps/workflow-guard-mcp/src/git-policy.ts:186–477`, the parity-log
entry at `mcp-toolbox/apps/workflow-guard-mcp/docs/policy-coverage.md:286`,
the W099 pins (`mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts:752–801`
+ `test/redirect.test.ts:41–49`), the W101 red-first record
(`docs/ledger/W101-*.md:37–46`), and the policy doc's §7 implementation
addendum (`docs/BRANCH_EXIT_POLICY_2026-09-23.md:483–523`).

**Boundaries:** the pinned asymmetry is a recorded ergonomics cost (a one-word
spelling route, `switch` for `checkout`), not an integrity hole; the
pointer-write variant-retry surface it shadows was closed semantically by
W101. The open pointer-integrity lanes are P18's (ref-adjacent filesystem
routes, residual #21's remainder), not P16's.
