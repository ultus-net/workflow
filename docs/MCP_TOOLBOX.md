# MCP Toolbox Bundling Decision

## Decision

`mcp-toolbox/` inside this repository is the canonical source for the MCP
toolbox (workflow-guard-mcp and the companion intelligence servers). The
standalone `mcp-toolbox` repository and the `opencode-workflow-guard` repository
are retired once this repository is up and running.

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
