# Agent Tools Roadmap

This is the umbrella repository roadmap. Workflow Guard's product roadmap remains in `apps/workflow-guard-mcp/docs/plan.md` and continues independently where its work does not block platform milestones.

## Stage 0: Consolidate The Baseline

Goal: treat the existing Workflow Guard implementation as the first proven vertical slice and remove assumptions from the earlier greenfield platform plan.

- Verify current official MCP TypeScript SDK behavior against the patterns already used by `apps/workflow-guard-mcp/src/server.ts`.
- Decide npm workspaces versus pnpm for the future monorepo.
- Decide the supported Node.js window and root build/test conventions.
- Add black-box stdio MCP tests for `guard_check` and `guard_status`.
- Test invalid input, structured output, process lifecycle, and installed/published binary behavior.
- Record which infrastructure is genuinely reusable without extracting it yet.

Gate: the existing MCP boundary is validated end-to-end and monorepo tooling decisions are documented.

## Stage 1: Minimal Monorepo Foundation

Goal: make the repository capable of hosting a second product without destabilizing Workflow Guard.

- Introduce workspace configuration and root verification commands.
- Preserve Workflow Guard package identity and public binaries.
- Move Workflow Guard files only where a workspace layout requires it, preserving behavior and package contents.
- Keep Workflow Guard-specific policy and adapters product-owned.
- Establish deterministic fixtures/integration helpers only to the extent required by real tests.
- Add CI for the repository-wide verification command if not already supplied externally.

Gate: Workflow Guard builds, tests, and packages exactly as expected from its workspace location, and the repository can host another independently runnable package.

## Stage 2: Code Intelligence Vertical Slice

Goal: build the second real MCP product and use it to discover the correct shared abstractions.

- Define a language-service domain boundary.
- Implement TypeScript source intelligence first.
- Expose one end-to-end MCP capability before broadening the tool set.
- Add symbols, definitions, references, and diagnostics incrementally.
- Exercise it against deterministic fixtures and real TypeScript repositories.
- Track concrete duplication with Workflow Guard's server/bootstrap/testing code.

Gate: a coding agent can reliably navigate and diagnose a TypeScript repository using structured MCP results.

## Shared-Infrastructure Review Gate

Stop before building more domains.

Review:

- What code is truly duplicated between Workflow Guard and Code Intelligence?
- Which duplicated behavior has identical lifecycle, security, and error semantics?
- Are tool schemas authoritative or duplicated across TypeScript/runtime definitions?
- Which test helpers work unchanged for both servers?
- Is a shared `mcp-core` or `contracts` package now justified?

Extract only evidence-backed common infrastructure. Do not create packages solely to match `PLAN.md`.

Review result (2026-08-28): no shared package is justified yet. The two products share the stdio/process lifecycle, a small bootstrap and black-box test convention, and currently identical small TypeScript configs, but their request cancellation, security, domain-error, and bounded-output semantics differ materially. See `docs/architecture/stage-2-review.md`; revisit extraction after another concrete consumer demonstrates identical behavior.

## Stage 3: Test Intelligence

Goal: let agents identify and execute relevant tests through structured contracts.

- Define a test adapter based on the first actual runner integration.
- Implement discovery, execution, and normalized failures.
- Add file-to-test relevance.
- Combine with Code Intelligence for symbol-to-test relevance where evidence supports it.

Gate: an agent can move from changed source to relevant tests and consume failures without parsing raw terminal logs.

Review result (2026-08-28): Stage 3 is accepted. Three products justified, and P308-P309 subsequently implemented, a shared location-independent TypeScript compiler base and a narrowly scoped private black-box stdio test lifecycle helper, but not a shared MCP runtime/contracts layer. File-to-test relevance satisfies the stage gate; symbol-to-test relevance remains deferred until an explicit Code Intelligence/Test Intelligence composition demonstrates semantic evidence beyond structural file/project proximity. See `docs/architecture/stage-3-review.md`.

## Stage 4: Git Intelligence

Goal: connect current code to local change/history information.

- Add structured working-tree and diff information.
- Keep Git Intelligence independently useful; use P407 dogfood evidence to decide whether changed-symbol correlation warrants an explicit cross-domain primitive.
- Add blame/history capabilities.
- Keep remote forge integration deferred until a later credentialed domain demonstrates a need that local history cannot satisfy.

