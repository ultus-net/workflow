# MCP Toolbox Bundling Decision

## Decision

`mcp-toolbox/` inside this repository is the canonical source for the MCP
toolbox (workflow-guard-mcp and the companion intelligence servers). The
standalone `mcp-toolbox` repository and the `opencode-workflow-guard` repository
are retired once this repository is up and running.

## First-class guard integration

`src/integrations/mcp-toolbox-guard.ts` exposes the vendored workflow-guard
policy as a Workflow `McpProvider`:

- `createWorkflowGuardMcpProvider()` runs the vendored policy core
  **in-process** (C2, 2026-10-11) — the ten portable policy modules are copied
  byte-identically into `src/integrations/guard-policy/` under a drift guard
  (`test/guard-policy-drift.test.ts`), so the seat calls the SAME `checkPolicy`
  the vendored app runs, with no subprocess, stdio handshake, or stale-dist
  class. It exposes `capabilities()`, `guardCheck(input)`, and `guardStatus()`.
- `guardPolicyEvidence(decision, mutationEpoch)` normalizes an
  `allow`/`deny`/`ask` decision into evidence with subject
  `policy:<policy-id>` — `allow` records `passed`, anything else `failed`.

The vendored `mcp-toolbox/apps/workflow-guard-mcp` app still builds and mounts
as the agent-facing MCP tool (its build-freshness gate stays in force); the
in-process copy is the hub/seat enforcement path.

The guard remains advisory for hosts that merely call it as a tool; Workflow's
kernel owns task state and evidence freshness regardless. In this repository
the hub is the wired host (plan Task G2): the `/bash` contained-shell route, the ACP
permission resolver, and the OpenCode plugin all deny on guard policy and
fail closed on guard errors. Since the guard is in-process (C2), a hub cannot
come up without it — a guardless hub is impossible by construction.

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
