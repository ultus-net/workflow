# Cross-Agent Accountability And Continuity Boundary

## Status

Accepted for roadmap planning on 2026-08-29. This document defines product boundaries and sequencing; it does not approve a specific storage schema or MCP API before P701.

## Context

The toolbox has proven a portfolio of independently useful engineering-evidence domains: Workflow Guard, Code Intelligence, Test Intelligence, Git Intelligence, Local Change Intelligence, and CI Intelligence. The umbrella architecture has intentionally separated primitive evidence, cross-domain composition, and host-specific enforcement.

Reassessment against the current `opencode-workflow-guard` implementation shows another recurring need that is not well described as either engineering intelligence or policy enforcement. Coding sessions accumulate durable facts about what work means, what verification or review occurred, which subject that evidence applies to, whether that evidence is still fresh, and which lower-priority findings remain unresolved. Those facts need to survive session boundaries and, where possible, transfers between different coding agents and harnesses.

OpenCode Workflow Guard demonstrates useful implementations of project memory, verification provenance, review attestations and durable follow-ups, project task-context discovery, recovery checkpoints, and machine-readable accountability status. It also demonstrates why host lifecycle hooks must remain distinct: native todo interception, automatic continuation, compaction injection, TUI feedback, tool-definition rewriting, environment hooks, and hard pre-tool enforcement derive authority from OpenCode rather than MCP.

## Decision

Treat cross-agent accountability and continuity as a first-class toolbox layer alongside engineering evidence, change intelligence, and policy/enforcement.

The four conceptual layers are:

1. Engineering evidence: Code, Test, Git, CI, and future runtime/data/security intelligence expose bounded observations about engineering systems.
2. Change intelligence: composed products such as `assess_local_change` correlate primitive evidence while preserving provenance and uncertainty.
3. Accountability and continuity: portable state records what has been established about work, what subject it applies to, whether it remains fresh, and what durable context or follow-up remains relevant across sessions and harnesses.
4. Policy and enforcement: Workflow Guard evaluates deterministic policy; host adapters enforce decisions only where the host provides an authoritative interception point.

The accountability layer begins with a common evidence/provenance contract rather than a universal event store. It must distinguish at least deterministic observations, attestations, derived state, and agent assertions. Evidence validity is subject-bound: a historical passing test or approval does not silently transfer to a changed worktree, commit, session, or other subject.

Project memory is the first planned concrete MCP product after that contract. Durable review evidence, verification evidence, and project-context discovery should initially be evaluated as cohesive accountability/continuity capabilities rather than split into one-server-per-tool products. Product boundaries will be decided from real trust, lifecycle, storage, and independent-use evidence.

Durability does not imply eager context injection. Portable memory and project-context capabilities should expose compact indexes, identifiers, provenance, and bounded search results so a harness can progressively disclose deeper context only when relevant. The repository remains the durable system of record where practical; accountability should make that knowledge more discoverable and verifiable rather than create a second exhaustive transcript-like context store.

## Relationship To Existing Products

- Test Intelligence remains the authority for local test execution and observed test outcomes. Accountability may reference verification evidence but must not create a second test runner.
- CI Intelligence remains the authority for provider-reported CI evidence. Accountability may reference that evidence without treating CI success as proof about a different local subject.
- Git Intelligence remains the read-only local Git evidence product. Recovery checkpoints or worktree mutations are not added to it without a separate mutation/trust-boundary decision.
- Change Intelligence continues to answer questions about a change. It does not become a session-state or memory server.
- Workflow Guard remains the policy decision product. Accountability state may be consumed by policy or host adapters, but an MCP connection alone is never represented as hard enforcement.

## Portable Candidates

The highest-priority portable capabilities demonstrated upstream are:

- subject-bound evidence/provenance and freshness semantics;
- project memory with explicit fact/decision/constraint/lesson kinds, search, supersession, provenance, and freshness;
- review attestations plus durable lower-priority follow-up debt and explicit resolution;
- verification evidence that references actual observations and invalidates when its subject changes;
- bounded discovery of durable project planning/task context without choosing or sequencing work;
- machine-readable current accountability status assembled from bounded evidence references.

Durable context also needs maintenance semantics. Supersession and freshness handle known changes, but dogfooding must also expose obsolete, contradictory, duplicate, or low-value records so they can be pruned or corrected rather than accumulating indefinitely as agent-facing knowledge.

Recovery checkpoints and managed worktree operations remain later candidates. They are portable in principle but introduce local mutation, ownership, and Git-overlap questions that should not be solved before the read-mostly accountability model is proven.

## Host-Specific Behavior

Do not move the following into MCP merely to make them appear portable:

