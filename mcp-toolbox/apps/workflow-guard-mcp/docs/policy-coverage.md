# Policy Coverage

This matrix classifies the upstream `opencode-workflow-guard` behavior by where it belongs in a cross-client architecture. The portable core evaluates deterministic facts supplied by a host. It does not execute Git, query remote services, or own client session state.

## Ported deterministic core

- Destructive shell operations, package hygiene, interactive-command safety, and deterministic shell normalization.
- Symlink-aware protected and secret paths plus secret-content detection.
- Protected-branch Git command parsing using host-supplied current/protected branch context.
- Inline, heredoc, PowerShell, and Base64 interpreter payload inspection.
- Symlink-aware shell mutation confinement and OpenCode/workflow-guard tamper checks.
- Multi-target patch validation and secret-source transfer laundering detection.
- Protected-branch enforcement for direct file mutations when the host supplies branch context.
- Read-only role enforcement for deterministic mutation actions when the host supplies a trusted role.
- GitHub/Azure DevOps MCP mutation classification from host-supplied tool names.
- GitHub/Azure PR-create recognition and malformed inline body/description preflight.

## Remaining portable candidates

- Manifest/lockfile and documentation preflight decisions when the host supplies changed-path facts and project requirements.
- Todo lifecycle/no-active-todo predicates if workflow-state facts become part of the portable API.

## Host adapter responsibilities

