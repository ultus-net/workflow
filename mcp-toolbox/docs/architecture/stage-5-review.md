# Stage 5 Review

## Status

Stage 5 is accepted on 2026-08-28. The fresh repository verification and
independent review required by P506 passed.

Local Change Intelligence remains an independently publishable composition
product. It talks to Git, Code, and Test Intelligence only through their public
MCP interfaces at runtime. No primitive product imports or depends on another
primitive product, and no composition-only dependency has moved into a primitive
domain.

## Dogfood Gate

P505 measured three recurring workflow shapes at commit
`34f2c5bfdc02263d6454b254c7dca43a21639946`; detailed reproduction and results
are in `local-change-intelligence-dogfood.md`.

The small tracked test-selection workflow does not justify composition as the
default. Three direct primitive calls returned the needed evidence in 1,598
bytes and 24.89 ms, compared with one 1,874-byte composed call taking 946.84 ms.
The composed result performed semantic work that the task did not need.

The recurring multi-consumer semantic workflow does justify bounded semantic
correlation. Direct use required seven calls and 6,479 bytes of intermediate
structured evidence; composition returned the same affected declarations,
consumers, relevant test, and explicit provenance in one call and about 3 KiB.
This result held for staged and unstaged forms. Composition was slower (roughly
1.23-1.25 s versus 0.72-0.74 s), so the retained value is fewer reasoning turns
and denser evidence, not lower compute latency.

The migration-era worktree is the negative control. Git does not establish a
rename/provenance relationship between deleted root files and untracked
`apps/...` successors. One status call is enough to establish that uncertainty;
broad composition returned roughly 191 KiB and bounded recommendations. It did
not fabricate a relationship. Dogfooding also found and fixed unsupported
semantic dispatch for a changed `package.json`: non-TypeScript paths now keep
Git/Test evidence without calling the TypeScript semantic capability.

## Permanence Decisions

Retain `assess_local_change` as a bounded composition surface, and retain
affected-symbol/consumer correlation. The latter has earned permanence because
it performs a recurring cross-domain reasoning step that otherwise requires
patch-line interpretation plus multiple semantic calls, while carrying each
material Git/Code source in the output.

Retain verification-gap and recommendation synthesis as decision support, not
coverage evidence. Structural test relevance remains explicitly distinct from
observed execution. `runRelevantTests` remains opt-in and carries the Test
Intelligence execution trust boundary through the composed tool annotations.

Do not position composition as a replacement for direct primitive calls. Agents
should prefer Git/Test primitives for narrow status, patch, or test-selection
questions. Do not add eager rename inference, coverage inference, remote forge
integration, or automatic broad test execution. The measured broad-worktree
cost also does not justify a new caching/runtime abstraction in this stage.

## Architecture And Trust

Semantic claims still require an unambiguous single Git scope, bounded patch
evidence, current TypeScript declaration intersection, and exact reference
evidence. Deleted, renamed, untracked, binary, mixed-scope, unsupported-language,
or truncated cases remain unknown rather than inferred. Required capability
failures after a valid request fail closed; expected ineligible inputs are not
requests to that capability.

All public limits remain bounded and uncertainty remains visible through source
provenance, nullable semantic/test evidence, and truncation/incomplete flags.
No new shared package or primitive dependency is approved by Stage 5.

## Verification

P506 ran the root `pnpm run verify` gate plus `git diff --check` after the final
Stage 5 mutations. Independent review covered test integrity, task completeness,
code hygiene, security/trust boundaries, and platform/architecture fit including
performance. It found no P0/P1 blockers. One P2 noted that independently
versioned primitive peers could over-return records before composition applied
its aggregate bounds; the runtime port schemas now enforce requested
cardinalities (and Test Intelligence's execution-result ceilings), with an
over-return regression at the process boundary. A P3 documentation precision
finding was also resolved by naming Code Intelligence alongside the Git and Test
runtime peers. Stage 5 therefore closes with product independence and bounded
trust boundaries intact.
