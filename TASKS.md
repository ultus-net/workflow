# Workflow v0 Task Roadmap

## Goal

Build Workflow as the durable, SDK-agnostic safety and execution layer around fast-changing agent hosts, MCP capabilities, and user interfaces.

The invariant is:

```text
model proposes -> Workflow authorizes -> tool acts -> environment supplies evidence -> Workflow validates -> state may advance
```

SDKs and UIs are replaceable adapters. They must not become sources of workflow truth.

## Architecture Constraints

- The deterministic kernel owns task state, dependency eligibility, policy decisions, evidence requirements, freshness/invalidation, and legal transitions.
- Host adapters translate host lifecycle and tool events. They do not reinterpret kernel decisions.
- Host capability reporting is explicit. A host without authoritative pre-mutation interception is `advisory`; Workflow must not imply that it provides enforced mutation safety.
- MCP integrations provide capabilities and evidence. MCP servers do not own Workflow orchestration or task state.
- UI adapters consume the application API and submit commands. UI frameworks do not own canonical workflow state.
- Model/provider-specific types do not enter the kernel.
- Memory and model claims may provide context but cannot satisfy deterministic prerequisites or verification requirements.
- Unknown or stale safety-critical state fails closed in enforced/autonomous operation.

## Phase 1: Contracts And Runnable Core

### W001 - Establish project/tooling foundation

**Objective:** Create the smallest TypeScript project structure needed to build, test, typecheck, and package host-neutral Workflow modules.

**Depends on:** None

**Acceptance criteria:**
- [ ] Repository has deterministic package/runtime configuration and standard ignore rules.
- [ ] Core, application, adapter, and UI boundaries can be represented without importing an SDK or UI framework into core.
- [ ] A minimal test proves the project can execute its test and typecheck commands.

**Verification:** Run the configured typecheck and test commands from a clean project install/runtime.

### W002 - Define kernel domain contracts

**Objective:** Define stable types for task identity/state, dependencies, artifacts, evidence, mutations, policy decisions, and state transition results before implementing orchestration.

**Depends on:** W001

**Acceptance criteria:**
- [ ] States include `BLOCKED`, `READY`, `IN_PROGRESS`, `VERIFYING`, `VERIFIED`, and `FAILED` with explicit semantics.
- [ ] Evidence identifies its subject and authority rather than exposing a generic `verified: boolean` contract.
- [ ] External/adapter inputs are distinguishable from trusted internal state.

**Verification:** Type-level/unit contract tests cover accepted variants and boundary validation.

### W003 - Implement dependency graph and transition engine

**Objective:** Make task readiness and legal state transitions deterministic.

**Depends on:** W002

**Acceptance criteria:**
- [ ] Dependencies determine `BLOCKED`/`READY`; callers cannot manually unlock downstream tasks.
- [ ] Illegal transitions are rejected with stable machine-readable reasons.
- [ ] Self-dependencies, missing dependencies, and direct/transitive cycles are rejected.
- [ ] Adding a dependency can re-block affected downstream work.

**Verification:** Unit tests cover the legal transition table, dependency unlocking, graph mutation, and cycle/error cases.

### W004 - Implement evidence and invalidation engine

**Objective:** Bind verification to observable subjects and invalidate it when relevant state changes.

**Depends on:** W002, W003

**Acceptance criteria:**
- [ ] `VERIFYING -> VERIFIED` requires the task's declared evidence requirements to be satisfied.
- [ ] Evidence tracks authority, subject, result, observation identity/time, and freshness state.
- [ ] A relevant mutation makes dependent evidence stale and prevents stale evidence from satisfying completion.

**Verification:** Tests prove successful verification, missing evidence, failed evidence, and post-verification mutation invalidation.

### W005 - Define capability-based host adapter contract

**Objective:** Define the SDK-independent boundary used by Pi, OpenCode, Cline, Crush/future hosts, or test fixtures.

**Depends on:** W002

**Acceptance criteria:**
- [ ] Contract represents session identity, proposed tool action, pre-action interception, post-action observation, cancellation, approvals, and host capabilities without importing a concrete SDK.
- [ ] Adapter declares whether pre-mutation enforcement is authoritative.
- [ ] Hosts lacking authoritative interception are classified `advisory` and cannot be reported as `enforced`.
- [ ] Malformed/unknown safety-relevant adapter input fails closed when enforcement is claimed.

