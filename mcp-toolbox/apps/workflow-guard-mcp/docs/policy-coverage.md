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
  Suites 81/0; the 55-row re-probe matches the position; see the W100
  doc's §7 implementation addendum for the record.