Gate: an agent can reconstruct useful code/change history through structured results.

Review result (2026-08-28): Stage 4 is accepted. Git Intelligence is independently useful for bounded local status, diff, history, and blame, while P406 showed no evidence that changed-symbol correlation belongs in either primitive product. The migration worktree also demonstrates that composition cannot manufacture Git provenance for untracked destination files. Keep products independent and evaluate changed-symbol correlation only as a measured Stage 5 intelligence-layer experiment. See `docs/architecture/stage-4-review.md`.

## Stage 5: Local Change Intelligence

Goal: prove that cross-domain composition provides value beyond primitive tools.

- Build `assess_local_change` from code, test, and Git domains.
- Return affected symbols/consumers, relevant tests, verification gaps, and recommended checks.
- Measure tool-call/context reduction during dogfooding.

Gate: composed intelligence demonstrably improves a recurring coding-agent workflow.

P501 contract: `docs/architecture/local-change-intelligence-contract.md` defines the evidence/provenance boundary and the separate-call measurement baseline that composition must beat without overstating semantic or Git relationships.

## Stage 6: Credentialed Domains

Goal: add external engineering systems in response to concrete need while preserving explicit trust boundaries.

Likely sequence, adjustable by demand:

- CI intelligence
- runtime/observability intelligence
- read-only database intelligence
- normalized security-scanner intelligence

Each begins read-only, gets a provider contract only when needed, and requires explicit credential/privacy documentation.

P601 contract: `docs/architecture/ci-intelligence-contract.md` starts Stage 6 with read-only CI run evidence because this repository already has GitHub-hosted CI. It fixes the provider-neutral trust, credential/privacy, normalization, pagination, cancellation, and deterministic fake-provider boundaries before provider implementation; CI mutations and Expanded Change Intelligence composition remain deferred.

Gate: each integration is useful independently, least-privilege, auditable, and tested against malformed/untrusted external responses.

Stage 6 sequencing update (2026-08-29): finish the current CI Intelligence dogfood/review slice, but do not automatically proceed to runtime, database, or scanner integrations. The current `opencode-workflow-guard` reassessment exposed a higher-priority cross-agent continuity gap. Further credentialed domains remain demand-driven after the Stage 6 review.

## Stage 7: Cross-Agent Accountability And Continuity

Goal: preserve trustworthy, bounded engineering accountability across sessions and different coding-agent harnesses without turning MCP into an orchestrator or claiming host enforcement it does not possess.

- Define a client-neutral evidence/provenance contract before choosing storage or broad tool APIs. Distinguish deterministic observations, attestations, derived state, and agent assertions, and bind freshness to the subject actually established.
- Build Project Memory as the first concrete vertical slice: durable facts, decisions, constraints, and lessons with search, supersession, provenance, and freshness.
- Establish a tool-exposure/context-economics gate before handoff dogfooding: measure actual model-visible tool-definition tokens where observable, retain serialized schema bytes as a portable regression metric, and require progressive discovery or narrower explicit exposure above the initial-context ceiling.
- Add subject-bound review attestations and durable lower-priority follow-up debt without making reviewer judgments deterministic proof or having the MCP launch review loops.
- Add verification evidence by referencing real Test Intelligence, CI Intelligence, or explicitly observed verification outcomes rather than creating another test runner.
- Add bounded durable project-context/task discovery without selecting, prioritizing, delegating, continuing, or sequencing work.
- Dogfood handoffs between different agents/harnesses and measure whether the receiving agent can recover current evidence, stale evidence, unresolved review debt, and durable project context without depending on the previous transcript.
- Evaluate recovery checkpoints and worktree mutations only after the read-mostly accountability model is proven and their Git ownership/trust boundary is explicit.

Gate: a cross-harness handoff can reconstruct what was established, what subject it applies to, what is stale or unresolved, and what durable context matters with materially less transcript dependence and no loss of provenance.

P701 planning boundary: `docs/architecture/accountability-continuity-boundary.md` records the portfolio split, portable candidates, host-specific exclusions, sequencing, and cross-harness success criteria. It deliberately does not preselect one universal storage or package boundary.

P701 contract: `docs/architecture/accountability-evidence-contract.md` defines the client-neutral evidence classes, subject identity, provenance, deterministic freshness/invalidation, bounded references, privacy, cancellation, and failure semantics that Stage 7 products must preserve. It deliberately treats unproven cross-kind, execution-time, and provider/local subject relationships as `unknown` rather than manufacturing current proof, and leaves storage/API/package choices to concrete vertical slices.

