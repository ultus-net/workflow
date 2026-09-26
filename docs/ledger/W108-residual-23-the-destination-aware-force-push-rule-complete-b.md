<!-- Ledger fragment: extracted from TASKS.md at line 3176 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W108 - Residual #23: the destination-aware force-push rule (Complete - both blind shell spellings resolved, lanes differ explicitly by policy, red→green pinned, dist probed) (2026-09-23)

**Source:** the pain-point queue's item 4 — SECURITY_ASSURANCE
residual #23 (the W101 round-7 watch-item): the shell lane's
force-push rules were destination-blind — any plus-prefixed push
refspec (and, discovered by the W108 iteration's exploration pass, the
`--force`/`--force-with-lease`/`-f` flag rule equally) classified
deny/destructive-operation even to the agent's own feature branch.

**What landed (vendored guard core + dist rebuilt):**
- The shape DETECTION stays regex (the same two shapes the blind rules
  matched, over the same three text variants); the VERDICT reuses the
  GIT lane's push-destination resolver — `pushedProtectedBranchIn` and
  `protectedBranchesIn` exported from git-policy and consumed by
  shell-policy (one grammar implementation, not a copy; the twin
  discipline).
- Resolution mapping: resolvable non-protected destination → allow
  (the recorded over-deny flips, both spellings); W084 tag publish →
  allow even when forced (the release-operation exemption now holds in
  both lanes — a deliberate behavior change, pinned); protected
  destination / wildcard / mirror → deny (fail-closed, unchanged).
- The `"unresolved-alias"` sentinel: a factless alias/default force
  push — the GIT lane maps it to its documented W090 fail-open allow
  (the W103 pins keep their as-found classification) while the SHELL
  lane maps it to deny: its force-push stance stays conservative where
  nothing is knowable. The lanes now differ EXPLICITLY by policy over
  the same grammar, pinned in both directions.
- `checkShellPolicy` gains a defaulted `GitPolicyContext` parameter;
  policy.ts threads the seat facts (the MCP schema already carried
  them). The destination-aware check runs after the generic destructive
  patterns (a compound's earlier destructive match still attributes
  first; the attribution-order shift for compounds mixing the
  post-push rules with a force push is recorded). Attribution corner
  (review round 1 P3): a command carrying BOTH force shapes (a
  plus-refspec and the force flag together) attributes the flag reason
  where the pre-fix pattern order attributed the plus reason — decision
  and policy unchanged, both reasons accurate.
- SECURITY_ASSURANCE #23 resolved-in-place (scoping corrected to both
  spellings); BRANCH_EXIT_POLICY's round-7 watch-item superseded with
  the stale shell-policy.ts cite corrected; the parity-log W108 entry.

**Evidence:** pre-change 14-row live probe against the pre-fix dist
captured every as-found deny (all feature-destination force shapes →
destructive-operation, forced tag publishes → deny, protected
destinations → the git lane's protected-branch-push attribution); pins
red-first ran 84/1 (EXACTLY the allow-flips test red; the preservation
test green as-found) then 95/0 (policy 85 + redirect 5 + mcp 5); dist
rebuilt and probed (12 cells match — a first probe run caught a STALE
dist, the LESS-0010 hazard applied mid-iteration); vendored typecheck
OK; repo lint/typecheck exit 0; security-assurance checker 7/0.

**Acceptance criteria:**
- [x] Force-pushes to resolvable feature destinations classify allow in
      the shell lane, both spellings, factless and with facts; wrapped
      forms inherit via the W102 recursion.
- [x] Force-pushes to protected, wildcard, mirror, or unresolvable
      destinations still deny; the factless fail-closed stance pinned.
- [x] Forced tag publishes follow the W084 exemption in both lanes
      (deliberate flip, pinned).
- [x] The lanes' differing policies over the same grammar are explicit
      and pinned in both directions; the twin discipline holds (one
      resolver implementation).
