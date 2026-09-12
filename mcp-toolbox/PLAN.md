# Agent Tools Platform Plan

## Purpose

Evolve this repository from a single Workflow Guard MCP package into a modular TypeScript monorepo for coding-agent tools. Workflow Guard remains a product in its own right and becomes the first proven vertical slice rather than being rewritten around speculative shared abstractions.

The platform should favor structured engineering intelligence over thin CLI wrappers. A new MCP capability should either expose information that is otherwise difficult for an agent to obtain safely, or correlate noisy information into a smaller typed result that improves engineering decisions.

Workflow Guard's product-specific plan remains in `apps/workflow-guard-mcp/docs/plan.md`.

## What Already Exists

The current repository has already validated several architectural choices:

- TypeScript, ESM, Node.js, the official MCP SDK, Zod, and stdio work together in a small distributable package.
- `apps/workflow-guard-mcp/src/server.ts` is a thin MCP adapter over domain logic rather than the owner of policy behavior.
- `apps/workflow-guard-mcp/src/policy.ts` exposes a client-neutral typed policy boundary.
- Deterministic policy checks are separated by concern and are independently testable.
- `apps/workflow-guard-mcp/src/claude-hook.ts` demonstrates that host enforcement adapters are distinct from advisory MCP transport.
- `apps/workflow-guard-mcp/docs/policy-coverage.md` clearly separates deterministic policy, trusted host/runtime facts, and concerns outside policy evaluation.
- The test suite contains adversarial coverage for policy parsing and safety behavior.

These are reference patterns. They should be reused where appropriate, not mechanically imposed on unrelated tools.

## Architectural Principles

1. Keep one repository for the coding-agent tooling portfolio while each MCP product remains an independently runnable and independently publishable npm package.
2. Split MCP servers by capability domain, trust boundary, lifecycle, or external system, not by individual tool.
3. Keep MCP transport thin. Domain behavior must remain usable and testable without an MCP connection.
4. Validate MCP and external-system inputs at boundaries; keep internal domain APIs typed.
5. Return structured results rather than making agents parse human-oriented CLI output.
6. Treat repositories, command text, remote responses, and third-party data as untrusted input.
7. Enforce security with code, permissions, and least-privilege credentials rather than relying on model instructions.
8. Distinguish advisory decisions from host enforcement, as Workflow Guard already does.
9. Keep domain packages independent. Cross-domain correlation belongs in an explicit intelligence layer.
10. Extract shared infrastructure only after at least two products demonstrate the same requirement.
11. Build one provider/adapter well before generalizing across many providers.
12. Dogfood each major capability before expanding the roadmap.
13. Treat durable accountability and continuity as distinct from both engineering intelligence and policy enforcement: portable evidence may cross sessions and harnesses, while host lifecycle authority remains adapter-owned.
14. Default repository-sensitive MCPs to local processes; use hosted services when the authoritative system is remote/shared, and add optional accountability synchronization only after local subject/freshness semantics are proven.
15. Treat agent context as a bounded resource: durable knowledge should support progressive disclosure and targeted retrieval, and accumulated agent-facing records must remain inspectable for stale, duplicate, contradictory, or obsolete content.

## Target Repository Shape

The target shape is directional. Directories should be introduced only when they contain real code.

