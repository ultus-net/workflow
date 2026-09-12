# Monorepo Tooling Baseline

## Status

Accepted for Stage 0 on 2026-08-28.

## Package Manager

Standardize the umbrella repository on pnpm workspaces.

The existing Workflow Guard package uses npm and has a `package-lock.json`, but minimizing that one-time migration is less important than having one package-manager model for the growing multi-package repository. pnpm provides explicit workspace semantics, efficient dependency storage, and strict package dependency boundaries without requiring a separate build-orchestration framework.

Consequences:

- Add a root `packageManager` declaration pinned to the chosen pnpm release when the workspace is introduced.
- Add `pnpm-workspace.yaml` during Stage 1.
- Replace the npm lockfile with `pnpm-lock.yaml` as part of the workspace migration, not during Stage 0 documentation work.
- Use the committed lockfile with frozen-lockfile behavior in CI.
- Do not support mixed npm/pnpm installation workflows inside the repository.

## Node.js Support

Set Node.js 22 or newer as the repository baseline when Stage 1 updates package metadata.

The current package declares Node.js >=20. For a new long-lived monorepo in August 2026, carrying Node 20 support forward is not useful: Node 20 reached end of life in April 2026. Node 22 remains a supported LTS line and provides a conservative floor without forcing the repository to require only the newest runtime line.

Package manifests should express the shared minimum consistently. CI can add a newer Node line later if compatibility testing across multiple supported majors proves valuable.

## Build And Verification

Keep package-level scripts conventional and independently runnable:

```text
build
typecheck
test
```

The workspace root should orchestrate those scripts with pnpm workspace/recursive commands and expose one `verify` command that performs the supported quality gates. The exact command is established in P101 once the workspace exists.

Do not introduce Nx or Turborepo at this stage. The expected initial package count and TypeScript build cost do not justify another task graph, cache, or configuration layer. Revisit this only with measured CI/local-build pressure.

## Publishing Boundaries

Each MCP product is an independent npm package. Workflow Guard and Code Intelligence therefore keep separate package manifests, package names, versions, binaries, dependency sets, and publish artifacts even though they share one workspace and lockfile.

Root workspace tooling orchestrates development and verification; it is not the published product. Shared workspace packages remain private unless an external consumer creates a reason to support them as public APIs.

Package smoke tests should exercise each product's packed npm artifact independently. This catches accidental cross-package files, undeclared workspace dependencies, missing binaries, and assumptions that only work from the monorepo source tree.

## Test Runner

Keep Node's built-in test runner with `tsx` for the baseline. The current suite is fast and already uses it successfully. A second product does not, by itself, justify migrating to Vitest or another runner.

Individual domains may require specialized test tooling for fixtures or external systems, but repository-wide unit/integration conventions should remain simple until a concrete limitation appears.

## TypeScript

Keep `tsc` as the baseline compiler/build tool and preserve strict ESM/NodeNext semantics already used by Workflow Guard. Shared TypeScript configuration should be introduced only for settings that are actually common after the second package exists.

Do not add a bundler solely because the project becomes a monorepo.

## Decision Summary

- Package manager: pnpm workspaces.
- Node.js floor: 22+ when workspace package metadata is migrated.
- Build: `tsc` per package.
- Tests: Node test runner with `tsx` by default.
- Root verification: pnpm workspace orchestration over package-level scripts.
- Publishing: one independently versioned npm package per MCP product; shared packages private by default.
- Task graph/cache: none initially.