- Discovering the current Git branch, configured protected branches, merge conflicts, ancestry/base freshness, and local merged state.
- Querying GitHub/Azure PR state or any other remote service.
- Resolving inherited todos, mutation budgets, user approvals, and live-system override authority.
- File claims, stale-write fingerprints, concurrent tool lifecycle, and mutation journaling.
- Verification/review evidence freshness and executing configured verification or post-edit validation commands.
- Reading body files, Git diffs, changed paths, project configuration, or other runtime facts needed by deterministic preflight rules.
- Declaring the LIVE control-plane roots (`liveConfigPaths`: runtime config, auth, the guard's own install/source) so guard-tamper classifies by runtime consumption rather than filename segments. Roots must be absolute; `~`/`$HOME` are expanded, and any unusable root (relative or unresolved) rejects the whole fact set so classification falls back to fail-closed segment matching rather than trusting partial facts.

## Outside `guard_check`

- Conversation continuation/Ralph orchestration and user-stop bookkeeping.
- Completion-claim observability, which is intentionally non-blocking upstream.
- Planning-file discovery and desktop notifications.
- Host UI presentation and notification delivery.

This separation is intentional: adding more MCP tools does not turn an advisory MCP connection into a native-tool interceptor. Hosts with trustworthy pre-action hooks can enforce core decisions; other clients should combine advisory policy with their native sandbox and approval model.

## Upstream parity log

- **2026-09-30 (P18, the wave's batch-1 task 3, branch `feat/p18-guard`): the
  parked P18 residual edges closed.**

  > **Dated review-round note (2026-09-30, the fresh-eyes review's two P2s, fixed in code):** (1) the shell lane's busybox lens is a LOOP now (the git lane's while-lens mirrored) — `busybox busybox sh -c top` classifies like `busybox sh -c top` (ask), one busybox word per pass; the round-1 prose below claimed the shell lane handled repeated busybox — the trace allowed it, the claim was unsupported, and the loop + its pin close it; (2) the interactive lane's sh-family regex gains `x` so `xsh -c top` asks like `sh -c top` — the lanes' regexes now match (`(?:ba|z|da|k|x)?sh`). Both pins added; dist rebuilt + re-probed (the two cells ask on dist too); 96/0 policy suite.

  (a) The busybox single-level asymmetry
  (W088's recorded "busybox env top / busybox timeout top / busybox sh -c top
  stay allowed while their non-busybox forms ask") is fixed: `interactiveReason`
  and the git-lane wrapper lens unwrap the words AFTER the busybox applet word
  (word-wise, no string round trip — `shell.ts` exports `unwrapWords` for both
  lanes to share), so `busybox env top`, `busybox timeout 5 top`,
  `busybox sh -c top`, `busybox env sh -c top`, `busybox busybox sh -c top` all
  classify like their direct forms (ask), while the quoted-argv-word discipline
  survives (`env 'a; top'` and `busybox env 'a; top'` stay allow). (b) The
  exotic-interpreter edge: `xsh` joins the sh-family regex
  (`(?:ba|z|da|k|x)?sh`) alongside `busybox sh`, and the wrapper-transparency
  lens covers both per-seat (main deny for the target-gated
  `busybox|xsh -c 'git branch -f main abc'` factless form; factless allow
  elsewhere as the W102 pins record). One W102-round-1 as-found pin flips
  allow→deny with a dated SUPERSEDED note in the test (the fused `-c` spelling
  the round deliberately pinned allow is now caught — the flip is the fix).
  (c) The zsh EQUALS expansion caveat (`-c='git commit -m x'`) is pinned an
  explicit, documented allow for sh/bash/zsh — parser-consistent: sh and bash
  reject the spelling live (verified: "invalid option", exit 2), zsh executes
  `=git` via equals expansion but only after the same `-c` consumption; the
  classification names the recorded caveat rather than leaving the spelling in
  the recognized set. **No red exists for (c) by construction** — the allow
  already held as-found; the pins make the classification explicit so it cannot
  drift. zsh itself is not installed in this environment (the equals-expansion
  execution path rests on the recorded caveat, not a live probe — stated
  honestly). Remains open from the parked row: the ref-adjacent filesystem
  routes (direct `.git/` writes) — covered only by the workspace-boundary
  lanes, unchanged. Evidence: red-first 92/3 (95 tests, 3 fail captured
  verbatim against unmodified src) → 95/0, then the review round's two P2
  fixes + pins → 96/0; full toolbox corpus
  `pnpm run verify` exit 0 in the worktree (typecheck+build+tests across the
  workspace, dist rebuilt and probed: nested-busybox ask cells, xsh/busybox
  git-lane denies, the three `-c=` allows all match dist); repo lint +
  typecheck exit 0 unpiped.

- **2026-09-20 (W084):** ported the upstream policy fixes that landed after the
  2026-09-12 vendoring (upstream `ec097d4..HEAD`, PRs #134/#135/#136/#144/#152):
  quoted-residue redirect/tamper matching (`prepareRedirectResidue`; verb
  patterns stay on quote-flattened text), collaboration-invocation exemptions
  (`gh|glab issue|pr`, `az repos pr`) with unquoted redirects still validated,
  the project `.opencode/plans/` exemption (per-candidate, symlink-aware,
  project-only), tag-publish exemptions (deletion stays flagged; the port is
  deterministic — no `git show-ref` probe, so short tag names stay under the
  ordinary protected-branch rule), fd-duplication and numeric-comparison
  operand filters, and a realpath candidate check in the guard-tamper
  configuration-path rule (closing a symlink gap relative to upstream's
  isProtectedPath). Upstream's todo-gate deadlock fix is evaluated and not
  ported as a gate (no todo predicates here); instead the `guard_status`
  precondition advice no longer claims a todowrite precondition the policy
  never enforced and OpenCode v2 hosts cannot satisfy. Plugin-runtime upstream
  changes (V2 plugin entrypoint, continuation, verify timeout, TUI slot
  rendering) remain deliberately out of scope: they are host-side plugin
  responsibilities, and Workflow ships no plugins.

  Known divergences, stated (secondary review 2026-09-20):
  - **Numeric redirect targets** (`echo x > 5`) are filtered as comparison
    operands and no longer count as file mutations — upstream's conscious
    tradeoff, ported as-is. Consequence: the freshness/verification signal
    misses a write into a numeric filename (an attacker chain via a symlinked
    numeric name was already outside the boundary deny pre-port; the
    mutation-signal gap is the delta). If a stricter signal is needed, scope
    the filter to genuine comparison syntax (`[[ ]]`, arithmetic) rather than
    dropping numeric targets wholesale.
  - **`git push --delete`/`-d` flags**: upstream's `tagRefspecIn` also returns
    false for flag-deleted pushes, so `git push origin --delete
    refs/tags/<name>` stays blocked there when the tag is named like a
    protected branch; the port omits that gate (deleting a tag is not a branch
    mutation, so allowing it is arguably more precise). Deletion REFSPECS
    (`:refs/tags/<name>`) are never exempt in either.
  - **`/dev/null|stdout|stderr|tty|fd/N` redirect targets**: upstream filters
    these from mutation analysis; the port does not, so `> /dev/null` still
    counts as a mutation signal (stricter, harmless — freshness gets an extra
    no-op signal).
  - **Quoted redirect targets containing spaces** analyze only up to the
    target's first space (pre-existing truncation class in both the pre-port
    regex and upstream); the comment in shell.ts states the first-word scope
    honestly.

- **2026-09-21 (W087, control-plane tier port step 1):** added the host-supplied
  `liveConfigPaths` fact. When a host declares its live control-plane roots, the
  guard-tamper configuration rule classifies by runtime consumption instead of
  filename segments (memory ec383547 F2/F3): a target resolving under a declared
  live root is T0 and denied (symlink-aware), while config-shaped paths
  elsewhere — dotfiles `.config/opencode`, worktrees — are T2 drafts and allowed,
  removing the live false positive where `cp <dotfiles draft> <repo draft>` was
  blocked on the destination segment (repro record 290ec890). The default with
  no fact is unchanged: fail-closed segment matching against the
  OpenCode/workflow-guard vocabulary, so every upstream adversarial pin
  (`.opencode/`, `~/.config/opencode/`, `workflow-guard.jsonc`) still holds.
  This is an intentional EXTENSION beyond upstream, not a port: upstream carries
  no live-path fact and keeps segment matching. The T1 ask-gate for promotion
  into live paths and the `opencode.jsonc`=ask nuance from the tier model are NOT
  yet implemented — this step covers T0-vs-T2 classification only.

- **2026-09-22 (W088):** upstream drift assessment `ed09c84..03fbdcf`
  (2026-09-20 → 2026-09-22, PRs #153–#176, upstream v1.15.0), continuation of
  the W084 parity program. All 24 merge PRs in the window classified:
  **converged:** #159 (`d240134`, opt-in host-supplied live control-plane
  paths) is upstream's own landing of the same design as the W087 step above —
  identical semantics (absolute-or-rejected roots, fail-closed fallback,
  symlink-aware, verb patterns unaffected); the T1 ask-gate and
  `opencode.jsonc`=ask nuance remain deferred on BOTH sides, so nothing to
  fold in. **converged by rewrite:** #165 (`ea3cab7`, interactive monitors only
  in command position) — the vendored rewrite was already command-position
  based (`executableIn` over unwrapped words), so upstream's false-positive fix
  (`az keyvault ... --name top`, `echo top`) could not reproduce here; the
  residual deltas upstream's fix covers — busybox applet forms (`busybox top`,
  `busybox vi`), case variants (`TOP`), and the batch-mode exemption scoped to
  the monitor's own arguments — were PORTED this iteration
  (shell-policy `interactiveReason`; pinned in test/policy.test.ts W088
  section). The busybox and case deltas are red→green verified (pins red
  against the unmodified tree); the batch-scoping delta has its own
  distinguishing pins (`env -b top`, `timeout -b top`: a wrapper's
  batch-shaped flag used to suppress the monitor rule through the raw-word
  check; red→green via stash choreography — `sudo -b top` is NOT an exemplar,
  the sudo rule returns before the monitor check in both trees). The class
  regex change is decision-neutral for every non-busybox non-`top` command
  (the regex was already `/i`). **partially assessed → queued:** #158
  (`c377cb9`, policy-port-rules, 2026-09-21): tamper anchoring to live config
  consumption surfaces aligns with the #159/W087 direction, but its
  payload-mode tamper scan (segment fallback, expanded inner-layer checks,
  markdown-scoped payload exemption) has no counterpart in the vendored
  `checkPolicy` file_write path, which scans write content for secrets only —
  a new portable-candidate class queued for the next iteration's semantic
  diff, NOT classified converged. **host-side only, deliberately not
  portable** (plugin/TUI/verification runtime responsibilities; Workflow ships
  no plugins): #154 TUI slot-render degrade, #156 verify worktree fingerprint
  fail-open-per-entry, #161 PR preflight binding + worktree no-rollback,
  #164 stale-write observation seeding, #166 worktree-cleanup idempotence,
  #169 stale file-claim takeover, #170 plugin version visibility, #175
  (`14a07f1`) branch-creation freshness start points (executes git ancestry)
  and its TUI badge fix, #174 guard_status git-hygiene snapshot (executes
  git — the portable core evaluates host-supplied facts; the Workflow hub
  itself could adopt the snapshot as an extension if wanted). **release-only,
  no policy content:** #153/#155/#157/#160/#162/#168/#176 (changeset-release
  merges). **test-only upstream:** #171 rubric default-bases asserts (nothing
  to port). **queued candidates (not taken this iteration, one change per
  iteration):** the #158 payload-mode tamper scan semantic diff, boundary
  deny-reason cause attribution for workspace escapes (#172 unresolvable-
  variable cause, #173 scratch-directory cause — deterministic
  message-quality port), opt-in `requireSubagentReview` strict recorder mode
  (#167 — Workflow-side review-gate analog), and a stated divergence: the
  hub reviewer sources `git diff HEAD` (uncommitted working tree) while
  upstream's rubric reviews the committed branch range
  (`<base>...HEAD`); upstream #163's `--`-before-revision empty-diff bug does
  not exist in the hub implementation. Known limitation, unchanged on both
  sides: monitor/pager indirection (`watch`/`xargs`/`man`, `find -exec`/
  `su -c`, shell loop bodies) is not modeled — and the busybox port is
  single-level: `busybox env top`, `busybox timeout top`, `busybox sh -c top`
  stay allowed while their non-busybox forms ask (pre-existing asymmetry,
  now visible).

- **2026-09-22 (W089):** correction to the #158 classification above plus a
  mainline-parity port. Correction: **#158 (`c377cb9`, policy-port-rules) is
  NOT merged into `origin/main`** — it exists only on the stale side branch
  `origin/fix/worktree-fingerprint`, so mainline carries no payload-mode
  tamper scan and no markdown-only payload exemption; the F2/F3 substance
  landed on mainline via #159 (live control-plane paths) and part of F1 via
  #175. The parity target remains mainline, so #158's unmerged semantics are
  recorded as upstream side-branch material, not a portable backlog item.
  Port: upstream's edit/write handler classifies targets with
  `isProtectedPath` — the same guard-config vocabulary (plans-file
  exemption, realpath awareness, live-root facts) the vendored shell side
  already carries as `isGuardConfigurationPath` — but the vendored
  `file_write` path consulted only the system/secret check, so a host
  enforcing `guard_check` verdicts would let a file write replace the
  guard's own configuration. W089 wires `isGuardConfigurationPath` into the
  `file_write` path loop and the interpreter-payload write-target loop
  (policy `guard-tamper` / `interpreter-guard-tamper`, deny), with upstream
  precedence: the tamper classification runs BEFORE the system/secret
  checks, so a config-shaped path keeps its own policy name even where a
  realpath would also match a system rule (observed live on this ostree
  host: `/home` is a symlink to `/var/home`, so user-level absolute paths
  realpath under `/var` — the pre-existing `/var` rule would otherwise mask
  the classification). Pinned red→green: 3 new tests (direct writes incl.
  the token-substring and plans-directory edges, live-root fact-mode with
  symlink-into-live, interpreter smuggled writes incl. tilde and relative
  forms; benign writes unchanged); suites 55/0, guard typecheck OK, repo
  lint/typecheck exit 0. Discovered divergences, recorded: (1) the vendored
  `checkProtectedPath` `/var` rule flags every absolute user-home write on
  ostree hosts (`/home` → `/var/home` realpath) — a false-positive class
  mainline does not have (its isProtectedPath has no `/var` rule); queued
  candidate; (2) mainline checks neither tamper nor secrets on the
  file_write PATH for reads, and its token-level interpreter scan is
  secrets-only — the vendored token loop is stricter there (kept as-is,
  recorded); (3) neither mainline nor the vendored core classifies
  file_write content for tamper payloads (content is secrets-only on both)
  — the #158 payload-mode idea remains UNMERGED upstream work, recorded for
  the operator's awareness, not a parity item.

- **2026-09-22 (W091):** the T1 promotion gate (frontier G3 part 1). Upstream
  has no counterpart — this is a Workflow-side extension closing the
  guard-invisibility finding from the agents-research assessment: from an
  agent seat, `workflow install fleet [--force]` was baseline-allow while
  the equivalent `cp` into a live root is guard-tamper-denied. The vendored
  core now recognizes the sanctioned promotion command in command position
  (post-unwrap: wrappers stripped; argument data like `echo workflow install`
  is not execution) and returns **ask** with policy `promotion-gate` — the
  T1 tier's decision (promotion = operator approval, never agent-auto-allow).
  Documented limitation (the T1 gate covers the sanctioned shape only):
  indirection (`npx workflow install`), nested shells and eval
  (`sh -c 'workflow install fleet'` — the recognizer does not recurse,
  unlike the interactive detector), and case variants (`Workflow install`)
  are NOT recognized. For those forms the promotion is unguarded AT THE
  SHELL LANE; the W090 fact-mode T0 deny covers only the agent performing
  equivalent writes DIRECTLY into declared live roots — the installer's own
  in-process writes are tool-invisible to the guard (review-round-1 P2:
  the original backstop attribution overstated this). Ordering: the
  promotion ask is evaluated after the deny-class policies so a compound
  whose other segment is a deny reports that deny, not the ask (pinned).
  Seat behavior is unchanged by design: seats without an operator channel
  collapse the ask to deny-with-remedy (the fail-closed direction —
  agent-initiated promotion now requires the operator's keyboard, exactly
  the T1 property); the ask channel itself (routing the ask to a human
  surface) is G3 part 2.
  Pinned red→green (1 new-failing test + command-position and backstop
  guards green pre-change; the compound-attribution pin red before the
  reorder); suites 59/0; dist rebuilt (LESS-0010 hazard); repo
  lint/typecheck exit 0.

- **2026-09-23 (W097):** the ostree `/var`-home false positive FIXED. The
  W089-era "queued candidate" is closed: on ostree hosts (/home is a
  symlink to /var/home), every home-anchored path — including
  workspace-relative file_writes whose lexical candidate resolves into the
  home mount — realpaths under /var and the `/etc//usr//var` prefix rule
  denied it. `checkProtectedPath` now classifies the user's REAL home
  (realpath-resolved) as user space: the system-space prefixes skip
  home-covered candidates while the `.ssh` and secret-name rules fire
  unconditionally (credentials live in the home). Another user's home,
  `/root/.ssh`, and genuine `/etc//usr//var` paths stay denied (pinned).
  Residual recorded: `homedir()` is trusted without a sanity clamp — a
  poisoned `HOME=/var` would neuter the `/var` rule (`/etc`/`/usr` still
  fire; `.ssh`/secret rules unconditional); host-side env only, agents
  cannot set it. Live probe before the fix recorded the deny for
  workspace-relative writes; after the fix the same probe returns allow
  with `/var/log` and `.ssh` still protected.

- **2026-09-23 (W101):** the branch-exit/branch-pointer family UNIFIED by
  semantic target, deliberately DIVERGING from upstream v1.15.x
  (verified at `origin/main` 03fbdcf, `src/policies/git.ts:126` — no
  `switch` write clause, a `-[dDM]` class missing `-f/-m/-C`, no
  fetch-refspec rule, and the same current-branch-shaped gate; upstream's
  `GIT_BRANCH_CREATE_RE`, git.ts:35, recognizes the sanctioned creates but
  only for the branch-freshness gate). The W100 position
  (docs/BRANCH_EXIT_POLICY_2026-09-23.md, frontier-ACCEPT at round 3)
  found the as-found classification admitting protected-branch pointer
  writes the checkout spelling denies — `switch -C <protected> [sha]`,
  `branch -f <protected>`, the three `branch -m` danger shapes (one-arg,
  TO-protected, and the `-m` lowercase the `-[dDM]` class never covered),
  force-copy `-C`/`-cf`, `switch --detach/-d`, cross-branch
  `branch -D <protected>` / `update-ref refs/heads/<protected>` / fetch
  destination refspecs, plus `switch -f/--discard-changes` (the discard
  twin of `checkout --`). The unified gate: force/rename/copy/delete/
  update-ref/fetch-destination forms are target-classified from ANY
  branch against the always-on `{main, master}` base ∪ W090 facts; renames
  check BOTH operands; the one-arg rename targets the current branch and
  fails closed factless; parse-uncertain shapes fail closed; detach and
  discard forms join the fact-gated spelling classes. The ONE deliberate
  with-facts loosening, recorded here for parity honesty: `git checkout
  -B <feature>` on a protected branch flips as-found DENY → allow — the
  unification of an identical intent with the `switch -C` spelling's
  pinned allow (the as-found deny was spelling-shaped over-reach); the
  superseded W099 characterization pin carries a supersession note and the
  superseding assertion lives in the W101 unification pin. `hasGitMutation`
  widened identically (twin-matcher drift discipline, §2.3).
  Upstream-port candidate queued for the plugin's own repo. Residuals
  recorded in SECURITY_ASSURANCE: the shell-wrapper bypass of the whole
  deny class (`sh -c` — queued companion fix) and the exotic symbolic-ref
  form. Live re-probe of the 28-row family inventory against the REBUILT
  dist: all 56 probe rows (facts + factless, on-branch + cross-branch,
  fixes + residuals) match the position; suites 79/0 (policy 69 + redirect
  5 + mcp 5); dist rebuilt (LESS-0010 hazard).

  Review round 1 (fresh-eyes) found three real gate defects — a P0
  value-option phantom bypass (space-form `--points-at`/`--format` values
  shifted the first-operand target selection, phantom-allowing a protected
  pointer move factless), a P1 wildcard branch-glob refspec destination gap
  in BOTH the fetch lane and the pre-existing push lane, and a P2
  `--force\b` over-match on `--force-create` that re-introduced the exact
  spelling-vs-intent asymmetry the change removes. All three fixed and
  pinned (value consumption in the operand walk; wildcard branch-glob
  destinations fail closed in both lanes with tag-glob exemptions kept;
  `--force(?!-create)\b` lookahead); pre-fix verdicts captured live against
  the pre-fix dist (allow/allow/allow/allow/deny) and post-fix green.
  Suites 81/0.

  Review round 2 (re-review) — REVISE: parseFetch's first-colon-operand
  early return let a benign first refspec, a URL remote, or an unconsumed
  `-o`/`-j` short value shield a later protected-branch destination
  (multiple refspecs per fetch are valid git; pre-fix shapes captured
  live as allow). Fixed: every branch destination checked (deny on ANY
  protected), `-j`/`-o` values consumed, the create/force-create mode
  combination fails closed for both spellings, and the reviewer's
  falsified "dead entries removed" claim honored by removing them.
  Suites 82/0; 55-row re-probe + all round-2 shapes green against the
  REBUILT dist.

  Review round 3 (re-review) — REVISE: --refmap's value is itself a
  refspec (the prune mapping) — with --prune a mapped absent source
  deletes the mapped local destination, and both spellings slipped the
  gate (the equals form never reached the walker's callback; the space
  form was consumed as a value). Fixed: parseFetch fails closed on ANY
  --refmap spelling before parsing; benign prune fetches stay allow;
  the -c/-C combination watch-item pinned. Pre-fix verdict captured
  live (allow); suites 83/0; 55-row re-probe + round-2 shapes green
  against the REBUILT dist.

  Review round 4 (re-review) — REVISE: the one-arg rename writes BOTH
  names — the position's row-12 framing covered only the SOURCE half;
  the destination operand force-overwrites a protected branch when it
  names one (git branch -M main from a feature branch destroys
  refs/heads/main — valid git). Fixed: the one-arg form checks BOTH the
  destination operand and the current branch (fact-gated source);
  factless stays fail-closed. Pre-fix verdicts captured live
  (allow, allow); suites 84/0; 55-row re-probe + round-2/3 shapes green
  against the REBUILT dist.

  Review round 5 (re-review) — REVISE: the delete grammar is variadic
  (git-branch(1): (-d|-D) <branchname>...) and the gate's delete arm kept
  only the first operand — git branch -D feat2 main classified allow
  while git deletes BOTH. Fixed: delete targets are ALL operands (force-
  set keeps first-operand-only). Recorded residual #22 (pre-existing
  push lane): push origin HEAD / @ / bare push from a protected seat
  update the remote protected branch under allow (colon form pinned
  deny) — queued resolution via the currentBranch fact. Pre-fix
  verdicts captured live (allow x3); suites 85/0; 55-row re-probe +
  round-2 shapes green against the REBUILT dist.

  Review round 6 (re-review) — no new bypass found (all shapes trace
  fail-closed or harmless; the round-5 variadic fix confirmed in src and
  dist); the one open watch-item — bundled conflicting branch modes
  (a -dc/-md short bundle) — is now hardened: multi-mode bundles fail
  closed (real git rejects the combination). Pinned; suites 85/0; all
  probes green. The reviewer's remaining REVISE grounds were execution
  and docs attestation beyond its shell-less toolset; the primary
  session's executed evidence covers those (this record).

  Review round 7 (re-review) — the blocker claim FALSIFIED by probe: the
  reviewer traced the push lane only and claimed the colon-less
  plus-prefixed refspec classified allow, but the shape was ALREADY
  DENIED by the shell lane's pre-existing force-push rule (shell-policy
  matches ANY plus push refspec as destructive-operation, ignoring
  destinations). The landed fix is an attribution improvement (the push
  lane names protected destinations protected-branch-push instead of the
  shell lane's coarser destructive-operation; the pin asserts the policy
  label). Watch-item recorded: the shell rule over-denies legitimate
  force-pushes to feature branches (destination-blind) — pre-existing,
  noted for the shell-policy's own queue. LESS-0018: a reviewer trace of
  ONE lane is not a verdict — probe before implementing.

  Review round 8 (re-review) — REVISE: the pull spelling shares the
  fetch lane's grammar but no lane classified it (allow across every
  seat; the merge intent git merge denies, the row-24 fetch-refspec
  deny, and the force-refspec destructive catch all bypassed by the
  composite spelling; pre-fix verdicts captured live: allow across
  facts and branches). Fixed: the pull subcommand shares parseFetch
  (destination sweep + --refmap veto, pull's integration options
  recognized) and gitWriteRe gains a current-branch-gated pull clause.
  --mirror/--all pushes fail closed (residual #24, as-found allow
  captured). Suites 85/0; 55-row re-probe + round-2 shapes green
  against the REBUILT dist.

