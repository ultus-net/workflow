# W200: M6 — the learner-profile lock is an availability boundary

Status: implemented, pending CI.

## Problem

`integration-plan.md` §F item 2 records a defect flagged by recon R2: two writers
share one `learner-profile.json` path — `src/pedagogy/learner-profile.ts` and
`mcp-toolbox/apps/learning-mcp/src/learner-profile.ts` — and each acquires the
same `<path>.lock`. The severity was corrected during recon: this is **not** a
corruption bug. Both writers persist with an atomic 0600 temp+rename, so a lost
race cannot tear the file.

The real defect is **availability**:

- `openSync(lockPath, "wx")` throws on the first `EEXIST`. Two overlapping
  sessions (a tutored session and a pedagogical coding session) meant one of them
  failed outright with `Learner profile is currently locked by another process`.
- There is no stale-lock recovery. A crash between `openSync` and the PID write,
  or a `SIGKILL` after it, strands the lock forever, and the only remedy the
  error text offers is "Remove stale lock if process terminated" — an operator
  action for a machine-detectable condition.

The install plan's M6 acceptance check is exactly this: "concurrent tutored
session + pedagogical coding session finish without lock errors; ... only one
process opens the lockfile."

## What shipped

Both writers keep the **single-writer exclusive-create lock** — ownership is
unchanged, whoever holds the lock does the read-modify-write — and gain two
recoveries:

1. **Stale reclaim.** `lockIsStale()` reads the lock's PID. A lock that vanished
   under us, holds no readable PID (crash mid-acquire), or names a process that
   is gone (`ESRCH`) is reclaimed and acquisition retried. A live PID, including
   one owned by another user (`EPERM`), is treated as live and never stolen. The
   reclaim is bounded (`MAX_STALE_RECLAIMS`) so an unreclaimable lock fails
   loudly instead of spinning.
2. **Bounded retry.** A live holder is waited on up to `timeoutMs` (default
   5000ms, 25ms between attempts) via a synchronous sleep, so two overlapping
   sessions **serialize** rather than one throwing. Past the deadline the
   documented error is still thrown — a genuinely stuck holder must surface, not
   block forever.

`updateLearnerProfile` gained an optional third argument,
`LearnerProfileLockOptions { timeoutMs?, retryDelayMs? }`, defaulted so existing
callers are unchanged. The two implementations are mirrored deliberately: the
toolbox app is a standalone pnpm package and cannot import the plane module, so
the contract is held by a test on each side rather than by shared code.

## Evidence

- `test/pedagogy-learner-lock.test.ts` (plane, registered in `test/ci-suites.txt`
  sorted): a dead-PID lock is reclaimed; an empty lock (crash mid-acquire) is
  reclaimed; an overlapping second writer lands and the merge is monotonic with
  both writers' evidence preserved; a live lock held past the timeout throws the
  documented error.
- `mcp-toolbox/apps/learning-mcp/test/learner-profile-lock.test.ts` (toolbox,
  run by the gate's `toolbox:verify`): the same dead-PID and empty-lock
  reclaims, and a timed-out acquire that neither clobbers the holder's lock nor
  writes a partial profile.
- `test/pedagogy-learner-profile.test.ts` and the learning-mcp suite still pass.
- Local: `tsc --noEmit` clean, `npm run build` clean, eslint clean,
  `ci-suites-manifest` green, `pnpm --dir mcp-toolbox/apps/learning-mcp run
  verify` green (19 tests).

## Scope decisions

- **One writer, not a client.** The plan offered "learning-mcp owns the file;
  `src/pedagogy` becomes a client **or at least retries**". Making `src/pedagogy`
  a client of the MCP server is an architectural move (it would spawn/attach the
  stdio server from the pedagogy module) that is out of scope here and should be
  a separate decision. The sanctioned floor — "at least retries", plus stale
  recovery — is what landed, and it is enough to satisfy M6's acceptance check.
- **Live holders are never stolen.** Stale detection is deliberately
  conservative: only a provably-absent (ESRCH) or unreadable PID is reclaimed.
  Age alone is not used, because a slow legitimate holder would then be robbed.

## Follow-ups

- If a single-writer *client* model is still wanted, take it as its own ledger
  entry (it changes process topology for the pedagogy module).
- M6's second half — "wire the tutor module to record evidence via the
  gateway" — depends on the M1 gateway lane and is not part of this lock fix.
