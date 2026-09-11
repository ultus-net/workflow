# Prompt Critique: Atomic, Dependency-Aware Execution

The goal should be stronger than asking an LLM to "break tasks into small steps." Decomposition and dependency satisfaction should be explicit parts of the execution protocol, with state transitions that prevent work from starting merely because it appears next in a list.

The useful abstraction is a lightweight dependency-aware scheduler rather than a conventional todo list. A numbered plan encourages sequential-looking reasoning but does not enforce prerequisites.

## Recommended Execution Protocol

```text
TASK EXECUTION PROTOCOL

Before implementation, decompose the request into atomic, independently
verifiable work units.

1. ATOMIC DECOMPOSITION
Break work down recursively until every task:
- has exactly one primary outcome;
- can be completed without switching objectives;
- has an observable completion condition;
- has a concrete verification method;
- lists every prerequisite it depends on;
- is small enough that failure affects only that unit.

If a task contains multiple independent actions, split it again.
Prefer the smallest useful executable unit, but do not split mechanical
operations that have no independently meaningful completion criterion.

2. DEPENDENCY GRAPH
Represent each task as:

ID:
Objective:
Depends on:
Inputs required:
Acceptance criteria:
Verification:
Status: blocked | ready | in_progress | verified | failed

Treat dependencies as a directed acyclic graph (DAG), not merely a
numbered sequence.

A task is READY only when:
- every task in `Depends on` has status VERIFIED;
- every required input/artifact exists;
- no unresolved decision blocks execution.

Otherwise its status MUST remain BLOCKED.

3. EXECUTION GATE
Before starting ANY task, explicitly evaluate:

PRECONDITION CHECK
[ ] All dependencies VERIFIED
[ ] Required artifacts exist
[ ] Required decisions resolved
[ ] Acceptance criteria known
[ ] Verification method known

If any item is false:
- DO NOT start the task.
- Mark it BLOCKED.
- Identify the missing prerequisite.
- Add or execute the prerequisite task first.

Never infer dependency completion merely because earlier work was
attempted.

4. SINGLE-TASK EXECUTION
Have at most ONE task `in_progress` unless tasks have been explicitly
proven independent and parallel execution is requested.

While executing a task:
- work only toward its stated acceptance criteria;
- do not opportunistically begin downstream tasks;
- if a new prerequisite is discovered, STOP this task, mark it BLOCKED,
  add the prerequisite to the graph, and resolve it first.

5. COMPLETION GATE
Finishing implementation does NOT complete a task.

A task may transition:

BLOCKED -> READY -> IN_PROGRESS -> VERIFIED

`IN_PROGRESS -> VERIFIED` is permitted only when its specified
verification succeeds.

If verification fails:
IN_PROGRESS -> FAILED

Then diagnose/fix/reverify before allowing dependent tasks to become
READY.

6. RE-EVALUATE AFTER EVERY TASK
After each VERIFIED task:
- update the dependency graph;
- determine which blocked tasks, if any, have become ready;
- check for newly discovered dependencies;
- select the next READY task;
- run its precondition check before starting it.

7. COMPLETION
The overall request is complete only when:
- every required leaf task is VERIFIED;
- every acceptance criterion is satisfied;
- no required task remains BLOCKED, READY, IN_PROGRESS, or FAILED;
- final integration verification succeeds.
```

## Key Improvements

Do not require literally minute-sized tasks. Excessive decomposition creates bookkeeping overhead and consumes context without improving correctness. The useful target is the smallest independently verifiable unit. "Change a variable name on line 38" is usually too small; "add email-format validation and its focused test" is a meaningful atomic unit.

Distinguish `implemented` from `verified`. This is one of the highest-value safeguards. A dependency should not be satisfied because the model reports that it implemented the prerequisite. Completion requires independent evidence that the expected result exists.

Dependencies should also be artifact-sensitive. If a UI depends on an API, it may specifically require a stable response contract, not merely a completed "API task." Explicit input and artifact requirements make this relationship observable.

Initial plans are predictions. The protocol must allow new dependencies to be discovered during execution. When that occurs, the current task should become blocked, the missing prerequisite should enter the graph, and execution should resume only after that prerequisite is verified.

Readiness should determine execution order, not task numbering. The next task should be a READY node whose dependencies are all VERIFIED. This also supplies a principled basis for parallelism when independent tasks are proven not to conflict.

For coding agents, task completion should not be batched retrospectively. After a mutation, perform focused verification, update actual state, inspect resulting artifacts, recompute readiness, and only then select another task.

## Execution Model

```text
PLAN
What needs to exist?
        |
        v
SCHEDULE
What is currently eligible to execute?
        |
        v
EXECUTE + VERIFY
Did this unit actually satisfy its contract?
        |
        v
SCHEDULE AGAIN
```

The most important invariant should appear prominently in the controlling instructions:

```text
CRITICAL INVARIANT:
Never begin a task whose prerequisites have not been VERIFIED.
When uncertain whether a prerequisite is satisfied, treat it as
unsatisfied until verified.
```

The last sentence matters because ambiguous prerequisites are especially susceptible to optimistic assumptions by an LLM.
