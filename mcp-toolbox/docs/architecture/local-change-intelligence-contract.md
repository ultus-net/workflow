# Local Change Intelligence Contract

## P501 Scope

Stage 5 tests whether an explicit intelligence layer can improve recurring
coding-agent change assessment beyond separate Git, Code, and Test Intelligence
calls. The first public capability is `assess_local_change`. It is read-only and
may correlate existing domain evidence, but it does not widen any primitive
domain's authority or make one primitive product depend on another.

P501 fixes the composition and measurement contract before implementation. It
does not approve changed-symbol correlation as a permanent feature. P503 may
experiment with that correlation only after P502 establishes a path-level
vertical slice, and P505 must measure the composed workflow against the
separate-call baseline below before P506 keeps or removes experimental output.

## Dependency And Trust Boundary

The dependency direction from `PLAN.md` remains authoritative:
change-intelligence may orchestrate domain APIs from above, while Code, Test,
and Git Intelligence remain independently runnable and publishable. Primitive
products do not import each other or change their public contracts for the
composition layer. P502 must choose the narrowest wiring that preserves this
direction; P501 does not justify extracting domain packages or a shared
contracts/runtime package merely to make composition convenient.

The composition layer receives no authority beyond the capabilities it
orchestrates. Git evidence remains local and read-only. Code Intelligence keeps
its own TypeScript/project and filesystem-confinement rules. Test discovery and
relevance keep their project-ownership rules; test execution remains an
explicit Test Intelligence operation and is not implied by assessment. The
composition layer must not execute package scripts, Git mutations, remote
operations, or credentialed integrations.

`workspaceRoot` is an absolute caller-granted root passed to each participating
domain through its existing boundary. A successful composition cannot broaden
that root when one domain rejects it. Domain errors and confinement failures
are not evidence that the missing relationship is absent.

## Evidence Model

Every composed claim must remain distinguishable as one of three classes:

- `observed`: a normalized fact returned by a primitive domain, such as a Git
  path/state or a Test Intelligence relevance candidate;
- `derived`: a deterministic correlation over identified observed facts, with
  the source facts named and any uncertainty retained;
- `recommended`: an action suggested from observed/derived evidence, never
  presented as a fact that the action ran or that a test covers a change.

P502 should keep provenance small rather than duplicating primitive payloads.
Each composed record identifies its source capability (for example,
`git.working_tree_status` or `test.find_relevant_tests`) and the stable source
identity needed to explain the claim, such as a workspace-relative path/test
ID. If a derivation uses multiple facts, all material sources are represented.
Human explanation text may summarize a derivation but is not its provenance.

Absence of evidence stays distinct from negative evidence. In particular,
`same_project` and `matching_stem` are structural relevance signals, not proof
of test coverage; no references for a surviving symbol do not prove there are
no dynamic consumers; and an untracked destination has no Git history merely
because a deleted tracked path has similar content or a similar name.

## Initial `assess_local_change` Boundary

P502 starts at path level. Given an absolute `workspaceRoot`, it obtains bounded
working-tree change identities from Git Intelligence and may enrich those paths
with existing Code/Test results. The initial result contains changed-path facts,
structural relevant-test candidates, source provenance, and explicit
truncation/incompleteness metadata. It does not return changed symbols,
consumers, coverage claims, verification gaps, or recommendations before the
later tasks that define and test those derivations.

The result is deterministic for identical primitive responses. Ordering is
defined by normalized workspace-relative path and then by the owning domain's
existing deterministic ordering. Composition limits are positive and bounded;
P502 must set concrete defaults/maxima before exposing an MCP schema. Source
truncation is propagated: a derived collection cannot claim completeness when
the source evidence used to build it was truncated.

For the first vertical slice, failure of a required domain call fails the
assessment with a normalized composition error rather than silently returning
a result that looks complete. P502 may distinguish required Git change
discovery from optional enrichment only if the public result explicitly names
which domains completed and which did not. There is no fallback to raw CLI
parsing or a second implementation of a primitive domain.

## Experimental Symbol Correlation

P503 may correlate Git change evidence with Code Intelligence symbol/reference
evidence only where both facts actually identify the relationship. A surviving
working-tree symbol whose source range intersects observed changed text may be
a derived affected-symbol candidate; references returned for that exact current
symbol may be derived consumer candidates. The implementation must define the
line/range mapping and negative cases before treating either as output.

Deleted symbols, binary changes, whole-file deletions, untracked destination
files, rename ambiguity, truncated patches, and syntax states where current
Code Intelligence cannot identify the prior symbol are explicitly uncertain
unless another existing primitive supplies the missing fact. Similar
path/content/name heuristics may be useful exploration hints, but they cannot be
reported as Git provenance or semantic identity.

Symbol-to-test correlation has the same burden. Passing an affected symbol's
containing file to `find_relevant_tests` only reproduces structural file
relevance and must remain labelled that way. A permanent symbol-to-test claim
requires semantic evidence beyond `exact_file`, `matching_stem`, or
`same_project` and must improve the P505 workflow measurements.

## Measurement Protocol

P505 compares composition with a separate-call baseline on the same repository
state, task prompt, evidence limits, and stopping condition. P501 defines the
baseline as direct use of the existing primitive tools: discover changed paths
with `working_tree_status`, request `local_diff` only for paths where patch
evidence is needed, use Code Intelligence directly for requested semantic
questions, and use `find_relevant_tests`/`run_tests` only when the workflow
requires test evidence. This matches the two-step Git workflow observed by
P406 rather than penalizing the baseline with an eager full diff.

For each representative workflow, record:

- primitive/composed tool-call count needed to reach the same decision;
- serialized structured-result bytes delivered to the agent, including
  truncation metadata;
- wall-clock latency, with the compared runs identified as cold or warm rather
  than mixing the two;
- correctness of path/symbol/test claims against facts the repository can
  establish, including unsupported or uncertain cases;
- whether the workflow required follow-up calls because evidence was missing,
  truncated, ambiguous, or wrong.

At minimum, dogfooding includes a small tracked source edit, a change with
multiple consumers/test candidates, and a repository-shape case involving an
untracked or rename-like destination. Additional cases should be added only
when they represent recurring work rather than benchmark-friendly fixtures.
Store enough task description, repository state/commit identity, limits, and
result-size/timing data for another run to reproduce the comparison.

There is no preselected percentage that makes composition successful. P506
accepts a capability only when measurements show a recurring workflow benefit
without losing material evidence or overstating provenance. Aggregation that
merely moves the same bytes behind one tool call does not by itself satisfy the
Stage 5 gate.

## Verification Gate

P502-P504 require deterministic fixtures at the composition boundary and
black-box MCP coverage for every exposed public shape. P505 uses real-repository
dogfooding in addition to those fixtures. Root `pnpm run verify` remains the
repository quality gate throughout Stage 5, and P506 requires independent
review before accepting any experimental correlation as permanent architecture.