- **2026-09-23 (W102):** the shell-wrapper bypass residual (#20) CLOSED —
  `checkGitPolicy` recurses into sh/bash/zsh/dash/ksh `-c` wrappers with
  the same seat facts and a depth-16 fail-closed cap (W100 §4.6's queued
  companion fix). The wrapper is TRANSPARENT to the full inner
  classification (alias, push, target gate, spelling lanes) — a wrapped
  benign command keeps its inner classification; the design direction is
  classification passthrough, not a deny-everything blanket (the first
  draft's deny-everything expectation was corrected by the pins:
  wrapper ≡ inner). The detection is shared verbatim with
  `hasGitMutation`, making the twin matchers' wrapper scope identical;
  env-prefixed wrappers (`env sh -c '...'`) remain outside BOTH matchers'
  scope — the honest edge, recorded rather than silently closed. The
  as-found allow residual pin superseded with a note; SECURITY_ASSURANCE
  #20 marks the resolution. Live verification: wrapped pointer writes
  deny through the wrapper (branch -f/update-ref/push from any seat
  where the inner command denies), wrapped benign commands allow, nested
  wrappers recurse, depth cap fails closed; suites 87/0 (policy 77 +
  redirect 5 + mcp 5); dist rebuilt (LESS-0010 hazard); the W100-era
  46-row inventory re-probe green against the REBUILT dist; repo
  lint/typecheck exit 0; security-assurance checker 7/0. NOTE: the
  env-prefixed-wrapper sentence ABOVE this note is STALE — falsified by
  review round 1 (prefixed wrappers were always detected); see the
  correction appended to this entry.

  Review round 1 on W102 (fresh-eyes) — REVISE: the fused -c-quote
  spelling (`bash -c'git commit -m x'`) bypassed both matchers (captured
  red live: allow on main), and the recorded env-prefix limitation was
  FALSIFIED (env/timeout/assignment prefixes were always consumed — the
  records corrected at all four sites; hasGitMutation now SHARES
  wrapperCommands). Round 2 on W102 — REVISE: the bundled-flag family
  (`-ec`/`-xc`/`-vc`, the `-o <value> -c` detour, the common spaced
  `bash -ec '...'`) — getopt consumes the rest of the word as -c's
  option-argument; the generalized -Xc matcher the boundary and shell
  lanes already use closes it, with transparency applied per seat
  (factless variants inherit the inner factless allow — the pin draft
  asserting blanket factless denies corrected per LESS-0019's own first
  point). Suites 89/0 (policy 79 + redirect 5 + mcp 5); 46-row re-probe
  green; lint/typecheck exit 0; checker 7/0.

  Review round 3 on W102 (fresh-eyes) — REVISE, B1: the -o bundle
  consumption was not getopt-aware — the walk died at the non-dash value
  word before reaching -c (`bash -euo pipefail -c 'git commit -m x'`
  classified allow on a protected branch; captured red live with facts
  and factless). Fixed: a bundle ENDING in o consumes the next word; a
  fused -opipefail correctly does not. Also recorded: W1 (TASKS.md
  carried the falsified env-prefix claim at three sites — the fourth
  site of the four-site correction was missed — corrected with dated
  notes), N1 (an inline stale-sentence marker on this entry's initial
  env sentence), N2 (the code comment's precedent note made precise —
  the boundary/shell precedents are non-capturing next-word finders, and
  this walker additionally handles the fused form). The transparency
  principle re-learned from the pins: the factless variants of
  spelling-lane shapes inherit the inner factless allow (the W090
  fail-open class); only target-gated shapes deny factlessly via the
  base set — the round-3 pin draft asserted blanket factless denies and
  was corrected by the pins themselves (LESS-0019's own first point,
  re-learned). Suites 90/0 (policy 80 + redirect 5 + mcp 5); the 46-row
  re-probe green against the REBUILT dist.

  Review round 4 on W102 (fresh-eyes) — REVISE, B2: the -O/+O shopt
  family. bash's `-O <shopt>` (and the opposite-sense `+O`/`+o`) consume
  a spaced argument and option parsing CONTINUES — the walk died at
  "extglob" and `git commit -m x` ran on main under allow (captured red
  live with facts and factless, four spellings). Fixed: value
  consumption extended to `-O`/`+O`/`+o` endings, and the walk treats
  plus-prefixed words as option-shaped (bash's plus-options are the
  opposite-sense shopt set), not positionals. The reviewer ALSO
  falsified the round-4 probe's own candidate: `bash -eu pipefail -c
  'echo hi'` is NOT a bypass — bash stops startup-option parsing at the
  first positional, the walk dying there is semantically faithful
  ("pipefail" ENOENT), pinned as empirical documentation opposite the
  -O family. Transparency: benign -O usage keeps its inner
  classification. Suites 91/0 (policy 81 + redirect 5 + mcp 5); the
  46-row re-probe green; lint/typecheck exit 0; checker 7/0. The
  getopt-enumeration lesson: the sh-family value options are small and
  enumerable (-o/-O/+o/+O) — LESS-0020 records that the general fix is a
  complete enumeration, not per-finding patches.

  ---- W103 (2026-09-23): the queued W101/W102 residuals #22 and #21 ----

  SECURITY_ASSURANCE #22 (HEAD-alias push resolution) and #21 (the
  symbolic-ref matcher line) closed in one guard-touch iteration, per the
  pain-point recommendation (items 2+3: small, same file, same region as
  W102). Pre-change probe captured the as-found allow for EVERY shape
  (24-row matrix against src, not inferred): alias/default pushes allow
  from the protected seat, push with mirror or all flags but NO
  remote/refspec arguments allow (the round-8 #24 sweep sat INSIDE the
  refspec loop and a zero-arg push never ran it), symbolic-ref
  protected-NAME writes allow even factless and even through sh -c
  wrappers, and symrefs aimed AT a protected branch allow.

  Fixed in src/git-policy.ts: (1) the push lane resolves HEAD/@ refspecs
  and the default push (no refspec beyond the remote slot — git's grammar
  makes the first non-option argument the repository) against the
  currentBranch fact; protected seat → deny/protected-branch-push,
  feature seat → allow, and a FACTLESS seat keeps the as-found allow —
  the deliberate divergence from round 4's factless fail-closed, because
  the alias destination is fact-shaped (only the fact names it), not
  base-set-shaped: these forms are the documented W090 fail-open class,
  symmetric with the pinned bare-pull factless allow (round 8) and the
  W102-era transparency principle. Honest config edge recorded in #22:
  push.default=upstream aiming a feature branch at a differently-named
  protected upstream is repo-config-dependent and stays unresolvable.
  (2) The --mirror/--all sweep hoisted per SEGMENT (the zero-arg edge
  above closes; the pre-existing with-remote pins stay green).
  (3) symbolic-ref joins parseUpdateRef in the target gate: the
  two-operand write form checks BOTH names — the protected NAME (the
  queued one-liner) AND the referent it is aimed at (a symref
  feat→main routes later commits through main; the rows-11-13
  both-operands principle) — while the HEAD-form repoint stays the
  deliberate row-25 exit-class allow, the one-operand form stays a read,
  and --short/-q are enumerated so benign reads do not newly fail closed
  (--delete and -m fail closed on parse uncertainty). (4) The twin
  matcher widens in the same change (§2.3): hasGitMutation's extras carry
  symbolic-ref >=2-token forms (write/delete) for the read-only-role
  lane; the one-operand read is not a mutation.

  Evidence: pins authored red-first (the two new W103 blocks + the
  flipped as-found pin + the twin additions ran 79/4 against the
  pre-fix tree — EXACTLY the four expected failures, no collateral;
  pre-fix classification live-probed via a scratch probe script, plus a
  pre-probe of the force-alias shape via the shell lane's
  destructive-operation attribution), then green 93/0 (policy 83 +
  redirect 5 + mcp 5) after the src edits; dist rebuilt + the dist probe
  re-run (src≡dist: every predicted flip landed, every preserved
  classification survived — feature/factless alias allows, HEAD-form,
  reads, benign writes); vendored typecheck OK; repo lint/typecheck
  exit 0; security-assurance checker 7/0. The W101-era as-found allow
  pin flipped in the round-5 test block WITH a resolution note (the
  residual pre-registered its own successor) — a pin move as the
  sanctioned closure, not test-weakening. LESS-0021 records the
  factless-design decision and the fixture-convention note (the
  scanner blocked a literal force-fragment in the probe script until it
  was constructed at runtime).

  Review round 1 on W103 (fresh-eyes completion reviewer, executed
  evidence) — [APPROVE] across all five axes, recorded via record_review
  against 3c2e46f: the reviewer reproduced red-first (79/4, only the four
  expected blocks) against a reverted src, executed a 108-cell
  classification matrix (32 allow→deny flips, ZERO deny→allow — the
  no-loosening invariant held), reconciled the counts, re-ran every gate
  (vendored typecheck, repo lint/typecheck, checker 7/0), and verified
  dist≡src by executing the compiled dist. Three P2s + one P3, all
  addressed in this iteration's follow-up commit:
  (P2-a) the entry below referenced LESS-0021 before it existed — the
  append happened in the REMEMBER step, closing the chain;
  (P2-b) the first-cut alias condition modeled ANY <=1-non-arg push as
  the default branch push: --tags/--follow-tags (tags-only release
  pushes, the W084 lane) and --delete/-d (whose single non-option
  argument is the deletion REFSPEC, not the remote) mis-flipped to deny
  from the protected seat — fixed: a refspec-shaping flag (--delete/-d)
  excludes the single-arg default-push reading (its destination is
  already checked by the literal loop) and tags-only flags are not
  default pushes at all; the round-1 pins ran red-first (81/2 — exactly
  the tags/delete/twin blocks) then green; the orchestrator's first
  refine also DROPPED the bare-args case (git push itself) — its own red
  pin caught it before any dist run;
  (P2-c) the twin's coarse >=2-token pattern flagged one-operand reads
  (--short/-q HEAD) as mutations, contradicting the comment and #21 —
  fixed with a flags-skipping two-operand pattern plus an explicit
  --delete clause (the flags group would swallow its single operand),
  and the first operand position refuses a dash because the engine's
  zero-iteration backtrack would otherwise still match flag+operand;
  (P3-d) `git push origin :HEAD` (empty-source deletion of the remote
  HEAD alias) classifies allow — pre-existing (executed), adjacent to
  the closed #22 family, recorded here as a queued deliberate pass, and
  pinned as-found in the W103 test block. Final suites 93/0 (policy 83
  + redirect 5 + mcp 5); dist rebuilt AFTER the fixes and re-probed
  (the intermediate dist-probe run caught a stale-dist divergence — the
  LESS-0010 hazard discipline applied mid-iteration; the one probe-line
  discrepancy was a scratch-script fragment bug producing a malformed
  flag, re-verified allow with the correct shape); repo lint/typecheck
  exit 0; checker 7/0.

  Review round 2 on W103 (the completing reviewer's continuation) —
  [REQUEST_CHANGES], P1: the round-1 tags-only fix gated the WHOLE alias
  disjunction behind !tagsOnly, re-opening the #22 hole for flag-combo
  pushes (`git push origin --tags HEAD` classified allow from the
  protected seat — the exact shape the iteration closed). Fixed by the
  reviewer's scoping: the exclusion applies to the DEFAULT-PUSH readings
  only (args 0 or 1); explicit HEAD/@ refspecs always resolve. En-route
  correction inside the round-2 fix: the round-2 table's no-remote cell
  (`git push --tags HEAD`, expect deny) was inconsistent with the
  reviewer's own formula — git's grammar makes the single positional the
  repository slot and tags-only flags push no branch refs, so the cell
  corrects to allow (pinned with the note). Round-2 P2 fixed: the twin's
  two-operand pattern now carries a flags group before EACH operand
  position (git permutes options — the interleaved write form
  `refs/heads/feat --short sym2` is a mutation again; red live before
  the fix). Round-2 P2-b: the LESS-0021 append was still pending (the
  REMEMBER step) — landed in this iteration's final commit; the ledger
  claims above were written ahead of the append and are only true as of
  that commit. Pins red-first (81/2 — exactly the round-2 blocks) then
  green 93/0; dist rebuilt and probed (8 round-2 cells match, including
  the corrected no-remote cell); repo lint/typecheck exit 0; checker
  7/0.

  Review round 3 on W103 (the same reviewer's continuation, final
  confirmation before the bind) — [REQUEST_CHANGES], one P1: the
  round-1/2 premise "--follow-tags is tags-only" was FALSIFIED by the
  reviewer's git dry-run (git 2.55.0) — the man page has --follow-tags
  push "all the refs that would be pushed without this option", so the
  DEFAULT PUSH fires and `git push --follow-tags` from a protected seat
  was re-opening the #22 hole under allow (3c2e46f had denied it
  correctly; the mis-modeling entered in 20361b6; the round-2 record
  had endorsed the allow pin without a grammar probe — recorded here as
  the falsification, not hidden). Fixed: the tags-only reading requires
  `--tags` WITHOUT `--follow-tags` (which also folds the round-3 P3
  combined-flags shape in); the follow-tags pins flipped with a
  falsification note; the false premise corrected in the src comment,
  the test comment, #22's sentence, and this log. All round-3 cells
  executed end-to-end on src and dist: follow-tags protected-seat forms
  deny, tags-only forms allow (correct per git), the corrected no-remote
  cell accepted by the reviewer (their round-2 deny expectation was
  inconsistent with their own formula — the pin, not the src, was
  corrected), the twin matrix 8/8, LESS-0021 confirmed appended (the
  P2-a chain closed). Suites 93/0 (policy 83, redirect 5, mcp 5); dist
  fresh and probed (11 cells match); repo lint/typecheck exit 0;
  checker 7/0.

  ---- W108 (2026-09-23): residual #23 — the shell lane's force-push
  rules become destination-aware ----

  The W101-era watch-item resolved per the pain-point queue's item 4.
  The pre-change 14-row probe captured the as-found matrix against the
  pre-fix dist: EVERY feature-destination force shape classified
  deny/destructive-operation (plus-refspec feature spellings ×3, the
  force-flag form to a feature branch — including the aliased forms
  WITH facts, i.e. the W103-era git-lane alias resolution allowed the
  shape and the blind shell rule then over-denied it end-to-end), the
  forced tag publish denied (contradicting the W084 release-operation
  exemption), and the protected destinations denied via the git lane's
  protected-branch-push attribution (the shell rule never fired there —
  the git lane runs first).

  Fixed in shell-policy.ts + git-policy.ts: (1) the shape DETECTION
  stays regex — the same two shapes the blind rules matched, tested over
  the same three text variants (command/decoded/normalized); (2) the
  VERDICT reuses the GIT lane's push-destination resolver —
  pushedProtectedBranchIn and protectedBranchesIn exported from
  git-policy and consumed by shell-policy (one grammar implementation,
  not a copy — the W102 round-1 P3 twin discipline); (3) a new
  "unresolved-alias" sentinel: a factless alias/default force push (the
  destination only knowable from the currentBranch fact) — the GIT lane
  maps it to its documented W090 fail-open allow (the W103 pins keep
  their as-found classification) while the SHELL lane maps it to deny,
  so its force-push stance stays conservative where nothing is knowable
  — the lanes now differ EXPLICITLY by policy over the same grammar
  (git lane fail-open vs shell lane fail-closed force stance), pinned in
  both directions; (4) the two blind regex entries removed from
  destructivePatterns and the destination-aware check placed after the
  generic destructive loop (a compound's earlier destructive match still
  attributes first; a compound mixing the post-push rules — kubectl and
  later — with a force push now attributes the earlier rule first: an
  attribution-order shift, recorded). Scoping note: residual #23's text
  had recorded only the plus-refspec instance; the W108 iteration's
  exploration pass flagged the flag spelling as equally blind and the resolution covers
  BOTH (the class heading was always "destination-blind").

  Deliberate behavior change, pinned: forced tag publishes classify
  allow in the shell lane now too (the W084 release-operation exemption
  holds in both lanes; pre-fix the shell rule denied the forced
  spelling). Deliberate preserved deny, pinned: a factless bare or
  remote-only force push denies (destructive-operation) — the shell
  lane's conservative stance where the destination is unknowable.

  Evidence: the pre-change probe (14 cells, above); pins authored
  red-first ran 84/1 (EXACTLY the allow-flips test red — the
  preservation test green as-found) then 95/0 (policy 85 + redirect 5 +
  mcp 5) after the src edits; dist rebuilt and probed (12 cells match —
  the first dist-probe run caught a STALE dist classifying the flips as
  deny: the LESS-0010 hazard discipline applied mid-iteration); vendored
  typecheck OK; repo lint/typecheck exit 0; checker 7/0. The
  fixture-writing convention earned its keep again: the scanner's shell
  normalization re-joins quote fragments, so a concatenation whose
  quote-stripped form reads as a force-push shape trips the rule even
  when the raw line looks safe — the pins hoist the push anchor off
  every concatenation line (LESS-0029 records the mechanism).
