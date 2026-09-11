# Workflow

Workflow is an in-process, deterministic workflow authority for agent hosts. Its core invariant is:

```text
model proposes -> Workflow authorizes -> tool acts -> environment supplies evidence -> Workflow validates -> state may advance
```

The kernel owns task state, dependency readiness, legal transitions, evidence requirements, and evidence invalidation. Host SDKs, MCP providers, and UIs are adapters around that authority; they do not own canonical workflow state.

## Current Scope

The v0 prototype currently demonstrates:

- deterministic dependency-derived task readiness and legal transitions;
- evidence bound to subjects and mutation epochs, with stale-evidence invalidation;
- a host-neutral application API and capability-based enforcement reporting;
- native Cline and ACP host translations without host types entering the kernel;
- an MCP capability/evidence boundary that validates external observations before admission;
- default-deny withholding for explicit process and credential capabilities at application authorization;
- interchangeable Ink TUI and browser UI projections over `WorkflowApplication`.

This is not yet a release-ready autonomous execution system. The local JSON store provides versioned restart recovery and single-store writer exclusion, but complete MCP Toolbox integration and OS/container isolation remain later roadmap work in `TASKS.md`.

## Run

Use Node 22 or newer.

```sh
npm install
npm test
npm run typecheck
npm run build
npm run tui
npm run web
```

The browser demo listens on `127.0.0.1:4173` by default; set `PORT` to override it. The standalone TUI deliberately assigns no semantic foreground or background colors. It inherits the user's terminal theme and communicates state through labels, markers, emphasis, and layout.

## Architecture

`src/kernel/` is the deterministic domain. It has no host SDK, MCP implementation, model provider, or UI dependency. `TaskGraph` derives readiness from dependencies and is the authority for state transitions, evidence admission, mutation epochs, and invalidation.

`src/application/` is the command/query boundary. `WorkflowApplication` keeps the graph private, authorizes proposed mutations, accepts explicit transition/evidence/mutation commands, and emits read-only snapshots for adapters and UIs.

`src/adapters/` contains replaceable external translations. A host adapter normalizes its lifecycle event into `ProposedToolAction`, reports host capabilities, and translates a `PolicyDecision` back to the host's native control. MCP providers expose discovery/invocation only; `normalizeMcpEvidence` validates observations before they can become evidence.

`src/ui/` contains replaceable presentation adapters. Both the Ink TUI and browser prototype read `WorkflowSnapshot` and issue application commands. Neither can directly mutate the task graph.

## Safety Guarantees And Limits

Within one live `WorkflowApplication`, the kernel deterministically rejects illegal task transitions, derives blocked/ready state from dependencies, requires declared fresh passing evidence for verification, and invalidates relevant evidence after a mutation.

`enforced` has a deliberately narrow meaning: the configured host integration guarantees authoritative interception before a mutation and applies Workflow's decision before that mutation occurs. `advisory` means Workflow can evaluate and display policy but cannot guarantee that the host cannot mutate around it. Transport alone proves nothing: an ACP connection remains advisory unless its bridge guarantees authoritative permission interception.

Workflow application policy is not a security sandbox. A process with filesystem, shell, network, or credentials outside the intercepted host path can bypass in-process policy. Unattended or high-impact operation therefore also requires least-privilege credentials plus OS/container/process isolation appropriate to the capability.

`WorkflowApplication` treats `process` and `credentials` as explicit high-blast-radius capability classes and withholds them by default. Operators may opt them in independently of task state; doing so grants application policy permission only, not OS-level containment. See `THREAT_MODEL.md` for trust zones, controls, and residual risks.

MCP output is external, untrusted input. Shape validation and evidence admission do not prove that an MCP server is truthful or that its observation authority is sufficient for a particular production claim. Evidence requirements must select appropriate authorities and subjects.

`JsonWorkflowStore` can persist tasks, evidence, mutation epoch, and transition history. Saves use a monotonic version plus an exclusive local lock so stale or simultaneous writers cannot silently overwrite a newer version. Restart recovery records orphaned `IN_PROGRESS` work as `FAILED` because its mutation outcome is unknown; `VERIFYING` remains `VERIFYING` for repeat verification. A leftover lock after process/host failure deliberately blocks further writes rather than guessing lock ownership, so this is fail-safe local persistence rather than a distributed or highly available store.

## Extension Contracts

Keep the kernel/application contract portable, but write a concrete adapter for each SDK/tool family. Do not build a universal adapter that guesses host semantics. `docs/HOST_ADAPTERS.md` documents capabilities, conformance expectations, capability classification, and advisory/enforced semantics.

`docs/MCP_INTEGRATION.md` documents provider integration and the evidence trust boundary. MCP remains capability/observation plumbing rather than workflow truth.

`docs/UI_INTEGRATION.md` documents the application API and state-ownership rule for new frontends. `docs/OPERATOR_GUIDE.md` documents deployment-time guarantees, enforcement interpretation, capability grants, persistence recovery, and operational limits.

## Roadmap

`TASKS.md` is the durable roadmap and acceptance criteria. The local W015 persistence baseline does not imply completion of W016-W018: threat modeling, operator/extension documentation expansion, and final release verification remain distinct gates.