**Verification:** Adapter conformance tests run identical event traces against an in-memory reference adapter.

### W006 - Define MCP capability/evidence boundary

**Objective:** Integrate MCP tools without coupling the Workflow kernel to MCP orchestration semantics.

**Depends on:** W002, W004

**Acceptance criteria:**
- [ ] MCP tools/capabilities can be discovered and invoked through an application-side port.
- [ ] MCP responses are treated as untrusted external input and normalized before becoming evidence candidates.
- [ ] MCP output cannot directly change canonical task state or self-certify verification.

**Verification:** Contract tests use a fake MCP provider to prove evidence normalization and rejection of malformed/untrusted results.

### W007 - Build first end-to-end headless slice

**Objective:** Prove the contracts compose before committing to a real SDK or UI framework.

**Depends on:** W003, W004, W005, W006

**Acceptance criteria:**
- [ ] A test host proposes a bounded mutation for a `READY` task and receives a Workflow authorization decision.
- [ ] A blocked task cannot mutate through an enforced host.
- [ ] Post-action MCP/test evidence can advance `VERIFYING -> VERIFIED` only when requirements pass.
- [ ] A later relevant mutation invalidates that evidence and downstream readiness is recomputed.

**Verification:** One deterministic integration test exercises the full proposal -> authorization -> action observation -> evidence -> state transition flow.

## Checkpoint A - Core Safety Boundary

- [ ] Full test and typecheck gates pass.
- [ ] No concrete SDK, model provider, MCP implementation, or UI framework is imported by the kernel.
- [ ] Enforced versus advisory guarantees are observable in the public application state.
- [ ] Independent review finds no safety-boundary P0/P1 defects.

## Phase 2: Application API And First Real Host

### W008 - Implement UI/host-neutral application API

**Objective:** Expose canonical state and commands through a stable application service that both UIs and host adapters can consume.

**Depends on:** W007

**Acceptance criteria:**
- [ ] API exposes workflow snapshot, ready/blocked tasks, blockers, evidence state, host enforcement capabilities, and transition history.
- [ ] Commands are explicit intents; clients cannot write canonical state directly.
- [ ] State/event ordering is deterministic enough for multiple UI implementations.

**Verification:** Application contract tests exercise queries, commands, errors, and event projection without a UI framework.

### W009 - Select and implement first real SDK adapter

**Objective:** Connect one current agent SDK without changing kernel semantics.

**Depends on:** W005, W008

**Acceptance criteria:**
- [ ] SDK-specific schemas remain inside its adapter package/module.
- [ ] Adapter reports capabilities truthfully and maps pre/post tool events into the generic contract.
- [ ] The shared adapter conformance suite passes unchanged.

**Verification:** SDK adapter tests plus a runnable smoke flow where the SDK permits it.

### W010 - Connect MCP Toolbox through the MCP boundary

**Objective:** Use existing portable MCP capabilities/evidence from Workflow without moving orchestration into MCP Toolbox.

**Depends on:** W006, W008

**Acceptance criteria:**
- [ ] Workflow can connect to configured MCP servers and expose their capabilities to the application layer.
- [ ] At least one read/evidence flow is demonstrated end to end.
- [ ] Disconnect, malformed response, and unavailable-server states are explicit and fail safely.

**Verification:** Integration tests against controlled MCP fixtures, followed by an optional local MCP Toolbox smoke test.

## Phase 3: Interactive UI

### W011 - Evaluate interchangeable UI options

**Objective:** Present concrete UI choices after the application contract is runnable, without binding Workflow to one rendering technology prematurely.

**Depends on:** W008

**Acceptance criteria:**
- [ ] Compare at least a browser UI, standalone TUI, and host-native UI option for portability, interaction quality, maintenance, and packaging.
- [ ] Provide runnable/prototype evidence where evaluation needs it.
- [ ] User selects the first UI before production implementation begins.

**Verification:** Decision is captured with rationale and does not alter kernel/application contracts.

### W012 - Implement selected interactive UI

**Objective:** Give the user a real interactive Workflow surface backed only by the application API.

**Depends on:** W011

**Acceptance criteria:**
- [ ] User can see task DAG/state, current/ready/blocked work, blocker reasons, host enforcement level, evidence, and recent transitions.
- [ ] User can perform appropriate interactive commands/approvals without bypassing application authorization.
- [ ] Empty, loading, error/disconnected, and advisory-host states are explicit.
- [ ] UI is keyboard-accessible and works at its intended desktop/mobile or terminal sizes.

