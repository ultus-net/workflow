<!-- Ledger fragment: extracted from TASKS.md at line 3834 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W120 - The dist-freshness gate: the vendored seat cannot mount (or test) stale policy (Complete - the W097-queued pin landed; LESS-0010's hazard closed) (2026-09-24)

**Source:** the park file's P6 (the W097 queue's "dist-freshness pin")
+ LESS-0010's en-route hazard: the hub-side tests ran a stale
vendored-guard dist because the test's ensureBuilt rebuilt only on
ABSENCE — a vendored-guard src change after the last build left the
enforcement seat executing pre-change policy; a hash/mtime check was
queued.

**What landed:** `guardDistIsStale(root)` (the app's src walk vs the
dist mtime); the runtime seat throws fail-closed via the injectable-root
`defaultToolboxGuardServerPath` (naming the remedy); the test's
ensureBuilt self-heals (rebuilds when stale — the hazard's origin fixed
at its origin).

**The live-tree probe (LESS-0039, with a probe-design miss recorded):**
the committed dist/server.js mtime predated src/policy.ts by a day (the
mtime staleness fact); the pre-rebuild artifact was overwritten before a
content comparison could run — the semantic staleness is
probable-but-unproven (the timeline supports it: the src's last commit
f95b4c1 landed Sep 23 22:29 (+1200); the pre-rebuild dist (mtime Sep 23
early) predated it — the rebuilt dist carries `pushedProtectedBranchIn`
(the W108 destination-aware rule), so the old seat was probable-stale).
The remedy: the runtime seat throws fail-closed (naming the remedy) and
the test's ensureBuilt self-heals (rebuilds when stale). The mtime
false-positive class (git checkout touches mtimes) is documented —
fail-closed is the deliberate direction.

**Acceptance criteria:**
- [x] The W097-queued dist-freshness pin landed: 5 pins (the stale
      fixture, the fresh fixture, the runtime throw naming the remedy,
      the runtime throw naming `toolbox:build`, and the real-tree
      conditional pin asserting the checked-out dist is fresh).
- [x] Red/green: the pins red at module level (the export absent),
      12/14 after the implementation (the orchestrator's fixture slip —
      the missing mcp-toolbox segment — diagnosed by the executor's
      evidence), 14/14 after the fixture repair; lint + typecheck exit
      0; the consumer suite (hub-guard-interception) green.
- [x] The test's ensureBuilt self-heals: a stale dist rebuilds before
      the suite exercises the server (the LESS-0010 hazard's origin
      fixed at its origin).
- [x] The runtime seat throws fail-closed on staleness (the enforcement
      composition cannot silently run pre-change policy); the mtime
      false-positive class documented.
