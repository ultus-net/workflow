# Change Intelligence MCP

`change-intelligence-mcp` provides bounded composition over the independently
runnable Git, Code, and Test Intelligence MCP products. Its initial
`assess_local_change` tool reports working-tree path facts, structural test
relevance, and bounded affected-symbol/consumer candidates. Semantic
candidates require current Git hunk lines to intersect a Code Intelligence
declaration and preserve both source capabilities. Relevance such as
`matching_stem` or `same_project` is not test coverage evidence.

The primitive servers are runtime peers, not package dependencies. By default
they are launched from `git-intelligence-mcp` and `test-intelligence-mcp` on
`PATH`. Deployments can set `CHANGE_INTELLIGENCE_GIT_COMMAND` or
`CHANGE_INTELLIGENCE_TEST_COMMAND` or `CHANGE_INTELLIGENCE_CODE_COMMAND`;
optional command arguments are JSON string arrays in the corresponding
`CHANGE_INTELLIGENCE_GIT_ARGS`, `CHANGE_INTELLIGENCE_TEST_ARGS`, and
`CHANGE_INTELLIGENCE_CODE_ARGS` variables.

Input limits default to 100 changed paths, 20 test candidates per current path,
20 affected symbols total, and 100 consumer locations total. Their maxima are
500, 100, 100, and 500 respectively. Paths represented only by deletion state
report `relevantTests: null`; if Git also reports a current non-deletion record
for that path, the current path is enriched normally. Deleted, renamed,
untracked, binary, truncated-patch, and mixed staged/unstaged paths do not get
semantic candidates because their current line identity is not established.
Files outside Code Intelligence's current TypeScript source-file domain also
retain path/test evidence with semantic candidates unknown rather than causing
the composed assessment to fail. `pathsTruncated`, per-path `testsTruncated`, `symbolsTruncated`, and `incomplete`
preserve source uncertainty.

Verification synthesis keeps structural relevance, observed execution, and
recommendations separate. By default relevant tests are reported as not yet run
and become bounded `run_test` recommendations; no relevant candidates produce a
`review_test_gap` recommendation rather than a coverage claim. Setting
`runRelevantTests: true` explicitly opts into Test Intelligence's `run_tests`
side effect for at most `testExecutionLimit` discovered IDs (default 20,
maximum 500). Recommendations have their own `recommendationLimit` (default 20,
maximum 100), and `testTimeoutMs` defaults to 30 seconds. Because one public
mode can execute repository tests, `assess_local_change` is not annotated as a
read-only or idempotent MCP tool. Test execution has the same local-code trust
boundary documented by Test Intelligence; recommendations are not observed
results.

Requires Node.js 22 or newer. Build, typecheck, and test with pnpm:

```sh
pnpm run build
pnpm run typecheck
pnpm run test
```