**Verification:** UI tests plus real runtime/browser or terminal interaction testing as appropriate.

## Checkpoint B - Usable Interactive Workflow

- [ ] A user can launch the selected UI and inspect a live Workflow session.
- [ ] A real host adapter can propose work through Workflow.
- [ ] MCP evidence appears through the same canonical state projection.
- [ ] UI cannot bypass kernel decisions.

## Phase 4: Prove Replaceability

### W013 - Add second host adapter

**Objective:** Prove SDK portability with a genuinely different host lifecycle/API.

**Depends on:** W009

**Acceptance criteria:**
- [ ] Second host passes the shared conformance suite without kernel changes.
- [ ] Capability differences produce truthful `enforced`/`advisory` behavior rather than host-specific exceptions in core.
- [ ] Switching host configuration does not change task/evidence semantics.

**Verification:** Run the same canonical traces through both adapters and compare kernel outcomes.

### W014 - Add second UI adapter/prototype

**Objective:** Prove presentation portability against the same application API.

**Depends on:** W012

**Acceptance criteria:**
- [ ] Second UI can render canonical state and submit at least one safe command without adding UI-specific state logic to core.
- [ ] Existing UI continues to work unchanged.

**Verification:** Manual/runtime smoke test plus application contract tests unchanged.

### W015 - Persistence, recovery, and concurrent actor hardening

**Objective:** Preserve authoritative workflow state safely across restarts and competing sessions/agents.

**Depends on:** W007, W008

**Acceptance criteria:**
- [ ] Task graph, transition journal, and evidence survive restart without trusting model summaries.
- [ ] Transition writes use version/conflict semantics so two actors cannot silently advance the same task incompatibly.
- [ ] Orphaned `IN_PROGRESS`/`VERIFYING` recovery has deterministic rules.

**Verification:** Restart/crash fixtures and concurrent transition tests.

## Phase 5: Safety And Release Readiness

### W016 - Threat-model capability and trust boundaries

**Objective:** Document and test where Workflow enforcement ends, especially shell/process authority, credentials, MCP trust, host interception, and production operations.

**Depends on:** W010, W013

**Acceptance criteria:**
- [ ] Threat model distinguishes application policy from OS/container sandboxing.
- [ ] Credential and high-blast-radius capabilities can be withheld independently of prompts.
- [ ] Advisory hosts and unverifiable evidence cannot be mistaken for enforced guarantees.

**Verification:** Adversarial tests cover malformed adapter/MCP inputs and attempted safety-boundary bypasses.

### W017 - Extension and operator documentation

**Objective:** Make adding another SDK, MCP provider, or UI straightforward without learning internal implementation details.

**Depends on:** W013, W014, W016

**Acceptance criteria:**
- [ ] Host adapter guide documents capabilities, conformance tests, and advisory/enforced semantics.
- [ ] MCP integration guide documents evidence trust boundaries.
- [ ] UI guide documents the application API and state ownership rule.
- [ ] Operator guide explains what Workflow does and does not guarantee.

**Verification:** Documentation examples match exported contracts and runnable commands.

### W018 - Full verification and independent review

**Objective:** Establish a trusted v0 baseline before treating Workflow as a reusable safety layer.

**Depends on:** W015, W016, W017

**Acceptance criteria:**
- [x] Tests, typecheck, lint/build/package checks and adapter conformance suites pass.
- [x] Runtime tests cover the selected UI and real host integration.
- [x] Independent review covers test truthfulness, task completeness, cleanliness, security, and platform fit with no unresolved P0/P1 findings.

**Verification:** Fresh full verification plus recorded secondary review against the final diff.

## Initial Dependency Path

```text
W001 -> W002 -> W003 -> W004 --+
          |       |             |
          +-----> W005          +-> W007 -> W008 -> W011 -> W012
          |                     |             |
          +-----> W006 ---------+             +-> W009 -> W013
                                      W006/W008 -> W010

W012 -> W014
W007/W008 -> W015
W010/W013 -> W016
W013/W014/W016 -> W017 -> W018
```

The immediate implementation target is W001 through W007. That yields a runnable headless safety slice before choosing a real SDK or UI, so SDK/UI experiments test the architecture instead of defining it.
