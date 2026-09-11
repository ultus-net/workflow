# Software and Infrastructure Workflow Critique

The dependency-aware approach becomes more important when the same harness operates across software development and infrastructure engineering. Infrastructure introduces dependencies on external state, permissions, propagation, health, reversibility, and time. A successful command does not necessarily establish the postcondition required by downstream work.

For this environment, the workflow should model a dependency-and-state graph rather than only a task DAG.

## Stronger Core Invariant

```text
CRITICAL EXECUTION INVARIANT

Never begin a task until every prerequisite is VERIFIED.

A prerequisite is VERIFIED only when its required postcondition has
been observed, not merely because the action intended to produce it
completed successfully.

When prerequisite state is unknown, stale, ambiguous, or unobservable,
treat the dependent task as BLOCKED.
```

For example, infrastructure may require this sequence:

```text
resource created
    -> resource reports READY
    -> DNS/IAM/config propagation confirmed
    -> connectivity verified
    -> dependent deployment becomes READY
```

## Extended Task Schema

```text
ID:
Objective:
Depends on:
Required preconditions:
Required inputs/artifacts:
Resources/state affected:
Risk / blast radius:
Mutation or read-only:
Expected postcondition:
Acceptance criteria:
Verification:
Rollback/recovery:
Status: blocked | ready | in_progress | verifying | verified | failed
```

The `verifying` state is useful because Terraform returning successfully, Kubernetes accepting a deployment, a cloud API returning success, or CI accepting a workflow does not establish operational readiness.

## Additional Infrastructure Rules

- Observation before mutation: inspect actual current state before changing it. Repository and infrastructure state can invalidate assumptions made during planning.
- Postconditions over command success: verify the resulting system property rather than only process exit status. A deployment should be healthy, an endpoint should behave correctly, and a policy should demonstrably grant or deny what was intended.
- Explicit destructive-operation gates: destructive, irreversible, production, credential, networking, IAM, migration, and state-management operations should receive a risk and blast-radius check before execution.
- Idempotency awareness: before repeating a failed infrastructure operation, establish whether a retry is safe. Repetition may be harmless for one operation and destructive for another.
- Reconciliation after mutation: after changing external state, rediscover relevant state rather than continuing solely from the agent's previous mental model.

## Execution Loop

```text
DISCOVER
Inspect repository + external state
        |
        v
DECOMPOSE
Create atomic tasks
        |
        v
GRAPH
Map task + artifact + state dependencies
        |
        v
SELECT READY TASK
        |
        v
PRECONDITION CHECK
Re-observe required state
        |
        v
RISK GATE
Assess mutation / blast radius / recovery
        |
        v
EXECUTE
One bounded change
        |
        v
VERIFY POSTCONDITION
Observe actual resulting state
        |
        v
RECONCILE
Refresh assumptions and dependency graph
        |
        v
SELECT NEXT READY TASK
```

## Prefer State Transitions Over Time-Based Chunks

For work spanning application code, Linux, networking, containers, cloud resources, Terraform, Kubernetes, and CI/CD, the correct boundary is usually an atomic state transition rather than elapsed time.

```text
Too coarse:
"Configure production networking"

Artificially tiny:
"Run terraform plan"

Better atomic unit:
"Add the private application subnet and verify its resulting route
table has no direct Internet Gateway route."
```

The decomposition rule can therefore be expressed as:

```text
MINIMUM SAFE EXECUTION UNIT

Recursively decompose work into the smallest independently executable
and independently verifiable state transition.

A task is sufficiently atomic when:
- it has one outcome;
- its prerequisites can be evaluated before execution;
- its mutation scope is bounded;
- its expected postcondition is explicit;
- verification can independently determine success or failure;
- failure can be isolated and recovery is understood.

Do not subdivide further when doing so creates bookkeeping operations
without independently meaningful postconditions.
```

## Task Dependencies Are Not Enough

Task dependencies and resource dependencies are not necessarily equivalent. `Deploy application depends on Create database` is weaker than specifying the actual states and artifacts required by the deployment:

```text
Create database
 produces:
   database_endpoint
   database_credentials_reference

 establishes:
   database.status = available
   network_path(app -> db) = reachable
   credentials = accessible_from_app
```

Downstream tasks should reference these observable artifacts and postconditions instead of trusting a task-level checkmark.

## Integration Verification

```text
TASK COMPLETION != SYSTEM SUCCESS

After all leaf tasks are VERIFIED, perform integration verification
against the original desired state.

Local verification proves individual transitions.
Final verification proves the transitions compose into the intended
system.
```

This protects against locally successful infrastructure and software changes that nevertheless fail as an end-to-end system.

The governing loop is therefore:

```text
Observe -> prove readiness -> mutate minimally -> prove postcondition
        -> reconcile reality -> unlock dependents
```

That abstraction applies consistently to changing a function, deploying a container, modifying IAM, applying a migration, provisioning infrastructure, and diagnosing production behavior.
