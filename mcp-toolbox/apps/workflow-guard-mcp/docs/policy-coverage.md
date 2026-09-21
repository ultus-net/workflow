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
