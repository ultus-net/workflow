# LLM Harness Enhancements: Deterministic Enforcement

The prompting approach and deterministic harness enforcement are complementary, but they should have different responsibilities. Prompting can help an LLM reason about decomposition, dependencies, risk, and verification. It should not be the sole authority enforcing invariants that must always hold.

LLM behavior remains probabilistic. Models can hallucinate completion, lose tasks during context compression, optimistically infer dependency state, skip verification, or continue downstream after a failed prerequisite. Repeating an invariant more emphatically in a prompt can reduce these failures but cannot make the invariant deterministic.

The stronger architecture is to let the model propose actions and state transitions while the harness independently decides whether those transitions are legal.

## Responsibility Boundary

```text
LLM
- understand intent
- propose decomposition
- identify likely dependencies
- select among eligible work
- reason about failures
- propose verification

HARNESS
- own canonical task state
- validate dependency satisfaction
- enforce legal state transitions
- require verification evidence
- prevent blocked work from starting
- detect omitted/skipped tasks
- enforce risk gates
- preserve state across model/context boundaries
```

The LLM should not be able to declare an invariant satisfied merely by emitting text saying that it is satisfied.

## Canonical State Outside the Model

Maintain the authoritative task graph in machine-readable harness state. The model receives a projection of that state but does not own it.

Each node should have enough information for deterministic eligibility checks:

```text
id
objective
dependencies[]
required_artifacts[]
expected_postconditions[]
acceptance_criteria[]
verification_requirements[]
risk_class
mutation_scope
status
verification_evidence[]
```

Where possible, artifacts and postconditions should be machine-observable rather than natural-language claims.

## Hook-Enforced State Machine

Use hooks or equivalent middleware at the boundaries where an agent can mutate the world or task state.

```text
BLOCKED -> READY
Allowed only if dependency and input predicates pass.

READY -> IN_PROGRESS
Allowed only after a fresh precondition check.

READY -> BLOCKED
Required when a fresh precondition check fails or required state becomes invalid.

IN_PROGRESS -> VERIFYING
Allowed after the bounded action completes.

VERIFYING -> VERIFIED
Allowed only when required verification evidence passes.

VERIFYING -> FAILED
Required when verification fails.

FAILED/BLOCKED -> READY
Allowed only after the cause of failure/blocking is demonstrably resolved.
```

Reject illegal transitions instead of asking the model to remember not to make them.

## Pre-Execution Hook

Before a mutation-capable tool call, deterministically evaluate at least:

```text
task.status == READY
all(task.dependencies.status == VERIFIED)
required_artifacts_exist(task)
required_preconditions_hold(task)
verification_strategy_defined(task)
risk_gate_satisfied(task)
mutation_matches_declared_scope(task)
```

If any predicate fails, reject the operation, keep or return the task to `BLOCKED`, and expose the failed predicate to the model. Fail closed when state is unknown rather than assuming readiness.

## Verification Hook

Treat tool success and task success as separate events. A successful command should produce evidence that is subsequently evaluated against the expected postcondition.

Examples include:

- tests report the expected assertions passing;
- a build artifact exists and is valid;
- an endpoint returns the expected behavior;
- a cloud resource reports the required state;
- a Kubernetes workload becomes ready and passes its health checks;
- an IAM policy is evaluated against intended allow/deny behavior;
- a network path is demonstrably reachable or unreachable as required.

Only the harness should authorize `VERIFYING -> VERIFIED` for invariants it can check deterministically.

## Dependency Unlocking

Do not let the LLM manually unlock downstream tasks. Recompute readiness from canonical state whenever a dependency changes.

Conceptually:

```text
for each BLOCKED task:
    if all dependencies VERIFIED
       and required artifacts exist
       and static prerequisites are satisfied:
        transition task to READY
```

Dynamic environmental preconditions should still be rechecked immediately before execution because infrastructure state can become stale between scheduling and action.

## Detect Skipping and Lost Tasks

The harness should compare completion against the canonical graph, not against the model's latest summary. Before the overall run can complete, enforce predicates such as:

```text
all(required_tasks.status == VERIFIED)
no required task is BLOCKED
no required task is READY
no required task is IN_PROGRESS
no required task is VERIFYING
no required task is FAILED
final_integration_verification == PASSED
```

This makes forgetting a task during context compression or reasoning insufficient to remove it from the workflow.

## Dynamic Dependency Discovery

The model must still be able to discover prerequisites that were not visible during initial planning. Treat graph mutation as a controlled operation:

```text
1. Agent reports newly discovered prerequisite.
2. Current task becomes BLOCKED.
3. Harness adds/validates the prerequisite edge or node.
4. Cycle detection runs before accepting the graph mutation.
5. Newly eligible prerequisite work is scheduled.
6. Original task can become READY only after the new dependency verifies.
```

Cycle detection is important because dependency graphs assembled incrementally by an LLM should not be assumed to remain acyclic.

## Infrastructure-Specific Enforcement

For infrastructure mutations, hooks can enforce additional controls independently of model reasoning:

- Require a fresh observation or plan before mutation where the platform permits it.
- Classify destructive or high-blast-radius operations and require stronger authorization.
- Reject retries when idempotency/recovery characteristics are unknown.
- Require rollback or recovery information for selected risk classes before execution.
- Invalidate cached readiness when relevant external state changes.
- Re-observe eventual-consistency-sensitive state rather than treating API acknowledgement as readiness.
- Separate production credentials and permissions from lower-risk environments at the tool/permission layer, not merely through instructions.

## Tool Capability Boundaries

Deterministic checks are strongest when combined with least-privilege tool exposure. A prompt saying "do not modify production" is weaker than withholding production mutation capabilities until an explicit policy gate authorizes them.

Prefer enforcement in this order when feasible:

```text
1. Capability boundary: impossible operation
2. Deterministic policy/hook: rejected operation
3. Workflow state machine: blocked transition
4. Prompt instruction: model is told not to do it
```

Prompting remains valuable at layer four because it helps the model avoid repeatedly proposing actions that the lower layers will reject. It should be treated as behavioral guidance, not the security or correctness boundary.

## Evidence Should Be Typed

A further enhancement is to avoid a generic boolean `verified`. Associate verification evidence with the postcondition it proves:

```text
evidence:
  type: test_result | resource_state | health_check | policy_check | artifact
  subject: <task/resource/artifact identifier>
  observed_at: <timestamp/state version>
  result: pass | fail
  details: <machine-readable payload/reference>
```

This enables freshness policies. A network reachability check from thirty minutes before a routing mutation should not necessarily satisfy a current dependency. Evidence can be invalidated when a mutation affects the state it depended on.

## Avoid False Determinism

Hooks should enforce predicates that can actually be established. Do not turn an LLM's natural-language assertion into a boolean and call that deterministic verification. If a property cannot be checked automatically, record that distinction explicitly and choose an appropriate human approval, external probe, or policy decision.

Determinism is most useful for workflow invariants such as legal transitions, graph consistency, required evidence presence, command/tool permissions, and observable machine state. Semantic judgments can remain with the LLM or human while being prevented from silently masquerading as mechanically verified facts.

## Recommended Governing Principle

```text
The model proposes.
The harness validates.
The environment provides evidence.
Only validated evidence advances state.
```

This architecture directly addresses hallucinated completion and skipped work. Instead of trying to make the LLM perfectly obedient through prompt injection alone, it assumes reasoning can fail and makes critical workflow invariants independently enforceable.
