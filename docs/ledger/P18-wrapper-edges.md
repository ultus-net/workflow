<!-- Ledger fragment: opened 2026-09-30 as a post-freeze record (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### P18(a) wrapper-transparency class closure — the exotic-interpreter edges (2026-09-30)

**Source:** `docs/PARKED_AND_LIMITATIONS.md` row P18 (operator-approved 2026-09-24), GitHub issue #296; `docs/SECURITY_ASSURANCE.md` residual #20's queued edges. Dispatched as the `feat/p18-wrapper` subtask off `origin/main@61fe0614`. The base already carried the landed P18 waves — the busybox nesting asymmetry + `xsh` (P18(b), `feat/p18-guard`), the `-c=` EQUALS spelling pinned allow (P18(c)), and the direct-`.git`/env-gitdir/boundary-refine/option-spelling routes (`feat/p18c-ref-routes`, `feat/p18-gitdir-edges`, `feat/p18-boundary-refine`, `feat/p18-gitdir-spelling`). This fragment records the REMAINING gap inside edge (a) and the assessment of (b) and (c) as found.

**What was still open (as found, 2026-09-30):** the P18(b) wave closed busybox + `xsh` by ENUMERATION — `/^(?:ba|z|da|k|x)?sh$/i` — and applied it at only two of the four copy sites (`git-policy.ts` `wrapperCommands`, `shell-policy.ts` `interactiveReason`). `boundary-policy.ts` (two sites: `shellHasFileMutation`, `checkBoundaryPolicy`) still carried the pre-`xsh` regex `/^(?:ba|z|da|k)?sh$/i`. Every shell name outside the enumeration bypassed ALL FOUR sites:

```text
# verbatim red capture — probe against the unmodified src (currentBranch: main)
allow   baseline  "ash -c 'git commit -m x'"     {"currentBranch":"main"}
allow   baseline  "mksh -c 'git commit -m x'"    {"currentBranch":"main"}
allow   baseline  "pdksh -c 'git commit -m x'"   {"currentBranch":"main"}
allow   baseline  "oksh -c 'git commit -m x'"    {"currentBranch":"main"}
allow   baseline  "lksh -c 'git commit -m x'"    {"currentBranch":"main"}
allow   baseline  "csh -c 'git commit -m x'"     {"currentBranch":"main"}
allow   baseline  "tcsh -c 'git commit -m x'"    {"currentBranch":"main"}
allow   baseline  "yash -c 'git commit -m x'"    {"currentBranch":"main"}
allow   baseline  "posh -c 'git commit -m x'"    {"currentBranch":"main"}
allow   baseline  "osh -c 'git commit -m x'"     {"currentBranch":"main"}
allow   baseline  "rsh -c 'git commit -m x'"     {"currentBranch":"main"}
allow   baseline  "fish -c 'git commit -m x'"    {"currentBranch":"main"}
allow   baseline  "xonsh -c 'git commit -m x'"   {"currentBranch":"main"}
```

**What landed (branch `feat/p18-wrapper`):** the sh-family vocabulary is now PRINCIPLED and SINGLE-SOURCED. `shell.ts` gains `isShFamilyInterpreter(name)` — `return /sh$/i.test(name)` — and the four copy sites consume it (git `wrapperCommands`, shell `interactiveReason`, boundary `shellHasFileMutation` + `checkBoundaryPolicy`), so the git, shell, and boundary lanes cannot drift again. Every POSIX-ish shell name ends in `sh` (sh, bash, zsh, dash, ksh, ash, mksh, pdksh, oksh, lksh, csh, tcsh, yash, posh, osh, rsh, xsh, xonsh, fish), so the class is closed rather than re-enumerated. busybox applet composition (`busybox ash -c …`, repeated busybox, a wrapper applet in between) unwraps word-wise as before and then feeds the same predicate.

- **Over-block tradeoff, pinned not hidden (fail-closed):** a NON-shell executable whose name ends in `sh` (e.g. `publish`, `flush`) that takes `-c <cmd>` is treated as a shell wrapper. It is observable only when the inner command would itself deny unwrapped, and it can only ADD a deny — never loosen one. Pinned in the P18(a) test block (`publish -c 'git commit -m x'` on main denies; `publish -c 'echo hi'` allows).
- **Transparency per seat is unchanged:** with facts on a protected branch the wrapped inner command denies; the factless seat inherits the inner factless allow (the W090 fail-open class); the target-gated shapes' base-set deny fires factlessly (the W102 principle).

**Edge (b) — the zsh EQUALS-expansion caveat — ASSESSED, UNCHANGED (pinned allow):** `Xsh -c='git commit -m x'` extracts the option-argument `=git commit -m x`, whose head is `=git`, not `git`; the classification stays parser-consistent across interpreters (the P18(c) pins, still green). sh/bash reject the spelling outright (`bash -c='echo hi'` → "invalid option", exit 2); zsh's default EQUALS option would expand `=git` to the resolved path and execute it. This difference is a genuine zsh-only runtime caveat and is left QUEUED as the recorded residual rather than guessed at: a fix would have to make the `=`-prefixed head interpreter-aware (or normalize a leading `=` in command position, which would over-deny the same spelling under sh/bash), and zsh is not installed here to verify the live execution. The residual stays stated in SECURITY_ASSURANCE #20.
  - Note: the suffix predicate does NOT change this — `=git` ends in `t`, not `sh`, so the `-c=` allow is unaffected.

**Edge (c) — ref-adjacent filesystem routes — ASSESSED, LANDED (base), boundaries unchanged:** direct `.git/` ref-adjacent writes classify through the W101 protected-target gate (`directRefWriteTargetIn`, reused by the shell mutation extractor and the `file_write` path loop); the env-spelled (`GIT_DIR`/`GIT_COMMON_DIR`/`GIT_WORK_TREE`), in-command-symlink, and `git --git-dir=`/`--work-tree` spellings joined it in the base waves. The genuinely un-inspectable routes stay RECORDED, not pretended: a `.git` symlink hop spelled without a `.git` component (unless the command creates the alias), a gitfile gitdir (bytes never read), an unresolved/globbed gitdir spelling, non-ref `.git` content (objects/index/config/hooks/tags), and the `file_write` lane's lack of command text.
  - Observed parallel site (assessed, out of scope): `skills-mcp/src/screening.ts:25` has an independent `(?:ba|z|da|k)?sh` piped-to-shell detector for skill payloads. It is a different policy surface (skill screening, not command authorization) in a different app and does not import the guard's predicate; recorded here so the drift is visible, not silently shared.

**Evidence:** red captured verbatim above (the probe against the unmodified tree). Green after the src edit: guard app suite 136/136 (`pnpm --dir mcp-toolbox/apps/workflow-guard-mcp run verify` — recursive typecheck + build + `node --test --import tsx test/*.test.ts`), policy file alone 125/0 (124/0 at base, +1 new P18(a) class-closure test; the interactive and boundary suites gained in-place assertions). Whole-toolbox `npm run toolbox:verify` exit 0 (all 19 workspace projects; run after a real frozen-lockfile install in the worktree — a symlinked `node_modules` false-failed two unrelated `code-intelligence-mcp` dependency-resolution tests, which pass with the real install). Repo-root `npm run lint` and `npm run typecheck` both exit 0 unpiped.

**Boundaries (remain):** edge (b)'s zsh runtime caveat (recorded residual, SECURITY_ASSURANCE #20); the edge (c) un-inspectable routes above; the `skills-mcp` screening detector (out of scope); and the suffix rule's deliberate fail-closed over-match for non-shell names ending in `sh`. No block was weakened.
