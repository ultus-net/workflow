# Continuity Checkpoint MCP

`continuity-checkpoint-mcp` provides one read-only recovery call over the Stage 7
continuity products. `recover_continuity` reads Review Accountability,
Verification Accountability, Project Context, and Project Memory, preserving
their payload provenance and evidence classes rather than creating a new source
of truth.

The returned `context` has one global character budget (12,000 by default,
100,000 maximum). Sources consume that budget in strict priority order: review,
verification, project context, then project memory. Only complete source
envelopes are included; if the next source does not fit, it and lower-priority
sources are omitted. `includedSources`, `omittedSources`, `truncated`, and
`sourceOrder` make that behavior explicit.

Each primitive call is independently bounded by `sourceLimit` (default 8,
maximum 20). Source envelopes are atomic: if a complete source payload does not
fit the remaining global budget, it and every lower-priority source are omitted
rather than detaching evidence from provenance, freshness, or trust metadata.
`memoryQuery` is passed only to Project Memory retrieval. This
composer does not persist state, resolve review debt, execute tests, choose a
task, or automatically inject context into an agent session. Those remain the
responsibility of primitive products or host lifecycle integrations.

The primitive servers remain independently runnable peers. Commands default to
`review-accountability-mcp`, `verification-accountability-mcp`,
`project-context-mcp`, and `project-memory-mcp` on `PATH`. Override them with
`CONTINUITY_CHECKPOINT_REVIEW_COMMAND`, `CONTINUITY_CHECKPOINT_VERIFICATION_COMMAND`,
`CONTINUITY_CHECKPOINT_CONTEXT_COMMAND`, and `CONTINUITY_CHECKPOINT_MEMORY_COMMAND`.
Corresponding `_ARGS` variables accept JSON arrays of command arguments.

Requires Node.js 22 or newer. Run `pnpm run verify` to typecheck, build, and test.
