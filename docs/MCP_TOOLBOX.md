# MCP Toolbox Bundling Decision

## Decision

`mcp-toolbox/` inside this repository is the canonical source for the MCP
toolbox (workflow-guard-mcp and the companion intelligence servers). The
standalone `mcp-toolbox` repository and the `opencode-workflow-guard` repository
are retired once this repository is up and running.

## First-class guard integration

`src/integrations/mcp-toolbox-guard.ts` exposes the vendored
workflow-guard-mcp server as a Workflow `McpProvider`:

- `createWorkflowGuardMcpProvider({ serverPath })` spawns the built server
  over stdio and exposes `capabilities()`, `guardCheck(input)`, and
  `guardStatus()`.
- `guardPolicyEvidence(decision, mutationEpoch)` normalizes an
  `allow`/`deny`/`ask` decision into evidence with subject
  `policy:<policy-id>` — `allow` records `passed`, anything else `failed`.

The guard remains advisory for hosts that merely call it as a tool; Workflow's
kernel owns task state and evidence freshness regardless. In this repository
the hub is the wired host (plan Task G2): the `/before-tool` route, the ACP
permission resolver, and the OpenCode plugin all deny on guard policy and
fail closed on guard errors, and the hub daemon refuses to start without a
working guard provider.

## Rationale

The toolbox's original umbrella-monorepo docs (PLAN.md,
docs/architecture/monorepo-tooling.md) describe keeping the MCP portfolio in one
repository. This Workflow repository is the natural progression of that
portfolio: the guard, the SDK harness, and the toolbox are required to be used
in conjunction, so they live in one codebase.

## Consequences

- Edit `mcp-toolbox/` here; do not push changes to the retired standalone repos.
- The toolbox keeps its own pnpm workspace and build; use
  `npm run toolbox:install` / `npm run toolbox:verify` from this repo's root.
- Each toolbox product remains independently publishable from its own
  subdirectory (`mcp-toolbox/apps/<product>` keeps its own package.json and
  packed-artifact tests).
- Workflow's root build/test (npm, tsc) covers only `src/` and `test/`; the
  toolbox is verified by its own `verify` command.
