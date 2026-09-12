# Local Change Intelligence Dogfood

P505 compared `assess_local_change` with the P501 direct-primitive baseline on
2026-08-28. The committed reference was
`34f2c5bfdc02263d6454b254c7dca43a21639946`. Measurements are local wall-clock
tool-request observations on Node.js 22.22.3, not performance budgets. Serialized
sizes are `JSON.stringify` UTF-8 byte counts of structured results. Each run used
a fresh top-level MCP client. Direct primitive servers were connected before the
timed requests, matching normal agent-configured peers; the composed request
includes the cost of launching its runtime primitive peers.

## Reproduction

The tracked cases use detached worktrees at the recorded commit so the canonical
migration worktree is not mutated. The small edit changes the single-line
`if (quote === "'") continue;` in `src/shell.ts` to the equivalent three-line
block. The multi-consumer edit reformats the return expression in
`hasPrCreateInvocation` and the early return in `checkPrCreatePreflight` in
`src/pr-policy.ts`; it was measured once unstaged and once staged. Limits were
`pathLimit=500`, `testLimit=20`, `symbolLimit=100`, `referenceLimit=100`, and
`recommendationLimit=20`. Baseline semantic queries used `document_symbols`
with limit 100 and `find_references` with limit 100.

The migration case uses the canonical worktree at the same `HEAD`. At
measurement time it contained 121 migration-era entries dominated by untracked
`apps/`, `packages/`, planning, and architecture files alongside deleted root
package paths and modified `package.json`. The temporary measurement harness was
itself one untracked entry, so reproductions after removing it should observe one
fewer path. This does not change the rename/provenance conclusion.

## Results

For the small `src/shell.ts` edit, the stopping condition was identifying the
changed path, patch, and relevant test. The optimized baseline needed three
calls (`working_tree_status`, `local_diff`, `find_relevant_tests`), delivered
1,598 bytes, and took 24.89 ms across those requests. Composition needed one
agent call, delivered 1,874 bytes, and took 946.84 ms. It correctly added
`dynamicShellSyntaxIn` and three reference locations, but those semantic facts
were not needed for the task. Composition loses this workflow on latency and
context despite reducing interaction count.

For the unstaged `src/pr-policy.ts` semantic workflow, the stopping condition
was identifying changed declarations, their consumers, and the relevant test.
The baseline needed seven calls: status, diff, symbols, three reference queries,
and test relevance. It delivered 6,479 bytes and took 723.25 ms. Composition
needed one agent call, delivered 3,013 bytes, and took 1,229.82 ms. Both found
`hasPrCreateInvocation`, its nested callback, and `checkPrCreatePreflight`, the
same consumer locations, and `test/policy.test.ts`. The composed result also
made the unrun-test gap explicit. The staged form produced the same facts and
scope-correct provenance: baseline 7 calls/6,479 bytes/741.21 ms; composition
1 call/3,007 bytes/1,252.60 ms. No result was truncated in either tracked case.

For the migration/rename-like workflow, the decision was whether Git establishes
that untracked `apps/workflow-guard-mcp/src/pr-policy.ts` succeeds deleted
`src/pr-policy.ts`. It does not. A direct full status call is sufficient to reach
that conclusion (10,705 bytes, 11.56 ms); a targeted follow-up relevance query,
when desired, adds 647 bytes and 5.63 ms. Broad composition returned all 121
paths in one 191,420-byte result taking 531.42 ms, was `incomplete`, and bounded
recommendations at 20 with `recommendationsTruncated: true`. Crucially it did
not invent affected-symbol or rename provenance for the untracked destination.

Dogfooding initially exposed a correctness defect in this case: the modified
root `package.json` was sent to Code Intelligence's TypeScript semantic API and
its expected unsupported input failed the entire assessment. P505 added a
regression and now semantic correlation is attempted only for TypeScript source
paths; unsupported changed files retain Git/Test evidence with semantic evidence
unknown. Failures from an eligible TypeScript semantic request still fail closed.

## Decision Evidence

The composed path/test summary and verification-gap synthesis are useful when a
semantic assessment is already needed, but they do not earn a recommendation to
replace cheap direct Git/Test calls. The small-edit and migration measurements
show that eager whole-change composition can add both latency and context.

Affected-symbol/consumer correlation does earn retention as a composition
capability for recurring semantic review: it removes the agent's
manual patch-line-to-symbol correlation and reference-query loop, reducing the
multi-consumer case from seven calls to one and roughly halving agent-visible
structured evidence while preserving explicit Git/Code provenance. Its measured
latency is worse, so it remains a convenience/evidence-density tradeoff rather
than a performance optimization. Rename inference, coverage inference, and
automatic broad test execution remain rejected/deferred.
