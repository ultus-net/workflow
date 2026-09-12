# MCP Product Boundary Survey

Survey date: 2026-08-28.

This review compares the existing `/var/home/hunter/opencode-workflow-guard` capabilities with the umbrella MCP repository. The goal is not one MCP server per current tool family. A separate product should have a cohesive domain, durable/client-portable semantics, and a release lifecycle that can evolve independently.

## Recommended Portfolio

### Workflow Guard MCP

Keep the existing `apps/workflow-guard-mcp` product focused on deterministic policy decisions. Policy evaluation, policy IDs, shell/Git/path/interpreter rules, protected branches, remote-mutation classification, and PR preflight belong together.

Host interception remains an adapter responsibility. An MCP server cannot become authoritative over native client tools merely by exposing policy methods.

Review/accountability tools should remain associated with Workflow Guard for now. Review freshness currently depends on trusted mutation/session observations that an advisory MCP server cannot independently reconstruct.

### Project Memory MCP

Recommended as a strong candidate for independent extraction, to be evaluated at the existing post-Code-Intelligence review gate rather than scheduled ahead of the current roadmap.

Current source: `/var/home/hunter/opencode-workflow-guard/src/lib/project-memory.ts`.

Current tools: `project_memory_search`, `project_memory_record`, `project_memory_import`, and `project_memory_export`.

The existing domain is more specific than generic chat memory: typed facts/decisions/constraints/lessons, provenance, supersession, Git/path freshness, bounded retention, SQLite/FTS retrieval, cross-process coordination, secret rejection, and explicit promotion to portable repository-local JSONL.

That is a coherent repository-knowledge product and is largely client-portable. Extraction should preserve these differentiators; if reduced to generic key/value or knowledge-graph memory, use an established memory MCP instead of maintaining another one.

### Socratic Learning MCP

Potential independent product after Project Memory, subject to dogfooding outside OpenCode.

Current source: `/var/home/hunter/opencode-workflow-guard/src/lib/learning.ts`.

Current tools: `learning_profile`, `learning_checkpoint`, and `learning_record`.

This should not be merged with project memory. Its state subject is a person across repositories, with different privacy, retention, synchronization, and product semantics. Opportunity ranking, intervention budgets, and evidence-backed learner state form a coherent learning domain.

### Change Assurance / Evidence MCP

Possible future product, not ready for extraction.

The current review/verification/follow-up machinery has a useful domain, but its truth depends on OpenCode observing workspace mutations and session provenance. `record_review`, verification freshness, mutation journals, and durable follow-ups are security/accountability state rather than project knowledge.

Extract only after at least two hosts can supply an equivalent trusted event/evidence contract. Until then, keep this behavior with Workflow Guard plus its host adapters.

## Keep Host-Specific

Do not extract the following as standalone MCP products now:

- `guard_next_tasks`: useful planning-file discovery, but not a differentiated durable task system;
- `guard_worktree_create` / `guard_worktree_cleanup`: their value comes from Workflow Guard ownership, protected-branch policy, todo state, and mutation/evidence invalidation rather than from wrapping Git worktrees;
- OpenCode todo ownership and lifecycle;
- Ralph/idle continuation;
- recovery checkpoints;
- file claims and concurrent native-tool lifecycle;
- permission UI/TUI behavior;
- runtime mutation observation used to decide whether verification/review evidence is still fresh.

Those depend on host capabilities and trusted lifecycle hooks. Putting MCP methods in front of them would not make the semantics portable.

## Prefer Existing Tools

Do not create standalone products for generic filesystem search, Git/worktree primitives, forge CRUD, browser primitives, or generic code search. Mature host tools and MCP servers already cover those operations.

The same rule applies to generic memory. Project Memory is worth extracting only because repository identity, provenance, supersession, freshness, secret filtering, bounded retention, and explicit portable promotion are part of its contract.

## Evaluation Order

1. Keep Workflow Guard MCP as the deterministic policy product and its host enforcement integrations separate.
2. Build Code Intelligence's first TypeScript-native vertical slice as planned; do not merge it with Workflow Guard.
3. At the post-Code-Intelligence shared-infrastructure/product review gate, evaluate Project Memory as a future independent product alongside the already planned roadmap priorities. Do not let this survey silently reorder `ROADMAP.md`.
4. If Project Memory is promoted through that roadmap decision, extract it as a client-portable domain rather than as a generic memory wrapper.
5. Dogfood Socratic Learning outside OpenCode and consider it separately only if there is genuine cross-client demand; it should not be bundled into Project Memory for convenience.
6. Keep review/verification assurance with Workflow Guard until trusted lifecycle evidence is portable across hosts.
7. Leave planning discovery, worktrees, recovery, continuation, file claims, and native session lifecycle in host adapters.

This keeps product boundaries aligned with state ownership and trust boundaries rather than with the accidental shape of today's custom-tool list.