```text
agent-tools/
|-- apps/
|   |-- workflow-guard-mcp/
|   |-- code-mcp/
|   |-- test-mcp/
|   |-- git-mcp/
|   `-- ...
|-- packages/
|   |-- mcp-core/                 # proven shared MCP infrastructure only
|   |-- contracts/                # genuinely cross-product contracts only
|   |-- workflow-guard/
|   |-- code-intelligence/
|   |-- test-intelligence/
|   |-- git-intelligence/
|   `-- change-intelligence/
|-- adapters/
|   |-- claude/
|   `-- ...
|-- integrations/
|   |-- github/
|   |-- postgres/
|   |-- opentelemetry/
|   `-- ...
|-- test/
|   `-- fixtures/
|-- docs/
|   |-- architecture/
|   |-- security/
|   `-- products/
|-- PLAN.md
|-- ROADMAP.md
|-- TODO.md
`-- pnpm-workspace.yaml
```

The repository can be renamed from `workflow-guard-mcp` when convenient. Renaming the repository is independent of restructuring its contents and should not block engineering work.

Each MCP application is also a package/release boundary. In particular, Workflow Guard and Code Intelligence must have separate package names, versions, npm artifacts, binaries, dependencies, and release lifecycles. Installing one must not install or expose the other's executable as part of the same npm package.

Shared internal packages should remain private by default. Publish a shared package only when it has a concrete consumer outside this monorepo; monorepo reuse alone does not require another public npm API.

## Dependency Direction

The intended long-term direction is:

```text
apps/* and adapters/*
          |
          v
   domain packages ------> provider integrations
          |                        |
          +-----------+------------+
                      v
             proven shared packages

change-intelligence ---> domain APIs
```

Avoid package dependencies created only to satisfy this diagram. A package boundary is justified by independent publishing, independent testing/lifecycle, a trust boundary, or demonstrated reuse.

## Workflow Guard Boundary

Workflow Guard is the reference product and should retain its semantics while the monorepo evolves.

Conceptually, its current code contains three categories:

### Portable policy behavior

Deterministic policy evaluation, shell/path/Git parsing, and portable checks can eventually live in a Workflow Guard domain package if extraction improves testing or reuse.

### Product policy

Protected branches, read-only coding-agent roles, tamper protection, secret-transfer rules, MCP mutation classification, and PR preflight remain Workflow Guard behavior. They must not migrate into generic MCP infrastructure simply because they are security-related.

### Host adapters

Claude Code mapping is client-specific enforcement glue. Future OpenCode, Codex, or other host integrations should remain adapters around a client-neutral policy contract.

Do not perform these extractions as a prerequisite to starting a second MCP product. Preserve behavior first; extract when a boundary produces concrete value.

## Shared MCP Infrastructure

A future `mcp-core` may own concerns that demonstrably recur across MCP products, such as:

- server bootstrap and identity conventions
- stdio lifecycle
- typed tool registration conventions
- cancellation and abort propagation
- normalized error handling
- output-size/truncation policy
- request correlation and privacy-conscious telemetry
- shared black-box MCP test helpers

It should not own domain security policy, source-code semantics, Git rules, test-runner behavior, database permissions, or provider-specific authentication.

Code Intelligence and Test Intelligence have now supplied the second and third concrete products. The Stage 3 review approved and the repository subsequently extracted only two proven shared pieces: the location-independent TypeScript compiler base configuration and the test-only SDK client lifecycle used to launch compiled stdio servers. Server runtime/bootstrap, domain contracts, schemas, confinement, cancellation, timeout, and output-limit behavior remain product-local because their semantics still differ. See `docs/architecture/stage-3-review.md`.

## Contracts

Prefer schemas beside the package that owns the behavior. A root `contracts` package should exist only for types genuinely consumed by multiple independent products.

MCP tool inputs and outputs should have one authoritative runtime schema from which TypeScript types are inferred where practical. This avoids the current Workflow Guard pattern where `GuardCheckInput` and the MCP Zod schema can drift.

Common result metadata may eventually include duration, truncation, and warnings, but only if it works naturally with the MCP SDK's native error and structured-content semantics.

## Capability Domains

### Workflow Guard

Continue the existing roadmap in `apps/workflow-guard-mcp/docs/plan.md`: portable deterministic policy, client enforcement adapters, team policy, and distribution/assurance. Its current security boundary remains authoritative: an advisory MCP server is not a sandbox.

### Code Intelligence

This is the next MCP product because it supplies high-value read-only capability without cloud credentials.

Initial tools:

- `document_symbols`
- `workspace_symbols`
- `find_definition`
- `find_references`
- `diagnostics`

Define a language-service adapter rather than making the domain TypeScript-specific. Implement TypeScript first, then add other language servers only in response to demand.

### Test Intelligence

Provide structured test discovery, execution, failures, and eventually coverage. Define a test-adapter contract after Code Intelligence has validated the broader monorepo patterns.

Candidate capabilities include `discover_tests`, `run_tests`, `run_tests_for_file`, `run_tests_for_symbol`, `test_failures`, and coverage queries.

### Git Intelligence

Expose structured local history and change information separately from remote forge integrations. Useful product capabilities include working-tree state, diffs, and blame/history. Correlating Git changes with code symbols is cross-domain intelligence and should be introduced only when dogfooding demonstrates value beyond separate Git and Code Intelligence calls; correlation with pull requests and issues remains a later credentialed/forge concern.

### CI, Runtime, Data, And Security Intelligence

These domains introduce stronger credential/trust boundaries and come later. They should begin read-only and use least-privilege credentials. Data access should use database-enforced read-only credentials wherever possible. Security tooling should normalize established scanners and must never return discovered secret values to the model.

### Web And Project Intelligence

Web intelligence remains demand-driven because existing browser tooling already supplies strong low-level capabilities. Project intelligence now has two distinct cases: exploratory repository intelligence still requires measurable reductions in repository exploration, while durable project context belongs to the cross-agent accountability/continuity layer when it measurably prevents lost state or unsupported completion claims across handoffs.

### Accountability And Continuity

The current `opencode-workflow-guard` implementation demonstrates portable concepts beyond deterministic policy: project memory, subject-bound verification evidence, review attestations and follow-up debt, and bounded discovery of durable planning context. These should be developed as a first-class cross-agent layer rather than hidden inside Workflow Guard or Change Intelligence. See `docs/architecture/accountability-continuity-boundary.md`.

Begin with an evidence/provenance contract that distinguishes deterministic observations, attestations, derived state, and agent assertions. Evidence must identify what subject it establishes and must not silently remain valid after that subject changes. Project memory is the first planned concrete product slice; review, verification, and task-context capabilities should earn package boundaries from demonstrated independent lifecycle/trust requirements rather than one-server-per-tool decomposition.

Durable knowledge should be retrieved progressively rather than injected wholesale into every agent context. Project Memory and context-discovery tools should return bounded high-signal references/results that let a harness load detail just in time, and their dogfood evaluations should measure retrieval quality, token/context cost, and stale or obsolete record accumulation as well as storage correctness.

MCP portability does not imply host enforcement. Native todo interception, session continuation, compaction injection, environment hooks, TUI feedback, and pre-tool blocking remain client adapters or host behavior. Recovery/worktree mutation remains deferred until ownership and Git-domain boundaries are explicit.

`opencode-workflow-guard` should ultimately be an OpenCode adapter/enforcer over these portable capabilities, not their canonical implementation. Deterministic policy, memory, review/verification state, and durable context should move to toolbox ownership as their portable contracts mature; OpenCode lifecycle interception, automatic continuation, native todo behavior, context/review triggering, and UI/session orchestration remain plugin responsibilities. Repository-sensitive MCPs are local-first; remote-system intelligence may be hosted, and future cross-machine accountability should use bounded synchronization rather than granting a hosted MCP broad workstation authority. See `docs/architecture/accountability-continuity-boundary.md`.

## Cross-Domain Intelligence

Do not build orchestration before the underlying domains are useful independently.

The first composed capability should be `assess_local_change`, using Code Intelligence, Test Intelligence, and Git Intelligence. It should identify affected symbols/consumers, relevant tests, verification gaps, and recommended checks.

Later, an `assess_change` capability can incorporate CI history, runtime evidence, database dependencies, public contracts, and security findings. Its success criterion is fewer low-level agent calls and better evidence-backed decisions, not merely aggregation.

Accountability is not another change-intelligence aggregator. It records what was established about work, which subject that evidence applies to, whether it remains fresh, and what durable context survives a handoff. Change Intelligence may produce evidence that accountability references, but it should not become a session-state or project-memory service.

## Security Model

The broader platform should preserve Workflow Guard's distinction between policy, trusted runtime facts, and enforcement while adding capability-level permissions:

```text
READ
  inspect source/history
  query telemetry
  query databases with read-only credentials

LOCAL_WRITE
  run tests/builds
  create temporary artifacts

REMOTE_WRITE
  rerun CI
  deploy previews
  mutate remote systems
```

Remote writes are individually opt-in. Repository configuration cannot grant permissions denied by the user's trusted configuration.

Important controls include workspace confinement, symlink-aware paths, subprocess cancellation/timeouts, output limits, credential/secret redaction, environment separation, audit events, and explicit mutation authority.

Workflow Guard's existing policy should be reused where it is the correct enforcement layer rather than duplicated inside every new MCP server.

## Transport And Configuration

Use stdio for local products first. Workflow Guard's planned Streamable HTTP team-policy work remains a product requirement and can provide evidence for any future shared remote-transport infrastructure.

Configuration ownership should be explicit. Product configuration belongs to the product; shared configuration machinery should be extracted only after common semantics exist. Untrusted repository configuration must never silently escalate capabilities.

## Testing Strategy

Preserve the existing adversarial Workflow Guard tests. Evolve toward three complementary levels:

1. Domain tests for pure logic.
2. Adapter/provider contract suites where multiple implementations exist.
3. Black-box MCP tests against real stdio servers and deterministic fixture workspaces.

Workflow Guard now has black-box MCP protocol tests. Their harness is a candidate for reuse by Code Intelligence if a second implementation demonstrates genuine reuse.

Workflow Guard also smoke-tests its packed npm artifact, installed binary shims, and installed MCP server. Future publishable products should satisfy the same release contract independently.

## Technology Direction

Existing choices are the default until evidence requires a change:

- TypeScript and ESM
- Node.js >=22
- official MCP TypeScript SDK
- Zod runtime schemas
- `tsc` builds
- Node's test runner with `tsx`
- stdio for local MCP transport

The monorepo standard is pnpm workspaces with a single workspace lockfile and a Node.js 22+ baseline. See `docs/architecture/monorepo-tooling.md`.

Do not add Nx or Turborepo until build/test scale demonstrates a need.

## Near-Term Boundary

The next milestone is not a full source-tree migration. It is:

```text
1. preserve Workflow Guard behavior and history
2. document the umbrella architecture
3. black-box test the existing Workflow Guard MCP boundary
4. establish minimal workspace conventions
5. build the first Code Intelligence vertical slice
6. identify actual duplication
7. extract shared MCP infrastructure only then
```

This sequence lets the second real product, rather than the architecture diagram, determine the shared platform API.

## Success Criteria

The repository succeeds when its tools make coding agents safer and more effective while remaining independently understandable and operable. Platform success is measured by correctness, safety boundaries, structured-result quality, context efficiency, latency, reliability, and reduced low-level agent work, not by package or tool count.
