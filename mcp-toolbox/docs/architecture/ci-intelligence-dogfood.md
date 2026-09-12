# CI Intelligence Dogfood

## P604 Scope

P604 dogfooded the compiled CI Intelligence MCP against the repository's current
GitHub upstream on 2026-08-29. The upstream configured by the local checkout is
`ultus-net/workflow-guard-mcp`. This exercise deliberately did not create, rename,
or migrate a GitHub repository; repository migration is a separate decision.

The upstream is public, so the MCP query used the least-privilege anonymous path
with only `CI_GITHUB_REPOSITORY` configured. No credential was written to disk or
passed through MCP input. A direct comparison used the already authenticated
`gh` client.

## Reproduction

Build the package, then launch its compiled server through an MCP client with:

```sh
CI_GITHUB_REPOSITORY=ultus-net/workflow-guard-mcp node dist/server.js
```

Call `list_ci_runs` with `limit: 20`. For provider comparison, query:

```sh
gh api 'repos/ultus-net/workflow-guard-mcp/actions/runs?per_page=20'
```

No token is required for the MCP reproduction while the repository remains
public. Private-repository reproduction requires `CI_GITHUB_TOKEN` as trusted
process configuration; credentials must not be committed or supplied as MCP
arguments.

## Observations

The compiled MCP returned `{"runs":[],"truncated":false}` in 459.1 ms including
stdio server startup and MCP connection. The direct GitHub REST query returned
`total_count: 0` and an empty `workflow_runs` array in 0.44 s. The two paths
therefore agree: GitHub currently reports no Actions runs for this upstream.

The empty normalized MCP payload is smaller than even the selected direct
provider response and omits provider-specific envelope fields. More importantly,
an agent does not need to interpret GitHub's response schema to establish the
bounded negative fact. At this repository state the material improvement is a
stable provider-neutral evidence shape, not fewer network round trips or lower
latency.

The authenticated `gh api rate_limit` observation reported the REST core budget
at 5,000/5,000 remaining immediately after the comparison. That is evidence only
for the authenticated direct-provider client, not for the anonymous MCP request:
GitHub applies different limits to unauthenticated traffic. CI Intelligence
already normalizes provider rate-limit failures, but this live empty-result case
did not exercise that path.

## Limits Exposed By Dogfooding

This is useful negative evidence, not a successful-run demonstration. Because
the upstream has no Actions runs, P604 cannot live-validate job summaries,
failure localization, hostile provider-controlled workflow/job names, unknown
conclusions, pagination, or truncation. Those behaviors remain covered by the
deterministic provider fixtures; live provider availability is intentionally not
a normal verification prerequisite.

The checked-in `.github/workflows/ci.yml` does not imply that GitHub has executed
it. Likewise, a future passing run would establish only provider-reported state
for its revision, not that this local worktree or every relevant test was
verified. CI evidence must remain revision-bound and observational.

The attempted authenticated MCP reproduction also demonstrated an operational
credential constraint: Workflow Guard rejected shell command substitution used
to inject `gh auth token`. That is desirable defense in depth. Public-repository
dogfooding needed no exception, and future private-repository dogfooding should
use trusted process/environment configuration rather than weakening shell policy.

## Gate Result

P604 passes as a negative-control dogfood gate. The normalized run query is
correct against direct provider evidence, bounded, low-context, read-only, and
usable without credentials for this public repository. There is not yet live
evidence that job detail materially improves agent work, so P604 does not justify
logs, steps, annotations, check APIs, CI composition, or another credentialed
capability. A repository with real run history should be used before broadening
those surfaces.