- automatic continuation or Ralph-style iteration;
- native todo interception or task mutation gates;
- session-idle and compaction lifecycle behavior;
- TUI badges, toasts, or host notifications;
- native tool-description rewriting;
- shell environment hooks;
- same-session read/write interception and concurrent tool-call claims;
- hard pre-tool enforcement.

Portable contracts may expose information these adapters consume. Enforcement authority remains with supported host APIs, OS/container isolation, credentials, and server-side controls.

### OpenCode Workflow Guard End State

`opencode-workflow-guard` should converge on a thin OpenCode adapter/enforcer rather than remain the source of truth for the engineering workflow. Ownership should move out of the plugin for deterministic policy logic, durable project memory, review attestations and follow-up debt, verification provenance/freshness, durable project-context discovery, and Git/Test/CI/Code evidence already owned by toolbox products. The plugin may still invoke those capabilities at authoritative OpenCode lifecycle points.

The plugin should retain behavior that requires OpenCode control-plane primitives: lifecycle hooks, pre-tool interception and enforcement, native todo integration, automatic continuation, session-idle/compaction behavior, automatic review/context triggering, TUI feedback, tool-definition/environment adaptation, and same-session orchestration supported by the host.

The extraction test is behavioral rather than organizational: if a capability can produce the same meaningful result without access to an OpenCode lifecycle, session, UI, or interception primitive, it is a candidate for portable toolbox ownership. If its authority comes from controlling OpenCode itself, it remains in the adapter. This keeps OpenCode, Claude Code, Codex, and future harness integrations free to orchestrate the same portable evidence differently without reimplementing its semantics.

## Deployment Model

Default repository-sensitive toolbox capabilities to local package/process installation. Code, Test, Git, Workflow Guard policy evaluation, Project Memory over repository-owned state, and local accountability synthesis operate on local worktrees or participate in local trust decisions; keeping them local minimizes source-code disclosure, avoids turning a network service into a filesystem authority, preserves offline behavior, and gives subject identity a direct relationship to the worktree being observed.

Hosted MCPs are appropriate when the underlying authority is already remote or organizationally shared, such as CI providers, runtime observability, hosted data systems, forge metadata, or organization-level policy/evidence stores. A hosted service should receive the minimum data required for that domain and should not become a proxy with broad workstation filesystem or shell access.

Project accountability may eventually use a hybrid model when cross-machine continuity is required: local adapters establish local subjects and observations, while an optional hosted synchronization/evidence service stores portable bounded records. Synchronization must preserve origin, subject, freshness, and trust class rather than converting a remotely stored agent assertion into stronger evidence. Hosting is therefore a deployment option behind the contract, not the source of accountability semantics.

Do not require a central hosted service for cross-harness handoff on the same project/machine. P701-P707 should first prove the model locally and establish explicit identity, concurrency, and conflict semantics before remote synchronization is introduced.

## Sequencing

Finish the already implemented CI Intelligence slice through P604/P605, but do not automatically schedule another credentialed domain afterward. The next major stage is accountability and continuity:

1. Define evidence/provenance classes, subject identity, freshness/invalidation, bounds, privacy, and trust semantics.
2. Build and dogfood a minimal Project Memory MCP vertical slice with bounded, progressive-disclosure retrieval.
3. Add subject-bound review attestations and durable follow-up debt.
4. Add verification evidence by referencing Test/CI observations rather than duplicating their execution capabilities.
5. Add bounded project-context/task discovery without planning or orchestration.
6. Dogfood cross-harness handoff and measure retrieval quality, context cost, stale/obsolete-record handling, and continuity quality before expanding mutation surfaces.

## Success Criteria

The accountability layer earns permanence when a second agent or harness can recover, without relying on the first agent's transcript:

- what durable project facts and constraints were intentionally recorded;
- what verification and review actually occurred;
- which exact subject each item establishes;
- which evidence is stale or incomplete after subsequent change;
- which review follow-ups remain unresolved; and
- where durable project work context exists without the MCP choosing the next task.

Success is reduced lost state and false completion confidence across handoffs, not merely fewer repository-search calls or a larger tool count.

## Deferred Decisions

- Whether project memory and operational accountability ultimately ship in one MCP package or separate packages.
- Whether an internal cross-product evidence contract package is justified; P701 defines semantics first and extraction still requires real multiple consumers.
- Whether worktree/recovery mutations belong with accountability, Git Intelligence, or a separate product.
- Whether portable task-state mutation is useful; discovery is intentionally scheduled first because harness-native todo lifecycle and enforcement differ materially.
- Whether cross-machine or team accountability needs an optional hosted synchronization/evidence service after the local cross-harness model is proven.
