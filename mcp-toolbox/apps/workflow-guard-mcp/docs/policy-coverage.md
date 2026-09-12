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

## Outside `guard_check`

- Conversation continuation/Ralph orchestration and user-stop bookkeeping.
- Completion-claim observability, which is intentionally non-blocking upstream.
- Planning-file discovery and desktop notifications.
- Host UI presentation and notification delivery.

This separation is intentional: adding more MCP tools does not turn an advisory MCP connection into a native-tool interceptor. Hosts with trustworthy pre-action hooks can enforce core decisions; other clients should combine advisory policy with their native sandbox and approval model.