P702 vertical slice: `apps/project-memory-mcp` implements independently publishable bounded `record_memory`/`search_memory` tools for workspace-scoped assertion memory. `docs/architecture/project-memory-contract.md` fixes canonical workspace identity, explicit supersession, progressive retrieval, local atomic storage, secret rejection, and the deliberate single-server-process limitation; cross-process coordination remains deferred pending dogfood demand.

P702A context-economics gate: `docs/architecture/tool-exposure-context-economics.md` makes actual model-visible token cost primary and serialized `tools/list` bytes secondary, targets <=1% initial context with a 2% ceiling, preserves complete stable server catalogs, and assigns progressive disclosure to capable hosts rather than connection-local MCP catalog mutation. Native host/provider tool search is preferred; independently addressable servers and explicit enablement are the eager-host fallback. The eager/explicit OpenCode evidence is sufficient for the user-approved P703 sequencing exception; P702A itself remains incomplete and its progressive OpenAI Responses measurement is backlogged as P702B until credentials are available. P703 must still report the available deliberate tool-context cost rather than accidental eager exposure.

P704 vertical slice: `apps/review-accountability-mcp` keeps review authority separate from Project Memory assertions. It stores bounded subject-bound reviewer attestations, deterministically reports comparable-subject freshness, preserves conflicting reviewer statements, creates durable P2/P3 follow-up debt, and requires explicit debt resolution without transferring or strengthening the original approval. It neither launches reviewers nor treats persisted approval as deterministic correctness proof.

P705 vertical slice: `apps/verification-accountability-mcp` persists bounded verification observations by delegating execution and provider lookup to Test Intelligence and CI Intelligence rather than accepting caller result claims or becoming another runner. CI evidence is correlated to authority-returned run identity and gets `fresh`/`stale` only for comparable provider/repository revisions; local Test Intelligence execution retains its workspace provenance but remains `unknown` for content freshness because no stable content subject is established by that authority contract.

P706 vertical slice: `apps/project-context-mcp` provides one read-only bounded discovery tool over explicit repository-owned task/planning sources. Conventional files have fixed precedence, `docs/plans/*.md` uses deterministic bytewise ordering and bounded enumeration, snippets/results are capped, opened-file identity is checked against its canonical confined source before reading, and returned repository text remains untrusted context rather than orchestration authority.

## Stage 8: Expanded Change Intelligence

Goal: enrich change risk assessment with evidence from external systems.

- Add CI history where predictive.
- Add runtime usage and error evidence.
- Add database/schema dependencies.
- Add security findings and coverage/contract evidence.
- Add `recommended_tests`, `investigate_failure`, or `merge_risk` only where they are distinct agent workflows.

Gate: `assess_change` provides concise evidence-backed risk information that is materially better than manually combining primitive calls.

## Demand-Driven Work

- Additional language servers and test runners
- GitHub/GitLab/Azure integrations beyond demonstrated need
- Web visual/accessibility intelligence
- Project/ADR/ownership intelligence beyond the Stage 7 durable context and accountability boundary
- Hosted/remote transport infrastructure
- Independently deployed servers
- Build graph/caching systems such as Nx or Turborepo

## Workflow Guard Parallel Track

Workflow Guard may continue its own roadmap throughout these stages, including client adapters, team policy, Streamable HTTP, audit events, configuration, compatibility testing, threat modeling, and release assurance.

When Workflow Guard and another product independently need the same infrastructure, that is evidence for extraction into a shared package. Workflow Guard work should not be blocked waiting for platform generalization.

Workflow Guard may also consume or contribute portable Stage 7 contracts, but OpenCode-native todo interception, automatic continuation, compaction injection, TUI feedback, environment hooks, tool-definition rewriting, and hard pre-tool enforcement remain host behavior rather than MCP portability targets.

## Roadmap Rules

- Preserve Git history and existing product behavior during restructuring.
- Prefer migration in verified increments over a one-shot directory rewrite.
- Prefer one proven provider/adapter over several partial implementations.
- Every domain gets deterministic tests before a second provider is added.
- Every remote mutation is separately permissioned and opt-in.
- Dogfood before advancing to the next major domain.
- Revise this roadmap when observed agent behavior changes priorities.
