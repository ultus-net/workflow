# Stage 4 Review

## Status

Stage 4 accepted on 2026-08-28.

Git Intelligence is an independently publishable MCP product with structured
working-tree status, bounded staged/unstaged diffs, file history, and committed
line provenance. The Stage 4 gate is satisfied: an agent can inspect current
tracked changes and reconstruct useful committed file history without parsing
raw Git output, remote access, or forge credentials.

Changed-symbol correlation remains deferred. P406 found no recurring workflow
where a new Git/Code primitive provides evidence that separate Git and Code
Intelligence calls cannot provide, and the current migration worktree exposes
an important limit: Git cannot correlate deleted committed root files with
their untracked `apps/...` successors before that relationship exists in Git.
Composition must not turn a filename/content guess into provenance.

## Dogfood Evidence

P406 exercised the domain adapters against the real migration-era monorepo and
records the measurements in `git-intelligence-dogfood.md`. A full status result
described 106 entries in about 9 KiB of serialized structured evidence and
single-digit milliseconds. The public default of 100 correctly signaled
truncation, so callers can cheaply discover when they need a larger query.

Unstaged diff exposed all 21 tracked changes in roughly 44-49 ms, but its
serialized result was about 140 KiB and correctly reported bounded patch
evidence. This supports a two-step agent workflow: use status to identify paths
and request patch evidence only when needed. It does not support eagerly
attaching language-level analysis to every changed path.

History and blame remained single-digit-millisecond queries for a committed
path and provided normalized bounded provenance. An untracked planning file had
no history and could not be blamed against `HEAD`, as intended. The same
boundary applies to untracked migration destinations: Code Intelligence may
understand their symbols, but Git Intelligence has no historical relationship
to correlate yet.

## Composition Decision

Do not add changed-symbol correlation to Git Intelligence, Code Intelligence,
or a product-to-product dependency. Each product remains independently useful
and independently publishable. Their security, path, output, and lifecycle
contracts stay product-local.

Do not schedule a new primitive merely to combine `working_tree_status` or
`local_diff` with document symbols. A caller can already make those separate
queries, while interpreting a patch as a semantic symbol change requires
decisions that belong above both primitive domains. The P406 context-size data
also argues against returning diff patches plus broad symbol evidence by
default.

Stage 5 is the appropriate place to test composition because its explicit goal
is to build and measure Local Change Intelligence across Git, code, and test
domains. An intelligence layer may correlate evidence without changing product
dependency direction. It should only retain a changed-symbol concept if
dogfooding demonstrates a recurring workflow improvement, such as fewer tool
calls or less context while preserving explicit provenance and uncertainty.

## Stage Decision

Stage 4 is accepted with no additional product capability scheduled. Local Git
status, diff, history, and blame satisfy the stage goal and remain read-only and
local. Remote forge integration stays deferred to a later credentialed domain.
Changed-symbol correlation is a Stage 5 experiment, not a Git Intelligence
feature, and must earn permanence through measured composition value.

Root `pnpm run verify` remains the repository quality gate. Existing Workflow
Guard review follow-ups are separate product debt and do not block Stage 4
acceptance.
