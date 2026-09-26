# Workflow v0 Task Roadmap

## Goal

Build Workflow as the durable, SDK-agnostic safety and execution layer around fast-changing agent hosts, MCP capabilities, and user interfaces.

**Parked items and recorded limitations live in `docs/PARKED_AND_LIMITATIONS.md`** — the operator-directed re-address queue; consult it before picking loop work (an entry whose dependencies have landed is the highest-value candidate).

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

### W019 - Linux runtime containment

**Objective:** Extend Workflow's policy boundary with a Linux-first runtime containment layer that can prove when process execution is isolated from ambient credentials, unrestricted filesystem access, and unapproved network/production authority.

**Depends on:** W018

**Scope:** Keep containment contracts host-neutral and portable, but make enforcement claims only for the tested Linux backend. Containment availability and effective capabilities are runtime facts, not configuration claims. An unavailable or insufficient backend fails closed instead of executing with ambient host authority.

**Acceptance criteria:**
- [x] A host-neutral containment contract describes requested process/filesystem/network/credential capabilities and returns observable enforcement/evidence state.
- [x] A Linux backend executes an allowed process inside an independently testable containment boundary and rejects execution when the requested boundary cannot be established.
- [x] Ambient credentials are absent by default; filesystem and network/production access require explicit grants rather than inheritance from the parent process.
- [x] Workflow policy authorization remains necessary but is not represented as sufficient for runtime containment; the application/operator surface distinguishes policy permission from containment enforcement.
- [x] Tests exercise successful contained execution plus fail-closed credential, filesystem, network, malformed-input, and unavailable-backend paths without requiring production credentials or mutation authority.
- [x] Documentation states the exact Linux/runtime prerequisites, guarantees, non-guarantees, and portability boundary.

**Verification:** `npm run lint`, `npm test`, `npm run typecheck`, `npm run build`, runtime containment integration tests on Linux, package dry-run, audit, diff check, and independent five-axis review against the final change.

W019 is complete. The v0 W001-W018 baseline remains the trusted host-policy/application foundation; W019 strengthens execution containment without weakening or conflating those existing authorization semantics.

### W020 - Composed end-to-end runtime verification

**Objective:** Prove the built Workflow package can carry one realistic host proposal through policy authorization, Linux runtime containment, observable mutation, evidence admission, and final task verification.

**Depends on:** W019

**Acceptance criteria:**
- [x] The E2E runner imports the built package rather than source modules.
- [x] A Cline-shaped process event is normalized by the real host adapter and authorized by `WorkflowApplication`.
- [x] The authorized operation executes through the real Linux Bubblewrap backend with an explicit writable grant and produces an observable host artifact.
- [x] The observed mutation is recorded, fresh environment evidence is admitted at the resulting mutation epoch, and the task reaches `VERIFIED` through legal application transitions.
- [x] The E2E runner is exposed as a stable package command and fails rather than skips when its Linux/Bubblewrap prerequisite is unavailable.

**Verification:** `npm run test:e2e` plus the existing lint, test, containment-runtime, typecheck, build, package, audit, diff, and independent-review gates.

### W021 - Interactive containment smoke driver

**Objective:** Let an operator manually exercise the same Workflow authorization and Linux containment path without turning the existing task-navigation TUI into a shell.

**Depends on:** W020

**Acceptance criteria:**
- [x] A package command presents a terminal prompt for one command and visibly reports policy, containment, command output, and final task state.
- [x] Commands execute through `WorkflowContainedProcess` and the real Linux Bubblewrap backend rather than an uncontained child process.
- [x] The session grants writes only to a fresh temporary workspace, keeps networking isolated and credentials cleared, and removes the workspace on exit.
- [x] Successful execution records mutation and fresh environment evidence before the task reaches `VERIFIED`.
- [x] Automated CLI coverage proves the visible allow/enforced/output/verified flow.

**Verification:** focused interactive CLI test plus lint, full test suite, containment/E2E runtime checks, typecheck, build, diff check, and independent review.

### W022 - Persistent interactive containment session

**Objective:** Allow multiple manual commands in one containment smoke session without weakening terminal Workflow task states.

**Depends on:** W021

**Acceptance criteria:**
- [x] The prompt accepts multiple commands until the operator enters `exit` or `quit`.
- [x] Every command independently crosses Workflow authorization, real Bubblewrap containment, mutation/evidence admission, and a terminal `VERIFIED` task state.
- [x] Each command uses a distinct Workflow task rather than reopening a terminal verified task.
- [x] The session shares only its temporary writable workspace; network isolation and cleared ambient credentials remain unchanged.
- [x] Automated CLI coverage proves two commands are independently allowed, contained, observed, and verified before clean exit.
- [x] A denied or nonzero command remains unverified and does not terminate the persistent session.
  - Dated note (2026-09-25, W132): the W126/W132 compiled-bin e2e found the contract violated on the GUARD-deny lane — the vendored guard's denial threw out of the unguarded per-command loop and killed the session (the nonzero lane held). Repaired in W132 (contained-shell.ts catches the denial per-command and reports Task: FAILED; the session survives — pinned in test/e2e-contained-shell.test.ts).

**Verification:** focused persistent CLI test plus lint, full test suite, containment/E2E runtime checks, typecheck, build, diff check, and independent review.

## Phase 6: SDK-Driven Coding Workflow

The product target from this point is not a richer containment demo. It is an interactive coding harness that can progressively replace the current OpenCode workflow while preserving Workflow's deterministic safety and verification boundaries.

The existing responsibility split remains fixed:

- The agent SDK/host owns model interaction, streaming, conversation/context handling, and its native tool-call lifecycle.
- Workflow owns canonical task/dependency state, authorization, capability policy, evidence, verification, persistence/recovery, and runtime-containment requirements.
- Host SDK schemas remain in host adapters. Model/provider types do not enter the kernel.
- The standalone Workflow TUI is the primary operator surface; host-native and browser surfaces remain replaceable adapters/proofs rather than sources of canonical state.
- `contained-shell` remains a diagnostic/runtime smoke surface. It is not the target coding UX and must not become a second hand-built agent runtime.

### W023 - Cline execution-containment bridge

**Objective:** Extend the existing `createWorkflowClinePlugin`/Cline hook integration with a supported SDK execution seam so process actions authorized by Workflow execute through `WorkflowContainedProcess` rather than Cline's ambient native executor.

**Depends on:** W022

**Acceptance criteria:**
- [x] Current Cline SDK/runtime APIs are used to identify a supported execution seam; Workflow does not implement a parallel model, shell, or tool loop to obtain containment.
- [x] A Cline process proposal is authoritatively intercepted and the exact authorized executable/arguments are bound into `WorkflowContainedProcess` before real Bubblewrap execution.
- [x] The result is returned through the SDK's normal tool-result lifecycle so the host/model can continue without treating Workflow as the conversation runtime.
- [x] If the installed/current Cline SDK cannot replace or delegate native process execution at an authoritative seam, the integration fails closed and the limitation is recorded rather than claiming containment from `beforeTool` authorization alone.

**Verification:** real Cline runtime integration test for authorization -> Workflow-contained execution -> SDK-visible result, plus existing adapter/containment gates and independent review of the execution binding.

W023 is complete against the installed `@cline/core` 0.0.82 public `ShellExecutor`/`createShellTool` seam. The runtime regression exercises the real Cline shell tool around Workflow's injected executor and real Bubblewrap containment, including SDK-visible success, working-directory semantics, and nonzero-command failure semantics.

### W024 - Real SDK coding-session vertical slice

**Objective:** Accept one natural-language coding request through the existing Cline SDK integration and prove that the SDK's consequential tool activity is governed by Workflow without a hand-built model/tool loop.

**Depends on:** W023

**Acceptance criteria:**
- [x] A real Cline model session can receive a natural-language coding request against a disposable Git repository and inspect the repository through its normal coding-agent lifecycle.
- [x] Every mutation/process action exercised by the slice is normalized by the concrete Cline adapter and must receive Workflow authorization before execution; process execution crosses the W023 containment bridge.
- [x] The SDK uses observed tool results to continue the same model session, produces a bounded code change, runs its verification, and returns a final response while Cline continues to own model streaming, conversation history, and its native agent loop.
- [x] The resulting repository state and verification result are independently observable in a controlled runtime test; model narration alone cannot satisfy completion.
- [x] The slice fails closed when authoritative host interception, containment, required credentials, or another required runtime capability is unavailable rather than silently downgrading the guarantee.

**Verification:** controlled disposable-repository coding task through the real Cline SDK runtime, resulting Git diff and verification evidence inspection, full existing gates, and independent review.

W024 is complete against installed `@cline/core` 0.0.82. `npm run test:cline-coding-session` starts a real local `ClineCore` model session using the operator's configured Cline provider, gives it a natural-language task in a disposable Git repository, observes Cline `read_files`/`run_commands` lifecycle traffic, and routes command execution through the Workflow-backed `ShellExecutor` and real Bubblewrap containment. The regression requires the model to run `git diff --check`, then independently checks the resulting tracked-file diff and content rather than accepting the model's completion claim. Missing Cline/provider configuration fails the runtime test instead of substituting an advisory or mocked session.

### W025 - Real workspace capability and mutation scope

**Objective:** Replace the disposable all-session writable directory assumption with explicit repository-scoped authority suitable for normal coding work.

**Depends on:** W024

**Acceptance criteria:**
- [x] A coding session can read the intended repository while writes are confined to explicitly authorized workspace paths and ambient filesystem access remains unavailable by default.
- [x] Workflow can distinguish ordinary repository mutation from process, credential, network, and out-of-workspace capabilities without relying on model intent text.
- [x] Host-native file mutations outside the authorized repository/workspace are denied by deterministic path policy; OS-level filesystem confinement is claimed only for execution paths actually routed through the containment backend.
- [x] Attempted contained-process writes outside the authorized repository/workspace fail closed and are covered by runtime tests.
- [x] Existing user changes in a dirty worktree are observable and are not silently reverted or overwritten by Workflow lifecycle machinery.

**Verification:** disposable clean/dirty repository fixtures exercise permitted edits, denied path escape, process execution, and unchanged containment/credential/network boundaries.

W025 is complete. `WorkflowApplication` now optionally owns an absolute workspace root and deterministically rejects lexical and symlink-mediated path escapes for host-native proposals. Cline exposes batched read and patch target paths to that authority, while `WorkflowContainedProcess` subjects its working directory and readable/writable grants to the same policy before Bubblewrap execution. Runtime coverage proves escaped grants fail closed, ambient filesystem/credential/network boundaries remain enforced, a real dirty Git fixture retains its pre-existing user edit, and the real Cline coding-session fixture runs with Workflow's repository authority enabled.

### W026 - Workflow-owned coding task lifecycle

**Objective:** Connect an SDK coding session to Workflow's canonical decomposition, readiness, evidence, and verification model so a long coding request cannot be completed merely by model narration.

**Depends on:** W024, W025

**Acceptance criteria:**
- [x] Coding work is represented by canonical Workflow tasks with explicit dependencies and verification requirements outside model conversation state.
- [x] SDK tool proposals are correlated with the active eligible Workflow task; blocked work cannot mutate merely because the model requests it.
- [x] Successful tool execution does not itself mark a task verified; admitted evidence must satisfy the task's verification requirements.
- [x] Host-neutral application commands support controlled task/dependency creation for newly discovered prerequisites without exposing `TaskGraph` directly or allowing the model to bypass cycle, readiness, or transition validation.

**Verification:** multi-step coding fixture proves blocked dependency rejection, focused verification, evidence-driven unlocking, and final completion only after all required tasks are verified.

W026 is complete. `WorkflowApplication` exposes controlled task and dependency commands while `TaskGraph` continues to derive readiness and reject missing, duplicate, self, or cyclic dependency changes. Application regressions prove blocked canonical work cannot mutate, tool success alone cannot satisfy verification, and fresh environment evidence unlocks downstream work. The real Cline coding-session fixture exercises the authoritative `beforeTool` seam against a blocked implementation task, then proves prerequisite evidence unlocks that same canonical task and final completion occurs only after each task's required evidence is admitted.

### Checkpoint C - Usable Coding Prompt

- [x] An operator can give Workflow a normal coding request rather than individual shell commands.
- [x] A real SDK supplies the model/agent loop; Workflow does not duplicate that machinery.
- [x] The agent can inspect, edit, test, and iterate in a real disposable repository while Workflow authorizes consequential actions and containment remains observable.
- [x] The final response reflects independently verified repository state rather than model-only completion claims.
- [x] Failure/denial remains diagnosable and does not silently become advisory execution.

Checkpoint C is reconciled from the configured real-Cline coding fixture: the fixture submits a natural-language coding request through `WorkflowCodingSession`, uses the real SDK-owned agent loop, exercises repository inspection plus contained mutation and verification, independently checks the resulting Git diff and repository content, and separately proves an authoritative Workflow denial never reaches execution. `npm run test:cline-coding-session` remains the executable evidence for this checkpoint.

## Phase 7: Daily-Driver OpenCode Replacement

### W027 - Host-neutral coding session port

**Objective:** Normalize SDK session input/output at the application boundary before attaching the standalone TUI to Cline activity.

**Depends on:** W026

**Acceptance criteria:**
- [x] A host-neutral application port represents prompt submission, streaming assistant/session activity, normalized tool proposal/outcome events, cancellation, and terminal session state without exposing Cline/model-provider types to UI or kernel modules.
- [x] The Cline integration translates its SDK lifecycle into that port while Workflow application state remains the authority for tasks, policy, evidence, and enforcement state.
- [x] A fake session adapter can drive the same application-facing event contract in tests, proving the TUI need not depend directly on Cline.

**Verification:** application/session contract tests plus Cline translation tests; existing kernel/application contracts remain unchanged where no session concern is involved.

W027 is complete. `WorkflowCodingSession` owns the application-facing prompt, activity subscription, cancellation, and terminal-state contract while a replaceable `CodingSessionDriver` keeps SDK details outside UI and kernel modules. `ClineSessionDriver` translates Cline status, assistant text, normalized tool proposal/result, error, completion, and stop behavior through that contract, reusing `ClineHostAdapter` subject normalization without moving task/policy/evidence authority out of `WorkflowApplication`. Fake-driver tests prove host independence, Cline event fixtures cover translation and cancellation, and the real configured Cline coding fixture now runs through the same host-neutral session boundary.

### W028 - TUI coding-session integration

**Objective:** Make the selected standalone Workflow TUI the usable operator surface for the SDK-driven coding lifecycle proven at Checkpoint C.

**Depends on:** W027

**Acceptance criteria:**
- [x] The TUI accepts prompts, streams model/session activity, and displays proposed/authorized/denied tool activity without owning canonical workflow state.
- [x] Task readiness, blockers, evidence, enforcement/containment state, and verification outcomes remain inspectable during the coding session.
- [x] Cancellation, ordinary command/model failure, and session completion have explicit operator-visible states and do not corrupt canonical Workflow state.
- [x] Terminal interaction remains keyboard-accessible and usable for routine repository work.

**Verification:** real terminal interaction tests plus controlled SDK coding session through the TUI and unchanged application/kernel contract tests.

W028 is complete. The TUI accepts an injected host-neutral `WorkflowCodingSession`, has explicit prompt-entry and cancellation controls, and renders bounded status/assistant/tool/completion/failure activity alongside canonical task, blocker, evidence, enforcement, and history projections. Component and PTY tests cover streaming, cancellation, keyboard interaction, and canonical-state separation, while the standalone CLI composes the configured Cline runtime rather than introducing a second provider contract.

### W029 - Session resume and long-context recovery

**Objective:** Make real coding sessions survive process/model context boundaries without treating conversation summaries as authoritative workflow state.

**Depends on:** W015, W026, W028

**Acceptance criteria:**
- [x] A persisted coding session can resume with task/evidence/journal authority restored from Workflow state; Workflow persists only canonical workflow/session correlation required for its authority, while conversation/context persistence uses SDK-native facilities as non-authoritative host state.
- [x] Interrupted `IN_PROGRESS`/`VERIFYING` work follows deterministic recovery rules before further mutations are authorized.
- [x] Context compaction, unavailable SDK conversation restoration, or model-session restart cannot erase unfinished canonical tasks or manufacture verification.

**Verification:** restart during a multi-task coding fixture, resume, re-observation where required, and successful completion without skipped work.

W029 is complete. Persisted Workflow state retains only canonical authority plus an opaque Cline session correlation; conversation history is restored from Cline through `readMessages` and is never canonical Workflow state. Orphaned `IN_PROGRESS` work recovers to `FAILED`, retry re-establishes readiness and authorization explicitly, unavailable correlated history fails closed, and `npm run test:cline-resume` proves restart-through-completion requires fresh post-restart evidence.

### W030 - Coding tool and integration parity

**Objective:** Close the practical tool gaps required for the user's routine OpenCode workload while preserving the established adapter/capability boundaries.

**Depends on:** W028

**Acceptance criteria:**
- [x] Repository file discovery/read/edit/patch, diagnostics/tests, shell/process, and Git inspection used by normal coding sessions are supported through the SDK and correctly classified/authorized by Workflow, including direct `apply_patch` registration through the public `localRuntime.extraTools` surface.
- [x] Required MCP capabilities can participate through the existing MCP boundary without becoming orchestration authority.
- [x] Image or other user-input modalities required by the chosen SDK workflow remain host/application concerns and do not introduce model-provider types into the kernel; image prompt input is supported through the host-neutral application port.
- [x] Parity gaps are tracked from observed real-session failures rather than speculative reimplementation of every OpenCode feature.

**Verification:** representative repository tasks exercise the supported tool matrix and policy-denial cases through the real SDK runtime.

W030 is complete as an observed parity assessment. Built-in mutation/process classification is conservative even when host callback metadata incorrectly reports a known editor, patch, or shell tool as non-mutating; extension tools can carry explicit least-privilege metadata without downgrading built-ins. The real SDK fixture covers repository reads, contained shell/test/Git work, deterministic SDK editor and direct `apply_patch` execution, authoritative denial, and SDK-native MCP participation. Image prompt input remains host-neutral and translates to Cline's public `userImages` field. The direct patch follow-up uses Cline's public tool factory and `localRuntime.extraTools`; Workflow does not own a parallel model/tool implementation.

### W031 - OpenCode replacement qualification

**Objective:** Decide from evidence whether Workflow is ready to become the default coding harness for the user's normal work.

**Depends on:** W029, W030

**Acceptance criteria:**
- [x] A representative suite of real coding prompts succeeds end to end across clean and dirty repositories, including edit/test/debug and multi-step tasks.
- [x] Recovery, cancellation, denial, malformed host input, containment failure, and verification failure cases remain fail-closed and understandable to the operator.
- [x] Remaining feature gaps versus the user's actual OpenCode usage are documented with explicit severity/workarounds; no critical daily-driver gap is hidden by the qualification result.
- [x] Full verification and independent review find no unresolved P0/P1 safety, state-integrity, or data-loss defects.

**Verification:** dogfood matrix over representative coding prompts, full automated/runtime gates, restart/recovery scenarios, and independent five-axis review before switching the default workflow.

W031's current matrix has no observed P2 daily-driver parity gap: real Cline coding, clean-to-dirty continuation, restart recovery, containment, policy denial, Git verification, editor/direct-patch mutation, image prompt input, and MCP participation are covered. OpenCode interoperability now has a separate authoritative `tool.execute.before` adapter/plugin and a host-neutral SDK session driver; SDK lifecycle events remain non-authoritative telemetry. A real OpenCode runtime E2E is not claimed by that contract coverage. Fresh full verification and independent review remain required before changing the default harness.

## Phase 8: Hub-Side ACP Spike

The ACP direction is evidence-first: prove a hub-side ACP client and per-agent interception/containment conformance before choosing the long-term operator surface. ACP is transport/interoperability, not authority. The patched Cline Ink terminal remains an operational fallback, not the presumed long-term base.

### W032 - ACP v1 wire contracts and NDJSON framing

**Objective:** Introduce a minimal, protocol-faithful ACP v1 wire boundary without changing `AcpHostAdapter`'s existing internal correlated contract.

**Depends on:** W031

**Acceptance criteria:**
- [x] Type contracts cover the minimal v1 messages needed for the spike: `initialize`, `authenticate`, `session/new`, `session/prompt`, `session/cancel`, `session/update`, and `session/request_permission`.
- [x] NDJSON stdio framing encodes one JSON-RPC message per line, handles multi-byte UTF-8, splits across arbitrary chunk boundaries, and rejects malformed lines fail-closed.
- [x] Existing `AcpHostAdapter` behavior remains unchanged and is not presented as an ACP v1 wire adapter.

**Verification:** focused unit tests for wire validation and framing plus existing adapter tests.

### W033 - ACP permission normalization and fail-closed denial

**Objective:** Normalize real ACP permission requests into the existing adapter/kernel path and encode denial using only valid ACP v1 outcomes.

**Depends on:** W032

**Acceptance criteria:**
- [x] A wire permission request is correlated with Workflow session/task context before reaching `AcpHostAdapter`.
- [x] A Workflow denial selects an agent-provided rejecting `optionId` when one exists.
- [x] When no rejecting option exists, the result explicitly requires fail-closed turn/session handling; the implementation never fabricates an option and never uses ACP `cancelled` as an ordinary denial.
- [x] Permission option `kind` is treated as a UI hint, not semantic proof.

**Verification:** focused unit tests for allow, deny-with-reject-option, deny-without-reject-option, malformed request, and UI-hint-only metadata cases.

### W034 - Hub-side ACP subprocess session spike

**Objective:** Prove the hub can own ACP subprocess lifecycle and translate a bounded prompt/session flow through the wire layer without any TUI commitment.

**Depends on:** W033

**Acceptance criteria:**
- [x] A controlled fake ACP agent subprocess performs `initialize` and `session/new` over NDJSON stdio.
- [x] A prompt turn forwards `session/update` notifications as live projection events only.
- [x] Cancellation and process failure produce explicit terminal states without corrupting Workflow authority.
- [x] The spike is headless and does not bind the session stream to a terminal UI.

**Verification:** fake-agent subprocess integration tests covering initialize, session creation, prompt/update, cancellation, malformed output, and process exit.

### W035 - Real ACP agent conformance evidence

**Objective:** Run the spike against `opencode acp` and `cline --acp` and record whether either integration can claim enforced interception.

**Depends on:** W034

**Acceptance criteria:**
- [ ] Runtime evidence records each candidate agent's negotiated capabilities, permission coverage, rejecting-option behavior, fs/terminal delegation, auto-approve exposure, and direct filesystem/process bypass behavior under containment. (Cline: complete, 2026-09-14. OpenCode: capabilities/permission coverage/one edit probe recorded; fs/terminal delegation, auto-approve exposure, and contained bypass remain unrecorded because OpenCode is eliminated as an enforcement candidate — record them only if it is reconsidered.)
- [x] `enforced` is reported only for an agent/launch mode whose relevant mutations are proven intercepted; otherwise the integration remains advisory or retains its SDK seam. (OpenCode default ACP is classified advisory; Cline's claim is scoped to its proven launch mode.)
- [x] Cline patched-SDK versus stock-ACP behavior is compared on the same pinned agent line where available. (See `docs/ACP_RESEARCH.md` §11 "Patched-SDK versus stock-ACP on the pinned 3.0.61 line".)

**Verification:** controlled runtime conformance output reviewed against `docs/HOST_ADAPTERS.md` enforcement semantics and full repository gates.

Current 2026-09-14 status: W032–W034 are implemented and verified. OpenCode 1.18.30 completed `initialize`, `session/new`, a read-only prompt, and one bounded edit probe over ACP. The edit changed a disposable file and emitted tool status updates, but OpenCode sent no `session/request_permission` before mutation; default ACP mode is therefore advisory transport, not enforced interception. Cline 3.0.61 with `CLINE_API_KEY`/`CLINE_PROVIDER=openrouter` and `--auto-approve false` completed env-auth handshake, sent `session/request_permission` before reads, edits, and `run_commands`, supplied usable `reject_once` options, honored allow-mode file and shell mutations, and preserved files unchanged in deny mode. The resolver now recognizes the complete Cline approval-gated tool surface (read/edit/process/fetch, mirrored from `sdk-tool-policies.ts`): path tools map path subjects and fail closed without one, process tools validate command metadata and expose only `cwd` as a subject (command text never becomes a subject because kernel subjects are workspace-relative paths), and unknown dangerous-capability tools fail closed. Cline is the leading ACP enforcement candidate. Containment is now proven: Cline 3.0.61 never delegates execution to client `terminal/*`/`fs/*` capabilities (verified in `apps/cli/src/acp/acpAgent.ts`; the ACP spec makes delegation client-capability-gated and optional), so the agent process itself is launched under Bubblewrap via `launchContainedAcpAgent` + `LinuxBubblewrapContainment.spawn` (streaming stdio; `ProcessContainment.isolation` fails closed on policy-only backends; `/etc/resolv.conf` symlink target is ro-bound so host-network DNS works). The gated contained probe (`WORKFLOW_ACP_CLINE_CONTAINED=1`) shows a full contained session with permission interception intact (6 requests), the allowed workspace write applied, a random-secret host-home canary invisible despite read attempts and an active `find /` search, and a `/tmp` escape write never reaching the host; network remains `host` by design (model API egress). The patched-SDK versus stock-ACP comparison on the pinned 3.0.61 line is recorded in `docs/ACP_RESEARCH.md` §11: the patch leaves `apps/cli/src/acp/` untouched (its ACP mode equals stock), patched-SDK can contain per-command with isolated network and intercepts tools ACP never gates, while stock-ACP needs no patch and contains the entire agent filesystem. OpenCode containment evidence is intentionally unrecorded (eliminated candidate); W035 stays open only on that explicit gap.

### W036 - ACP surface decision inputs

**Objective:** Convert spike evidence into a clean Workflow terminal surface decision without prematurely committing to patched Cline.

**Depends on:** W035

**Acceptance criteria:**
- [x] Research documents what the hub session stream can and cannot project reliably. (`docs/ACP_SURFACE.md` §1–2, grounded in Cline 3.0.61 `session-updates.ts`: projections incl. message/reasoning/tool/mode/config; explicit non-projections incl. usage, error, iteration, plan content, commands.)
- [x] A clean Workflow terminal surface evaluation identifies daily-driver parity requirements and gaps. (`docs/ACP_SURFACE.md` §3, gaps G1–G6.)
- [x] Patched Cline Ink remains explicitly classified as fallback/migration surface unless spike evidence shows the clean surface cannot yet satisfy a material requirement. (`docs/ACP_SURFACE.md` §4: fallback unless G1 token economy or G2 commands/mentions are judged material.)

**Verification:** updated research/decision documentation plus independent five-axis review.

Current 2026-09-14 status: **decision recorded — GO** (`docs/ACP_DECISION.md`). The operator judged G1 (token/cost visibility) deferrable and G2 (commands/mentions) satisfied by ACP `configOptions` model/settings switching. The clean Workflow surface over stock-ACP Cline with whole-agent Bubblewrap containment is the lead path; patched Cline Ink is the fallback/migration surface. **G4 resolved:** the gated resume probe proves `session/load` replays faithfully after a full agent restart and continuation works. **G1 mitigated:** the hub metering proxy (`src/integrations/model-usage-proxy.ts`, `meteredProviderSettings`) holds the provider key proxy-side, forces usage accounting, and recorded real turn metrics (2 requests / 8,668 tokens / $0.0132 on the post-P1-fix re-run; originally 8,790 tokens / $0.0140) with a placeholder-only sandbox env; the clean surface CLI now routes all model traffic through the proxy (placeholder-only contained env) and prints metrics at exit — remaining G1 work is budget enforcement. **Post-decision phase in progress 2026-09-14:** session lifecycle is wired into hub `authorize` by `AcpSessionDriver` (`src/integrations/acp-session.ts` — per-request permission resolution through `createWorkflowAcpPermissionResolver` → `WorkflowApplication.authorize` with fail-closed title classification), the default spawn path is whole-agent containment via `AcpSessionDriver.contained` → `launchContainedAcpAgent`, and the clean surface UI composes the host-neutral `WorkflowCodingSession` over the ACP projection (`src/cli/acp-tui.tsx`, `npm run tui:acp`; `WORKFLOW_ACP_RESUME=<sessionId>` resumes). Remaining follow-ups tracked in the decision record (G5 error surfacing, G7 context/compaction, per-prompt task decomposition).

## Phase 9: Universal Surfaces

### W037 - ACP universal session driver

**Objective:** Give the universal TUI a protocol-native path to any ACP-speaking agent (the established cross-editor agent protocol), so the driver registry's `--driver acp` generalizes beyond bespoke Cline/OpenCode drivers.

**Depends on:** W027, W030, universal-TUI plan (docs/superpowers/plans/2026-09-14-universal-tui.md)

**Acceptance criteria:**
- [x] An `AcpSessionDriver` implements `CodingSessionDriver` over a stdio JSON-RPC ACP client: `session/new`, `session/prompt`, `session/cancel`, and `session/update` notifications translate to the host-neutral `CodingSessionEvent` stream; kernel/application contracts unchanged. (`src/integrations/acp-session.ts`, `test/acp-session.test.ts`, 2026-09-14.)
- [x] ACP `session/request_permission` flows through `AcpHostAdapter` + `WorkflowApplication.authorize` (the hardened trust boundary), so Workflow is the permission authority at exactly the protocol seam designed for it. (`AcpSessionDriver` wires per-request resolution through `createWorkflowAcpPermissionResolver`; recognized-title map is fail-closed.)
- [x] ACP filesystem/terminal capability services are routed through `WorkflowContainedProcess`, so an ACP agent's shell runs inside containment by protocol construction rather than by host patch. (Not applicable to Cline 3.0.61: it never delegates `fs/*`/`terminal/*` capability services to the client — W035 evidence — so its shell is contained by whole-agent Bubblewrap launch instead, which is the equal-strength enforcement path for this client shape. Applies when a future ACP agent does delegate.)
- [x] The driver registry gains `acp` (`--driver acp`); unavailable agents fail closed with the exact spawn/connect error — no silent fallback to another driver. (`src/cli/driver-registry.ts`; `test/driver-registry.test.ts` proves explicit ACP selection propagates the composer error unchanged.)
- [x] Adapter conformance covers the ACP driver lifecycle (fake ACP server fixture), including denial, cancellation, and malformed-notification fail-closed paths. (`test/acp-session.test.ts` exercises all three through `AcpSessionDriver` + `WorkflowCodingSession`; transport-level malformed/cancel coverage remains in `test/acp-subprocess.test.ts`.)

**Verification:** ACP conformance fixture tests plus one real ACP-speaking agent smoke session; existing gates unchanged.

W037 is complete. The universal registry explicitly composes ACP through the same contained `AcpSessionDriver` runtime used by the dedicated ACP surface; driver selection has no cross-SDK fallback path.

## Phase 10: Review Control Plane

The W037 universal surface is the acceptance-test baseline for this phase. Run operator acceptance testing before changing review-control-plane behavior so product-surface failures can be attributed to the verified W037 baseline rather than concurrent review infrastructure changes. These items adapt deterministic review-pipeline ideas observed in Alibaba OpenCodeReview; they do not add OpenCodeReview as a runtime dependency.

### W038 - Universal surface operator acceptance baseline

**Objective:** Exercise the clean W037 baseline with real operator workflows before further control-plane changes.

**Depends on:** W037

**Acceptance criteria:**
- [x] Exercise the supported universal drivers needed for daily use and record composition, prompt, mutation/denial, cancellation, and failure-surfacing results without silently changing drivers.
- [x] Confirm canonical task state, authorization level labels, containment claims, and session activity remain truthful during the exercised paths.
- [x] Record material parity gaps as explicit follow-up work rather than folding unrelated control-plane changes into the baseline.

W038 is complete (2026-09-15). The real `workflow-tui --driver acp` source surface launched through a PTY against Cline 3.0.61 + Bubblewrap, displayed `acp | standalone (local authority)` and `ENFORCED / native`, preserved ordinary first-character prompt input, and disposed cleanly. The real contained ACP probe passed with a workspace mutation while host-home canary and `/tmp` escape attempts remained contained; the real deny probe preserved the target after Workflow selected the agent's rejecting permission option. ACP session regressions cover cancellation and malformed-notification fail-closed behavior. Acceptance found and fixed two surface defects before moving on: assistant transcript entries were hard-coded as `Cline` instead of using the composed driver label, and plain-key empty-composer accelerators stole valid first prompt characters. The options menu is now explicit via `/` or Ctrl+P, ordinary composer characters are preserved, and regression tests pin both behaviors. Existing unchecked convergence items in `docs/TUI_PARITY.md` remain known product gaps rather than new W038 regressions.

### W039 - Deterministic review coverage manifest

**Objective:** Make review scope a control-plane fact rather than an LLM judgment by deriving the exact changed/untracked files, relevant tasks, tests, authority boundaries, and required review rules before a reviewer runs.

**Depends on:** W038

**Acceptance criteria:**
- [x] A deterministic manifest identifies every in-scope changed/untracked file and the review obligations attached to it.
- [x] Secondary review cannot report complete coverage while required manifest entries remain unreviewed.
- [x] Manifest generation and completion checks have behavioral tests for large diffs, untracked files, and security-sensitive changes.

W039 is complete. `src/review/manifest.ts` derives the manifest deterministically from `git status --porcelain=v1 -z --untracked-files=all` output — every changed and untracked file (renames carry their source path), obligations attached from the explicit `REVIEW_OBLIGATION_RULES` table (security/authority/tests/docs plus the always-present baseline `general`), a code-unit-sorted entry list, and a stable sha256 digest for W041 provenance. The hub reviewer sources status through the same contained shell seam as the diff (`createGitStatusSource`), embeds the rendered manifest in the rubric prompt, and fails closed on any approval whose final `[COVERAGE]` line leaves manifest entries unreviewed (`src/integrations/hub-reviewer.ts`, wired through `createReviewerFactory`); `changes_requested` verdicts are never coverage-gated, and a missing status source leaves the gate dormant rather than fabricating scope. Behavioral coverage in `test/review-manifest.test.ts` proves large diffs (801 synthetic entries), untracked files (including the exact `git diff HEAD` omission they close), renames, deletions, and security-sensitive obligation attachment against a real git repository, plus exact-gap completion checks; `test/hub-reviewer.test.ts` proves the approval coverage gate fail-closed, the no-status-source backward-compatible path, and status-sourcing failure containment. Honest limits, stated plainly: the `[COVERAGE]` line binds reviewer claims to the deterministic scope list — it cannot prove the reviewer actually read each file (the same process discipline as the ≥3-axis rule); direct verifier-token `/run/review` submissions are not manifest-gated (honest-client discipline, unchanged); W040 partitioning and W041 provenance are expected to build on the manifest and its digest.

### W040 - Risk-aware review partitioning and rule matching

**Objective:** Keep large reviews complete and context-efficient by deterministically grouping related files into isolated review units and attaching focused rules based on path, component, and risk class.

**Depends on:** W039

**Acceptance criteria:**
- [x] Related implementation/tests/configuration are grouped deterministically, with an integration review covering cross-unit behavior.
- [x] Security/authority, persistence/recovery, UI, and test changes receive their applicable focused rules without injecting every rule into every reviewer prompt.
- [x] Partitioning never removes a file or obligation from the W039 coverage manifest, and deterministic tests prove that invariant.

W040 is complete. `src/review/partition.ts` groups the W039 manifest deterministically into review units: src-layer components, tests paired to the src module sharing their basename stem (unpaired tests form their own unit), docs, scripts, and root groups, with components larger than `MAX_REVIEW_UNIT_FILES` (12) split into sorted chunks (`~2`, `~3`). Each unit carries only its applicable focused rules — the baseline five-axis rules plus risk-matched rules from `REVIEW_FOCUS_RULES` (security, authority, persistence, ui, tests, docs; persistence and UI are explicit `REVIEW_RISK_RULES` path classes added on top of W039 obligations, never re-derived scope) — so no reviewer prompt receives every rule. An integration review exists exactly when more than one unit exists, carries no files, and requires `[COVERAGE]` of every unit id. `partitionPreservesManifest` is the W039 contract — every manifest file appears exactly once with its obligations intact and the integration unit stays file-free — pinned by tamper tests (dropped file, diluted obligations, file-bearing integration, grown manifest), the 600-entry large-manifest case, and digest-determinism tests across input order. `HubReviewerRunner` reviews multi-unit scope unit by unit: one fresh isolated reviewer session per unit (unit scope + focused rules + the capped diff), then one integration session; any unit rejection, unparseable verdict, missing axis reference, or incomplete `[COVERAGE]` fails the whole review closed with a parseFailure naming the unit, and approval records a single run-level verdict whose summary names the axes, units, and digests. Single-unit and no-status compositions keep the exact W039 single-session behavior (pinned by regression tests), so small reviews cost nothing extra. Honest limits, stated plainly: each unit reviewer still receives the full capped diff as context (per-unit diff slicing is a possible later refinement); unit sessions multiply reviewer cost linearly for genuinely multi-component diffs — the intended W040 trade of cost for isolation and focused rules; and the partition digest is the hook W041 provenance is expected to bind.

### W041 - Review provenance and replay

**Objective:** Bind independent-review evidence to the exact mutation and make review decisions auditable and resumable.

**Depends on:** W039, W040

**Acceptance criteria:**
- [x] Persist a compact review record containing the commit/diff fingerprint, coverage manifest and rule-set version, reviewer identity, inspected units, findings, verification evidence, and disposition.
- [x] Later mutations invalidate review completion when their fingerprint or covered obligations change.
- [x] Interrupted reviews can resume without treating stale review evidence as approval for new mutations.

W041 is complete. `src/review/provenance.ts` defines the record — commit hash (via a fail-soft `git rev-parse HEAD` source), a prompt digest (the same diff under a different ask is a different review; the ask is REAL in production — `/run/begin` accepts an optional `taskPrompt`, the scheduler always declares its schedule's prompt, and the registry threads it to the reviewer), a diff digest (sha256 of the tracked diff the reviewer saw, binding changed file content rather than only path shape), the W039 manifest digest, the W040 partition digest, and a rule-set digest hashing every obligation/risk/focus/integration rule, the unit cap, the review axes, the ≥3-axis minimum, and the diff cap — alongside reviewer identity, inspected units, covered paths, bounded findings, verification facts, and disposition (approved / changes_requested / interrupted). Integration-review records use a NUL-prefixed provenance marker (`INTEGRATION_PROVENANCE_UNIT_ID`): git paths can never contain NUL, so no path-derived component id — not even a literal `integration/` directory — can collide with the cross-unit marker in the journal. `src/integrations/review-provenance-store.ts` journals records as append-only NDJSON in hub state (`~/.workflow/review-provenance.jsonl`, `WORKFLOW_HUB_PROVENANCE` overrides; never inside a reviewed workspace, where a journal would mutate the very fingerprint it records), with fail-closed load validation (a corrupt journal is never partially trusted), 0600 permissions, atomic trims to the newest half past the 256-record cap, and the `JsonWorkflowStore` atomic-write discipline. `HubReviewerRunner` journals every decision BEFORE it records (an approval that cannot be provenanced is never recorded; per-unit and integration records during partitioned reviews, run-level records for every disposition, best-effort `interrupted` records on infrastructure failure that never mask the original error). Replay is fail-closed by construction: a unit resumes only when its NEWEST same-fingerprint record was an approval with complete single-unit coverage (run-level aggregate records never satisfy unit resume) — a newer rejection or interruption shields any older approval, any fingerprint change (commit, prompt, diff content, manifest, partition, or rules) resumes nothing, and records from other workspaces never apply (identical fingerprints can exist across clones; only this workspace's own provenance replays here; the journal stores the workspace exactly as the run registry provides it). Full-replay approval (all units plus integration resumed, zero fresh sessions) is possible by design — that is what replay means for a byte-identical review problem — and its records say so (`resumed from provenance: N`), so the audit trail never hides a replay-only approval. Honest limits, stated plainly: the fingerprint binds review-time state (untracked-file CONTENT is bound by path only — the status source does not hash untracked bytes); mutations landing DURING a review remain the kernel's mutation-epoch freshness job; the journal is 0600 same-user hub state, so it disciplines honest clients exactly like the verifier token — a compromised same-user process can fabricate records; the trim rewrite assumes the hub's single-writer journal (a concurrent-writer lock is follow-up debt); direct verifier-token `/run/review` submissions remain unjournaled honest-client discipline; diff-only compositions (no status source) journal nothing. Tests: `test/review-provenance.test.ts` (per-component fingerprint fail-closed matching including diff content, record validation, newest-record-wins resume incl. rejection-shielding and run-level scan-past, integration-marker non-collision), `test/review-provenance-store.test.ts` (durability across instances, corrupt-journal fail-closed, bounded trim), `test/hub-reviewer.test.ts` (journaled single-session and partitioned decisions, partial resume, pure-replay zero-session approval, stale-fingerprint/different-ask/foreign-workspace non-resume with full behavioral assertions, interrupted-then-resumed end-to-end, journaled rejections, registry-threaded prompt reaching the reviewer rubric).

### W042 - Executable security assurance case

**Objective:** Consolidate Workflow's distributed security guarantees into an auditable threat/assurance map tied to executable verification.

**Depends on:** W038

**Acceptance criteria:**
- [x] Document actors, trust boundaries, threats, mitigations, and fail-closed assumptions across hub authority, adapters, ACP, containment, model proxying, persistence, and local UI surfaces.
- [x] Each material security claim points to an implementation boundary and an automated test or explicitly identified manual/gated verification.
- [x] The assurance case does not upgrade advisory or policy-only behavior to enforced behavior and records known residual risks explicitly.

W042 is complete. `docs/SECURITY_ASSURANCE.md` is the executable assurance map: twelve surface sections (kernel/application authority, hub authority and run control plane, host-adapter fail-closed semantics, ACP session and wire, Linux Bubblewrap containment, model proxying, persistence and recovery, the W039-W041 review control plane, local UI surfaces, the guard corpus and credential custody, the scheduler, and the gated live-probe catalog), each binding its material claims to an implementation boundary plus a machine-parseable citation — `test/<file>#"<exact title>"` for automated tests, `gated[ENV]: test/<file>#"<title>"` for env-gated live probes, `manual[npm run <script>]` for host-gated commands. `test/security-assurance.test.ts` is the checker that makes the case executable: it parses all citations and fails when any cited test file, exact test title, gate variable, or package script ceases to exist, guards against the map being gutted (all twelve sections, 100+ citations, 8+ gated probes, 6+ manual commands), requires every three-column claim row to carry a verification, and pins the honesty statements (advisory is never enforcement; residual risks stay stated — the C3 model-channel exfiltration, G7 compaction, the same-user honest-client limits). Nineteen known residual risks are stated in the map's final section, sourced from `THREAT_MODEL.md`, `docs/GUARD_CORPUS_MAP.md`, the W041 honest-limits notes, and the transport residual (`goose serve` HTTP/WS out of containment scope). The checker's hardening is part of the case: per-section citation floors (a gutted section fails the count even when the aggregate holds), empty verification cells in claim rows are rejected rather than skipped, and implementation-boundary file references are existence-checked so a row cannot point at a vanished file. Round-1 review turned one manufactured citation into a real one: the hub's guardless-startup refusal is now genuinely test-verified in `test/hub-guardless-startup.test.ts` (a guard that cannot start rejects the provider composition, failing the hub's top-level startup await) instead of riding on an unrelated credential-brokering test, and the constant-time token comparison is honestly labeled an implementation property rather than a test-verified claim. Honest limits, stated plainly: the checker verifies citation existence, not claim truthfulness — the cited tests carry the truth burden, and the map's per-claim rows name them precisely; the gated-probe citations prove the probes exist and their gates are wired, while their live verdicts live in `docs/HOST_ADAPTERS.md` per pinned agent version. `THREAT_MODEL.md` now cross-references the map at the top.
## Phase 11: Daily-Driver Replacement Qualification

The goal of this phase is what W031 left open: replacing the operator's current daily driver — opencode plus the agent-side workflow-guard plugin — with the hub-owned surface. The honesty rules are unchanged: advisory or policy-only behavior is never presented as enforced, per-version probe discipline stays (an unprobed agent bump is capped advisory), and every remaining gap versus the plugin is fixed here or recorded as an explicitly accepted delta.

Operator direction for this phase: **goose (AAIF) takes the backup and general-purpose contained-agent slot** that the vendored-Cline runtime holds today — OpenCode remains the coding lead — per the 2026-09-16 research record (`docs/GOOSE_RESEARCH.md`) and qualification plan (`docs/superpowers/plans/2026-09-16-goose-qualification.md`). The backup-slot takeover and the SDK-seam retention are two separate, probe-gated decisions; Cline removal is evidence-gated, never date-gated. Documentation reconciliation comes first: the design has moved (OpenCode lead pivot, review control plane W039-W041, skills delivery, goose scoping) and every downstream item cites docs that must tell the truth.

### W043 - Documentation reconciliation and AGENTS.md generation

**Objective:** Eliminate documentation drift from the design changes, then generate the repo-root AGENTS.md (the operator's `/init` step) from the reconciled docs so future agent sessions start with accurate context instead of rediscovering it.

**Depends on:** W038, W041

**Acceptance criteria:**
- [x] A drift audit walks every operator-facing doc (`docs/ACP_RESEARCH.md`, `docs/ACP_DECISION.md`, `docs/HOST_ADAPTERS.md`, `docs/FEATURES.md`, `docs/TUI_PARITY.md`, `docs/TUI_INTEGRATION.md`, `docs/HUB_PROTOCOL.md`, `docs/GUARD_CORPUS_MAP.md`, `docs/OPENCODE_QUALIFICATION.md`, `docs/GOOSE_RESEARCH.md`, `THREAT_MODEL.md`) claim-by-claim against current code; living docs are corrected in place, dated decision records get append-only supersession notes — history is never silently rewritten.
- [x] `docs/FEATURES.md` rows and `docs/TUI_PARITY.md` convergence items are re-baselined against the shipped W039-W041 control plane and the W038-accepted surface; superseded claims are marked, not deleted.
- [x] AGENTS.md is generated at the repo root after reconciliation, capturing: the architecture layers and kernel-purity rule, the verification commands (lint/typecheck/build and the focused-test pattern; no full-suite-by-default resource directive), worktree and stacked-PR conventions, the five-axis review discipline, and the honest-claims culture.
- [x] Every path, command, and gate cited in AGENTS.md is verified to exist and run as documented.

W043 is complete. The drift audit (three parallel claim-by-claim passes over all eleven docs) found the architecture and probe-verdict claims accurate, with drift concentrated in four places. Living docs corrected in place: `docs/HOST_ADAPTERS.md` (the ACP adapter row still said "no production integration yet" — it is now the lead surface's production adapter via `AcpSessionDriver`; the adapter-file table gained the five missing ACP wire/permission/subprocess/contained-agent/resolver rows; the `task: "ask"` pin is correctly attributed to the hub-written per-runtime XDG config); `docs/HUB_PROTOCOL.md` (the contract now documents what W039-W041 and the auto-reviewer made true — `requiresReview` also declares the `test:<workspace>` evidence requirement, `/run/finish` can auto-launch the hub reviewer and run the workspace tests (reviewer → tests → VERIFIED, a finish can take minutes), `/bash` documents its authorization-targeting `workspace` field, `/team-task` documents the verify-command-owned promotion semantics, and the protocol field is honestly labeled as not-yet-asserted by the reference client); `docs/TUI_PARITY.md` (usage meter renders in the header status line, not the footer; export writes to the operator cwd; the boolean-options row no longer overclaims test coverage); `docs/TUI_INTEGRATION.md` (dated inline supersession note: the patched-Cline-primary-surface statement was overtaken by the 2026-09-16 pivot the same day it was written); `docs/GUARD_CORPUS_MAP.md` (the dangling-symlink regression citation is path-qualified to `mcp-toolbox/apps/workflow-fs-exec-mcp/test/hub-client.test.ts`; the review-scope row is extended with W040 partitioning and W041 provenance — appended, not rewritten); `docs/FEATURES.md` (12→14 toolbox servers; the progress-emission claim scopes the fs-exec logging-only exception; the OpenCode probe row gains the skills-delivery probe with an honest no-live-verdict-yet note; the review-gate-polish row is marked superseded/Complete in place, not deleted; two completeness rows add the hub guard-interception and credential-custody surfaces verified by the W042 case); `THREAT_MODEL.md` (the review-gate control cell cites the W039-W041 controls; the C3 egress paragraph splits the SHIPPED budget caps from the still-planned proxy payload policy). Dated records got append-only supersession-note sections: `docs/ACP_RESEARCH.md` (five notes: verification snapshot superseded by the assurance case, the OpenCode advisory verdict superseded by the ask-config probes, the Cline-leading-candidate recommendation superseded by the pivot, the patched-vs-stock A/B framing retired, the F1/G3 deferral scoped to the Cline surface), `docs/ACP_DECISION.md` (four notes: the wedge-chain review step strengthened by W039-W041, the G1 metrics/budget remaining-work items shipped, the fs-delegation deferral corrected — terminal delegation genuinely still deferred, the F1 follow-up complete), `docs/OPENCODE_QUALIFICATION.md` (three notes: superseded as the qualification of record by the ACP pivot, the E2E row scoped to the plugin/driver surface, the McpToolProvider terminology pinned to the vendored patch double). `docs/GOOSE_RESEARCH.md` needed nothing: same-day record, every hub-side claim code-verified and its external claims re-verified live (v1.50.1 still latest, pin target unmoved). `AGENTS.md` now exists at the repo root — architecture layers with the kernel-purity rule, the verification-command discipline (focused tests, never the full suite by default), worktree and stacked-PR conventions with the stranding history, the five-axis anti-rubber-stamp review discipline, and the honest-claims culture — and every path, command, gate, and version pin it cites was verified to exist and run (one stale citation caught and fixed during verification: the vendored-build script is `npm run tui:cline:build`).

**Verification:** the drift-audit diff plus a freshness check that each cited doc claim matches its implementation boundary; AGENTS.md citations smoke-checked.

### W044 - Hub session resource hygiene and G1 metric surfacing

**Objective:** Make long daily use of the hub surface resource-safe and cost-visible: spawned daemons are reaped on session exit, and the metering proxy's recorded usage/cost is visible in the session surface.

**Depends on:** W036, W038

**Acceptance criteria:**
- [x] The surface's launcher terminates or reuses the hub/agent processes it spawns; no orphaned daemons survive session exit, and a regression test proves the spawned-process count returns to baseline after exit (the operator-flagged ~300MB-per-launch accumulation must be impossible).
- [x] Per-turn and cumulative per-session token/cost metrics from the metering proxy's records are visible in the session UI (TUI and/or web).
- [x] The PTY-based test suites themselves do not leak daemons (teardown reaps what they spawn).

W044 is complete. The ~300MB-per-launch leak was exactly one unowned spawn: `resolveWorkflowHub`'s autohub path detached the hub (`detached: true` + `unref` + no pid retained), so every `workflow`/`workflow-monitor` launch that could not reuse a live hub left a full Node hub daemon (plus its guard MCP child) running forever — accumulating one ~300MB daemon per launch. The fix is ownership, not refcounting: `resolveWorkflowHub` now hands the spawned `ChildProcess` to its caller via `onSpawned`, and only the launcher that SPAWNED a hub ever terminates it (`terminateOwnedHub` — SIGTERM, the same graceful path the hub itself uses on Ctrl+C, which removes discovery + verifier discovery + the instance lock). A resolve that REUSES a probed hub gets no kill handle — someone else's daemon stays running. `src/cli/tui.tsx` and `src/cli/ink-tui.tsx` track the owned hub and terminate it on every exit path (normal child exit, process `exit`, SIGTERM 143, SIGHUP 129 — the terminal-hangup path); `tui.tsx` also terminates its Cline child on the signal paths. The hub itself closes its guard MCP child when startup fails (a lock-loser hub previously exited with a live guard child because the guard started before `createWorkflowHub` and the close was unreachable on the throw path). Regression proof at two levels: `test/hub-autohub-reap.test.ts` proves the owned child is handed out, terminated, and its pid actually dies (baseline restored, ESRCH-verified) while reuse never spawns or hands out a kill handle; `test/tui-cli.test.ts` adds a full PTY end-to-end test — a real TUI launch in a fresh HOME auto-spawns a real hub, the PTY close (SIGHUP) reaps it, and the test asserts the hub pid dies and its discovery + lock files are removed. Metrics (G1 surfacing): `src/ui/usage.ts` adds `UsageView` + `UsageTurnTracker` — cumulative tokens/cost straight from the metering proxy plus a per-turn delta computed at the session-state turn boundaries the UI already observes (`running` baselines, `completed` publishes the delta; failed/cancelled turns publish nothing — a partial bill is not an honest per-turn figure) — and the `usage` prop is now a `UsageSource` (raw view) instead of a preformatted string. The ACP TUI (the lead session surface) renders `N tokens · $C · +P this turn · $c` in the header status line; the universal TUI's acp driver exposes the same accessor through `ComposedDriver`; the web UI already rendered cumulative + context size and is unchanged. The monitor's hub-side per-session aggregation stays open (documented in `docs/TUI_PARITY.md`). PTY-suite hygiene: the only PTY test that could leak (the Ctrl+C test's launcher runs with autohub reachable-or-fail) now pins `WORKFLOW_AUTOHUB=0` so the suite itself can never leave an unowned hub behind, matching the `tui-e2e` precedent; the new reap test's teardown reaps what it spawns. Tests: `test/usage-tracker.test.ts` (5), `test/hub-autohub-reap.test.ts` (2), `test/tui-cli.test.ts` (11/11 including the e2e reap), `test/tui-tasklist.test.ts` usage render (cumulative + per-turn), plus the hub-client/hub-lifecycle/workflow-hub/tui/tui-e2e/web/acp-session suites all green; lint/typecheck/build clean. Honest residual: metrics live only as long as the runtime (per-proxy in-memory closure — nothing survives a session for later inspection; the monitor and hub-side aggregation stay open, and W045's budget enforcement reads the live snapshot for scheduled runs only).

**Verification:** focused lifecycle/PTY tests are green as listed above (the PTY e2e proves the reap end-to-end: auto-spawn → SIGHUP exit → pid dead, discovery + lock removed); the live operator confirmation — metrics visible in the header line and no accumulation across consecutive daily launches — lands with the operator's next dogfood sessions (W049).

### W045 - G1 budget enforcement on recorded usage

**Objective:** Enforce spending caps for interactive sessions, not only scheduled runs, so cost accidents are impossible even in attended use.

**Depends on:** W044

**Acceptance criteria:**
- [x] A configurable per-session/per-run budget cap is enforced against the proxy's recorded usage: crossing the cap aborts the in-flight turn (session/cancel semantics) or refuses new prompts — fail-closed and operator-visible, never a silent truncation.
- [x] Server-side enforcement via OpenRouter per-key credit limits is configured or explicitly documented as the chosen mechanism; the hub records which mechanism is active per runtime.
- [x] Tests prove the cap-abort path and its operator-visible state; scheduled-run budget caps remain unchanged.

W045 is complete. `src/integrations/session-budget.ts` carries the interactive enforcement: `sessionBudgetFromEnv` parses per-axis caps from `WORKFLOW_SESSION_BUDGET_{INPUT,OUTPUT,TOTAL}_TOKENS` / `WORKFLOW_SESSION_BUDGET_COST_USD` (a malformed value throws — a broken cap never degrades to an unenforced session; all-unset means no local guard), `createSessionBudgetGuard` is the scheduled-run guard itself (`createBudgetGuard`, re-exported from `hub-scheduler.ts` under the session-budget name) — one implementation, same `budgetViolation` rules, two enforcement points, so the interactive guard can never drift from the scheduled-run semantics, and `sessionBudgetMechanism` names the active mechanism. `composeSessionWithBudget` (acp-runtime, both OpenCode and Cline paths) wires the guard into every configured runtime: it checks the metering proxy's recorded usage on every session event; the first crossing cancels the in-flight turn through session/cancel semantics and the sticky violation is installed as the session's refusal gate — `WorkflowCodingSession` gained a `refusalGate` option consulted before every submit, so a crossed budget refuses new prompts (the turn never starts, the queue is never entered) and the refusal surfaces as a failed event when the session state accepts events, never silently. Operator visibility: the TUI header usage line appends `! budget exceeded: ...` (the sticky violation rides the W044 usage poll), and the hub-side record is per runtime — the web session channel serves `budgetMechanism` (and the violation once crossed) on `/api/session`, and the hub logs the mechanism when composing the scheduled-run and hub-reviewer runtimes. Server-side backstop: when no local caps are configured, the chosen mechanism is OpenRouter's per-key credit limit on the metering proxy's upstream key (the only key agents never see) — documented in the mechanism record itself; the repo cannot configure OpenRouter account-side, so the record honestly names the division: local guard when caps are set, provider-side limit otherwise. Scheduled-run caps are untouched (same `budgetViolation` semantics, same per-schedule wiring; the scheduler suite passes unchanged). Tests: `test/session-budget.test.ts` (9 — parsing incl. fail-closed malformed caps, mechanism record, guard cancel-once/sticky, refusal-gate semantics incl. gate-clears-again, runtime wiring under-cap, in-flight cancel at the crossing, header formatting), plus the web `/api/session` mechanism assertion and the TUI crossed-budget render; the hub-scheduler budget tests and the whole focused battery (92/92) green, lint/typecheck/build clean. Honest residual: the guard checks on session events (the scheduled-run guard's semantics) — a turn that emits no events between the crossing and its own completion is cancelled at the next event rather than mid-stream; wiring the proxy's `onUsage` callback as an additional mid-stream check is future hardening, as is any cross-session persistence of recorded usage.

**Verification:** focused budget tests green as listed; the live metered session hitting a small cap lands with the operator's next dogfood sessions (W049) — until then the cap-abort path is proven by the unit and wiring tests only.

### W046 - Per-prompt task decomposition for interactive sessions

**Objective:** Let an interactive prompt authorize against canonical decomposed Workflow tasks instead of a single session task, closing the plugin's in-session multi-task discipline gap.

**Depends on:** W026, W027

**Acceptance criteria:**
- [x] An interactive session can create, select, and complete canonical tasks through application commands only (deterministic kernel validation; no direct TaskGraph exposure).
- [x] Tool proposals correlate with the active eligible task; blocked work cannot mutate.
- [x] Decomposition suggestions are advisory (model-proposed); task creation and dependency changes stay deterministic operator-confirmed or rule-driven.
- [x] Tests prove blocked-decomposition rejection and evidence-driven unlocking in an interactive-shaped flow.

W046 is complete. The mechanism, not a UI: `src/application/task-commands.ts` is the deterministic task-command port — `createTask` (kernel-validated: missing/duplicate/cyclic dependencies reject), `activateTask` (READY→IN_PROGRESS + `selectActiveTask`; BLOCKED/VERIFIED/FAILED/VERIFYING refuse with the state named, never guessing), `completeTask` (IN_PROGRESS→VERIFYING→fresh environment evidence→VERIFIED, evidence-gated exactly like every canonical task — tool success alone never verifies), `retryTask`, and a non-throwing `activeTaskId()`. The TaskGraph itself is never handed out; the port composes only application commands, so the kernel keeps owning validation, readiness derivation, and evidence freshness. Correlation: `AcpSessionDriver`'s task stamp widened from a fixed id to `TaskId | (() => TaskId)` — hub runs, the reviewer, and web sessions keep their fixed ids (proven unchanged), while the interactive surfaces (`acp-tui`, the universal TUI's acp driver) compose `activeTaskCorrelation(application)`: every proposal re-reads the active-task pointer at request time, so an operator activating a decomposed task mid-session moves the authorization target for every later proposal — the money test drives the same driver/session through three prompts and watches the stamped task id move from the session seed to the decomposed task and then to the fail-closed sentinel after completion. The sentinel (`no-active-task`, a non-existent id) is the blocked-work form: `activeTaskId()` throwing (no IN_PROGRESS task) correlates with a sentinel that the application gate denies as UNKNOWN_TASK — fail-closed without leaving the ACP permission request unanswered on the wire (a throwing getter would hang the request; the correlator never throws). Advisory half: ACP `plan` projections keep arriving as advisory events with zero canonical effect (pinned by a test: a planning prompt creates no tasks); nothing model-proposed becomes canonical except through the port, operator-confirmed or rule-driven like the hub's run/team-task flows. Docs reconciled honestly: SECURITY_ASSURANCE residual 19 rewritten (the mechanism landed; the residuals that remain are the thin selection UX and the explicit-activation requirement), the ACP_DECISION supersession note updated (the original :58 follow-up line keeps its dated wording, the note supersedes its decomposition clause), and the acp-tui "lives in the hub follow-up, not here" comment replaced by the correlation comment. Tests: `test/interactive-task-commands.test.ts` (8 — port contract incl. kernel rejections through the port, blocked-decomposition rejection (BLOCKED task denies mutation and refuses activation), evidence-driven unlock (prerequisite VERIFIED → dependent READY → activated → allowed), retry, illegal-state completion guards, sentinel fail-closed correlation, the interactive-shaped three-prompt correlation test, fixed-id stability for hub runs, advisory-plan purity), plus the full affected battery green (acp-session, application, coding-session-queue, adapter-conformance, security-assurance, web, hub-runs, session-port — 90/90 + the 8 new). Honest residual: no TUI task-selection palette yet — the port is the seam every surface can drive (the web UI's existing `/api/tasks` + `/api/transition` routes already speak application commands), and a session whose active task completes must explicitly activate the next one; until a palette exists, mid-session task switches are a surface-integration exercise, honestly not dogfooded live yet.

**Verification:** application/session contract tests plus the interactive-shaped correlation suite green as listed; a real interactive session exercising a multi-task request lands with the operator's dogfood sessions (W049) — until then the flow is proven by the fake-agent interactive test only.

Round-1 review fixed four findings: (P1) the acp-tui composition never initialized the active-task pointer — the lazy correlation would have denied every mutation on the lead interactive surface; the launcher now calls `startInteractiveTask()` before composing, pinned by a source-level boot test (the launcher is a top-level script, not importable in-process). (P2) the sentinel id was creatable — `WorkflowApplication.addTask` now reserves `no-active-task` at the application seam (covering the port, the web API, and every other creation path) so a hostile task with that id can never turn the no-active deny into an allow; pinned by test. (P3) kernel transition rejections now surface through the port (`assertTransition` throws with the code and reason — an unsatisfied `requiredEvidence` completes to VERIFYING and then refuses VERIFIED with EVIDENCE_REQUIRED, state-visible, never a silent no-op); pinned by test. (P3) the classify doc-comment was re-attached to its method. Test count: 11 (8 + sentinel reservation + rejection surfacing + the boot pin).

### W047 - G5 error surfacing and G7 context visibility

**Objective:** Recover the diagnostics and context awareness the plugin's in-process hooks provided, honestly: surface every failure with an actionable cause, and project whatever context/usage signals the agent emits.

**Depends on:** W027, W038

**Acceptance criteria:**
- [x] Turn failures, reviewer/crash/containment failures surface in the session UI with actionable causes (blocking-reason style) rather than silent stops.
- [x] Agent-emitted usage/context notifications (standard or agent-custom session/update kinds, e.g. goose's usage channel) project into the session record.
- [x] Restart discipline is documented as the G7 mitigation (resume-backed), and compaction-time control is explicitly recorded as out of hub scope over ACP — visibility is never upgraded to control.
- [x] Tests cover the error-surfacing paths with controlled failures.

W047 is complete. G5 error surfacing: the wire already carried causes that were being discarded, and two failure shapes produced nothing at all — both fixed at the driver/launcher level. (1) A fail-closed permission denial now threads its wire cause into the failed turn: `ACP turn cancelled by the agent (fail-closed: no_reject_option)` instead of the bare cancelled line (the fixture's `failClosedReason`, pinned end-to-end). (2) An agent crash mid-turn surfaces as a failed turn carrying the exit cause (`ACP agent exited…`) — the pending prompt rejects, never hangs (new `crash-mid-turn` fixture mode; the crash-between-turns shape `crash-idle` pins the closed-client cause on the next prompt). (3) Boot/composition failures (missing agent binary, containment policy-only, unwritable config, missing upstream key) print a blocking-reason-style cause (`failed to start the contained session: …` / `failed to start the composed <driver> driver: …`) and exit 1 instead of a raw stack trace — `acp-tui` wraps its composition, and `universal-tui` moved `composeDriver` inside its try so the finally tolerates a composition that never produced a driver. (4) The one failure that produced no event at all — a hung agent (no exit, no response) — is bounded by an OPTIONAL operator-armed turn watchdog (`WORKFLOW_ACP_TURN_TIMEOUT_MS`; off by default because a wrong timeout would abort legitimate long turns; a malformed value throws — a broken watchdog never degrades to a silent one): the failed turn carries `exceeded WORKFLOW_ACP_TURN_TIMEOUT_MS=Nms — cancel the turn or restart the session` and the driver cancels best-effort. G7 context visibility: the wire client tolerated unknown update KINDS but a goose-shaped custom notification METHOD (`_goose/unstable/session/update`) would have fail-closed-crashed the whole connection, and the driver DROPPED every kind its projection didn't specialize (`usage_update` never reached the session record — correcting the ACP_SURFACE claim that "the hub projection forwards unknown update types untouched", which was true only at the client-listener layer). Now: agent-custom NOTIFICATION methods are tolerated and projected (a well-formed nested `update` payload flows through the same pipeline; anything else projects as `agent_custom` named by its method), agent-custom REQUESTS (with an id) stay fail-closed — the client cannot answer a method it doesn't implement — and the driver's projection turns every unhandled well-formed kind into an advisory `agent-context` session event (new event type, rendered as dim `[context] usage_update: totalTokens 250 · $0.02` rows by the TUI; the web transcript still drops it, documented). G7 mitigation stated once, coherently (criterion 3): compaction-time CONTROL stays explicitly outside hub scope over ACP; the mitigation is restart discipline, resume-backed (session-id projection into the transcript + `WORKFLOW_ACP_RESUME` + probe-proven `session/load` context restoration) — stated in the ACP_SURFACE W047 correction (which supersedes the old forwarding claim and the thin-surfacing G5 row), SECURITY_ASSURANCE residual 15's mitigation pairing, and GUARD_CORPUS_MAP hole 1; visibility is never upgraded to control anywhere. Tests: `test/error-surfacing.test.ts` (12 — crash mid-turn, crash idle, failClosedReason threading, the watchdog env parse + hung-turn bound, usage_update projection, goose custom-notification tolerance + agent_custom projection, custom-request fail-closed teardown, TUI failed-row render, TUI [context] render, both launcher boot-catch pins), with four new fixture modes (`crash-mid-turn`, `crash-idle`, `hang`, `goose-usage`, `custom-request`); the affected battery green. Honest residuals: hub-owned reviewer/scheduler failures remain monitor-surface by design (their canonical state is the run registry; the interactive session is not their surface — the decision is now documented here), the watchdog is off by default (a hung turn without it still hangs; that is the operator's deliberate choice), and agent-context does not reach the web transcript yet.

**Verification:** focused surfacing tests green as listed (12/12 with controlled failures at every path); a live session with an induced failure lands with the operator's dogfood sessions (W049) — until then the crash/deny/hang paths are proven by the controlled-fixture tests only.

### W048 - Goose backup-slot qualification

**Objective:** Qualify goose (AAIF) as the backup and general-purpose contained-agent kind — `WORKFLOW_ACP_AGENT=goose` taking over the vendored-Cline fallback slot — with enforcement classification earned through the six gated probes, never configuration claims.

**Depends on:** W035, W037, W043 (research: `docs/GOOSE_RESEARCH.md`; plan: `docs/superpowers/plans/2026-09-16-goose-qualification.md`)

**Acceptance criteria:**
- [x] `AcpAgentKind` gains `goose` with a contained `goose acp` launch profile: `GOOSE_MODE=approve`, hub-written config under `GOOSE_PATH_ROOT` (probe-verified), provider env-composed per workload (`GOOSE_PROVIDER=openrouter|azure_foundry`; OpenRouter through the loopback metering proxy with a placeholder-only credential inside the boundary, Azure AI Foundry key env injected — no keyring inside containment), `GOOSE_TELEMETRY_ENABLED=false`, extension allowlist, no native `.agents/skills` in composed workspaces.
- [ ] The six gated probes from the plan run live and their per-probe verdicts land in `docs/HOST_ADAPTERS.md` — PERMISSION (every mutating call reaches `request_permission` with usable reject options and denials honored, given LLM-classified write detection), SUBAGENT (absence-or-denial under approve mode), MOUNT (skills-mcp stdio extension delivers `list_skills` verbatim), RESUME (`session/load` across a contained restart), METERED (on both operator providers; `usage_update` channel confirmed), HOOKS (PreToolUse deny + `on_failure: block` under containment; subagent-internal coverage resolved) — no aggregate claims.
- [x] goose is reported `enforced` for its proven launch mode only if the permission probe proves pre-mutation interception with denials honored; otherwise it is honestly capped advisory.
- [x] Spawn classification covers goose's delegation tool names when applicable; unknown high-blast-radius tools fail closed.

W048's live qualification ran 2026-09-17 against the operator-upgraded goose **1.50.1** (the researched target line; `goose update`, SLSA-verified), six probe runs through the loopback metering proxy on the openrouter provider, each run's `agentInfo` recording the version. Per-probe verdicts (recorded in full in the `docs/HOST_ADAPTERS.md` goose row and the SECURITY_ASSURANCE S12 catalog — no aggregate claims): **PERMISSION Green** — every mutating call (a todo-write, a `write` to the canary, even a `shell` fallback) reached `session/request_permission` with the full option set (`allow_always`/`allow_once`/`reject_once`/`reject_always`) and the hub's deny-all was honored; the canary was never written — pre-mutation interception with usable reject options PROVEN, so per the criterion goose is reportable **`enforced` for this proven launch mode** (contained `goose acp`, `GOOSE_MODE=approve`, hub-written config, proxy metering). **SUBAGENT Green (denied)** — the `delegate` tool PROJECTS under approve mode (live evidence superseding the plan's expected-absent) and routes through the hub for permission; denied at the hub; zero unprojected spawns; the subagent canary never written. On this evidence `delegate` entered `KNOWN_SPAWN_TOOLS` (`src/adapters/acp.ts` — hub-gateable, mirroring OpenCode's `task` precedent); its `load` sibling never projected and stays unclassified; unknown high-blast-radius tools remain mutation-classified fail-closed to session teardown. **MOUNT Green** — the hub-written `GOOSE_PATH_ROOT/config/config.yaml` in the DOCUMENTED map-shaped `extensions:` schema (fetched from goose-docs.ai after the first live run honestly rejected a list-shaped candidate with `NO_MCP_TOOLS`) mounts the skills-mcp stdio extension; the agent called `list_skills` returning the probe skill verbatim — the research's GOOSE_PATH_ROOT unknown resolves POSITIVE (`goose info` confirms the path; `goose acp` reads it), F1 single-delivery-path proven on goose. **RESUME Green** — `session/load` across a full contained restart replayed the transcript and restored model context (the exact keyword recalled). **METERED Green (openrouter)** — placeholder-only credential inside the boundary (asserted), the proxy recorded 3 requests / 5,279 tokens / $0.0005, and TWO `usage_update` channels projected into the session record (goose's custom notification works end-to-end through W047's tolerance). **HOOKS Green** — a project-scope deny plugin in the documented structure (`plugin.json` + `hooks/hooks.json` + an executable exit-2 script, composed per the goose-docs hooks page after the first run's undocumented candidate shape failed honestly with the canary written) with `on_failure: block` BLOCKED the mutation under containment — the Cline-seam decision input resolves positive on the deny path. The campaign also fixed two composition bugs found by live evidence: `OPENROUTER_HOST` is the provider ROOT (goose appends `/api/v1` itself — the first run 404'd on a doubled path) and `GOOSE_MODEL` must be composed (fail-closed now: `WORKFLOW_GOOSE_MODEL`/`GOOSE_MODEL`, openrouter defaulting to `openrouter/auto` like the sibling paths; azure honors `AZURE_FOUNDRY_MODEL`). Still open, honestly: the METERED probe's azure_foundry run (no `AZURE_FOUNDRY_*` credentials in the probe environment — re-run when provisioned; criterion 2's "on both operator providers" arm stays unchecked for exactly this), and the subagent-internal PreToolUse coverage question (research §7.3 — `SubagentStart`/`Stop` are not emitted by goose, so subagent-internal hook coverage stays unprobed until the spawn surface is exercised with a granted spawn; the seam decision's other arm). `test/goose-agent-config.test.ts` carries both composition fixes as pins across its 5 tests (the model threading + host-shape assertions live in tests 3-5). Version pin policy: re-run the family on every goose bump (weekly cadence; 1.50.1 is the version of record).

**Verification:** all live probe runs green as recorded above with evidence logs in each run's output (plus the honestly-disclosed iteration failures — the NO_MCP_TOOLS list-schema candidate, the NO_HOOK_EFFECT undocumented manifest, the doubled-path 404 — each one forcing a stronger composition, never a smoothed verdict); the unit tests (5/5), the six probes' clean gate-skips, and the assurance checker (6/6 with the goose catalog rows) are green; the azure_foundry metered run and the subagent-internal hook-coverage arm pend the operator's Azure credentials and a granted-spawn session respectively — recorded, not hidden.

### W049 - Goose as the operator's general-purpose daily agent

**Objective:** Dogfood goose (contained, hub-composed) in the general-purpose/ops-plus-development workload on the universal surface, as the qualification plan's daily-driver criterion.

**Depends on:** W048

**Acceptance criteria:**
- [ ] A recorded dogfood matrix covers representative real work: repo edits, shell/ops tasks, MCP participation, resume across restart, and a denial case.
- [x] Material gaps versus the current opencode+plugin setup are recorded with severity/workaround; no critical gap is hidden by the result.
- [ ] Cost/usage visibility from W044/W045 is exercised in real sessions on both operator providers.

**Verification:** the dogfood record plus full gates on any code changes it produces.

**Status (2026-09-17, agent-run):** the dogfood matrix is recorded in `docs/GOOSE_DOGFOOD.md` — five cells (repo edit, shell/ops, MCP participation, resume across restart, denial case) plus the W044/W045 cost/visibility exercise, all through the real production runtime path (`createConfiguredAcpRuntime`, `WORKFLOW_ACP_AGENT=goose`, goose 1.50.1, openrouter via the metering proxy). The matrix forced two product fixes, both pinned by tests: unknown ACP mutation tools are now denied fail-closed instead of tearing down the session (goose's built-in `todo` tool was killing turns), and the goose config root is workspace-keyed persistent state so `session/load` finds the store across a full restart (the per-launch pid+uuid dir deleted on dispose made resume impossible on the runtime path). Gaps recorded, not hidden: MCP read-policy is an explicit operator decision (`skills-mcp__list_skills` denied by default authorization — goose adapted and reported honestly); assistant text arrives via the turn result and surfaces must read both channels; subagent-internal hook coverage still needs a granted-spawn session (W050 input). Criterion 2 is checked on that record; criteria 1 and 3 stay open on their operator arms — the agent-run sessions are smoke sessions on scratch workspaces, the azure arm pends `AZURE_FOUNDRY_*` credentials, and the operator's own daily-driver period remains the takeover gate (W050, Checkpoint D).

### W050 - Cline fallback-slot retirement and SDK-seam decision

**Objective:** Remove the vendored-Cline runtime — patched-TUI build, `.workflow-cline` checkout, Cline drivers/probes — once the two separate, probe-gated decisions resolve: the backup-slot takeover (goose) and the SDK seam's host-hook retention.

**Depends on:** W048, W049

**Acceptance criteria:**
- [ ] The backup-slot takeover resolves: the six probes pass and the W049 dogfood period holds, so goose demonstrably covers the fallback/insurance role the vendored-Cline runtime holds today.
- [x] The SDK-seam retention resolves: the hooks probe proves PreToolUse deny + `on_failure: block` under containment AND subagent-internal tool calls demonstrably fire hooks — or, if they do not, the operator records an explicit accepted-risk decision in the decision doc that the seam's unique subagent-internal visibility is no longer required; the seam is not retired by silence or enthusiasm. (**Resolved 2026-09-21 via the accepted-risk arm**: the probe arm resolved NEGATIVE live twice on goose 1.50.1 and was never demonstrated on the vendored-Cline seam either; the operator signed the drafted accepted-risk in `docs/ACP_DECISION.md` (W050 SDK-seam decision, dated 2026-09-21) — subagent-internal visibility is not a required capability, the residual risk (internal activity inside a granted spawn is neither hook-intercepted nor projected; spawns remain default-denied on `enforced` surfaces) is the operator's explicit accepted risk.)
- [x] Removal removes: the `.workflow-cline` vendored checkout, the patched-TUI build/pretest, `WORKFLOW_ACP_AGENT=cline`, Cline session drivers/adapters, the Cline probe family and their tests — with all references updated (`docs/HOST_ADAPTERS.md`, `docs/FEATURES.md`, `docs/TUI_INTEGRATION.md`, `docs/ACP_DECISION.md`) and the plugin-era findings archived, not silently dropped. (**Verified 2026-09-21** against the tree: no `.workflow-cline` checkout exists, the vendored runtime/patch/probe family are gone (removed on `feat/w050-cline-removal`, merged as PR #40, 2026-09-18), the thin stock-ACP connector is retained (`src/integrations/cline-launch.ts` resolves ambient `cline --acp`; `WORKFLOW_ACP_AGENT=cline` composes the generic ACP runtime), and every referenced doc carries the dated removal/supersession notes — HOST_ADAPTERS W050 follow-up, FEATURES lead-agent row, TUI_INTEGRATION retirement note, ACP_DECISION's step-6 supersession plus the 2026-09-21 accepted-risk pointer. The plugin-era findings stay archived in those notes, not deleted. **Clarification recorded honestly:** the criterion's "`WORKFLOW_ACP_AGENT=cline`" clause reads as removing the engine KIND, but the shipped removal keeps the cline agent kind selectable through the stock-ACP connector (probe-PENDING on stock 3.0.62) — the criterion's substance (no vendored checkout, no patch, no SDK runtime) holds.)
- [x] The repository's full gates pass on the removal diff; the ACP conformance family still passes for the remaining agent kinds. (**Closed 2026-09-21** — the release-gate run recorded: `npm test` on the merged tree containing the removal (602db3c, post-#64) — **1236 tests, 1187 pass, 0 fail, 49 gated skips** (gated live probes skip without env gates per the probe discipline) — plus typecheck, lint, build, and `toolbox:verify` clean; the ACP conformance family for the remaining agent kinds (opencode lead, goose backup) is green in the same run (the shared adapter-conformance trace and the ACP-generic/OpenCode harnesses) and probe-evidenced in `docs/PROBE_VERDICTS.json` (opencode subagent/mount/resume/ask greens 2026-09-16; goose family greens 2026-09-17 — with the subagent-hooks arm deliberately recorded `negative`, the documented finding, not a green). Criterion 1 (the backup-slot daily-driver period) stays with the operator, per the Checkpoint D note.)

**Verification:** the removal diff plus the full suite and an independent five-axis review; the decision record cites the probe evidence and (where applicable) the operator's written accepted-risk record.

**Status (2026-09-17, SDK-seam arm evidence):** the granted-spawn SUBAGENT-HOOKS probe (`test/acp-goose-subagent-hooks-probe.test.ts`, `WORKFLOW_ACP_GOOSE_SUBAGENT_HOOKS=1`) ran live twice against goose 1.50.1 and resolved the subagent-internal arm **NEGATIVE**: the delegated subagent's file-write fired NO PreToolUse record and produced NO ACP tool_call projection in both runs (the spy plugin logged exactly the top-level's todo_write ×2, the delegate spawn itself — PreToolUse DOES intercept the delegation — and one agent-attribution-ambiguous shell `cat` verify; the write-shaped classifier was tightened twice against the real payloads and re-validated offline against both preserved logs, `~/.subhooks-probe.log` + `~/.subhooks-probe2.log`). Combined with the never-emitted SubagentStart/Stop ACP updates, the seam's claimed subagent-internal visibility is now evidence-bounded on both surfaces — goose demonstrably lacks it, and the vendored-Cline seam never demonstrated it live either. Criterion 2's operator arm is evidence-backed: the remaining paths are a live Cline-side subagent-internal hooks proof, or the operator's explicit accepted-risk record in `docs/ACP_DECISION.md` (the evidence note is appended there); the takeover arm (criterion 1) still needs the operator's daily-driver period.

**Status (2026-09-18, removal-on-branch):** criterion 3's artifacts are implemented on branch `feat/w050-cline-removal` (not yet merged) — the vendored-Cline SDK runtime, `.workflow-cline/` checkout, Workflow patch, build/pretest scripts, SDK tests/fixtures, and the hub's Cline-specific `/before-tool` and `/team-task` routes are gone; the host-neutral `src/integrations/hub-http.ts` and the thin stock-ACP connector (ambient `cline --acp`, probe-PENDING on stock 3.0.62) are retained. Criterion 4's focused gates (typecheck, lint, focused batteries, `test/security-assurance.test.ts`, `toolbox:verify`, e2e) are green pending the full-suite release gate, so criterion 4 stays unchecked until that full gate and the five-axis review land.

### Checkpoint D - Daily Driver Replaced

- [x] Fresh full verification (complete suite plus typecheck/lint/build) and an independent review pass on the final merged tree. (**Done 2026-09-21** on the merged tree containing the removal (602db3c, post-#64): `npm test` — the repository's full gates — **1236 tests, 1187 pass, 0 fail, 49 gated skips** (gated live probe families skip without their env gates, per the probe discipline), plus typecheck, lint, build, and `toolbox:verify` all clean. The independent review pass: the recorded whole-branch five-axis APPROVE at the merged tip `c558a63` (record-review 2026-09-21T02:15Z, session `…XbmOSpsu`, covering the register, doctor, monitor, delivery, and UI fixes now on the merged tree) plus this release-gate commit's own docs review (record-review 2026-09-21T03:31Z, which independently reproduced the full-suite counts and the register evidence). Review lineage: round-1 APPROVE (register slice) → round-2 REQUEST_CHANGES (2×P1) → fixes verified → whole-branch APPROVE at the merged tip.)
- [ ] The operator's default harness is the hub-owned surface (OpenCode coding lead, goose general-purpose/backup), the opencode workflow-guard plugin is retired from daily use, and the switch is recorded with the honest delta list (G7 control, per-session escalation counters, any accepted risks). (**Prepared 2026-09-21, awaiting the operator's daily-driver confirmation**: the hub-owned surface is the recorded default since the 2026-09-16 pivot and the 2026-09-18 browser-default bind; goose is the qualified backup (W048/W049); the honest delta list now has its hardest entries closed — G7 compaction control restored via W082 (manual control + config trigger + data-lane monitor, no plugin) and the SDK-seam subagent-internal visibility accepted in writing (`docs/ACP_DECISION.md`, 2026-09-21). The tick waits for the operator to confirm the daily-driver switch in fact happened.)
- [ ] No critical daily-driver gap is hidden: every remaining delta versus the plugin is fixed, accepted in writing, or tracked with severity. (**Partially prepared 2026-09-21**: fixed = G7 compaction control (W082); accepted in writing = subagent-internal hook visibility (`docs/ACP_DECISION.md`); tracked-with-severity still to write = per-session escalation counters and todo-presentation parity (the remaining two deltas — a small ledger pass, then the operator signs the list).)

## Phase 12: AI-landscape follow-ups and open-source model pivot (2026-09-19)

Promoted 2026-09-19 with operator direction after implementation + independent five-axis review (verdicts recorded per item; detailed plans: `docs/superpowers/plans/2026-09-19-ai-landscape-followups.md` and `docs/superpowers/plans/2026-09-19-open-source-model-pivot.md`). Items below record what landed, where, and the honest residual follow-ups; probe-gated claims remain probe-gated.

### W051 - Pre-trust parsing audit across all surfaces

**Status (2026-09-19, implemented + reviewed [APPROVE]):** inventory in `docs/PRETRUST_PARSING_AUDIT.md` (dated; includes the levels.json startup-parse row; toolbox-discovery row marked removed-by-W050 with mcp-settings.ts); directory-canary ordering tests prove no reads of poisoned fixtures on covered helpers (`test/pretrust-parsing-audit.test.ts`, 3/3). **Residual (PARTIAL):** criterion 3 covers only the inventory-covered helper paths; universal/acp TUI startup, web-service, hub discovery/scheduler, skills-mcp process startup, ACP tool-call reads, and persistent state need a process-level harness or per-runtime probes.

### W054 - Memory-poisoning defenses for durable agent state

**Status (2026-09-19, implemented + reviewed [APPROVE]):** durable-state inventory with writer authority (`docs/DURABLE_STATE_INVENTORY.md`); provenance stamps in project-memory-mcp (launch-config stamp, missing-stamp fails closed, MCP refuses unstamped writes); deterministic startup attestation + canary detection (`src/integrations/durable-state-attestation.ts`, CLI `npm run durable-state:attest`), poisoned-fixture tests green; THREAT_MODEL residual recorded (attestation validates structure/provenance, not truth). **Residual:** the runtime wire is parked — W050 removed cline-runtime (the only memory-injection caller) and no successor surface injects project memory yet, so nothing calls `attestProjectMemory` before a turn in production; wire it at the first durable-state injection boundary. Run-registry finding routing and canary seeding in live investigation surfaces pending.

### W057 - Harness assumption ledger + model-bump audits

**Status (2026-09-19, implemented + reviewed [APPROVE]):** `docs/HARNESS_ASSUMPTION_LEDGER.md` (7 components with assumed model gaps; operator-invoked remove-one-at-a-time audit procedure; worked example explicitly marked illustrative); version-bump discipline references the audit in `docs/HOST_ADAPTERS.md` (operator-invoked, never automatic, never a substitute for probe re-runs). **Residual:** first real audit run must replace the illustrative numbers.

### W063 - Containment refinements

**Status (2026-09-19, implemented + reviewed [APPROVE]):** resolve-before-validate symlink ordering pinned by tests (non-exploitable audit recorded honestly; W025 fix acknowledged); type-level `read-write-no-delete` mount mode (bwrap ro-bind + per-file binds; delete AND creation blocked — limitation documented; platform passthrough refuses the mode); custom-component audit `docs/CUSTOM_COMPONENT_AUDIT.md` (P2/P3 findings GA-1/GA-2/MX-2/MX-3/MX-4/CB-1/CT-1/CT-3 recorded); OTLP pull-based export deferred with design note. Also repaired a stale `web-sessions` citation in `test/security-assurance.test.ts` left by the main rewrite.

### W064 - Standards tracking for SECURITY_ASSURANCE

**Status (2026-09-19, implemented + reviewed [APPROVE]):** dated claim/not-claim entries for NIST agent identity, ACSC/CISA/NCSC six-agency guidance (2026-04-30), ISO/IEC 42001, Anthropic Model Hardware Standard preview, OpenAI misalignment reporting framework, and Google "Three Layers of Agent Security"; pinned append-tolerantly by `test/security-assurance.test.ts` (7/7).

### W070a - Open-source-first routing pivot

**Status (2026-09-19, implemented + reviewed [APPROVE], integrated through main 0a0e126 + PR #44/c20eef3):** default pool `deepseek-flash` / `glm-5.3` / `glm-5.3-flash` / `kimi-k3`, all endpoints/IDs live-verified with recorded evidence (vendor 401 probes + OpenRouter catalog rows; no guessed IDs); canonical `ModelProfile` request shaping (GLM/K3 never `thinking:disabled`; effort low/high/max); per-vendor metering pools with placeholder-key discipline composed in `createOpencodeRuntime` alongside PR #44's upstream-key fallback; off-peak scheduler option (GLM window verified; DeepSeek operator-supplied); closed models remain operator-override. **Mechanism correction (2026-09-19, operator):** the pivot operates at the OpenRouter Auto Router level — the agent default stays `openrouter/auto` and the operator-configured open-source `~…-latest` alias pool (`WORKFLOW_OPENROUTER_AUTO_ALIASES`) is injected as the Auto Router's `allowed_models`; the per-vendor metering pools are the opt-in direct-endpoint cost path (engage only with vendor keys), not the pivot mechanism. **Residual:** live vendor completion probes gated unrun (need `DEEPSEEK_API_KEY`/`ZAI_API_KEY`/`MOONSHOT_API_KEY`); off-peak cost delta unmeasured; OpenRouter fallback route test-only until a production caller exists; ACP-conformance re-run owed for new hub-sent params.

### W070b - Open-model optimization + deterministic tool-usage enforcement

**Status (2026-09-19, implemented + reviewed [APPROVE after P1 fix], integrated through main 0a0e126 + PR #44/c20eef3):** per-model replay policy enforced at the metering proxy (K3 preserved-thinking contract: stripped replay rejected 400 pre-upstream; DeepSeek mid-conversation tool-call synthesis diverted to the Anthropic-format path 409; adjacency rule fixed for parallel tool calls after reviewer-reproduced P1); DeepSeek strict-schema translator (canonical ModelProfile-keyed; `/beta` strict mode served via gated golden probe; production `/beta` endpoint selection deliberately deferred to a dedicated provider seam, documented in `docs/OPEN_MODEL_ENFORCEMENT.md`); guard deny-with-redirect text tightened; bounded tool-expected-turn steering (≤2 retries, monitor-visible, opt-in) — a behavioral nudge, never a security control; 13-pattern inventory of the retired workflow-guard plugin with per-pattern dispositions; vendor golden-probe corpus defined. **Residual:** steering dormant until a production caller passes `toolExpectedTurn`; strict-mode production wiring (W062 seam); one live probe run per vendor (keys).

### Checkpoint E - AI-landscape follow-ups landed

- [ ] Live vendor probes recorded per family (needs vendor keys) and off-peak delta measured or no-go'd.
- [ ] Attestation wired at the first post-W050 durable-state injection boundary; run-registry routing for supervisor findings.
- [ ] Strict-mode production seam (W062) and golden-probe verdicts recorded per vendor.
- [ ] W052/W065/W058/W059 and the remaining Phase 12 candidates scheduled per the follow-ups plan sequencing.

## Phase 13: Standard-Surface Background Authority

### W071 - Stock-TUI surface over a hub-owned OpenCode server

**Objective:** Let the operator keep the standard `opencode` TUI as the
interface while the Workflow hub owns, contains, and authorizes the OpenCode
server behind it — the inverse of the current browser-fronted composition and
the terminal counterpart to the remote ACP bridge. Plan:
`docs/superpowers/plans/2026-09-19-standard-tui-background-authority.md`.

**Depends on:** W035 (ACP conformance), W037 (ACP session driver), W046 (task
correlation), W050 (Cline retirement; hub-http seam), and the merged remote ACP
bridge (`src/integrations/remote-acp/*`, PR #43).

**Acceptance criteria:**
- [ ] The hub launches and owns a **contained** `opencode serve` (Bubblewrap,
      loopback-only, hub-written config: metered provider via the loopback
      proxy, pinned `ask` ruleset, skills-mcp mount, scratch HOME); an
      unavailable or policy-only containment backend fails closed.
- [ ] A loopback **gateway** fronts the server with an auth split — the
      upstream server credential is hub-only, the stock TUI holds a distinct
      password — and permission replies from the client are routed to the hub
      broker, so the hub is the **sole** upstream permission answerer.
- [ ] The `workflow-opencode` launcher `exec`s the stock `opencode attach`
      binary with connection details only; the operator's UI is unmodified and
      Workflow owns no display.
- [ ] The hub broker maps `permission.asked` → `ProposedToolAction` →
      `WorkflowApplication.authorize` + guard, replies fail-closed, correlates
      sessions to canonical tasks, and records decisions/evidence; malformed
      events, SSE loss, and reply errors all reject.
- [ ] The gated probe family runs live with per-probe verdicts recorded in
      `docs/HOST_ADAPTERS.md` (TUI-ATTACH, AUTHORITY-SPLIT, PERMISSION,
      RULE-CONFIG, BYPASS, SUBAGENT, SSE/TURN, AUTH/METERED, CONTAINMENT); the
      surface is reported `enforced` **only** on green PERMISSION +
      RULE-CONFIG, otherwise `advisory`.
- [ ] Residuals are recorded, not buried: host-network egress for the
      contained server, subagent-internal projection invisibility, and the
      Workflow-managed server home/history.
- [ ] Focused gates pass on the diff (`npm run lint`, `npm run typecheck`,
      focused tests) and an independent five-axis review is recorded.

**Verification:** the live attach + denial + bypass probe evidence, the
`HOST_ADAPTERS.md` verdict row, the updated `docs/HUB.md` / `docs/FEATURES.md` /
`SECURITY_ASSURANCE.md` claims, and an independent five-axis review before
merge.

**Status (2026-09-19, M0–M3 on branch `feat/w071-standard-tui-background-authority`):**
plan `docs/superpowers/plans/2026-09-19-standard-tui-background-authority.md`;
decision record `docs/OPENCODE_SERVER_AUTHORITY.md`. **M0 complete:** against
real opencode 1.18.31, the loopback server honors `OPENCODE_SERVER_PASSWORD`,
reads the hub-written `XDG_CONFIG_HOME` config, the `ask` ruleset is pinnable,
the gateway passes the stock-client surface, and the **authority split holds**
(TUI-only credential → 401 upstream; intercepted at the gateway). **M1
implemented:** `opencode-server-runtime.ts` (contained `opencode serve` +
metered config + proxy, fail-closed), `opencode-server-gateway.ts` (auth split,
compression/pathname fidelity, broker hook vs advisory pass-through),
`opencode-server-discovery.ts`, the `workflow-opencode-server` daemon, and the
`workflow-opencode` stock-TUI launcher (bins/scripts added). **Sequencing
refinement (recorded):** server ownership landed in a dedicated workspace-scoped
daemon, not the global `workflow-hub`; hub promotion stays available through the
discovery seam. **M2 implemented:** `opencode-server-authority.ts` —
subscribes to the server SSE via the production `HttpRemoteEngine`, maps each
`permission.asked` to a `ProposedToolAction` (`AcpHostAdapter` + an explicit
OpenCode capability classifier so `webfetch`→network and `task`→spawn), runs
`WorkflowApplication.authorize` (+ optional guard), and answers upstream
`once`/`reject`; unmappable/malformed/guard failures and policy denials all
`reject` (fail closed); SSE loss marks authority lost; sessions correlate to
canonical `opencode-session:<id>` IN_PROGRESS tasks; every decision is
journaled (observability only). **Review passed:** an independent five-axis
review returned REQUEST_CHANGES (2×P1) and all fixes landed (reply-route
normalization-safety, advisory forward path, authority-lost teardown, gateway
error boundary, launcher hardening); the branch was rebased onto main (W071 =
Phase 13). **M3 implemented:** operator-intent reconciliation —
`auto-resolve` answers from policy immediately (operator reply = observation);
`ask-me` holds policy-allowed asks and reconciles the operator's answer as
`policyDeny ? reject : operatorReply` with a fail-closed timeout, so the
operator can tighten but never loosen; enforcement mode
(`WORKFLOW_OPENCODE_ENFORCEMENT=enforced`) verifies the pinned `ask` ruleset at
startup (`assertAskRuleset`, fail closed), makes the gateway construction
refuse to exist without the broker hook, and arms the bypass alarm — a
mutating tool activity with no prior Workflow decision is journaled, fires
`onBypass`, and tears the surface down. **M4 implemented:** server-path
evidence/metering/budget/skills — `recordMutation` on observed completed
mutations (a decided-but-not-completed mutation advances nothing); skill
delivery journaled on observed completion (`recordSkillRead` bound to the
session task; `read_skill` entered the ACP adapter's `KNOWN_READ_TOOLS` and
the broker carries a read kind so the delivery is authorizable); the
session-budget watcher (`opencode-server-budget.ts`, W045 caps → abort active
turns + sticky violation → mutating asks denied fail-closed); the daemon logs
the active budget mechanism and final metering totals. Focused gates green:
typecheck, lint, 43 unit tests, gated live probe, build. The verify-command
run gate stays hub-owned (recorded boundary). **Still open:** the live
`permission.asked` → authorize → reply probe and the rest of the probe family
(RULE-CONFIG/BYPASS/SUBAGENT/AUTH/METERED/CONTAINMENT — need a model key), a
real contained launch with a key, the literal interactive TUI operator smoke,
the `HOST_ADAPTERS.md` verdict row, and the final five-axis review pass. The
surface remains **`advisory`** — no `enforced` claim until the probes run.

## Phase 14: Roadmap Compliance & Plugin-Retirement Parity (2026-09-19)

### W072 - Three-level decomposition ledger + strict-compliance register

**Objective:** Make the agent's decomposition a **deterministic, operator-gated ledger** —
roadmap/plan → canonical tasks → canonical steps/todos — so a task cannot be marked done while its
steps are open, and so goals/work cannot drift from the plan without operator approval. This is the
capability the operator's "evidence + ledger" requires and the precondition for retiring
`opencode-workflow-guard` (Checkpoint D).

**Depends on:** W046 (task-command port), W050 (hub-http seam), W071 (standard-TUI authority), and
Phase G of `docs/superpowers/plans/2026-09-15-hub-owned-enforcement.md`.

**Spec:** `docs/TASK_TODO_LEDGER_PARITY.md` — invariants I-1…I-10, kernel child nodes, evidence-bound
checkoff, immutable execution-log target, staged bridge→MCP migration, Phase-G retirement parity.
**V2 target:** `docs/OPENCODE_V2_MIGRATION_SPEC.md` — C/D and the native bridge now target the OpenCode
v2 HTTP API after qualification; no deeper v1 ACP expansion without a separately approved compatibility fix.
**Register:** `docs/COMPLIANCE_REGISTER.md` — DRIFT-001…024 obligations (strict compliance; no prose
promotions).
**Baseline:** `docs/PLAN_VS_REALITY_AUDIT.md`.

**Acceptance criteria:**
- [ ] **I-1** Mutations deny without an active canonical step on an `IN_PROGRESS` task (`NO_ACTIVE_STEP`),
      enforced at the application gate and mirrored in `workflow-guard-mcp`; test proves the deny.
- [ ] **I-2** Active steps cannot be silently deleted/omitted; test proves the block.
- [ ] **I-3** Step completion requires fresh typed evidence bound to the step (subject `step:<id>`);
      an agent cannot complete a step without an intervening authorized/observed action; test proves it.
- [ ] **I-4** A task/run cannot leave `IN_PROGRESS`/reach `VERIFIED` while any required step is open;
      a canonical `isRunComplete` predicate refuses completion with any required node open; tests prove both.
- [ ] **I-5** Secondary review audits the ledger against the diff/evidence; a checked step with no
      corresponding work yields a P0/P1 and `REQUEST_CHANGES`; pinned by a review test.
- [ ] **I-6** Immutable plan ledger + **append-only execution log**; canonical state is a deterministic
      replay/projection of the log (write/read only; permissions deterministic); restart resumes by replay.
- [ ] **I-7** Every step declares its done-condition before it can start; test proves an undeclared step cannot start.
- [ ] **I-8** At most one `IN_PROGRESS` step per task; test proves a second concurrent start is rejected.
- [ ] **I-9** Deterministic validation gates ordered codes→schema→cross-field→**state-diff re-query**→tests;
      an LLM only classifies; test proves a claimed-but-absent change is rejected.
- [ ] **I-10** Every execution-log entry carries durable identity (session/agent/task/step).
- [x] Stage 1 native-`todowrite` bridge keeps the agent's DX while the plugin remains the enforcement
      seat (per Phase G). Stage 2 hub-owned enforcement; Stage 3 portable MCP step tool; Stage 4 G6 corpus
      remain future stages.
- [ ] Drift obligations closed with linked evidence: in particular **DRIFT-003** (GUARD_CORPUS_MAP
      "Ported (superset)" overclaim), **DRIFT-004** (`workflow-fs-exec-mcp` dead `/before-tool` route),
      **DRIFT-008/009** (empty `requiredEvidence` escape, missing run-completion predicate),
      **DRIFT-001/002** (W050/Cline reconciliation, Checkpoint C evidence).
- [ ] Ledger checks folded into the G6 adversarial corpus; `opencode-workflow-guard` retirement only
      after the per-pinned-version criteria (a)/(b)/(c) pass — never date-gated.
- [ ] Focused gates pass (`npm run lint`, `npm run typecheck`, focused tests) and an independent
      five-axis review is recorded.

**Verification:** kernel/application tests for I-1…I-4, the `isRunComplete` test, the review-audit test,
the G6 corpus run for the pinned agent version, and the closed `docs/COMPLIANCE_REGISTER.md` rows with
their linking artifacts.

**Status (2026-09-20, Stage 1 bridge landed; C/D paused for OpenCode v2):** spec, audit, compliance register,
and v2 migration/qualification spec are committed. Stage 1 kernel/application work plus native ACP
`todowrite` bridge are implemented and reviewed **APPROVE**. Focused gates: typecheck/lint clean;
145/145 focused tests; `test/step-ledger.test.ts` now pins ledger, restore, done-condition, ownership,
and bridge behavior. **Still open:** all-surface enforcement, G6 corpus folding, immutable execution log,
state-diff evidence, v2 C/D reconciliation, and Phase-G probes. W072 remains **in progress**, not
complete.

**Addendum (2026-09-20, v2 host-version finding):** stock OpenCode **removed the `todowrite`/`todoread`
agent tools entirely in v2** (upstream `anomalyco/opencode#42421`, closed **not planned**; verified
on the pinned v2.0.10 binary — zero tool strings, zero HTTP todo routes; only adjacent experimental
surface is `instructions/entries`). Consequences: the native-todowrite bridge has **no agent-facing
input on the pinned OpenCode host version** (it remains valid for hosts that expose native todos —
goose/cline); the guard's todowrite gate can never be satisfied by a model on OpenCode v2, which
validates the earlier removal of the todo requirement from the workflow-guard plugin. Decision: do
NOT pivot tracking to `instructions/entries` (experimental, session-scoped, wrong semantics), and —
per the operator's no-plugins constraint — do NOT restore a todo tool via the v2 plugin API's
`ctx.tool.transform` (the richer v2 plugin surface is deliberately not adopted; see the constraint
recorded in project memory 2026-09-20). The canonical tracking surface is the Workflow step ledger —
surfacing it in the custom web UI is the accepted track; an upstream-candidate PR (§8) to restore a
generic todo tool is parked, and the interim advisory workaround is a plan file via
`WORKFLOW_ADVISORY_NOTES`. Recorded in project memory 2026-09-20.


## Phase 15: Bounded recursive self-improvement (2026-09-19)

### W073 - Bounded self-improvement loop (Karpathy loop) under Workflow authority

**Objective:** Implement the propose → apply → test → evaluate → commit/discard
loop described by the operator's two cited sources (MindStudio's "Karpathy
Loop" explainer; Anthropic's "When AI builds itself") as a deterministic
integration-layer orchestrator that routes every candidate through the
canonical run lifecycle, so nothing is committed unless the kernel reached
`VERIFIED` on fresh evidence. The loop is workspace-parameterized, so the same
control-plane capability can later be pointed at other repositories.

**Spec:** `docs/superpowers/plans/2026-09-19-recursive-self-improvement-loop.md`.
**Module:** `src/integrations/self-improvement-loop.ts` (loop, git candidate
workspace, `createAuthorityGate`).

**Depends on:** the run registry / run-lifecycle gates (W038–W042 area) and
the hub reviewer + test runner wiring (`hub-run-gates.ts`). No kernel change.

**Acceptance criteria:**
- [x] A candidate is committed only after `finish("verified")` resolves; every
      rejection path closes the run `failed` and discards the workspace.
- [x] An authority-begin refusal, a malformed proposal, or a proposal-source
      failure stops the loop without mutating (fail closed).
- [x] The loop is single-instance per workspace; a second concurrent run for
      the same workspace is refused.
- [x] Bounds stop the loop deterministically: `maxIterations`,
      `maxConsecutiveRejections`, and an optional cost budget.
- [x] The objective is validated up front (absolute workspace, non-empty
      description, positive integer iteration cap, valid direction/budget).
- [x] A verified-but-uncommittable candidate is audited and stops the loop,
      reporting it uncommitted — never as committed.
- [x] The git candidate workspace detects a change, commits it, and
      destructively discards uncommitted work in a dedicated checkout.
- [x] An integration test composes the real `createRunRegistry` (reviewer +
      test runner) and proves an accepted candidate's run reaches `VERIFIED`
      on recorded reviewer + environment evidence, while a rejected
      candidate's run ends `FAILED` and its change is discarded.
- [x] `npm run lint`, `npm run typecheck`, and the focused test file pass.

**Verification:** `test/self-improvement-loop.test.ts` (21 tests: hermetic
bounds/fail-closed coverage, the registry-composition acceptance path, and
real-git workspace coverage); `npm run lint`; `npm run typecheck`; the recorded
five-axis review.

**Status (2026-09-19, implemented on `feat/w073-self-improvement-loop`):** the
loop, git candidate workspace, and authority adapter landed with the focused
suite green (27 tests: hermetic bounds/fail-closed coverage, the
registry-composition acceptance path, and real-git workspace coverage), lint
and typecheck clean. **Independent five-axis review:** `[REQUEST_CHANGES]`
(2×P2, 5×P3); both P2s fixed and pinned by test — a failed rollback (run close
or discard) is now surfaced on the iteration record and **stops the loop**
instead of continuing over an unsafe tree — and the P3s are fixed
(best-effort commit ref, realpath-keyed single-instance lock, guarded
`usageUsd`/`onIteration`) or recorded as residuals (`git add -A` dirt,
iteration-boundary budget) in the plan's review record. **Re-review:**
`[REQUEST_CHANGES]` on one P2 regression from the fix round (the lock acquired
the realpath key but released the raw path, leaking the lock under path
aliases); fixed and pinned by a symlink-alias symmetry test, with the
remaining new branches pinned too. **Residuals (recorded,
not buried):** the production agent applier and `measure` are composition-time
seams — this item ships the orchestrator and git workspace, not a new agent
runtime; the git command runner runs outside Bubblewrap in this first slice
(hub-side action on a dedicated workspace, not an agent tool call); proposals
are not yet sourced from a live model. A final re-review verdict is recorded
before merge.

**Trigger / monitor / cancel surface (2026-09-19, operator-directed):** the
operator chose the hub-owned **registry + admin CLI + hub API** path with
boundary-scoped cancel. Landed: the loop's cooperative `shouldStop` hook
(checked only at iteration boundaries; a throwing predicate fails closed); the
hub-owned `self-improvement-registry.ts` (`start`/`status`/`cancel`, validated
specs, realpath duplicate refusal, bounded history); the hub routes
`POST /rsi/start|status|cancel` (`hub-http.ts` + `workflow-hub.ts`; 404 when
unconfigured); and the `workflow-rsi` CLI client (`src/cli/rsi.ts`, bin added).

**Adversarial-review round (2026-09-19, operator-directed):** an independent
adversarial reviewer with its own primary-source research returned
`[REQUEST_CHANGES]` (2×P0, 2×P1) and all four blockers were fixed and pinned:
a **clean-baseline precheck** (`CandidateWorkspace.assertBaseline`; refuses a
dirty tree or non-repo, so the destructive discard can only revert the loop's
own candidate changes); **`requiresReview` defaults to true** at `/rsi/start`
with explicit opt-out (`requiresReview:false` / `--no-review`; the vacuous
evidence-free default path is closed); **`/rsi/start` and `/schedule/run-now`
require the verifier credential** (the same trust model as `/run/finish`) with
the CLI reading `verifier.json`; and the reviewer's run ask is the
**operator-authored objective**, never the candidate's hypothesis.
`THREAT_MODEL.md` (2026-09-19 §1–6) records the residuals honestly — notably
that the boundary is credential-scoped, not process-scoped (a same-UID process
that can read `verifier.json` can start a loop), and that reviewer
independence carries a prompt-injection residual through candidate-authored
diffs. Focused suites: loop 32, registry 8, hub API 5, schedule manager 10, CLI
parse 6 — all green; lint and typecheck clean. The production `LoopRunner`
(live proposal source + agent applier + measure) remains a composition-time
seam; `cli/hub.ts` now composes the registry with a fail-closed runner until
Checkpoint F lands it.

### W074 - Scheduled-task manager (backend landed; web page pending)

**Objective:** expose the existing hub cron engine as an operator-managed
scheduled-task surface: hub routes (`schedule/list|save|delete|run-now`), a
live schedule authority that persists via `saveSchedulesTable` and feeds the
running scheduler (today the table loads once and is frozen), a next-run
preview over `cronMatches`, and a Schedules page (nav slug beside Chat ·
Sessions · Usage) with create/edit, pause, run-now, delete, and last-outcome
correlation via `/snapshot` gateObservability.

**Status (2026-09-19, backend implemented + adversarially reviewed):**
`ScheduleDefinition` gained an `enabled` pause flag (retained but skipped by
`tick`); `nextCronMatch` and `HubScheduler.trigger(id)` added;
`schedule-registry.ts` owns the table live (list/get/save/remove; persists via
`saveSchedulesTable` before admitting; run-now attached to the scheduler); hub
routes `/schedule/list|save|delete|run-now` added (`hub-http.ts` +
`workflow-hub.ts`, which auto-wires the registry's run-now to the scheduler —
`run-now` is verifier-credential-gated after the adversarial review, P1-1);
overlapping tick/run-now fires are collapsed (in-flight guard + minute
consumption); `cli/hub.ts` now composes the live registry with an always-on
scheduler, so operator edits take effect without a hub restart. Focused suite
`test/schedule-manager.test.ts` (10 tests) green alongside the touched
hub-scheduler/hub-runs suites; lint and typecheck clean. **Pending:** the web
Schedules page and its SSR/CDP tests. **Residual:** schedule edits are
hub-single-writer (the existing instance lock guarantees one hub); a durable
registry across restarts is part of the long-horizon gap below.

## Long-horizon gaps recorded 2026-09-19 (OpenRouter cookbook)

The operator supplied OpenRouter's "Build a Long-Horizon Agent" cookbook; the
W073 loop and hub scheduler were checked against it. Gaps (honest, tracked):

- **Per-iteration step/token ceilings** on the candidate agent turn (W073
  budgets only at iteration boundaries via `usageUsd`).
- **Durable/resumable loop state**: the registry is in-memory; a hub restart
  loses running loops and iteration records. Adopt the cookbook's `StateAccessor`
  atomic temp+rename discipline (swallow only `ENOENT`).
- **Completion notification**: notify (webhook/event) when a loop terminates.

### Checkpoint F - bounded self-improvement loop landed

- [x] Wire a live proposal source (agent turn) and a production `measure` at a
      composition root.
- [x] Containment-wrap the git command runner (or route commits through the
      contained shell executor) and record the residual closure.
- [ ] Point the loop at a second repository to prove the workspace-parameterized
      control-plane capability end to end.
- [ ] Project the registry status/iteration records into the web UI (Sessions
      page card + `/rsi` surface-handled command) over the `/rsi/*` routes.
- [ ] Durable/resumable loop registry (atomic `StateAccessor`-style persistence)
      + per-iteration step/token ceilings + completion notification.

**Checkpoint F status (2026-09-21, boxes 1–2 implemented on
`feat/checkpoint-f-rsi-agent-wiring`):** `src/integrations/self-improvement-agent.ts`
composes the production loop (`createAgentDrivenRunLoop`): an agent-driven
proposal source over the full iteration history, an agent applier whose change
detection stays with `git status --porcelain` (an agent's claim can never
fabricate or suppress a change), a measure over a hub-executed command
(`WORKFLOW_RSI_MEASURE_COMMAND` must print one finite number; anything else
rejects the candidate fail-closed), and the git runner routed through the
hub's contained shell executor with constant command strings — commit messages
are staged inside the workspace `.git/` (0600, removed after the attempt, the
only path the sandbox mounts) and travel via `git commit -F`, with identity
carried on `git -c user.name/email` flags (the sandbox clears the
environment, so global gitconfig is unreachable — an independent review P0
caught the first version staging the message outside the mount, where the
commit could never complete; the fix is pinned end to end against the real
containment backend by
"the contained commit path completes on the real containment backend end to
end") and hook execution disabled (`--no-verify` +
`core.hooksPath=/dev/null`) so a planted pre-commit hook cannot run at commit
time. Recorded residual: a repo-configured clean filter
(`.gitattributes`/`.git/config`) still runs during `git add -A`, so committed
content can differ from the diff the reviewer saw — the enforcement for not
pointing the loop at untrusted repositories stays with the operator and the
guard (THREAT_MODEL 2026-09-21 §7). That closes the "git command runner runs
outside containment" residual from the W073 plan.
`cli/hub.ts` composes the registry lazily through the new
`createWorkflowHub` `selfImprovementFactory` handles seam (the same pattern as
`schedulerFactory`), with `WORKFLOW_RSI_AGENT` strict-parsed (`0` restores the
fail-closed refusal, `1`/unset enables, anything else refuses hub startup —
mirroring the `WORKFLOW_ACP_AGENT` precedent), and prompt templates
(`WORKFLOW_RSI_PROPOSAL_PROMPT` / `WORKFLOW_RSI_APPLY_PROMPT`) plus the
measure command are the operator/host config seams — the module defaults are
versioned source, and `{{placeholder}}` rendering fails closed on the
template only, so agent- or objective-authored `{{...}}` content passes
through as data. Honesty notes: the budget supplier counts SUCCESSFUL
proposal+apply turn cost only — a failed turn's spend is recorded in the
run-usage ledger (the turn runner records usage in `finally`) but not
budget-counted, and reviewer/test gate cost is metered by the hub's own run
usage (both recorded residuals); per-iteration step/token ceilings, the
durable registry, and completion notification remain the box-5 gaps; the web
UI projection (box 4) and the second-repository proof (box 3) are open.
Verification: `test/self-improvement-agent.test.ts` (18 tests: template
rendering/parse fail-closed + value-passthrough, mutator defers to git,
measure strictness, contained-git constant-command allowlist + `.git`-staged
`-F` message + hook hardening + refusal of unexpected verbs, the composed
loop's accept/verify/commit path, budget cap, boundary-scoped cancel,
proposal-failure and authority-refusal fail-closed stops, prompt prefix, and
the real-backend contained-commit pin), `test/hub-rsi.test.ts` (6 tests,
incl. the factory composition pinning that the registry is built against the
real run-registry controller), regression on
`test/self-improvement-loop.test.ts` (32/32); typecheck and lint clean.

## Phase 16: Settings Panel, Launcher Engine Axis, and Hub Orientation (2026-09-20)

The operator panel rollout (selector `13269a9`, connector catalog `c221908`, model routing
`91ab09f` is **complete**). Remaining slices of the agreed sequence plus the hub-briefing design
decision (recorded in project memory 2026-09-20).

### W075 - Launcher engine axis: `workflow web --agent <kind>`

**Objective:** Let the operator choose the ACP agent kind (opencode / goose / cline) at launch —
`workflow web --agent goose` — resolved through `WORKFLOW_ACP_AGENT`, with the panel's agent
switcher and posture labels driven by `listWebAgents()` (`src/ui/web-agents.ts`). One selector
implementation covers all surfaces; per-kind probe verdicts in `docs/HOST_ADAPTERS.md` decide what
each surface may claim.

**Depends on:** the committed selector (`13269a9`); connector catalog (`c221908`); model routing
(`91ab09f`).

**Acceptance criteria:**
- [x] `workflow web --agent <kind>` accepts `opencode`, `goose`, `cline`; invalid kinds fail closed
      with the valid list in the error. (`parseAgentFlag`, pinned in `test/workflow-launcher.test.ts`.)
- [x] Explicit `--agent` overrides `WORKFLOW_ACP_AGENT`; absence leaves the env default untouched.
      (`resolveAgentKind` precedence pinned; the launcher writes the same env the runtime reads, so
      every surface honors one axis. An invalid env value stays `acpAgentKind`'s fail-closed problem.)
- [x] The webapp surfaces the resolved engine kind and its containment posture (from
      `listWebAgents()`) honestly — unprobed kinds show their probe-PENDING status, not a green check.
      (Pre-existing and pinned: status-bar containment title, agent switcher, settings AgentSection,
      `/api/agents` with availability `reason`; goose/cline render `contained`, opencode `advisory`.)
- [x] Parsing lives in `src/cli/launcher-args.ts` with focused tests; `npm run typecheck`/`lint` clean;
      an independent five-axis review is recorded. (Parsing + tests + gates done 2026-09-20. Review
      round 1: REQUEST_CHANGES — three P2, three P3, no P0/P1; all six fixed in `d2c78cd` (honest
      launch-consumption copy, truthful save state + disclosed clear limitation, wired precedence,
      exact-value fact pins, `acpAgentKind` lockstep drift guard). Re-review 2026-09-20: **APPROVE**
      recorded, 35/35 focused.)

**Verification:** `node --import tsx --test test/workflow-launcher.test.ts` (10/10 after the
lockstep test; 35/35 across web-settings + webapp-surface + workflow-launcher), typecheck and lint
clean, five-axis review APPROVED (2026-09-20).

### W076 - Qualification probes: stock opencode web UI behind the hub gateway; v2 config hot-reload

**Objective:** Turn the two remaining experimental seams into probe-gated, dated verdicts: (a) the
stock opencode web UI projected through the hub gateway as a second surface (per
`docs/ideas/hub-control-plane.md`); (b) v2 config hot-reload — a routing/settings change reaching a
live hub session without a restart.

**Depends on:** W075 (engine axis lands before probes exercise multiple agent kinds).

**Acceptance criteria:**
- [x] A live probe drives the stock opencode web UI behind the hub gateway and records the verdict
      per pinned version in `docs/HOST_ADAPTERS.md` (gated, skips clean when unset).
      (`test/opencode-webui-gateway-probe.test.ts`, gate `WORKFLOW_OPENCODE_WEBUI_PROBE=1`; **live
      green on stock v2.0.10, 2026-09-20** through the enforced gateway. Required a deliberate
      `app-shell` route class (§2.5 row) and surfaced the version-tolerance repair: v2.x serves the
      SPA on every bare path, so the health wait walks both contracts via the shared
      `src/integrations/opencode-health.ts` module (v1 JSON `{healthy:true}` or v2 `/api/info` —
      landed 2026-09-20 from a concurrent session in this checkout, folded into the W076 commit with
      attribution); the always-run runtime test (4/4) is repaired. The M1 attach probe's bare-path
      spellings are stale on v2.0.10 — stated in `docs/HOST_ADAPTERS.md` with the reason;
      re-qualification open.)
- [x] A live probe or deterministic test proves config publish → live session pickup (or documents
      the restart-required limitation honestly in `docs/FEATURES.md`). (Documented: launch-time
      application only — only `model` reaches a launch config today; reasoning effort has no launch
      consumer yet; no hot reload, changes reach a *new* session. Pinned by the routing UI copy +
      focused tests; `docs/FEATURES.md` row "Settings panel: model routing (slice 2)".)
- [x] No claim upgrades to Complete without the probe evidence; hub config publish remains the
      single journal of record. (The web-UI row was upgraded only with the live probe; W071's attach
      surface stays advisory/probe-PENDING with the staleness stated, not silently repaired.)

**Verification:** `WORKFLOW_OPENCODE_WEBUI_PROBE=1 node --import tsx --test
test/opencode-webui-gateway-probe.test.ts` green (v2.0.10, 2026-09-20); classifier + gateway suites
82/82; `test/opencode-server-runtime.test.ts` 4/4; typecheck and lint clean; dated rows in
`docs/HOST_ADAPTERS.md`, `docs/FEATURES.md`, and §2.5.

**Gap follow-ups (2026-09-20, same day — the two named gaps are closed):**
- **Fresh research** against the brand-new official v2 docs (`opencode.ai/v2/docs/api`, 136
  operations — §9): the matrix was reconciled with the documented inventory (bare permission/
  worktree/pty reads unblocked; documented session ops classified — `agent`/`model` switch,
  experimental `skill`/`wait`, staged-revert family, inbox PATCH; undocumented verbs like `PUT
  /api/session/{id}` and the speculative `switch` narrowed away), and the dual-lane integration
  decision (ACP = control lane; v2 HTTP API = data lane, per the operator) is recorded in project
  memory and §9.
- **M1 attach probe re-qualified live on v2.0.10** (`WORKFLOW_OPENCODE_SERVER_ATTACH=1`, v2
  spellings): config loaded and parsed, `/api/session` create through the gateway returns
  `data.id`, authority split holds, **broker SSE subscribes and intercepts without forwarding**
  (the engine's event stream now tries `/api/event` by content-type with a `/global/event`
  fallback). Still advisory — the live permission path needs a model key.
- **v2 provider-visibility finding** (§9, matching the upstream custom-provider issue class):
  config-defined providers do not list in `/api/provider` or `/api/model` on v2.0.10, and
  `/api/model/default` ignores the config `model`; the metered provider is asserted via the loaded
  config documents. Follow-up: evaluate the `/api/credential/{id}/activate` path for metered
  visibility.
- **The stock web UI tab is wired**: `openStockWebTab` (`src/cli/web-launch.ts`) surfaces the
  gateway-served stock UI as a second `workflow web` tab when the topology daemon is already
  running (probe-verified, quiet otherwise, foreign-host refused, `WORKFLOW_OPENCODE_STOCK_TAB=0`
  opt-out); 3/3 focused tests (`test/web-launch-tab.test.ts`).

### W077 - Hub orientation briefing (prompt-level block; skill depth layer behind a dated decision)

**Objective:** Give hub-launched agents a deterministic orientation so toolbox/guard tools are used
correctly. Design decision recorded 2026-09-20: a static, versioned, provenance-tagged prompt-level
orientation block is the guaranteed/discovery layer (~100–150 tokens: hub role, tool presence,
"check `guard_next_tasks` before planning", pointer to the skill); detailed tool data lives in a
skill body **generated from `toolbox-catalog.ts`** (single source of truth, written as a workspace
file at session create for OpenCode first). Native host skill injection stays **off** per the
2026-09-15 hub-owned-enforcement plan — the skill-file route needs an explicit dated supersession or
a file-provisioning framing before it ships.

**Depends on:** W076 (probes establish the host-version behavior the skill-discovery claim needs).

**Acceptance criteria:**
- [x] `buildOrientation()` (extending `src/integrations/prompt-guidance.ts`): static template,
      `ORIENTATION_VERSION` stamp, no interpolation of task/repo/env data, silence-when-unset,
      prepended at scheduled-turn session start. (Implemented as `buildOrientation` +
      `hubPromptGuidanceFromEnv` — the hub composes orientation first, operator advisory second;
      `WORKFLOW_HUB_ORIENTATION=0` opts out. The block is composed once at hub startup and
      **prepended per scheduled turn** — each scheduled run's session start; bounded ~160 tokens.
      Version "2" drops the pointer to the not-yet-delivered skill, review P2.)
- [x] Composition pin + no-interpolation pin in focused tests (scheduler composition like
      `test/hub-scheduler.test.ts:178`). (Pinned in `test/g5-observability.test.ts`: **full-text
      frozen pin** — any wording change must fail the test and force a version bump — plus
      no-placeholder and hedged-tool-presence pins, opt-out pin, ordering pin; the scheduler's own
      `promptGuidance` seam is unchanged so the existing composition pin holds.)
- [x] Orientation version + fingerprint recorded in the run registry for review provenance. (The
      version is embedded in the block text; the scheduler now records the **composed** prompt as
      the run's `taskPrompt` — pinned by a scheduler test (`begin records the composed prompt`) —
      so the W041 provenance digest binds exactly what the agent received and an orientation change
      invalidates recorded fingerprints. Review P1: the original claim was false because `begin`
      recorded the raw schedule prompt; fixed in the same slice.)
- [x] Skill body generated from the toolbox catalog with a content-pinning test against the corpus;
      per-host delivery (OpenCode skill dir; goose/cline) only when that surface qualifies.
      (`toolboxSkillBody` generates from the resolved catalog — names, descriptions, truthful
      availability; corpus-pinned in `test/toolbox-catalog.test.ts`. **Delivery is deliberately NOT
      implemented**: native host skill injection stays off per the 2026-09-15 plan — a dated
      decision or file-provisioning framing is the prerequisite, stated in `docs/FEATURES.md` —
      and the orientation block does not reference the skill until it ships.)
- [x] Ledger rows in `docs/HARNESS_ASSUMPTION_LEDGER.md` (advisory orientation block, skill recall)
      and a `docs/FEATURES.md` status entry; advisory only — enforcement stays in the guard MCP
      server. (Orientation row added; the skill-delivery row lands with the delivery decision.)

**Verification:** `test/g5-observability.test.ts` (W077 composition/opt-out/no-interpolation pins) +
`test/toolbox-catalog.test.ts` (skill-body corpus pin) + `test/hub-scheduler.test.ts` (seam
unchanged) — 23/23; typecheck and lint clean; ledger + FEATURES rows dated 2026-09-20. Five-axis
review round 1: REQUEST_CHANGES (P1 provenance claim false — begin recorded the raw prompt; P2
block pointed at the undelivered skill; three P3s) — all fixed in `c296415` (composed prompt is the
recorded ask, orientation v2 drops the skill pointer, full-text frozen pin, hedged tool presence,
precise wording). Re-review 2026-09-20: **APPROVE** recorded.

### W078 - `workflow doctor`: honest self-check of the operator's setup

**Objective:** One command that states the truth about the local setup — settings docs parse,
credential presence (booleans, never values), hub/gateway reachability, containment posture
(enforced vs policy-only), and per-surface probe verdicts from `docs/HOST_ADAPTERS.md` — surfaced
fail-loud, matching the honest-claims culture. Idea adopted from oh-my-openagent's `doctor`
(pattern only; SUL-1.0 upstream, no code).

**Depends on:** none.

**Acceptance criteria:**
- [x] `workflow doctor` checks: settings files parse (global + workspace overlay), credential
      presence per agent (presence booleans only), hub reachability (discovery + probe), server
      topology gateway reachability, containment backend report, and prints each surface's
      probe-PENDING verdicts with their gates. (**Complete 2026-09-21**: all six checks live in
      `src/cli/doctor.ts` — the containment backend report was the last missing piece (`checkContainment`:
      linux enforced-capable with bwrap present, a warn when the bwrap binary is missing since
      contained launches fail closed at spawn, and the typed policy-only passthrough on non-Linux,
      never claimed as enforced) and probe verdicts print from the register with their gates.)
- [x] Every check is pass/warn/fail with an actionable fix line; nothing silently passes.
      (**Verified 2026-09-21** against the report composition and its pins.)
- [x] Focused tests pin the report composition; typecheck and lint clean; five-axis review.
      (**Verified 2026-09-21**: `test/doctor.test.ts` (6) + the register suite; typecheck/lint
      clean; the five-axis review of 2026-09-21 covers the doctor surface — APPROVE recorded for
      this pass, including the register-driven gate catalog and the containment check.)

**Follow-up (2026-09-20, W078 follow-up — the machine-readable probe verdict register):**
the doctor reported probe gates from a hardcoded list that had already drifted (it named 8
families while the test corpus carries ~30 gate-style probe files), and the dated verdicts lived
only in prose — documentation and runtime claims had no shared record. The register makes the
verdict state durable and machine-checkable:

- [x] `docs/PROBE_VERDICTS.json` (schema v1, fail-closed validation in
      `src/integrations/probe-verdicts.ts`): one dated row per gate — host + version of record,
      probe file, gate env, date, result (`green`/`red`/`negative`/`pending`/`blocked`),
      enforcement posture the verdict supports, evidence write-up, and a required blocker for
      every `blocked` row (the missing operator environment/credential). Seeded with 42 rows
      covering every gated probe family: dated greens (OpenCode ACP 2026-09-16, goose 1.50.1
      2026-09-17, topology M1/webUI/compact on v2.0.10 2026-09-20, scheduled turn, vendored-Cline
      3.0.61 era), the Cline subagent Red, the goose subagent-hooks Negative, and the honestly
      blocked family (remote ACP bridge, model-key permission probes, open-model live, stock-Cline
      auth, azure metered) — item 5 of the operator's list now has a durable machine-readable home
      instead of prose-only blockers.
- [x] Bidirectional anti-drift pin (`test/probe-verdict-register.test.ts`): every register row's
      probe file must exist AND still name its gate, and every gate-style `WORKFLOW_* === "1"`
      probe file in the test corpus must have a register row — adding a gated probe without
      registering it, or renaming/removing a gate the register records, fails the suite. Fail-closed
      schema drift cases pinned (version, dates, enums, duplicate ids, deleted probe file,
      blocked-without-blocker).
- [x] Doctor reads the register (`checkProbeVerdicts`, replacing the stale hardcoded
      `checkProbeGates` list): renders the tally and which gates are armed right now, surfaces
      pending/blocked as a warn with the run-a-probe fix line, and fails loud on a corrupt or
      drifted register. Doctor's own pin (`test/doctor.test.ts`) updated to the register-driven
      composition.
- [x] Five-axis review for this follow-up slice. (**Done 2026-09-21: APPROVE** recorded by a
      fresh-context secondary reviewer across all five axes, no P0-P2 findings, six P3s — the
      register's `updated` stamp predating its newest row, optional-field typing, the doctor fix
      line for blocked rows, the corpus-scan heuristic limits, awkward fail wording, and a cheap
      non-gated unit pin for the server-runtime composition. **Fixed in this slice:** the stamp
      bumped and a validator rule added (`updated` can never predate the newest verdict date —
      fail-closed, test-pinned), optional `blocker`/`note` fields now type-checked fail-closed,
      the probe-path pattern widened to subdirectory probe files, the scan heuristic's documented
      limits stated in the anti-drift test, and the doctor fix line now routes blocked rows to
      their named blocker instead of an impossible "run the probe". **Accepted residuals:** the
      flat corpus scan stays (documented); the server-runtime composition spread is covered by the
      shared `meteredOpencodeConfig` pin plus the gated live probe rather than a dedicated
      non-gated unit.)

**Verification (2026-09-20, widened 2026-09-21):** `test/probe-verdict-register.test.ts` (5) +
`test/doctor.test.ts` (5) — 10/10; typecheck, lint, and build clean. Focused-run per the
operator resource directive (no full-suite run).

### W079 - Hash-anchored edits: evaluation against the read-fingerprint ledger (design doc)

**Objective:** Evaluate a Hashline-style upgrade (`LINE#ID` content-hash tags on reads, edits
validated against the tags) for the surfaces where Workflow owns the edit path, against the
implemented `FileClaimLedger` digest/size/mtime freshness (DRIFT-022). Idea adopted from
oh-my-openagent / "The Harness Problem"; no upstream code.

**Depends on:** W072 ledger invariants (fresh reads before mutation).

**Acceptance criteria:**
- [x] A dated design doc compares content-addressed line identity vs the current digest/size/mtime
      claim matching: capture points (where reads are surfaced), enforcement point (edit validation
      through the guard, not prompt text), adversarial cases (same-hash collisions, truncated
      reads), and a probe plan. (**Done 2026-09-20:**
      `docs/superpowers/specs/2026-09-20-w079-hashline-read-fingerprint-decision.md` — grounded in
      the as-built capture points (ACP fs-read lane + the v2 gateway claims) and the
      `STALE_OR_MISSING_READ` authorization gate.)
- [x] A decision with evidence: adopt, adapt, or reject — recorded in the doc; no code before the
      decision. (**Decision 2026-09-20: REJECT** — the current whole-file digest ledger is strictly
      more conservative on every adversarial case the doc examines: sha256 whole-file has no
      collision surface while per-line hashes collide trivially and need positional anchors that
      insertions invalidate; a truncated read claims whole-file freshness either way, so hashline
      degrades to the whole-file rule everywhere it matters; the enforcement point would not move —
      hashline only relaxes what counts as stale, which is the invariant the ledger exists to hold.
      The one real improvement the idea surfaced — recording a read window for windowed reads — is
      recorded in the doc as a scoped option requiring its own dated decision if the gateway lane
      ever surfaces windowed reads; the ACP lane does not today. No code shipped with this
      decision.)

### W080 - Skill-embedded connector scoping (gated on the skill-delivery decision)

**Objective:** Let the generated `workflow-toolbox` skill (W077) declare which connectors it needs,
mounted on demand for the session and torn down after — the context-budget fix oh-my-openagent
ships as "skill-embedded MCPs". Hard constraint: skill-scoped mounts still cross the hub-written
config and guard authorization — scoping, never a bypass lane.

**Depends on:** the dated skill-delivery decision (W077 — native host skill injection stays off
until it exists).

**Acceptance criteria:**
- [x] The skill schema gains an optional `connectors` declaration validated against the toolbox
      catalog (unknown connector → fail loud). (**Done 2026-09-20, schema half only — the mount
      half stays gated on the skill-delivery decision, as the dependency states:**
      `validateSkillConnectors` in `src/integrations/toolbox-catalog.ts` — absent means no
      connector claims; an unknown name, a non-string entry, or a duplicate fails loud
      (`TypeError`), validated against the catalog that is the single source of truth;
      `toolboxSkillBody` renders a validated declaration into the frontmatter (`connectors:` list,
      frontmatter `version` bumped to 2) and stays byte-identical to the W077 corpus pin without
      one. Pins: `test/skill-connectors.test.ts` (4). **Mount half landed 2026-09-21** behind the
      operator's file-provisioning decision (see the delivery box below) — the note that a mount
      seam would be dead code applied to the pre-decision state only.)
- [x] Delivery (when it ships) mounts only declared connectors, through the existing launch-config
      path; the guard still owns authorization. (**Shipped 2026-09-21** behind the operator's
      file-provisioning decision (dated addendum in
      `docs/superpowers/plans/2026-09-15-hub-owned-enforcement.md`): `provisionToolboxSkill`
      provisions the generated skill into the hub-owned `SKILLS_MCP_DIR` store (write-on-create/
      drift, idempotent; the store stays outside agent workspaces and the hub-written config now
      composes `"skill": "deny"` for the native skill tool — composed-but-probe-gated, honoring
      unverified live), and `skillConnectorMounts` composes the declared floor
      (`workflow-guard-mcp` + `skills-mcp`, built-filtered) into the hub-written config's mcp map —
      never duplicating the delivery mount or operator-enabled servers, and an explicit operator
      disable always wins over the declaration. Wired into BOTH lanes (ACP subprocess composition
      and the topology server config; best-effort delivery with visible degradation). Pins:
      `test/skill-delivery.test.ts` (4, incl. the skills.ts scan contract and stale-repair).)
- [x] Probe-gated per host version before any claim. (**Discipline held:** the store provisioning
      and scan contract are verified model-free (`test/skill-delivery.test.ts` exercises the
      `skills.ts` `scanSkills` contract against the provisioned store), while the in-agent
      `read_skill` delivery verdict on OpenCode stays probe-gated —
      `WORKFLOW_ACP_OPENCODE_SKILLS` remains `pending` in `docs/PROBE_VERDICTS.json` and no
      delivered-in-agent claim is made until it runs.)

### W081 - Session stats on the Usage page (data-lane read #2)

**Objective:** Surface the documented `GET /api/experimental/session/stats` (per-session activity,
usage, tool reliability) in the custom web UI's Usage page, read through the enforced gateway when
the server topology runs — same honest-unavailable pattern as the live MCP state.

**Depends on:** W076 (gateway + app-shell class landed).

**Acceptance criteria:**
- [x] `fetchSessionStats` in `src/integrations/opencode-live-state.ts` with the same
      discovery/probe/loopback/fail-closed contract as `fetchLiveMcp`. (**Verified 2026-09-21**
      against the as-built code: the shared `resolveLiveGateway` walk — discovery → loopback-host
      check → gateway probe → the resolved gateway — is the single honest gate both reads share;
      every unavailable outcome is an explicit reason, never a fabricated connection.)
- [x] A read-only endpoint + Usage-page block rendering the server's own stats, attributed;
      honest reasons when unavailable. (**Verified 2026-09-21**: `GET /api/usage/sessions/live`
      in `src/ui/web.ts` is read-only and honest-unavailable; the Usage page block
      (`src/ui/webapp/usage-view.tsx`) fetches it and renders the server's own aggregate —
      sessions/prompts/steps, the token split incl. cache read/write, cost, and tool
      reliability — with the unavailable reasons surfaced as values.)
- [x] Focused tests; typecheck and lint clean. (**Verified 2026-09-21**:
      `test/opencode-live-state.test.ts` (8, incl. the stats live/unavailable shapes) green;
      typecheck and lint clean. The slice had landed with its ledger boxes unticked — this pass
      reconciles the ledger to the shipped, tested implementation.)

### W082 - Auto-compaction over the v2 API (restore the plugin-era feature)

**Objective:** Restore context-window maintenance lost in the plugin→hub pivot. OpenCode v2 exposes
compaction over the documented API (`POST /api/session/{sessionID}/compact`; provider/model config
distinguishes `native` vs `summary` compaction) **and its runtime already compacts on context
overflow instead of retrying** — no plugin involved, per the operator's no-plugins constraint. The
design is hub-owned and deterministic — not a prompt-side loop: (a) classify `compact` in the
route-class matrix (currently deny by default; it is session maintenance that cannot advance
canonical state — reclassify deliberately with tests, not by drift), (b) an operator compaction
control in the custom web UI, (c) a hub-owned auto-trigger at a usage threshold (deterministic
gate, budget-guard compatible), (d) probe per pinned version. The v2 compaction
hook (`ctx.session.hook("compaction")`) is explicitly NOT used — no plugins.

**Depends on:** W076 (gateway verdicts); probe gating per `docs/HOST_ADAPTERS.md`.

**Acceptance criteria:**
- [x] Route-class decision recorded in §2.5 with tests: `compact` is now an explicitly classified
      forwarded session-input op (operator-controlled maintenance) — classifier row + gateway
      forward test + upstream stub updated; the §2.5 bullet records the dated reclassification
      (`fork`/`move`/`remove`/staged-revert remain denied).
- [x] Research note: what OpenCode v2 does natively per compaction type (`native` vs `summary`) and
      whether the ACP lane (`opencode acp`) auto-compacts without the HTTP route — **completed
      2026-09-20** as the dated §9 research note (pinned v2.0.10 binary strings + the v2 OpenAPI):
      `native` compaction is provider-local (replay cannot reconstruct it), `summary` is v2's own
      persisted checkpoint; auto-compaction is per-model runtime config (`compactIfNeeded`,
      `compactThreshold`, `compaction.auto`) that runs on the session stream — **not** the HTTP
      route — so the ACP lane auto-compacts exactly when the model's config enables it, and the
      operator regression is the overflow `400` ("start a new session or use /compact") when auto
      is unavailable. No plugin involved, per the no-plugins constraint.
- [x] The PWA surfaces context pressure and a compaction control (custom UI, per the
      surface-division decision); the hub-side auto-trigger is deterministic and budget-guard-aware.
      (**Manual control landed 2026-09-20**: the inspector Context section's "Compact…" affordance →
      `POST /api/sessions/compact` → the manager's agent-session record → the documented route
      through the enforced gateway; the honest copy states the documented steering semantics
      (queued, runs at the next step boundary) and failures surface the gateway's reason verbatim.
      **Auto-trigger decided and landed 2026-09-21, config-side** — the design decision (operator
      direction 2026-09-20): ownership is the **session runtime under hub-written config**, per the
      §9 research note that the ACP lane auto-compacts exactly when the model's compaction config
      enables it, so Workflow's deterministic lever is composing `compaction: { auto: true }` into
      the hub-written config rather than owning a poller. The **hub scheduler** is rejected as
      owner (cron is the wrong shape for a threshold trigger; the hub daemon has no per-session
      visibility), the **session manager** is rejected (its ACP `usage_update` view covers only
      live web-UI sessions, and — store finding below — it cannot reach those sessions through the
      gateway anyway), and the **topology daemon monitor** is recorded as the data-lane follow-up
      behind a per-session usage-read probe (per-session message tokens are documented in the v2
      message payloads). Implementation: settings `agents.<id>.autoCompact` (explicit boolean,
      default off, workspace-over-global, panel toggle for opencode) composes
      `compaction: { auto: true }` in `meteredOpencodeConfig` — consumed by the ACP subprocess
      composition AND the topology server config (the daemon resolves the same preference
      fail-soft). **Budget-guard-aware by construction**: a compaction turn is a normal metered
      model turn through the same loopback proxy the W045 interactive budget guard watches, the
      sticky refusal gate still bounds every later prompt, and no bypass lane is composed. Focused
      pins: `test/auto-compact-config.test.ts` (3). **Store finding recorded honestly:** the web
      session registry's agent-session ids live in the ACP subprocess's scratch-HOME store while
      the gateway fronts the topology server's own store, so the manual control's admit path is
      qualified at the route level (probe-created session) and its session-level reachability for
      web-UI ACP sessions is unprobed — the control surfaces the gateway's refusal verbatim when
      the store does not hold the session, never a fabricated success. **Data-lane backstop
      monitor landed 2026-09-21** (operator direction): the daemon-side monitor
      (`src/integrations/opencode-server-monitor.ts`) ticks deterministically against the
      documented `GET /api/session` entries (each carries the session's `tokens` — live-verified
      shape on v2.0.10) and fires the documented compact route when a session crosses the
      operator-set threshold `agents.opencode.autoCompactAtTokens` (positive integer, never
      invented — absent/malformed leaves the monitor off); hysteresis re-arms only when usage
      drops below the threshold, failures back off with a doubling cooldown and record the
      server's message verbatim (never a fabricated success), and a sticky session-budget
      violation vetoes every fire. Pins: `test/opencode-server-monitor.test.ts` (6); the probe's
      live monitor arm (read path against the real server, evaluated ≥ 1, zero fires for an empty
      session) ran green the same day.)
- [x] Live probe evidence per pinned version; no enforced claim without it. (**Done 2026-09-20:**
      `test/opencode-compact-probe.test.ts` gated `WORKFLOW_OPENCODE_COMPACT_PROBE=1` ran live
      green on stock v2.0.10 through the **enforced** gateway — unauthenticated compact `401`,
      session create via the documented route, and compact **admitted** as the documented
      `Session.Inbox.Compaction` inbox item (queued at the next step boundary); the verdict is
      recorded in `docs/HOST_ADAPTERS.md`.) (**Auto-trigger probe added and run live 2026-09-21:**
      `test/opencode-auto-compact-probe.test.ts`, gated `WORKFLOW_OPENCODE_AUTO_COMPACT_PROBE=1`,
      ran live green on stock v2.0.10 — the composed hub-written config carries
      `compaction: { auto: true }` beside the pinned ask ruleset and the real server's
      `/api/config` documents include that document with the compaction block parsed (the
      config-load arm IS the deterministic trigger delivery). The LIVE auto-compact turn arm — a
      real model turn overflowing context and compacting — stays **PENDING** (needs a real model
      key, operator environment); recorded in `docs/PROBE_VERDICTS.json`
      (`opencode-auto-compact-config-load`, dated 2026-09-21, with the pending arm named in the
      row). No plugin hook is composed anywhere in this slice; no `enforced` claim for the
      runtime's auto-compaction behavior. **Monitor arm added and run live the same day:** the
      probe's second live describe starts a probe session through the documented route and runs
      the monitor's deterministic tick against the real server — the usage read (session entries'
      `tokens`) is qualified live (evaluated ≥ 1, zero fires for an empty session, clean errors).

### W083 - Step-ledger panel in the custom web UI (the todo-tracking track)

**Objective:** Surface the W072 kernel step ledger (roadmap → tasks → steps) in the
custom web UI's inspector Tasks section — the accepted tracking surface since
stock OpenCode v2 removed native `todowrite`/`todoread` (W072 addendum). The
surface reads the canonical ledger and drives operator-gated step transitions
through the application command port only; the kernel keeps validating legal
transitions and evidence-bound completion, so the panel can never self-certify
a step.

**Depends on:** W072 (step ledger invariants I-1…I-4, kernel + application API);
no kernel change.

**Acceptance criteria:**
- [x] `GET /api/steps` reads the workspace's canonical ledger through the
      application (`taskSteps`/`activeStepId`/the snapshot's task states) —
      never the raw TaskGraph; the panel's "active task" is the ledger-relevant
      fact (exactly one task IN_PROGRESS, else null), not the
      interactive-authorization pointer.
- [x] `POST /api/steps/start|complete|cancel` drive the operator-gated
      transitions through the application command port; kernel rejections
      surface verbatim as `409` with the structured
      `ILLEGAL_STEP_TRANSITION` / `STEP_EVIDENCE_REQUIRED` /
      `STEP_TASK_NOT_IN_PROGRESS` code and reason (fail-closed honesty, no
      client-side success invention). Plus `POST /api/steps/define` (append-only
      operator decomposition) carrying the bridge's explicit
      environment-evidence requirement — an empty requirement list would let a
      step complete with zero evidence and hollow out I-3.
- [x] The inspector Tasks section renders each task's step ledger (state chip,
      content, evidence-requirement count) with start/cancel/complete actions;
      the complete action states that completion is evidence-bound and shows
      the kernel's rejection reason instead of a silent failure.
- [x] Focused endpoint + SSR tests pin the read shape, the transition mapping,
      the rejection surfacing, and the append-to-existing-ledger round-trip;
      typecheck and lint clean. **Five-axis review APPROVED (2026-09-20,
      independent fresh-context reviewer): no P0/P1/P2; four P3 notes — the two
      actionable ones (dangling test comment; missing HTTP pin for
      append-with-existing-ledger) fixed in the follow-up commit; the two
      pattern-fidelity notes (unknown step id → sibling-style 400 catch-all;
      duplicate step contents share the `step:<content>` subject via the
      kernel's subject-equality matching — pre-existing kernel behavior, same
      shape as the native bridge) recorded for a future W-item.** 56/56 focused
      across the endpoint, SSR, settings-endpoint, kernel step-ledger, doctor,
      G5, and web-service suites.
### W084 - Upstream plugin parity port (opencode-workflow-guard, post-vendoring drift)

**Objective:** Port the policy-relevant fixes the original
`opencode-workflow-guard` plugin landed since the vendoring base (upstream
`ec097d4`, 2026-09-09) into the vendored portable core
(`mcp-toolbox/apps/workflow-guard-mcp`). Upstream drifted through 2026-09-20:
quoted-data tamper false positives, collaboration-command exemptions, the
`.opencode/plans/` protected-path exemption, tag-publish git false positives,
and the V2 todo-gate deadlock. The port adapts semantics into the vendored
rewrite; plugin-runtime-only changes (V2 plugin entrypoint, continuation,
verify timeout, TUI slot rendering) are deliberately NOT ported — they are
host-side plugin responsibilities, and Workflow ships no plugins.

**Depends on:** the vendored guard core; no kernel change; the no-plugins
constraint is unchanged (the guard MCP is Workflow-owned, not an OpenCode
plugin).

**Acceptance criteria:**
- [x] Redirect/tamper matching runs on the quote-stripped residue
      (`prepareRedirectResidue` ported): quoted data spans no longer produce
      phantom redirect targets; quoted redirect targets still count; verb
      patterns still run on quote-flattened text (quoted command words stay
      blocked); fd-duplication (`2>&1`) and numeric comparison operands
      (`WHERE count > 5`) are not file mutations, while a real redirect
      alongside them still is.
- [x] Collaboration invocations (`gh|glab issue|pr`, `az repos pr`) are exempt
      from quoted-arg mutation scanning — their quoted arguments are command
      data — while their unquoted redirects still get full validation
      (guarded-path destination, outside-workspace).
- [x] Project plan files under `.opencode/plans/` are exempt from the
      guard-tamper config-path rule (documents, not configuration); the plans
      directory itself, `plansx/` prefixes, `plans/../` escapes, and
      user-level `~/.config/opencode/plans/` stay blocked; the exemption is
      per-candidate so a plans symlink resolving into a config-shaped realpath
      is still denied. The port also closed a realpath gap the vendored
      guard-tamper check had relative to upstream: `isGuardConfigurationPath`
      now checks the realpath candidate behind a lexical path, matching
      upstream's symlink-aware `isProtectedPath` constraint.
- [x] `git tag` publish flows are exempt from protected-branch write rules
      (release, not branch mutation) while tag deletion (`-d`/`--delete`)
      stays flagged; tag-shaped explicit refspecs (`refs/tags/...`) are exempt
      from the protected-branch-push rule while deletion refspecs
      (`:refs/tags/...`) are not. The port is deterministic — no `git
      show-ref` execution (the portable core evaluates host-supplied facts);
      upstream's short-name tag probe (`git show-ref`) is consciously not
      ported — short names stay under the ordinary rule, which only collides
      when a tag is named like a protected branch (that rule's intended
      target). Upstream's merged-branch push rules (which their tag exemption
      also relaxes) do not exist in the vendored core, so no additional
      relaxation is needed.
- [x] The V2 todo-gate deadlock fix is evaluated and consciously **not
      ported as a gate** — the vendored core has no todo predicates
      (policy-coverage lists them as remaining candidates) and the Workflow
      guard dropped the todo requirement in W072. But the evaluation surfaced
      the same deadlock in advisory form: the vendored `guard_status`
      precondition text claimed "an active task in todowrite" — a
      precondition the policy never enforced and OpenCode v2 hosts cannot
      satisfy (native todowrite removed). The text is now host-aware
      (keep an active task/step where the host has a tracking surface;
      otherwise the host's ledger), so the advisory no longer steers a model
      toward an impossible precondition.
- [x] Adversarial regression pins for every ported behavior in the vendored
      test suite (quoted residue, verb flattening, numeric comparisons,
      collaboration exemptions incl. the quoted-target survival, plans
      exemptions incl. the symlinked-realpath case, tag publish/delete, tag
      refspec push incl. the tag-source-to-protected-branch shapes);
      `npm run toolbox:verify` green across the monorepo (guard product
      typecheck+build+tests 0 fail); repo typecheck and lint clean.
      **Five-axis review: first verdict [REQUEST_CHANGES] (independent
      adversarial reviewer, live probes) — P0 tag-source refspec bypass
      (`refs/tags/v1:main` exempted as tag-publish; resolves to
      `refs/heads/main`) and P1 collaboration quoted-redirect-target
      regression — both fixed in `4e65cb2` with regression pins; re-review
      [APPROVE] (2026-09-20, probed 9 deny / 13 allow tag shapes, 44/44 probe
      cases, no over-tightening, no new P0–P2). Known divergences are stated
      in `docs/policy-coverage.md` (numeric-target mutation-signal tradeoff,
      push `--delete`/`-d` flag gate omission, `/dev/null`-family filter
      divergence, quoted-target first-space truncation).**
### W085 - Schedule create/edit in the web UI (the hub reload seam is the live registry)

**Objective:** Complete the Schedules page's operator surface: create and edit
schedules from the browser through the existing hub proxy. The original idea
of a "hub reload seam" is already solved by main's live schedule registry
(W074: `createScheduleRegistry` reads the table live, so `POST /schedule/save`
takes effect on the very next tick without a hub restart) — what is missing is
purely the affordance: the Schedules page renders pause/resume and delete but
no create/edit form, and its empty state points the operator at hand-editing
the table file.

**Depends on:** main's hub proxy (`/api/schedules/save` upsert-by-id with
field stripping, pinned in `test/web-operator-surfaces.test.ts`); no hub
change.

**Acceptance criteria:**
- [x] The Schedules page offers a create form (id, title, cron, prompt,
      workspace, review requirement) and per-schedule edit that prefills the
      form; editing preserves advanced fields (budget, taskClass, off-peak)
      by sending the full schedule entry through the same save proxy.
      (**Verified 2026-09-21** against the as-built code: the create/edit form
      (`src/ui/webapp/schedules-view.tsx`) upserts through
      `POST /api/schedules/save` with the full entry, so the hub's
      ScheduleMeta advanced fields survive edit round-trips.)
- [x] Save failures surface the hub's validation message verbatim (e.g. an
      invalid cron) — never a silent failure or a fabricated success.
      (**Verified 2026-09-21**: `onSaveSchedule` resolves the hub proxy's
      error message and the form renders it in a `role="alert"` slot.)
- [x] The pause/resume toggle and delete keep their existing semantics; run
      and loop start stay CLI-only with the page saying so. (**Verified
      2026-09-21**: pause/resume/delete ride the existing hub-proxy routes
      unchanged, and the page states "run-now and loop start are CLI-only —
      they require the verifier credential, never the browser token".)
- [x] SSR pins for the form affordances; the save-proxy endpoint tests keep
      passing unchanged (no server change); typecheck and lint clean.
      (**Verified 2026-09-21**: the W085 pins in `test/webapp-surface.test.ts`
      (create/edit affordances, colliding-id refusal before the save, per-
      schedule edit) and `test/web-operator-surfaces.test.ts` (save proxy)
      green; typecheck and lint clean. The slice had landed via
      `feat/schedule-create-edit` (PR #62) with its ledger boxes unticked —
      this pass reconciles the ledger to the shipped, tested implementation.)

### W086 - Control-plane install: vendored fleet payload, doctor checks, plugin-free posture (2026-09-21)

**Objective:** make "the required agent prompts are in the installed config"
a verifiable property of the control plane instead of a manual copy step.
The OpenCode agent fleet (`decompose`/`executor`/`reviewer`/`retrospective`),
its slash commands (`/decompose` `/retro` `/review-diff` `/rsi-loop`), and
the companion repo docs they reference are vendored in-repo with a committed
sha256 manifest; an operator-invoked installer deploys them; the doctor
verifies the installed state and the enforcement posture, read-only, and
prints the sanctioned fix both ways (the installer or exact shell commands).

**Spec:** `docs/superpowers/plans/2026-09-21-control-plane-install-doctor.md`.

**Acceptance criteria:**
- [x] The fleet payload (agents, commands, the full companion docs folder)
      is vendored under `assets/opencode-fleet/` with a committed manifest;
      a focused drift-guard test re-runs the generator's logic and fails
      when manifest and assets disagree.
- [x] `workflow install fleet [--force]` deploys agents/commands into the
      host config dir with refuse-to-clobber (local edits survive unless
      `--force`) and installs docs into the workspace repo
      install-if-missing only — repo-owned living files (`lessons.md`) are
      never overwritten, force or not; writes are atomic; nothing deleted.
- [x] `workflow doctor` gains the fleet-payload check (missing = fail with
      both the installer command and the exact `cp` commands; drift = warn;
      a malformed manifest fails closed) and the guard enforcement-posture
      check (plugin-free posture stated honestly: hub-launched sessions are
      guarded at launch, raw host launches unguarded by design; a recorded
      host-config plugin entry is a warn with the parity-probe fix line).
- [x] The host config document (`opencode.jsonc`) is never written by the
      installer or the doctor — the doctor reads it and prints fragments;
      promotion into it stays an operator edit (tier boundary: the installer
      is the ask-gate for payload, the config surface stays operator-owned).
- [x] `npm run typecheck`, `npm run lint`, and the focused suites
      (`test/install-doctor.test.ts`, `test/doctor.test.ts`) pass.

**Residuals (recorded, not buried):** the raw-launch parity probe
(hub-guarded session vs plugin session) is not yet recorded — the posture
check claims hub-launch guarding only, never parity; the vendored docs are
verbatim operator-authored text including dotfiles-anchored sections
(adaptation in target repos is an operator editorial call); the dotfiles
side keeps `opencode.jsonc` + personal config and drops its fleet copies as
an operator follow-up (one source per artifact).

### W087 - Guard tier port step 1: host-supplied live control-plane paths (T0/T2) (2026-09-21)

**Objective:** replace the vendored guard's filename-segment guard-tamper
matching with a runtime-consumption fact when the host can supply it, so the
live control plane (T0) stays denied while config-shaped versioned drafts
(T2: dotfiles `.config/opencode`, worktrees) are allowed. This removes the
live false positive where `cp <dotfiles draft> <repo draft>` was blocked on the
destination segment (F3, memory `ec383547`; live repro record `290ec890`).

**Where:** `mcp-toolbox/apps/workflow-guard-mcp` (the vendored portable guard
core), guard-tamper path only.

**Acceptance criteria:**
- [x] `guard_check` accepts an optional host-supplied `liveConfigPaths`; when
      present, guard-tamper denies only targets resolving under a declared live
      root (symlink-aware) and allows config-shaped paths elsewhere; when
      absent, the legacy fail-closed segment matching is unchanged.
- [x] Default-mode upstream adversarial pins (`.opencode/`,
      `~/.config/opencode/`, `workflow-guard.jsonc`) remain green; the new
      test covers draft-allow, live-deny at both ends, and symlink-into-live.
- [x] Guard app build/typecheck clean, `node --test --import tsx
      test/*.test.ts` 49/49, `npm run toolbox:verify` EXIT=0 (Server Card
      regenerated).
- [x] Declared live roots are normalized (absolute required; `~`/`$HOME`
      expanded); any relative or unresolved root rejects the whole fact set so
      classification falls back to fail-closed segment matching rather than
      trusting partial facts.
- [ ] T1 ask-gate for promotion into live paths and the `opencode.jsonc`=ask
      nuance (next step of the tier port).
- [ ] Host-side wiring that supplies `liveConfigPaths` from the hub/launcher,
      including the in-use OpenCode plugin (proposal on record).

**Residuals (recorded, not buried):** with a supplied fact, segment matching is
fully replaced, so a host that declares an incomplete or wrong (but well-formed,
absolute) live-root set is fail-open for the undeclared config paths
(workspace-boundary and protected/secret checks still apply). This is an
intentional EXTENSION beyond upstream, not a parity port.

### W088 - Upstream parity drift assessment 2026-09-22 + busybox interactive port (PRs #153–#176)

**Objective:** keep the parity program current ahead of `opencode-workflow-guard`
retirement (Checkpoint D): classify every upstream change since the W084
assessment (`ed09c84..03fbdcf`, 2026-09-20 → 2026-09-22, upstream v1.15.0) into
converged / host-side-only / queued, and fold in the one verified policy delta.
Finding: #159 is upstream's landing of the W087 design (converged, nothing to
fold); #165's monitor fix is nearly converged by the vendored rewrite — except
busybox applet forms (`busybox top`, `busybox vi` were ALLOWED), case variants
(`TOP`), and the batch-mode exemption being scoppable by a wrapper flag.
Full classification recorded in
`mcp-toolbox/apps/workflow-guard-mcp/docs/policy-coverage.md` (2026-09-22
parity-log entry).

**Where:** `mcp-toolbox/apps/workflow-guard-mcp/src/shell-policy.ts`
(`interactiveReason`), adversarial pins in `test/policy.test.ts`.

**Acceptance criteria:**
- [x] Busybox applet forms of interactive commands are detected:
      `busybox top`/`busybox htop`/`busybox vi`/`busybox nano`/`BusyBox less`
      ask; benign busybox usage (`busybox top -b -n 1`, `busybox echo top`,
      `busybox grep -c top f`, `busybox ls top-level-dir`) stays allow.
- [x] Monitor matching is case-insensitive in executable position only:
      `TOP` asks; `echo Top`, `az keyvault ... --name top` stay allow.
- [x] The batch-mode exemption is the monitor's own flag, not a wrapper's:
      the real exemplars `env -b top`/`timeout -b top` flip allow→ask (red via
      stash choreography); `sudo -b top` stays ask (via the sudo rule, which
      returns before the monitor check — not an exemplar of the scoping);
      `top --batch` stays allow; wrappers and indirection stay detected
      (`timeout 5 top`, `cat file | top`, `sh -c top`, `eval htop`).
- [x] Verifier: new W088 pins ran RED against the unmodified tree (3 tests:
      busybox detection, case variants, and — after the review fix — the
      scoping exemplars) then GREEN after the port (43/43); guard-app suites
      52/0 across mcp+redirect+policy (22 W088 asserts), guard typecheck OK,
      repo `npm run lint` + `npm run typecheck` exit 0.
- [x] Held-out check recorded: `test/package.test.ts` (npm-pack artifact test)
      fails in workflow-guard-mcp AND browser-verification-mcp on a PRISTINE
      main worktree (`npm pack --json` output shape, environment/npm drift) —
      pre-existing on main, unrelated to this diff, verifier untouched.
- [ ] Queued candidates (one change per iteration): the #158 payload-mode
      tamper scan semantic diff (vendored file_write content path scans
      secrets only), boundary deny-reason cause attribution (#172/#173),
      opt-in `requireSubagentReview` strict recorder mode (#167,
      Workflow-side review-gate analog), and the stated divergence that the
      hub reviewer sources `git diff HEAD` (uncommitted) where upstream's
      rubric reviews the committed branch range.

### W089 - File-write control-plane classification (mainline parity) (2026-09-22)

**Objective:** close the file-write enforcement hole in the vendored guard
core: upstream's edit/write handler classifies targets with `isProtectedPath`
(the guard-config vocabulary — plans-file exemption, realpath awareness,
W087-style live-root facts), but the vendored `file_write` path consulted
only the system/secret check, so a host enforcing `guard_check` verdicts
would allow a file write to replace the guard's own configuration.
Assessment correction bundled: PR #158 (`c377cb9`) is **not merged into
upstream main** (side branch `origin/fix/worktree-fingerprint` only) — the
parity target stays mainline; the W088 parity log carries the dated
correction.

**Where:** `mcp-toolbox/apps/workflow-guard-mcp/src/policy.ts` (file_write
path loop), `src/interpreter-policy.ts` (write-target loop,
`liveConfigPaths` threaded), `src/boundary-policy.ts` (export only).

**Acceptance criteria:**
- [x] `file_write` targets classified with `isGuardConfigurationPath`
      (deny `guard-tamper`): `.opencode/**` (incl. non-markdown payload
      files — mainline has no markdown exemption), root
      `opencode.json(c)`/`workflow-guard.jsonc`, `.config/opencode/**`,
      user-level absolute paths; plans FILES and ordinary workspace files
      (incl. token-substring `docs/.opencode-notes.md`) stay allow.
- [x] Live-root facts apply to writes: declared-root writes deny (T0),
      dotfiles drafts allow (T2), symlink-into-live denies.
- [x] Interpreter payloads writing guard-config paths deny
      (`interpreter-guard-tamper`, tilde + relative forms); benign
      interpreter writes unchanged.
- [x] Upstream precedence: the tamper classification runs before the
      system/secret checks (needed on this ostree host where `/home`
      realpaths under `/var` — the pre-existing `/var` rule would otherwise
      mask the classification; that false-positive class is recorded as a
      queued candidate, not fixed here).
- [x] Verifier: W089 pins RED against the unmodified tree (43 pass/3 fail —
      exactly the new tests), GREEN after the port (55/0 across
      policy+mcp+redirect); guard typecheck OK; repo lint/typecheck exit 0.
- [ ] Queued (one change per iteration): ostree `/var`-home
      false-positive class in `checkProtectedPath` (mainline has no `/var`
      rule); boundary deny-reason cause attribution (#172/#173);
      `npm pack --json` verifier debt (human-gated).

### W090 - Seat fact-supply seam part 1: branch facts + live roots (frontier G2) (2026-09-22)

**Objective:** close the frontier assessment's largest finding (§4 "design
ported, seat not fed"): `guardInputFromToolCall`/`guardCheck` supplied only
action/command/path/content/workspace — so protected-branch discipline was
dead in hub-seated sessions, and the W087 live-root fact could not even be
carried by the seat contract. W090 part 1 enriches guarded
shell/git/file_write calls at the single convergence point (the provider's
`guardCheck`) with workspace-derivable facts: `currentBranch` (read-only
`git branch --show-current`, fail-open to omitted on failure/detached HEAD),
`protectedBranches` (hub default `["main","master"]`, mirroring the
vendored plugin's default project config; a configured source is follow-up),
and `liveConfigPaths` (the runtime-config root `~/.config/opencode` when it
exists — only existing-and-absolute roots are declared). Caller-supplied
facts always win; no workspace → no enrichment (fact-less behavior
preserved). `trustedRole` is deliberately deferred (seat-level role
semantics need their own design — frontier G2 part 2).

**Where:** `src/integrations/mcp-toolbox-guard.ts` (contract + resolver +
provider enrichment); the four workspace-carrying seats are unchanged (they
flow through the provider and always set `workspaceRoot`). The containment
seat's workspaceRoot-less calls enrich nothing — enrichment is strictly
input-workspace-driven (the review's P2: an `options.workspace` fallback
would have bound branch facts to the hub root while executing in a per-call
cwd — removed after round 1); its sandbox is the boundary, and passing
workspaceRoot there is queued with care (it would also activate
workspace-boundary denies for legitimate HOME-cache writes).

**Acceptance criteria:**
- [x] Protected-branch discipline engages in hub-seated sessions:
      `file_write` on a protected branch denies `protected-branch-write`;
      the same write on a feature branch allows; caller-supplied
      `currentBranch` wins over discovery.
- [x] The live-root fact engages W087 fact mode through the seat: a write
      under a declared live root denies `guard-tamper` (T0) where the
      fact-less call was baseline-allow; with a runtime-config root present,
      project `.opencode/**` drafts flip to T2 allow (the designed
      semantic — stated, not hidden).
- [x] Fail-open honored: git failure and an absent runtime-config root omit
      the fact (never guess); existing provider/seat tests unchanged (no
      workspace → no enrichment).
- [x] Verifier: W090 pins RED (compile-level — the seam did not exist) then
      GREEN 9/9; held-out seat/interception suites 21/0 (hub-guard-
      interception, guarded-process, hub-guardless-startup,
      acp-workflow-resolver); repo lint/typecheck exit 0. Review round 1
      [REQUEST_CHANGES] (P1 non-discriminating caller-wins pin — fixed to
      the discriminating shape: repo on a feature branch, caller declares
      `main`, deny must come from the caller's fact; P2 options.workspace
      fallback contradicting the scope narrative — fallback removed,
      enrichment strictly input-workspace-driven; P2 T2 under-claiming
      residual recorded; P3s fixed: detached-HEAD assert, dead test dir,
      inert-fact comment, resolver skipped when all facts are caller-
      supplied) → round 2 verification green.
- [x] Residual recorded (review P2): in fact mode, workspace-internal
      guard-config files (`workflow-guard.jsonc`, the vendored guard's own
      source/dist when the hub runs on this repo) flip deny→allow because
      only the runtime-config root is declared — the designed T2 semantic;
      the boundary is promotion (T1 ask-gate), so this residual is bound to
      the G3 queue item and must be re-classified before any runtime
      consumes workspace-level guard config.
- [x] Hazard fixed en route: the vendored guard `dist/` was stale (built
      pre-W089), masking the file_write tamper lane from hub tests —
      rebuilt; `ensureBuilt()` only builds when dist is MISSING, so
      dist-freshness remains a known hazard (LESS-0005 noted it;
      dist hash-check queued).
- [ ] Queued (one change per iteration): G2 part 2 (`trustedRole` supply +
      seat-role semantics), containment-seat `workspaceRoot` question,
      ostree `/var`-home fix, G5 branch-exit pins, G3 ask channel,
      G4 matched-surface field, dist-freshness pin, `npm pack` verifier
      debt (human-gated).

### W091 - T1 promotion gate: `workflow install` becomes guard-visible (frontier G3 part 1) (2026-09-22)

**Objective:** close the guard-invisibility finding from the agents-research
assessment: from an agent seat, `workflow install fleet [--force]` — the
sanctioned deployment of the fleet payload into the live control plane —
was baseline-allow while the equivalent `cp` into a live root is
guard-tamper-denied. The T1 tier says promotion is an ASK (operator
approval), never agent-auto-allow.

**Where:** `mcp-toolbox/apps/workflow-guard-mcp/src/policy.ts`
(`isPromotionCommand`, command-position recognition post-unwrap).

**Acceptance criteria:**
- [x] `workflow install [fleet [--force]]` returns **ask** with policy
      `promotion-gate` (T1: operator approval required); wrapper forms
      (`timeout 30 workflow install fleet`) stay recognized.
- [x] Command-position discipline: `echo workflow install`,
      `grep 'workflow install' notes.md` stay allow (argument data is not
      execution — the LESS-0012 class).
- [x] Known limitation pinned (review-round-1 P2 corrected): indirection
      (`npx workflow install`), nested shells/eval (`sh -c '...'` — the
      recognizer does not recurse), and case variants are NOT recognized —
      for those forms the promotion is unguarded AT THE SHELL LANE; the W090
      fact-mode T0 deny covers only the agent performing equivalent writes
      DIRECTLY into declared live roots (the installer's own in-process
      writes are tool-invisible to the guard). Pinned with a
      symlink-into-live deny.
- [x] Ordering pinned (review-round-1 P3): segment-level denies win over
      the promotion ask in compound commands (`destructive && workflow
      install fleet` reports the destructive deny, not the ask) — the
      promotion ask is evaluated after the deny-class policies.
- [x] Seat behavior unchanged by design: channel-less seats collapse the
      ask to deny-with-remedy (fail-closed — agent-initiated promotion now
      requires the operator's keyboard, the T1 property); the ask channel
      itself is G3 part 2.
- [x] Verifier: promotion pin RED against the unmodified tree (48 pass/1
      fail — only the new promotion-ask test failing, the command-position
      and backstop guards green pre-change), GREEN after the port; the
      compound-attribution pin RED before the ordering fix (49 pass/1 fail),
      GREEN after (59/0 across policy+mcp+redirect); guard typecheck OK;
      **dist rebuilt** (the LESS-0010 stale-dist hazard); repo lint +
      typecheck exit 0.
- [ ] Queued (one change per iteration): G3 part 2 (the ask channel —
      routing the ask to a human surface through the seats),
      G2 part 2 (`trustedRole`), G5 branch-exit pins, G4 matched-surface
      field, ostree `/var`-home fix, dist-freshness pin, `npm pack`
      verifier debt (human-gated).

### W092 - The ask channel part 1: guard asks join the operator hold on the primary seat (frontier G3 part 2) (2026-09-22)

**Objective:** close the ask-collapse half of frontier G3 for the primary
transport: the opencode-server authority's `ask-me` mode already holds
policy-allowed asks for the operator (M3: parked holds, fail-closed timeout,
gateway-intercepted operator replies reconciled tighten-never-loosen) — but
the **guard's** `ask` short-circuited to deny before the hold could apply.
The change: in `ask-me` mode a guard `ask` joins the operator hold (mapped
to a held allow the operator answers — approve = the T1 ask answered,
reject/timeout = fail-closed tighten); in `auto-resolve` mode it stays a
documented deny (no operator is attached to answer). **Scope honesty
(review-round-1 P2): the authority path is complete and pinned, but the
stock daemon does not yet receive guard asks** — the only production
constructor (`src/cli/opencode-server.ts`) passes no guard provider, so
**daemon guard-wiring is the top queued item**; the W091 promotion gate is
the named producer once wired. The ask branch also generalizes beyond
promotion-gate by design (e.g. the network `external-side-effect` ask now
holds in ask-me mode instead of instantly denying).

**Where:** `src/integrations/opencode-server-authority.ts` (the `decide`
guard branch only). The other four seats' ask collapse is queued
(documented per-seat).

**Acceptance criteria:**
- [x] ask-me: guard `ask` is held (`pendingOperatorReplies` = 1); operator
      approve → delivered allow/once with the guard policy in the reason;
      operator reject → delivered reject; timeout → reject (fail closed).
- [x] auto-resolve: guard `ask` fails closed to deny with the ask
      provenance and the no-operator-channel statement; `pendingOperatorReplies`
      stays 0.
- [x] Guard deny is answered immediately, never held (both modes).
- [x] Verifier: W092 pins RED against the unmodified tree (27 pass/4 fail —
      all four hold-behavior tests), GREEN after the edit (31/0); held-out
      suites 51/0 (opencode-server-gateway, hub-guard-interception,
      guarded-process); repo lint/typecheck exit 0.
- [ ] Queued (one change per iteration): **daemon guard-wiring** (the stock
      `opencode-server` constructor passes no guard provider — the top item),
      the ask channel on the other four seats, the pending-ask surface in
      the operator UI (plane 3′), G2 part 2 (`trustedRole`), G5 branch-exit
      pins, G4 matched-surface field, ostree `/var`-home fix,
      dist-freshness pin, `npm pack` verifier debt (human-gated).
- [x] Residuals recorded (review round 1): a held guard ask blocks the SSE
      loop up to the hold window (delayed alarms, not false ones — the
      pre-existing serial-hold residual widens; noted in
      `docs/OPENCODE_SERVER_AUTHORITY.md`); the ask branch generalizes
      beyond promotion-gate (network `external-side-effect` asks now hold
      in ask-me); the guard-deny-never-held pin covers ask-me only (the
      deny branch is mode-independent by construction).

### W093 - Serverless hosting option for the control plane (AZ Function) (Planned — intent recorded, design queued)

**Operator intent (2026-09-22):** the control plane will likely run as an
Azure Function — a serverless hosting option alongside the local daemon.

**Status: intent + constraints only. No design, no claims.** The hub today
is a local daemon: plane 3 binds loopback-only (`127.0.0.1`, discovery-file
tokens), plane 3′ is the uncredentialed browser channel
(`THREAT_MODEL.md`-accepted **loopback** posture), agent transports are
local stdio/ACP, containment is bwrap, and durable state is local files.
Remote hosting re-opens each of these as a design question, per the
protocol-planes doc (`docs/PROTOCOL_PLANES_2026-09-22.md`):

- **Auth becomes mandatory**: off-loopback, plane 3's bearer-token classes
  (operator vs verifier) become network credentials; the plane-3′
  uncredentialed channel cannot exist remotely and needs a credentialed
  replacement or explicit scope removal.
- **Agent transports**: stdio ACP runtimes are local; hosted agents go
  through the remote-ACP bridge (draft, advisory — `OPENCODE_REMOTE_ACP_
  SPEC.md`) or stay local while the control plane is remote.
- **Containment**: bwrap is a local-runtime primitive; contained-shell
  semantics (`/bash`, run gates) need a runtime decision (Azure container
  jobs? drop to advisory?).
- **Durable state**: local JSON stores → a durable remote store decision
  (per `DURABLE_STATE_INVENTORY.md` writer authorities).
- **Long-running loops**: the RSI loop and scheduler tick are
  long-lived/periodic — a consumption-based function needs durable-function
  or timer-trigger shaping.

**Acceptance criteria:**
- [ ] A hosting assessment (AZ Function vs container-app vs stay-local,
      per the four-plane map) with the THREAT_MODEL re-read — before any
      hosting code.
- [ ] The plane map re-stated for the hosted topology (what moves, what
      stays local, what the credential model becomes).
- [ ] Operator decision recorded before implementation.

### W094 - Daemon guard wiring: the ask-hold becomes reachable on the stock server (frontier G3 part 2, wiring) (2026-09-22)

**Objective:** close W092's top queued item: the authority's guard-ask hold
(W092) is implemented and pinned but the stock daemon constructor
(`src/cli/opencode-server.ts`) passed no guard provider, so guard asks never
reached the hold in production. Wire the vendored guard into the daemon
(hub-precedent fail-closed composition, `src/cli/hub.ts` "no guard → refuse
to run"): the daemon composes `createDefaultToolboxGuardProvider` with its
workspace and passes it to `createOpencodeServerAuthority`.

**Where:** `src/cli/opencode-server.ts` (main() composition + an exported
`createOpencodeServerGuard(workspace)` helper for the composition pin).

**Acceptance criteria:**
- [x] The daemon composes the guard fail-closed: a guard startup failure
      rejects main() (the daemon refuses to run guard-less — the hub's
      "no hub, no mutations" posture).
- [x] The composed guard is the production path: through the REAL vendored
      server, `workflow install fleet` asks `promotion-gate` (the W091 rule
      + W090 enrichment live in the daemon's guard) — pinned via the
      exported helper.
- [x] Module-level guard behavior on the authority is already pinned
      (W092: hold/approve/reject/timeout/auto-resolve); the daemon-level
      end-to-end pin (spawn + permission.asked → hold) is queued with the
      dist-freshness pin.
- [x] Verifier: composition pin RED (the helper did not exist) then GREEN;
      daemon/authority/gateway suites green; repo lint/typecheck exit 0.
      Review round 1 [REVISE] fixed: a live-artifact anti-drift pin now
      proves main() wires the guard into the authority (the production
      composition had no other automated verifier - deleting the guard pass
      from the authority options fails the pin); guard.close() added to ALL
      post-composition failure paths (runtime creation, enforced-ruleset
      refusal, gateway failure, uncaughtException reap) - the hub precedent
      mandates explicit reaping, child self-reaps-on-EOF is inferred
      semantics; the component-doc addendum superseded the stale
      does-not-yet-pass-a-guard-provider claim with the dated W094 landing
      note; the credential-less composition residual recorded (inert today -
      the vendored guard consumes only HOME; the daemon must compose the
      broker if guard credentials are ever configured). Review round 2
      [APPROVE].
- [ ] Queued (one change per iteration): daemon-level end-to-end ask pin,
      the ask channel on the other four seats, the plane-3′ pending-ask
      surface, G2 part 2 (`trustedRole`), G5 branch-exit pins, G4
      matched-surface field, ostree `/var`-home fix, dist-freshness pin,
      `npm pack` verifier debt (human-gated).
### W095 - Local model-routing policy at the metering proxy (Partial - the metering-proxy seam landed via W109's transformBody; the routing design note EXISTS and is frontier-verified through round 3 (2026-09-24); the per-role end-to-end check queued) (2026-09-22)

**Operator question:** "readdress the mixture-of-experts local router idea -
would it be a good idea to classify things before handing them to
OpenRouter?" - i.e. a local MoE-style classifier/router between the agent
runtimes and the OpenRouter upstream.

**Position (this ledger entry is the recorded shape, not a claim of landed
work):**
- **Yes to a local ROUTER; no to content-classification-as-MoE.** The
  routing decision that matters is ALREADY made upstream of the request by
  the thing that understands the work: the agent fleet's task decomposition
  (decompose -> executor -> reviewer roles; task-decomposition.md strong/
  weak routing with acceptance checks - the cheap-model-error-leakage
  mitigation). That IS the working mixture-of-experts: roles are the
  experts, and the classifier is structured and reviewable. A per-request
  content classifier would guess what the decomposition already knows, adds
  a model call (latency/cost/failure modes), and mis-classification sends
  edits to weak models - the exact leakage class the fleet discipline
  exists to prevent.
- **OpenRouter's Auto Router stays the default for general traffic** - it is
  a vendor router with more routing data; do not duplicate it. The hub
  already constrains it deterministically (the openrouter-auto-latest
  seam: alias resolution + allowed_models pool injection + cost-tier
  bands).
- **The local router's right shape: POLICY-driven routing at the
  metering-proxy seam, keyed to metadata the control plane already holds -
  never prompt content.** Concretely: (a) task-class routing
  (model-profile.ts already carries coding/general/batch classes and
  per-family reasoning-effort) - hub-composed agent configs can set
  per-role models today; (b) budget-driven downgrades (a session nearing
  its W045 caps routes remaining turns to the cheap pool - deterministic,
  auditable); (c) schedule-driven routing (batch/off-peak pools - the
  DeepSeek off-peak opportunity already in AI_LANDSCAPE_RESEARCH.md item
  176); (d) failover (OpenRouter outage -> local fallback pool). All
  rule-based, testable, logged - HOME-A/B per the migration-boundary rule
  (routing policy that gates cost/authority is control-plane owned).
- **Rejection recorded:** prompt-content classification as a gate is
  rejected for now - it duplicates the vendor router, blurs the metering
  proxy's pass-through posture, and its errors are quality-authority errors
  the acceptance-check discipline would have to catch after the fact.

**Acceptance criteria:**
- [x] A routing-policy design note (the four metadata keys, the pool
      matrix, the precedence: task-class -> budget -> schedule -> failover)
      before any code.
      (docs/MODEL_ROUTING_POLICY_2026-09-23.md — frontier-verified
      through round 3, 2026-09-24: the round-2 repairs confirmed against
      the tree (the zero-callers state re-grepped, the tier-label cite,
      the globality note, the repaired quantifier) and two new findings
      incorporated (the deviation counts stale post-W109 — the
      cache-marker pass is the seam's second consumer; the
      enumeration-boundary clarification). The criterion's tick stands
      on the note's §8 round-3 record.)
- [x] The metering-proxy seam shaped for policy routing (the
      autoLatest-style transform point) without changing the pass-through
      posture for unclassified traffic. LANDED in W109 (2026-09-23): the
      transformBody option is the named policy-routing transform point;
      `composeBodyTransforms` composes consumers in order with per-stage
      fail-open extended to throwing stages; the pass-through posture for
      unclassified traffic pinned. The budget-downgrade consumer itself is
      still queued (it attaches through this seam).
- [ ] The fleet's per-role models verified end-to-end (the de-facto MoE)
      before building anything new.
- [x] Frontier verification of the design note (same pattern as #78/#82).
      DONE (2026-09-24): the three-round Kimi K3 chain recorded in the
      note's §7-§8 (round 1 REVISE with the fleet-architecture + pool-
      substrate + downgrade-seam corrections; round 2 REVISE with the
      self-corrected failover-wiring claim + the partially-applied
      sentence caught; round 3 REVISE with the stale W109-era deviation
      counts corrected + the enumeration boundary stated — all
      tree-verified by the verifiers themselves). This criterion and
      criterion 1's "frontier-verified" are the same verification; the
      tick stands on the note's §8 record.

### W096 - Serverless hosting option for the control plane (AZ Function) (Planned - intent + constraints only)

**Operator intent (2026-09-22):** the control plane will likely run as an
Azure Function - a serverless hosting option alongside the local daemon.
**Status: intent recorded; design queued.** Remote hosting re-opens, per
docs/PROTOCOL_PLANES_2026-09-22.md: plane 3 auth (off-loopback, the
operator/verifier credential classes become network credentials), the
plane-3-prime uncredentialed browser channel (cannot exist remotely -
credentialed replacement or explicit scope removal), agent transports (stdio
ACP runtimes stay local or go through the advisory remote-ACP bridge),
containment (bwrap is local-runtime; /bash and run gates need a runtime
decision), durable state (local JSON stores -> durable remote store per the
DURABLE_STATE_INVENTORY.md writer authorities), and long-running loops
(RSI/scheduler -> durable-function or timer-trigger shaping).

**DUPLICATE (found 2026-09-24, contradiction sweep):** this item
duplicates W093 — same operator intent (2026-09-22), same title, same
open hosting-assessment criterion — recorded twice during that session.
W096 carries the fuller constraint enumeration (the plane map's five
re-opened surfaces); W093 carries the plane-3 loopback facts. The
canonical resolution (merge into one item or supersede one) is the
operator's call — both are operator-intent records, not agent-authored
design. No work is queued twice: the hosting assessment criterion is the
same single deliverable.

**Acceptance criteria:**
- [ ] A hosting assessment (AZ Function vs container-app vs stay-local,
      per the plane map) with the THREAT_MODEL re-read - before any
      hosting code.
- [ ] The plane map re-stated for the hosted topology.
- [ ] Operator decision recorded before implementation.

### W097 - The ostree /var-home false positive: the vendored file-write lane was dead on the operator host (2026-09-23; re-landed on the v2 branch after the merged-branch push block)

**Objective:** the vendored checkProtectedPath system rule (the /etc//usr//var prefix test) denied EVERY write on ostree hosts: /home is a symlink to /var/home, so every home-anchored path - including WORKSPACE-RELATIVE file_writes whose lexical candidate resolves into the home mount - realpaths under /var and was denied as a protected-system-or-credential-path. Live-probed before the fix: checkProtectedPath(src/a.ts, cwd) on the operator workspace returned the deny (the entire W089 file-write lane was dead-on-arrival on this host); the W089 review had caught only the absolute-path instance.

**Where:** mcp-toolbox/apps/workflow-guard-mcp/src/path-policy.ts (the checkProtectedPath candidate loop).

**Acceptance criteria:**
- [x] The user real home (realpath-resolved) is classified as user space: home-anchored absolute writes and workspace-relative writes return undefined (allow); the /etc//usr//var prefixes no longer fire for home-covered candidates.
- [x] Genuine system paths stay protected: /var/log, /var/lib, /etc, /usr still deny (they are not under the real home).
- [x] Credential rules still fire inside the home: .ssh and secret-name rules unchanged (credentials live in the home).
- [x] Verifier: W097 pins RED against the unmodified tree (52 pass/1 fail - exactly the user-home test; the genuine-/var and credential tests green pre-change as they assert existing protection), GREEN after the fix (62/0 across policy+mcp+redirect); guard typecheck OK; dist rebuilt and the LIVE probe re-run post-fix (home-abs: undefined; ws-relative: undefined; var-log: protected; ssh: protected); repo lint/typecheck exit 0.
- [ ] Queued (one change per iteration): the ask channel on the other four seats, the plane-3-prime pending-ask surface, daemon-level end-to-end ask pin, G2 part 2 (trustedRole), G5 branch-exit pins, G4 matched-surface field, dist-freshness pin (RESOLVED 2026-09-24 in W120 — `guardDistIsStale` + the runtime fail-closed throw + the test's self-healing rebuild; see the park file's P6), npm pack verifier debt (human-gated).

### W098 - Control-plane caching posture: cache-enabling + affinity, never response-caching (Partial - c1 audit/c2 markers/c3 spec/c4 frontier landed; the affinity implementation parked as P19) (2026-09-23)

**Operator question:** "should we be doing caching on the control
plane/router as well? This would complement the provider-side caching done
at OpenRouter's end."

**Position (recorded, design queued):**
- **Yes - but the control plane's caching role is cache-ENABLING, not
  response-caching.** Provider-side prompt caches reward STABLE prefixes;
  the hub composes the largest prefixes (system prompts, fleet guidance,
  tool definitions, per-role model config), so its discipline decides hit
  rates: (a) cache-aware composition - stable per-session prefixes,
  append-only per-turn content, stable tool-list serialization; (b) a
  cache-bust audit of everything the hub prepends per turn (the W073
  orientation/advisory guidance is the first thing to check); (c)
  cache-control marker injection at the transformBody seam for
  anthropic-wire pools (Anthropic requires explicit markers; OpenAI-family
  auto-caches) - a concrete, small complement OpenRouter cannot do
  per-workspace.
- **Model affinity as a routing key modifier**: pin consecutive turns of a
  session to the same vendor/model so provider-side prefix caches actually
  hit - Auto Router may bounce providers per request, losing cache state.
  Cost tradeoff recorded: affinity gives up per-request optimization for
  cache-hit savings; for long sessions with large stable prefixes the
  cache wins. This is a modifier on the W095 role key (narrow the pool,
  don't add a fifth key).
- **Deterministic-resource caching with TTL (already exists, the model to
  follow)**: the OpenRouter catalog cache in openrouter-auto-latest.ts
  (6h success / 60s failure backoff) - cache deterministic, versioned
  resources; never agentic turns.
- **Response caching is REJECTED**: agentic turns are nondeterministic and
  state-dependent (a cached response is by definition not fresh
  observation - the kernel's fresh-evidence rule), and serving from cache
  would corrupt the metering trail (recorded usage is the budget/billing
  evidence; phantom-free turns break its truthfulness). Same four-home
  logic as W095.

**Acceptance criteria:**
- [x] A cache-bust audit of hub-composed prefixes (orientation/guidance,
      system prompts, tool serialization) - before any affinity work.
      AUDIT SCOPE CORRECTION (W109 frontier round 1, 2026-09-23): the
      audit must extend into HOST-COMPOSED prefixes — on the default
      surface the system prompt and tool serialization are composed by
      OpenCode, not the hub (the environment block, compaction rewrites,
      mid-session tool churn are host-side); the hub composes the
      orientation block, per-turn advisory guidance, MCP mounts, and the
      loop prefix. Also (Anthropic-vendor conflation correction): the
      Messages SCHEMA requires explicit markers; whether the three
      anthropic-compatible endpoints (deepseek/glm/kimi) accept them is
      UNPROBED — the opt-in stays dark until per-vendor probes land.
      PART 1 LANDED (2026-09-24, feat/w098-proposal-prompt-cache-order):
      the loop-prefix slice — the default RSI proposal prompt reordered to
      stable preamble -> append-only history -> changing counters (the
      per-iteration counters previously rendered BEFORE the history,
      busting the provider prefix cache right before the bulk of every
      proposal turn); the W098 ordering pin freezes the invariant.
      Honest scope: verified structurally (the ordering pin +
      formatHistory's append-only serialization); the provider cache-hit
      improvement is NOT yet measured on live traffic.
      PART 2 LANDED — THE HUB-COMPOSED AUDIT (2026-09-24,
      test/w098-c1-guidance-audit; pins + ledger only, zero src change).
      Findings per site: (1) orientation block — static, versioned,
      zero-interpolation by construction (prompt-guidance.ts:69-86), the
      content snapshot + no-placeholder + order + opt-out pins already
      freeze it, and it renders as expected (g5-observability.test.ts:90-133); (2) per-turn advisory
      guidance — env-derived constants composed ONCE at hub startup
      (hub.ts:159), constant per process; (3) scheduler composition —
      guidance prepended, per-turn schedule prompt after
      (hub-scheduler.ts:358), the verbatim prefix order already pinned
      (hub-scheduler.test.ts:191) and the composed prompt is the recorded
      ask (the W041 digest binds it); (4) the reviewer rubric — stable
      five-axis preamble -> per-run content (task, manifest, diff) ->
      verdict instructions (rubric.ts:32-93); the section order was
      UNPINNED — the new decision-freezer pin freezes it (green on first
      run, the characterization-pin discipline); fresh session per run,
      so cross-run prefix affinity does not apply; (5) the RSI apply
      prompt (self-improvement-agent.ts:139-148) — static preamble leads,
      per-candidate fields follow, no append-only history to invert, fresh
      session per apply turn — stable, unpin-worthy beyond part 1's
      proposal-pin pattern; (6) the iteration-21
      reasoning-claim findings — observability-only, never injected into
      prompts (hub.ts:276-281). MCP-mount tool serialization and the
      host-composed prefixes (the OpenCode environment block, compaction
      rewrites, mid-session tool churn) are OUTSIDE hub control —
      DISPOSITIONED as host-side, not audited: the hub cannot pin what it
      does not compose, and that segment's cache behavior remains
      unmeasured. Criterion complete for the hub-composed surface: stable
      by construction; the affinity work (c3) is unblocked.
- [x] Cache-control marker injection at transformBody for anthropic-wire
      pools (opt-in per pool via model-profile.ts). LANDED in W109
      (machinery + pins, wire-gated, absent-never-fabricated) — with the
      two-sided honest scope: real-traffic effectiveness is queued on the
      messages-lane transform+metering governance gap (pre-existing) and
      the vendor probes; see the W109 item's queued list.
- [x] Affinity routing specced as a W095 key-1 modifier (pool narrowing),
      with the cost tradeoff recorded and the metering trail verified
      unaffected. LANDED (2026-09-24, PR this branch):
      docs/AFFINITY_ROUTING_SPEC_2026-09-24.md — frontier-verified in
      three rounds (Kimi K3: round 1 REVISE with 3×P1 — the
      family-granularity narrowing does NOT stop the bounce (the pin
      narrows to ONE SLUG); the role→model map the spec first cited does
      NOT exist (the spec is explicitly CONDITIONAL on W095 key-1's
      landing); the W109 lane equation corrected — round 2 REVISE at the
      pointer layer (six stale cross-refs, one wrong work-item cite) —
      round 3 ACCEPT). The metering trail is verified unaffected scoped
      to the RECORDING mechanics (affinity composes at the autoLatest
      allowed_models injection, upstream of the usage event) with the
      content-variance caveat recorded (the W109 pollution class — the
      trail's per-vendor content varies; P12's fields land on the
      governed lane only). The cost tradeoff is recorded two-sided
      including the outage-persistence cost (key 4 unwired — a pinned
      vendor's degradation persists session-long). The savings remain
      unmeasured (park P11) until P12 + P9.
- [x] Frontier verification of the design (same pattern as #82/#85).
      RAN (W109, 2026-09-23): Kimi K3, fresh context, adversarial — round
      1 REVISE (2×P1: the synthetic-path pin + the unrecorded
      messages-lane blocker; the glm/kimi mis-shape; 4×P2: the deferred
      breakpoint, the throw-containment, the vendor-premise conflation,
      the cached-token metering blind spot) with all corrections
      incorporated; round 2 confirms. The full record is the W109 item.

### W099 - G5 branch-exit consistency pins (Complete - pins landed; asymmetry unification queued) (2026-09-23)

**Source:** frontier agents-research assessment §6 G5
(docs/AGENTS_RESEARCH_PORT_ASSESSMENT_2026-09-22.md; operator priority
"frontier findings are top priority"). F1's identical-intent disease survived
its fix in a new spelling, and no vendored test pinned any branch-creation
behavior (grep 2026-09-22).

**What landed (vendored guard, pins only — no src change, dist untouched):**
- policy.test.ts: the as-found classification set frozen — allowed exits on a
  protected branch (`git checkout -b`, `git switch`, `git switch -c/-C`,
  `git switch main`); the F1 asymmetry residual pinned verbatim
  (`git checkout <branch>` and `git checkout -B` DENIED on a protected branch
  while the intent-identical switch forms are allowed — the case-sensitive
  `(?!-b\b)` lookahead at src/git-policy.ts:7); the load-bearing
  `git checkout -- <file>` working-tree-discard deny; the off-protected-branch
  allowance (the gate targets protected-branch writes, not exits); and the
  W090 no-facts fail-open (the protected-branch gate cannot engage without
  facts).
- redirect.test.ts: the protected-branch-write redirect names
  `git checkout -b` — the one checkout spelling the matcher partly blocks —
  so matcher and guidance must move together.

**Deliberately NOT done:** unifying the checkout/switch asymmetry (allowlist
all pure exits vs make switch symmetric) is a policy decision requiring its
own iteration + frontier verification; these pins freeze current behavior so
any change requires a decision, not drift. One change per iteration.

**En-route finding (pre-existing, queued):** package.test.ts fails on this
host for reasons unrelated to W099 — npm 12.0.2's `npm pack --json` returns a
keyed object while the untouched test destructures the legacy array shape
("object is not iterable"). It was already outside the focused-evidence set
(W097 recorded policy+mcp+redirect only). Fixing it is a legitimate
test-vs-npm-version repair but its own iteration; NOT folded here.

**Acceptance criteria:**
- [x] Every branch-exit spelling class pinned (characterization, as-found:
      all 4 policy pins + 1 redirect pin green on first run — predicted,
      then verified; no pin was weakened).
- [x] The asymmetry documented in-source-comment + ledger so the F1 disease
      cannot resurrect silently.
- [x] Focused suites green: policy 58/0 (54 + 4), redirect 5/0 (4 + 1), mcp
      5/0; vendored typecheck exit 0 (node --import tsx --test; npm 12).
- [x] Assessment doc §11 addendum appended (G3 closure by W091/W092
      recorded; G5 closure recorded; G2 part 2 + G4 remain open).

### W100 - Branch-exit/branch-pointer unification position (Complete - position recorded, frontier-verified at round 3; implementation queued) (2026-09-23)

**Source:** the G5 queued follow-up (the checkout/switch asymmetry decision
queued by W099); operator priority "frontier findings are top priority".

**What landed (position doc only — NO code change):**
- docs/BRANCH_EXIT_POLICY_2026-09-23.md: the 28-row family inventory probed
  LIVE against the built vendored core (with and without W090 facts), the
  structural finding (the deny class is spelling-SHAPED and
  current-branch-GATED — nine+ protected-pointer-write holes on the allow
  side: `switch -C <protected> [sha]`, `branch -f <protected> <sha>`,
  one/two-arg `-m`/`--move` renames, force-copy `-C`, `switch --detach/-d`,
  cross-branch `branch -D <protected>` / `update-ref refs/heads/<protected>`
  / fetch destination refspecs, `switch -f/--discard-changes`, and the
  shell-wrapper bypass of the ENTIRE deny class), the semantic analysis
  (exits/creates vs discards vs pointer writes vs the justified
  row-4 ambiguity deny), the position (unified semantic classifier,
  target-gated against the always-on `{main, master}` ∪ facts base — the
  push lane's own shape — fail-closed under parse uncertainty, pure
  exits/creates allowed, the factless posture split by class), two explicit
  outside-the-family residuals (shell-wrapper lane, exotic symbolic-ref
  form) with queued companion fixes, and the rejected-alternatives record
  (including the blanket-fail-closed fallback with its
  graceful-degradation property).
- Upstream parity verified read-only at `origin/main` 03fbdcf
  (v1.15.0-5-g03fbdcf, package 1.15.1): the same holes; upstream's
  `GIT_BRANCH_CREATE_RE` (git.ts:35) recognizes the sanctioned creates but
  only for the freshness gate. The unified fix is a deliberate, recorded
  upstream divergence (parity-log entry queued with the implementation).
- Frontier verification: Kimi K3, three rounds (REVISE → REVISE → ACCEPT,
  appendix A append-only). Round 1 falsified two draft claims (row-4
  "fact-independence"; the upstream version label read off the dirty
  v1.11.0-4 working tree) and under-counted the family by five classes
  plus the whole cross-branch dimension; round 2 caught three defects the
  revision itself introduced (detach mis-grouped into the target gate;
  pin-coverage overclaim for rows 16–18/6; row 25 outside every §4
  bucket); round 3 confirmed all corrections and accepted. Every
  incorporated finding was re-verified by live probe before incorporation;
  the appendix carries the per-finding dispositions.
- LESS-0017 (the scanner incident: the live plugin's file scanner blocks
  probe scripts AND documents carrying force-refspec shapes — the W084
  fixture convention is load-bearing for writing security analysis at
  all; finest-grain escapes recorded).

**Queued (next iteration, per §4.1 of the doc):** widen BOTH matchers
(`gitWriteRe` + `hasGitMutation`) to the full pointer family; the
structured protected-target gate (renames check both operands; one-arg
rename resolves to `currentBranch`; parse-uncertain → deny); the fetch
destination-refspec rule mirroring the push lane; red-first pins for rows
6/9–15/22–24 + new characterization pins for 16–21 + the round-3
watch-item pins (explicit `checkout <sha>`, row 27) — W099 pins stay
red-free by design; dist rebuild + live re-probe; parity-log divergence
entry; SECURITY_ASSURANCE residuals for the wrapper lane and symbolic-ref
form; the deny-path `sh -c` recursion as the companion fix.

**Acceptance criteria (this item = the position; implementation has its
own item):**
- [x] Family inventory probed live (with + without facts), 28 rows, every
      verdict reproducible.
- [x] The holes enumerated precisely, including the cross-branch dimension
      and the twin-matcher drift.
- [x] Position recorded with the factless posture split by class and the
      residuals explicit.
- [x] Frontier verification ACCEPT at round 3 (appendix A append-only,
      wrong rounds preserved).
- [x] Upstream divergence basis verified at a pinned ref (read-only).
- [x] LESS-0017 recorded; LESS-0016 stands from W099.

### W101 - The protected-target gate: unified branch-pointer classification (Complete - implemented, pinned red→green, live-probed; wrapper + symbolic-ref residuals recorded) (2026-09-23)

**Source:** the W100 position (docs/BRANCH_EXIT_POLICY_2026-09-23.md,
frontier-ACCEPT, PR #88 merged) — its §4.1 implementation sketch.

**What landed (vendored guard core + dist rebuilt):**
- `gitWriteRe` widened: the checkout clause exempts `-B` (the force form is
  target-gated now, not spelling-gated); a switch clause joins for the
  fact-gated detach/discard classes (`-d/--detach/-f/--force/
  --discard-changes`); the branch clause stays `-[dDM]` (row 16's
  conservative target-blind deny untouched). `hasGitMutation` widened
  identically per the twin-matcher discipline (branch pointer forms +
  fetch colon-refspec).
- NEW protected-target gate in `checkGitPolicy` (runs per segment, before
  the current-branch-gated lanes, after alias/push): force/rename/copy/
  delete forms target-classified from ANY branch against the always-on
  `{main, master}` base ∪ W090 facts; renames check BOTH operands; the
  one-arg rename targets the current branch and fails closed factless
  (row 12); parse-uncertain shapes fail closed; `update-ref refs/heads/
  <T>` and fetch destination refspecs (incl. the force-prefixed source
  form) target-shaped. Pure exits/creates/feature-target recovery flows
  stay allowed (row 10's `branch -f <feature>` recovery flow pinned).
- **One deliberate with-facts loosening, recorded for parity honesty:**
  `git checkout -B <feature>` on a protected branch flips as-found DENY →
  allow — unifying the identical intent with the `switch -C` spelling's
  pinned allow. The superseded W099 characterization pin carries a
  supersession note (append-only comment); the superseding assertion is
  the W101 unification pin. Upstream divergence recorded in the parity
  log (W101 entry) with the upstream-port candidate queued.
- SECURITY_ASSURANCE residuals #20 (shell-wrapper bypass of the deny
  class — queued companion fix: deny-path `sh -c` recursion) and #21
  (exotic symbolic-ref form + ref-adjacent filesystem routes) recorded;
  the security-assurance checker stays green (7/0).

**Evidence:** red-first — the 11 new W101 pin blocks ran 59/10 against the
unmodified tree (exactly the position's promised changes), then green
79/0 (policy 69 + redirect 5 + mcp 5) with TWO gate bugs caught by the
pins and fixed before commit (the one-arg rename's currentBranch check
was unreachable through the empty-targets loop; the factless fail-closed
deny was dropped in the rewrite) — the pins caught both; the W099 pin
collisions resolved by supersession + probe, never by weakening. Live
re-probe of the 28-row family inventory against the REBUILT dist: all 56
probe rows match the position (facts + factless, on-branch +
cross-branch, fixes + residuals).

**Review round 1 (fresh-eyes) — REJECT, three real gate defects, all
fixed and pinned:** (P0) space-form value options (`--points-at HEAD`,
`--format x`) shifted the parser's first-operand target selection —
`git branch -f --points-at HEAD main <sha>` phantom-allowed a protected
pointer move factless; (P1) wildcard branch-glob destinations
(refs/heads/*:refs/heads/*) escaped BOTH the new fetch lane and the
pre-existing push lane (tag globs keep their W084 exemption); (P2)
`--force\b` over-matched `--force-create`, re-introducing the exact
spelling-vs-intent asymmetry for the switch spelling (deny-direction).
Fixes: value consumption in the operand walk; wildcard branch-glob
destinations fail closed in both lanes; `--force(?!-create)\b` lookahead.
Pre-fix verdicts captured LIVE against the pre-fix dist (allow, allow,
allow, allow, deny — genuine red), post-fix green. The spec's §4.4
"W099 stays red-free" claim was corrected by a §7 implementation addendum
on the W100 doc (the -B feature-on-main pin supersession always moved one
pin; the doc's red-free claim missed it — the supersession is disclosed
in the pin comment, the parity log, and here).

**Evidence (final, at the review-fixed tip):** review round 2 (re-review)
— REVISE with one new fail-open: parseFetch's first-colon-operand early
return let a benign first refspec, a URL remote, or an unconsumed
`-o`/`-j` short value shield a later protected-branch destination
(pre-fix shapes captured live as allow). Fixed: every branch
destination checked (deny on ANY protected), `-j`/`-o` values consumed,
the create/force-create mode combination fails closed for both
spellings, and the falsified "dead entries removed" claim honored by
removing them. Review round 3 (re-review) — REVISE with one new
unrecorded fail-open: `--refmap`'s value is itself a refspec (the prune
mapping — with `--prune` a mapped absent source DELETES the mapped
local destination) and both spellings slipped the gate; parseFetch now
fails closed on ANY `--refmap` spelling before parsing; the `-c`/`-C`
combination watch-item pinned; benign prune fetches stay allow (pre-fix
verdict captured live as allow). Suites 83/0 (policy 73 + redirect 5 +
mcp 5); the 55-row live re-probe + all round-2/3 shield shapes green
against the REBUILT dist; repo lint/typecheck exit 0. Review round 4
(re-review) — REVISE: the one-arg rename writes BOTH names (the
position's row-12 framing covered only the source half; the destination
operand force-overwrites a protected branch when it names one — git
branch -M main from a feature branch destroys refs/heads/main, valid
git); fixed — the one-arg form checks BOTH the destination operand and
the current branch (fact-gated source), factless stays fail-closed;
pre-fix verdicts captured live (allow, allow); suites 84/0 (policy 74 +
redirect 5 + mcp 5). Review round 5 (re-review) — REVISE: the
delete grammar is variadic (git-branch(1): (-d|-D) <branchname>...) and
the gate's delete arm kept only the first operand — git branch -D feat2
main classified allow while git deletes BOTH; fixed — delete targets
are ALL operands (force-set keeps first-operand-only). Recorded
residual #22 (pre-existing push lane): push origin HEAD / @ / bare push
from a protected seat update the remote protected branch under allow
(colon form pinned deny) — queued resolution via the currentBranch
fact. Pre-fix verdicts captured live (allow x3); suites 85/0 (policy 75
+ redirect 5 + mcp 5); 55-row re-probe + round-2 shapes green against
the REBUILT dist; repo lint/typecheck exit 0. Review round 7
(re-review) — the blocker claim FALSIFIED by probe: the colon-less
plus-prefixed refspec shape was already denied by the shell lane's
pre-existing force-push rule (destructive-operation, ignoring
destinations); the landed fix is an attribution improvement (protected
destinations named protected-branch-push by the push lane; the pin
asserts the policy label). Watch-item recorded: the shell rule
over-denies legitimate force-pushes to feature branches — pre-existing,
noted for the shell-policy queue. LESS-0018: a reviewer trace of ONE
lane is not a verdict — probe before implementing. Review round 8
(re-review) — REVISE: the pull spelling shares the fetch lane's grammar
but no lane classified it (allow across every seat — the merge intent,
the row-24 fetch-refspec deny, and the force-refspec destructive catch
all bypassed by the composite spelling; pre-fix verdicts captured live:
allow across facts and branches). Fixed: pull shares parseFetch
(destination sweep + --refmap veto; pull's integration options
recognized) and gitWriteRe gains a current-branch-gated pull clause.
--mirror/--all pushes fail closed (residual #24, as-found allow
captured). Suites 85/0 (assertions added inside existing blocks);
55-row re-probe + round-2 shapes green against the REBUILT dist; repo
lint/typecheck exit 0; security-assurance checker 7/0. Review round 6
(re-review) — no new bypass found (all shapes trace fail-closed or
harmless; the variadic fix confirmed in src and dist); the one open
watch-item — bundled conflicting branch modes (a -dc/-md short bundle)
— hardened: multi-mode bundles fail closed (real git rejects the
combination); pinned; suites 85/0; all probes green.

**Acceptance criteria:**
- [x] Both matchers widened in the same change (`gitWriteRe` lanes +
      `hasGitMutation` extras), per §2.3's drift discipline.
- [x] The target gate closes rows 6/9–15/22–24 (with facts and, for
      pointer forms, factless via the base set) without loosening anything
      except the documented row-8-class unification.
- [x] Red-first pins for every changed row; W099 set survives except the
      one position-superseded assertion (supersession note recorded);
      characterization pins added for rows 16–21 + the round-3 watch-items
      (explicit `checkout <sha>`, row 27) + the review-round shapes
      (value-option phantom, wildcard globs, `--force-create`).
- [x] dist rebuilt + live re-probe green (56/56 pre-review, 55/55
      post-review-fixes).
- [x] Parity-log W101 divergence entry (incl. the review round);
      SECURITY_ASSURANCE residuals #20/#21; repo lint/typecheck exit 0.
- [x] Queued (NOT this iteration): the deny-path `sh -c` recursion
      companion fix; the exotic symbolic-ref matcher line; the
      `localBranches` fact for row 4's disambiguation (separately queued).

### W102 - The wrapper recursion: residual #20's closure (Complete - deny-path sh -c recursion landed, residual resolved) (2026-09-23)

**Source:** the W100 position's §4.6 queued companion fix and the W101
review record's residual #20 (SECURITY_ASSURANCE): every git deny class
was bypassable by wrapping — `sh -c 'git reset --hard <sha>'` classified
allow because `checkGitPolicy` did not recurse while `hasGitMutation`
did (the twin matchers' wrapper scopes diverged).

**What landed (vendored guard core + dist rebuilt):**
- `checkGitPolicy` recurses into sh/bash/zsh/dash/ksh `-c` wrappers with
  the same seat facts and a depth-16 fail-closed cap (shared verbatim
  with `hasGitMutation`'s detection — the twin matchers' wrapper scope is
  now identical). The wrapper is TRANSPARENT to the full inner git
  pipeline (alias, push, target gate, spelling lanes): a wrapped command
  inherits exactly the verdict its unwrapped form would get, because the
  wrapper executes in the same repository with the same facts.
- The design direction the pins settled: wrapper TRANSPARENCY, not a
  deny-everything blanket — the first draft's deny-everything test
  expectation was wrong (a feature-branch reset stays allow through the
  wrapper) and the corrected pins assert wrapper ≡ inner. The as-found
  allow residual pin superseded with a note (residual closure);
  SECURITY_ASSURANCE #20 marks the resolution including the honest edge
  (CORRECTED across rounds 1-2: the env-prefix claim was falsified —
  prefixed wrappers were always detected; the fused -c-quote and
  bundled-flag forms were real and are now detected via the SHARED
  wrapperCommands implementation, not a verbatim copy; the remaining
  edge is exotic interpreter names and the zsh EQUALS caveat).
- W100 doc §7 item 12; parity-log W102 entry (after the W101 rounds).

**Evidence:** red-first — the 2 new W102 pin blocks ran 75/2 against the
pre-fix tree (the wrapper shapes classified allow as-found), then green
87/0 (policy 77 + redirect 5 + mcp 5) after one test-expectation
correction (the wrapped feature-branch reset is allow — transparency,
not a blanket). Live verification against the REBUILT dist: wrapped
pointer writes deny through the wrapper (branch -f / update-ref / push
from any seat where the inner command denies), wrapped benign commands
allow, nested wrappers recurse, the depth cap fails closed; the 46-row
W100-era inventory re-probe green. Repo lint/typecheck exit 0;
security-assurance checker 7/0.

**Acceptance criteria:**
- [x] The deny path recurses into sh-family wrappers with the same facts
      and depth cap, sharing hasGitMutation's detection (twin-matcher
      scope identical).
- [x] Wrapped pointer writes deny; wrapped benign commands allow
      (transparency, not a blanket); nested wrappers recurse; the depth
      cap fails closed.
- [x] The as-found residual pin superseded with a note; SECURITY_ASSURANCE
      #20 marks the resolution with the env-prefix limitation stated.
      CORRECTION (review round 1, 2026-09-23): the env-prefix limitation
      was FALSIFIED (prefixed wrappers were always detected — live probe:
      deny across all three prefix forms); #20's corrected text states the
      real edges (busybox/xsh interpreters, the zsh EQUALS caveat).
- [x] dist rebuilt + the 46-row re-probe green; suites 87/0.
      (Suite count at this item's write time; superseded across review
      rounds 1-4 — the final count is 91/0, see the evidence below.)
- [x] Queued (NOT this iteration): env-prefixed wrapper coverage
      (`env sh -c '...'` — shared with hasGitMutation's scope); the
      symbolic-ref matcher line; the HEAD-alias push resolution; the
      localBranches fact.
      CORRECTION (review round 1, 2026-09-23): the queued env-prefix
      item above was FALSIFIED — env/timeout/assignment prefixes are
      consumed by the unwrapper and prefixed wrappers were always
      detected; the correction is recorded in SECURITY_ASSURANCE #20,
      LESS-0019, the W100 doc §7 item 12, and here (this line). The
      genuinely queued edges are the exotic interpreter names (busybox
      sh, xsh), the zsh EQUALS caveat, and the fused-bundle shapes the
      review rounds continue to harden. (Review rounds 3-4 appended:
      the -o bundle consumption and the -O/+O shopt family — see the
      parity-log W102 rounds 3-4; the duplicate correction block that
      stood here was a splice artifact, deduped.)
      (Round-5 hygiene: the correction block appeared TWICE — the second
      occurrence above is the splice artifact itself, retained and
      marked here rather than silently deleted; the canonical correction
      is the first one.)
      CORRECTION (review round 1, 2026-09-23): the queued env-prefix
      item above was FALSIFIED — env/timeout/assignment prefixes are
      consumed by the unwrapper and prefixed wrappers were always
      detected; the correction is recorded in SECURITY_ASSURANCE #20,
      LESS-0019, the W100 doc §7 item 12, and here (this line). The
      genuinely queued edges are the exotic interpreter names (busybox
      sh, xsh), the zsh EQUALS caveat, and the fused-bundle shapes the
      review rounds continue to harden.

### W103 - The W101/W102 residual closures: alias-push resolution + symbolic-ref gate line (Complete - residuals #22 and #21 resolved, red→green pinned, dist probed) (2026-09-23)

**Source:** the pain-point queue's items 2+3 (one guard-touch iteration,
same file, same region as W102): SECURITY_ASSURANCE #22 (HEAD-alias
pushes from a protected seat) and #21 (the symbolic-ref protected-NAME
matcher line), both queued by the W101/W102 records.

**What landed (vendored guard core + dist rebuilt):**
- Push lane: HEAD/`@` refspecs and the default push (no refspec beyond
  the remote slot) resolve against the `currentBranch` fact — a
  protected seat's alias/default push denies `protected-branch-push`;
  a feature seat's stays the normal publish flow. FACTLESS seats keep
  the as-found allow (the documented W090 fail-open class; the round-8
  bare-pull symmetry; the W102-era transparency principle — the alias
  destination is fact-shaped, not base-set-shaped). The `--mirror`/
  `--all` sweep hoisted per segment (the no-remote-argument form never
  ran it before; a #24 edge). Honest config edge recorded: push.default
  =upstream toward a differently-named protected upstream stays
  repo-config-dependent (recorded in #22, not guessed at).
- Target gate: `symbolic-ref` joins `parseUpdateRef` (sub-aware mode) —
  the two-operand write form checks BOTH names (the protected NAME and
  the referent it is aimed at: a symref aimed AT a protected branch
  routes later commits through it), while the HEAD-form repoint stays
  the row-25 exit-class allow, the one-operand form stays a read, and
  --short/-q are enumerated so benign reads do not newly fail closed;
  --delete and -m fail closed on parse uncertainty. The `.git/`
  filesystem-route half of #21 remains the open residual (part 2).
- Twin matcher: hasGitMutation's extras gain symbolic-ref ≥2-token
  forms (write/delete) — the gate and the twin widen together (§2.3).
- SECURITY_ASSURANCE #21 (RESOLVED PART 1, part 2 kept open) and #22
  (RESOLVED, edges stated); parity-log W103 entry; the W101 round-5
  as-found allow pin flipped WITH a resolution note (the residual
  pre-registered its own successor).

**Evidence:** pre-change live probe (24-row matrix against src) captured
every as-found allow; pins authored red-first ran 79/4 with EXACTLY the
four expected failures (the two new W103 blocks, the flipped pin, the
twin additions) and zero collateral; green 93/0 (policy 83 + redirect 5
+ mcp 5) after the src edits; dist rebuilt and the dist probe re-run
(src≡dist); vendored typecheck OK; repo lint/typecheck exit 0;
security-assurance checker 7/0.

**Review round 1 (fresh-eyes completion reviewer, executed evidence):**
[APPROVE] across all five axes (recorded via record_review) — red-first
reproduced (79/4), a 108-cell matrix showed 32 allow→deny flips and ZERO
deny→allow, all gates re-run, dist≡src verified by execution. Three P2s
addressed in the follow-up commit with red→green re-verification
(tags-only and --delete/-d refspec-shaping flags excluded from the
default-push reading; the twin's read-flagging fixed with a
flags-skipping two-operand pattern; the dangling LESS-0021 reference
resolved by the append) and one P3 recorded as-found (`:`-sourced remote
HEAD deletion stays allow, pinned). Final: suites 93/0, dist re-probed
after the post-fix rebuild (a mid-iteration stale-dist divergence was
caught by the dist probe itself), repo lint/typecheck exit 0, checker
7/0.

**Review round 2 (the completing reviewer's continuation):**
[REQUEST_CHANGES] with one P1 — the round-1 tags-only fix had gated the
WHOLE alias disjunction, re-opening the #22 hole for tag-flag combos
with an explicit alias refspec; fixed by scoping the exclusion to the
default-push readings only (explicit HEAD/@ refspecs always resolve),
plus the twin's interleaved-flags fix (git permutes options) and the
LESS-0021 append (the REMEMBER step). The round-2 table's no-remote
cell was corrected against the reviewer's own formula (git's grammar
makes the single positional the repository slot; tags-only flags push
no branch refs). Re-verified: 81/2 red (exactly the round-2 pins) then
93/0 green, dist rebuilt and probed (8 round-2 cells), repo
lint/typecheck exit 0, checker 7/0. Round 3 re-binds the verdict to the
final tip.

**Review round 3 (the same reviewer's continuation):**
[REQUEST_CHANGES] with one P1, falsified by the reviewer's executed git
dry-run (git 2.55.0): `--follow-tags` is NOT tags-only — the man page
has it push "all the refs that would be pushed without this option"
(the default push fires), so the round-1/2 allow for `git push
--follow-tags` from a protected seat was a false premise re-opening the
#22 hole (the round-2 record had endorsed that allow pin without a
grammar probe — recorded as the falsification, not hidden). Fixed: the
tags-only reading requires `--tags` WITHOUT `--follow-tags` (folding
the round-3 P3 combined-flags shape in); the follow-tags pins flipped
with the falsification note; the false premise corrected in the src
comment, the test comment, #22's sentence, the parity log, and
LESS-0021's dated correction. Re-verified: 82/1 red (exactly the
flipped pin) then 93/0 green, dist rebuilt and probed (11 cells match),
repo lint/typecheck exit 0, checker 7/0. Round 4 re-binds the verdict
to the final tip.

**Acceptance criteria:**
- [x] Alias/default pushes from a protected seat deny; from a feature
      seat and a factless seat they keep their classification; mixed
      refspecs, plus-forms, and wrapped variants pinned.
- [x] symbolic-ref protected-NAME writes deny factlessly and through
      wrappers; the HEAD-form, reads, and benign writes keep their
      classification; unenumerated shapes fail closed.
- [x] The --mirror/--all zero-argument edge fails closed.
- [x] The as-found pin moved only as the residual's pre-registered
      resolution, with the note in place; SECURITY_ASSURANCE and the
      parity log record the honest factless and config edges.

### W104 - The npm-12 package-shape repair (Complete - the twice-queued W088/W099 debt closed for the recorded apps; the 11-app sibling class discovered and queued) (2026-09-23)

**Source:** the pain-point queue's item 5 — the twice-queued W088 and
W099 records: `npm pack --json` on npm 12.0.2 returns a KEYED object
(keyed by package name) while the package tests destructure the legacy
array, so the destructure itself throws (`object is not iterable`) and
the artifact tests fail on a pristine tree (LESS-0007 recorded it for
workflow-guard-mcp AND browser-verification-mcp; LESS-0016 confirmed
the failure environmental by probing the raw npm shape).

**What landed (tests only — no src changes anywhere):**
- The two recorded apps' package tests are version-portable: the pack
  output is extracted either as the legacy array's first entry or as
  the keyed object's entry FOR THIS PACKAGE, and the entry's `name` is
  now pinned (`assert.equal(entry.name, ...)`) — the old array
  destructure never checked which entry it got, so the repair
  STRENGTHENS the test (a wrong-entry or shape regression now fails).
- DISCOVERED AND QUEUED (not this iteration): the same stale destructure
  exists in 11 MORE toolbox apps (grep: change-intelligence, ci-
  intelligence, code-intelligence, git-intelligence, learning, project-
  memory, review-accountability, skills, test-intelligence,
  verification-accountability, egress-audit) — `toolbox:verify` runs
  every app's suite (`pnpm -r ... run test`), so all 13 package tests
  are red on npm 12 at the release gate. Spot-probe executed live:
  project-memory-mcp fails with the identical
  `object is not iterable`. The sibling sweep is its own next item
  (mechanical, same fix shape, one app at a time or batched by the
  executor with per-app green evidence).

**Evidence:** workflow-guard-mcp — red-first captured live (`object is
not iterable` at the destructure, line 19) then the FULL app suite
94/0 (package + policy 83 + redirect 5 + mcp 5, zero collateral);
browser-verification-mcp — dist built, package test 1/0; project-
memory-mcp spot-probe red live (the queued class); repo lint/typecheck
exit 0; security-assurance checker 7/0; both vendored typechecks OK.

**Acceptance criteria:**
- [x] The two recorded apps' package tests pass on npm 12.0.2 and keep
      their full assertion set (bin maps, executable bits, MCP launch,
      tools list / CDP evidence) unchanged.
- [x] The extraction is version-portable (legacy array or npm-12 keyed
      object) and discriminates by package name (the new name pin).
- [x] No src changes; no verifier weakened (the test gains an
      assertion).
- [x] The 11-app sibling class recorded as a queued finding with the
      grep + live spot-probe evidence.

### W105 - The npm-12 sibling sweep: the remaining 11 package tests (Complete - 13/13 package tests green on npm 12; the ci-intelligence pre-existing build break discovered and queued) (2026-09-23)

**Source:** the W104 item's queued discovery — the same stale legacy-
array destructure in 11 more toolbox apps' package tests (the
`toolbox:verify` release gate runs every app's suite).

**What landed (tests only — no src changes anywhere):** the landed
W104 extraction pattern applied to all 11 sibling package tests —
version-portable extraction (legacy array or npm-12 keyed object) with
the entry's `name` pinned per app, ending `const filename =
entry.filename;` so every downstream reference survived unchanged.
Six INLINE-destructure files additionally received the packOutput
binding; five SPLIT files changed only the destructure line. Comment-
block attribution: the inserted blocks carry the W105 tag (not the two
landed apps' W104 tag) because the tag names the iteration that
touched the file — W104 never edited these 11; the review round
confirmed the tag update is correct per-item attribution. The
shared-helper question (the W104 review's P3) is decided for now:
inline per-app, consistent with the two landed W104 apps (per-app test
locality; the apps are standalone packages) — re-open if a future
drift class hits again.

**DISCOVERED AND QUEUED (not this iteration):** ci-intelligence-mcp's
BUILD/typecheck fails pre-existing on main — `error TS18046: 'payload'
is of type 'unknown'` twice in src/github-actions-adapter.ts (lines
171, 178). tsc emits output despite the errors (noEmitOnError
default), so the app's package test runs and passes with the sweep
fix; the failure is unrelated to this diff (zero src changes; the
errors pre-date it at the base commit). Its fix is its own item.

**Evidence:** 11/11 package tests green (each 1/0, per-app dist built)
— 13/13 across the toolbox on npm 12.0.2; per-app typechecks 10/11 OK
(ci-intelligence's pre-existing failure recorded above); repo
lint/typecheck exit 0; security-assurance checker 7/0. The executor
applied the two-variant spec with zero deviations (structural
verification: no stale destructure residue repo-wide, 13 name pins =
11 new + 2 landed, 6 packOutput bindings in the 6 inline files).

**Acceptance criteria:**
- [x] All 11 sibling package tests pass on npm 12.0.2 with the same
      version-portable extraction and name pin as the two landed apps.
- [x] Downstream `filename` references preserved in every file (the
      `const filename = entry.filename;` ending); no other lines
      changed; no src changes.
- [x] 13/13 package tests green across the toolbox — the npm-12
      package-shape class is closed at the release gate.
- [x] The ci-intelligence pre-existing build/typecheck break recorded
      as a queued finding with the exact TS error lines.

### W106 - The homedir-trust residual: SECURITY_ASSURANCE #25 (Complete - the W097-era queued record closed; docs-only) (2026-09-23)

**Source:** the pain-point queue's item 6 — W097's queued record: the
ostree fix (LESS-0015) deliberately left the homedir trust anchor
unclamped and queued the residual for SECURITY_ASSURANCE; LESS-0015
carried it only, and the doc had no entry (verified by grep on current
main before landing).

**What landed (docs-only):** residual #25 in
docs/SECURITY_ASSURANCE.md — the unclamped `os.homedir()` anchor in
`checkProtectedPath` (a poisoned `HOME=/var` — or the extreme `HOME=/`
— would classify system paths as user space and neuter the
corresponding system-space prefix rules), bounded honestly: the `.ssh`
and secret-name rules are env-independent and still fire, the
workspace-boundary lanes never consult the home anchor, and the edge
is HOST-SIDE ONLY (the guard process's environment belongs to the
operator's host; agent seats cannot set it — the W097 review verified
agents cannot reach it). The deliberate non-patch is recorded with its
reason and a mitigation shape (passwd-entry anchor, or intersect with
the workspace root). AGENTS.md's residual-count line updated 24 → 25
with the dated attribution.

**Evidence:** absence verified by grep on current main before landing
(the queue's "confirmed still missing" claim re-verified); the
entry's code cites read from path-policy.ts (the W097 classification
block); security-assurance checker 7/0 after (its pins are
count-agnostic — section presence + headline residuals + no-TODO);
repo lint/typecheck exit 0 (docs-only diff code-inertness).

**Acceptance criteria:**
- [x] The residual is stated in the doc with its honest boundary (what
      the poisoned HOME neutering covers and what still fires), the
      host-side-only reachability claim, and the W097 provenance.
- [x] The deliberate non-patch and its reason recorded, not hidden.
- [x] AGENTS.md's honesty-count line reflects the new count with a
      dated attribution.
- [x] No code changes; the checker's pins unaffected.

### W107 - Web-UI C1 + C2: response-honesty coverage + the kernel invariants panel (Complete - the amux P1 candidates landed observability-only, guards honored) (2026-09-23)

**Source:** the pain-point queue's item 8 — the amux research doc's P1
candidates C1 and C2 (docs/AMUX_RESEARCH_2026-09-23.md §6), with their
trust-boundary guards carried into the item text as the doc required:
C1's guard — the coverage metadata comes from the hub server, never
client-computed; C2's guard — invariant evaluation stays kernel-side,
and the UI may not self-derive agreement from client-observed state.

**C1 — what landed:** every `/api/usage` response now carries a
server-computed `coverage` object assembled from facts the server
already holds: the requested `days` param verbatim (`requestedDaysParam`)
plus `ignoredParams` when a value outside the whitelist was silently
coerced (the pre-change behavior: `days=14` silently became a 7-day
query — now stated), the actual queried window (ISO pair), per-source
`{rows, limit, truncated}` tells (the proxy's `metadata.truncated` was
read and then DROPPED by the handler before this), the day-
granularity availability (`queryDaily` silently returned an empty
series when the granularity was unavailable — now an explicit
`granularityAvailable: false` tell), and `creditsAvailable`. Unknown
fields stay ABSENT (never fabricated) — fakes and sources that do not
know a fact yield absent keys, and the bare (no-analytics) route
carries no coverage at all. The webapp renders the coverage line
inline beside the numbers (window · per-source rows/limits/truncation
· the empty-series tell · ignored params).

**C2 — what landed:** a pure kernel evaluator
(`src/kernel/invariants.ts` — no IO, no UI; the kernel owns task
state, transition legality, and evidence freshness) over the graph
state producing rows `{id, label, verdict: passed | failed |
could-not-discriminate, judged, failures?}` for three invariants:
`state-legality` (judged: all tasks), `verified-evidence-fresh`
(judged: verified tasks — the kernel demotes verified tasks on
mutation by construction, so the row's honest job is disclosing the
judged population: "N judged, 0 failures" is an all-clear only
because N is stated), and `evidence-record-shape` (judged: evidence
records; the FAILED branch discriminates corrupt persisted inputs).
Empty populations render could-not-discriminate — never a silent
pass. The application relays it (`WorkflowApplication.invariants()` +
`GET /api/invariants`); the webapp mounts an InvariantsPanel in the
operator's panels column rendering verdicts with the judged
population and the could-not-discriminate distinction ("judged
nothing, so it says nothing about the fleet").

**Evidence:** red-first — the kernel tests failed compile-level (the
evaluator did not exist), the webapp surface test on the missing
panel module, and web.test.ts ran 19 pass / EXACTLY the two new W107
tests failing with zero collateral; green — 64/0 across
task-graph-invariants (8) + web.test.ts (21) + webapp-surface + the
security-assurance checker (7), plus the held-out task-graph suite
9/0 and webapp-presenters unchanged; typecheck exit 0 (the branded-id
helper fixes: a test helper's parameter type intersected with a
branded id cannot accept a plain string — Omit the branded field from
the Partial instead); lint exit 0.
   CORRECTION (review round 1, 2026-09-23): this item's earlier draft
claimed the pre-change handler "dropped" the proxy's
`metadata.truncated` — FALSIFIED by the reviewer against base source:
`query()` mapped `metadata.truncated` into `AnalyticsResult.truncated`
faithfully, the base handler relayed byModel/byDay whole (truncated
inside them), and the base UI already rendered byModel truncation;
only byDay truncation went carried-but-never-rendered. The genuine
pre-change anti-patterns this iteration closed: silent days coercion
(no disclosure), silent empty series on unavailable granularity,
undisclosed limits/window, and the byDay truncated tell carried but
never rendered. Recorded as the correction, not hidden.

**Acceptance criteria:**
- [x] Every /api/usage response carries server-computed coverage;
      unknown fields absent, never fabricated; ignored params stated
      instead of silently coerced.
- [x] The coverage line renders inline beside the numbers in the
      webapp; the truncated and empty-series tells are visible.
- [x] Invariant evaluation lives in the kernel (pure); the UI relays
      and never self-derives agreement.
- [x] Every invariant row states its judged population; empty
      populations render could-not-discriminate, never a silent pass.
- [x] The C1/C2 guards from the amux doc carried into the item text
      and honored by construction.

### W108 - Residual #23: the destination-aware force-push rule (Complete - both blind shell spellings resolved, lanes differ explicitly by policy, red→green pinned, dist probed) (2026-09-23)

**Source:** the pain-point queue's item 4 — SECURITY_ASSURANCE
residual #23 (the W101 round-7 watch-item): the shell lane's
force-push rules were destination-blind — any plus-prefixed push
refspec (and, discovered by the W108 iteration's exploration pass, the
`--force`/`--force-with-lease`/`-f` flag rule equally) classified
deny/destructive-operation even to the agent's own feature branch.

**What landed (vendored guard core + dist rebuilt):**
- The shape DETECTION stays regex (the same two shapes the blind rules
  matched, over the same three text variants); the VERDICT reuses the
  GIT lane's push-destination resolver — `pushedProtectedBranchIn` and
  `protectedBranchesIn` exported from git-policy and consumed by
  shell-policy (one grammar implementation, not a copy; the twin
  discipline).
- Resolution mapping: resolvable non-protected destination → allow
  (the recorded over-deny flips, both spellings); W084 tag publish →
  allow even when forced (the release-operation exemption now holds in
  both lanes — a deliberate behavior change, pinned); protected
  destination / wildcard / mirror → deny (fail-closed, unchanged).
- The `"unresolved-alias"` sentinel: a factless alias/default force
  push — the GIT lane maps it to its documented W090 fail-open allow
  (the W103 pins keep their as-found classification) while the SHELL
  lane maps it to deny: its force-push stance stays conservative where
  nothing is knowable. The lanes now differ EXPLICITLY by policy over
  the same grammar, pinned in both directions.
- `checkShellPolicy` gains a defaulted `GitPolicyContext` parameter;
  policy.ts threads the seat facts (the MCP schema already carried
  them). The destination-aware check runs after the generic destructive
  patterns (a compound's earlier destructive match still attributes
  first; the attribution-order shift for compounds mixing the
  post-push rules with a force push is recorded). Attribution corner
  (review round 1 P3): a command carrying BOTH force shapes (a
  plus-refspec and the force flag together) attributes the flag reason
  where the pre-fix pattern order attributed the plus reason — decision
  and policy unchanged, both reasons accurate.
- SECURITY_ASSURANCE #23 resolved-in-place (scoping corrected to both
  spellings); BRANCH_EXIT_POLICY's round-7 watch-item superseded with
  the stale shell-policy.ts cite corrected; the parity-log W108 entry.

**Evidence:** pre-change 14-row live probe against the pre-fix dist
captured every as-found deny (all feature-destination force shapes →
destructive-operation, forced tag publishes → deny, protected
destinations → the git lane's protected-branch-push attribution); pins
red-first ran 84/1 (EXACTLY the allow-flips test red; the preservation
test green as-found) then 95/0 (policy 85 + redirect 5 + mcp 5); dist
rebuilt and probed (12 cells match — a first probe run caught a STALE
dist, the LESS-0010 hazard applied mid-iteration); vendored typecheck
OK; repo lint/typecheck exit 0; security-assurance checker 7/0.

**Acceptance criteria:**
- [x] Force-pushes to resolvable feature destinations classify allow in
      the shell lane, both spellings, factless and with facts; wrapped
      forms inherit via the W102 recursion.
- [x] Force-pushes to protected, wildcard, mirror, or unresolvable
      destinations still deny; the factless fail-closed stance pinned.
- [x] Forced tag publishes follow the W084 exemption in both lanes
      (deliberate flip, pinned).
- [x] The lanes' differing policies over the same grammar are explicit
      and pinned in both directions; the twin discipline holds (one
      resolver implementation).

### W109 - The transformBody seam bundle: W098 c2 + W095 c2 + W098 c4 (Complete - marker machinery + the composed seam landed; real-traffic effectiveness queued on the messages-lane governance gap; frontier round 1 REVISE, corrections applied, round 2 confirms) (2026-09-23)

**Source:** the pain-point queue's item 7 — the W098 c2 + W095 c2 bundle
(same transformBody seam) followed by W098 c4 (frontier verification of
the caching design, the Kimi K3 pattern). The queue's sub-item numbers
map to the acceptance-criteria bullets: W098 c2 = cache-control marker
injection at transformBody for anthropic-wire pools (opt-in per pool via
model-profile.ts); W095 c2 = the metering-proxy seam shaped for policy
routing (the autoLatest-style transform point) without changing the
pass-through posture for unclassified traffic; W098 c4 = the frontier
round. W098 c1 (the cache-bust audit) and c3 (the affinity spec) stay
queued — the ledger sequences c1 before affinity work only.

**W098 c2 — what landed (machinery + pins; real-traffic effectiveness
queued):** the per-pool opt-in (`ModelProfileInput.cacheMarkers` →
`ModelProfile.cacheMarkers`, absent stays absent) and the pure marker
pass (`applyCacheMarkers`): on the anthropic wire with the opt-in, the
STABLE composition-time prefixes get `cache_control: {type:
"ephemeral"}` — the system block (string → block array; array → last
block only, pre-existing markers preserved) and the last tool
definition; the per-turn message lane is untouched (its breakpoint
policy is deliberately undecided — see the queued decisions); opt-in
and wire-gated, absent-never-fabricated, never mutating.
`createOpenModelMeteringPool` threads the opt-in per pool and — the
prerequisite the pre-change composer dropped — the definition's `wire`
reaches the profile (anthropic-wire profiles were unconstructible).

**W095 c2 — what landed:** `createModelUsageProxy`'s `transformBody`
option is now the named POLICY-ROUTING transform point (the W095 design
note's second consumer attaches here), with the exported
`composeBodyTransforms` helper: ordered composition, per-stage
fail-open — a stage returning a non-record OR THROWING is skipped and
the chain continues with the last good body (frontier round 1 P2: the
fail-open extends to exceptions; a buggy policy consumer cannot 502 the
pool). The pass-through posture for unclassified traffic is unchanged
and pinned. Ordering guidance recorded for the budget consumer: a
model-rewriting stage attaches BEFORE the profile-shaping stage.

**DISCOVERED AND QUEUED (the load-bearing gaps the frontier round
shaped):**
1. **The messages-lane governance gap (P1, pre-existing W070b-era):**
   the proxy's parse/transform/usage-injection pipeline gates on the
   `/chat/completions` path only — the anthropic messages path passes
   through UNTRANSFORMED and effectively UNMETERED (clarifier, review
   round 1 P3: the lane does reach `recordUsage`, but the OpenAI-shaped
   extraction keys against the anthropic usage shape, so `usageEvents`
   can increment with zero tokens — the trail is polluted, not absent).
   The cache-marker pass therefore fires on real anthropic-wire traffic
   only after that lane is governed; the c2 end-to-end pin exercises the
   governed lane with an anthropic-wire profile. Queued as its own item
   (it needs the replay policy's Messages-schema compatibility and the
   anthropic usage shape recorded before the metering trail is trusted
   on that lane). RESOLVED-IN-PART (W123, 2026-09-24): the extraction
   half — the anthropic usage shape records real tokens (the pollution
   closed) and both prerequisite records landed — see the W123 item and
   park P9's dated note; the sentence above describes the as-found
   state, superseded on the metering half only.
2. **The cached-token metering blind spot (P2):** the metrics model
   knows only prompt/completion/total/cost — no cache_read/cache_create
   fields exist, so when markers fire on real traffic the cache-hit
   savings that justify the position are unobservable in the hub's own
   metering trail.
3. **The vendor-probe precondition (P2):** the position's "(Anthropic
   requires explicit markers; OpenAI-family auto-caches)" conflates
   Anthropic-the-vendor with the anthropic-compatible endpoints the
   pools would hit (api.deepseek.com/anthropic, api.z.ai/api/anthropic,
   api.moonshot.ai/anthropic) — their cache_control acceptance is
   UNPROBED, and a rejecting endpoint turns the opt-in into a
   per-request 400. The opt-in stays documented as dark until
   per-vendor probes land (probe-gated, never date-gated).
4. **The message-lane breakpoint policy (P2, deferred deliberately):**
   the anthropic wire allows a small number of breakpoints and caches
   only at marked prefix ends; the minimal slice marks the static head
   only, so the growing conversation — the dominant token mass — is
   never cache-read until the per-turn boundary policy is decided. The
   deferral is recorded as load-bearing, not a footnote.
5. The hub-side prefix discipline governs a minority of the prefix: on
   the default surface the system prompt and tool serialization are
   composed by OpenCode (host-composed), so W098 c1's cache-bust audit
   must extend into host-composed prefixes (the environment block,
   compaction rewrites, mid-session tool churn) — the position's "(a)
   the hub composes the largest prefixes" was over-powered and is
   corrected in the W098 item.
6. Opt-in granularity: the composer flag covers all keyed families at
   once (coarser than per-vendor-pool); per-family granularity queued.

**W098 c4 — the frontier verification record (round 1, 2026-09-23):
REVISE.** Kimi K3 via the `general` subagent (model
openrouter/moonshotai/kimi-k3), fresh context, read-only, adversarial
brief (falsify the position, the marker design, the opt-in surface, the
seam composition, the metering-trail constraint). Findings, verified
against code by the verifier and incorporated the same day: P1 ×2 (the
synthetic-path end-to-end pin + the unrecorded messages-lane blocker;
the glm/kimi anthropic mis-shape via the new wire threading), P2 ×4
(the deferred breakpoint unrecorded; the fail-open narrower than its
doc — throwing stages propagated; the vendor premise conflated and the
compat endpoints unprobed; the cached-token metering blind spot), P3
×4 (opt-in granularity, the ordering guidance, the fallback-slug
affinity scope, the debug debris). The verifier also confirmed the
sound spine: pure marker pass, opt-in/wire-gated,
absent-never-fabricated, pass-through preserved, the response-caching
rejection sound, the deterministic-TTL model sound. Round 2 (the same
session, continuation) verifies the corrections below.

**W098 position corrections (dated, append-only):** (1) "(Anthropic
requires explicit markers; OpenAI-family auto-caches)" conflates
Anthropic-the-vendor with the anthropic-compatible wire — the Messages
SCHEMA requires markers; whether the three compat endpoints accept them
is UNPROBED (the opt-in stays dark until probed). (2) "(the hub
composes the largest prefixes: system prompts, fleet guidance, tool
definitions, per-role model config)" is over-powered — on the default
surface the system prompt and tool serialization are composed by
OpenCode (host-composed); the hub composes the orientation block,
per-turn advisory guidance, MCP mounts, and the loop prefix, and c1's
audit must extend into host-composed prefixes.

**Evidence:** red-first (4 compile-level marker tests + the
composition/pool behavioral tests failing with zero collateral) then
32/0 (model-profile 13 + model-usage-proxy + open-model-proxy), plus
the held-out replay/schema/budget suites (9 pass) and the repo
typecheck/lint exit 0. The frontier round ran its own suite checks
(31/31 at its pre-fix state). The round's process notes: the verifier
correctly flagged that the iteration was uncommitted worktree state
(normal pre-commit) and that the W109 item did not yet exist (it was
authored after the round, as the corrections).

**Acceptance criteria:**
- [x] W098 c2 (machinery + pins; the two-sided honest scope in the
      queued list): the marker injection at transformBody, opt-in per
      pool via model-profile.ts, wire-gated, absent-never-fabricated.
- [x] W095 c2: the seam shaped for policy routing (the composition
      helper + the named second consumer) with the pass-through posture
      unchanged for unclassified traffic (pinned: empty chain, non-record
      stages, throwing stages, unknown-model traffic).
- [x] W098 c4: the frontier verification ran and its corrections landed
      (Kimi K3, fresh context, adversarial; round 1 REVISE with 2×P1 +
      4×P2 incorporated; round 2 confirms).
- [x] The discovered gaps queued with their costs (the messages-lane
      governance, the vendor probes, the breakpoint policy, the
      cached-token metering fields, the c1 audit scope).

### W110 - Web-UI C3: refusal-legible evidence-gated transitions (Complete - the kernel refusal names the missing artifacts, the tasks panel renders it verbatim; the claim-shaped evidence endpoint discovered and queued) (2026-09-23)

**Source:** the pain-point queue's item 9, candidate C3 (the amux
research doc's first C-batch item), with its trust-boundary guard
carried into the item text: NEVER a UI surface accepting operator/agent
prose as kernel-gate evidence — Workflow's evidence must be
environment-supplied and kernel-validated.

**What landed:**
- Kernel (the refusal computation, pure): the EVIDENCE_REQUIRED
  rejection now names the UNSATISFIED requirements — each missing
  artifact with a per-requirement diagnosis discriminating no-evidence /
  wrong-authority / not-passing / stale ("the passing evidence is stale
  (a mutation landed after it)") — in the prose AND as a structured
  additive `missing` field on the rejected TransitionResult (absent on
  gates that do not produce it, never fabricated). The client never
  derives the refusal (the W107 guard pattern: the kernel computes, the
  UI relays).
- Webapp: `advance`/`retryTask` now RETURN the kernel's structured 409
  refusal (the pre-change UI discarded it with a bare
  `.then(() => refresh())`); the Tasks panel holds per-task refusal
  state and renders it verbatim beside the task (the step-rejection
  convention: role="alert", the refusal color, the machine code for the
  trail, and the missing artifacts as the per-entry artifact list).
- DISCOVERED AND QUEUED (the guard's exact trap, live): `POST
  /api/evidence` accepts client-chosen `subject`+`result` as
  HARDCODED-authority:"reviewer" kernel evidence from any same-origin
  tab — a same-origin page can satisfy a task's evidence gate by posting
  a claim. The kernel validates only subject/authority/result/freshness/
  epoch matching. The C3 "authorized attach path" design depends on
  governing this endpoint first (the honest producers that exist: the
  hub test runner's environment evidence at `test:<workspace>`, the
  axes-checked review verdict flow at `run:<id>`; the
  verification-accountability MCP observations never reach the kernel).
  Queued as the evidence-endpoint governance item — NOT silently kept.
  The authorized-attach machinery (surface the producing flow per
  missing artifact, route around the claim-shaped endpoint) is the
  follow-on item this legibility unblocks.

**Evidence:** red-first (the two kernel pins failed against the generic
prose) then green — kernel 11/11, the web 409 round trip carries the
structured `missing` + the enriched reason, the surface pin renders the
verbatim reason with the per-entry artifacts; 62/0 across task-graph +
web + webapp-surface; typecheck/lint exit 0.
   CORRECTION (review round 1, 2026-09-24): the "zero collateral" claim
was WRONG — the web.test.ts append SILENTLY DELETED the pre-existing
W107 C2 pin (`assert.equal(stateLegality.judged, 1)`), a gratuitous
test weakening the fresh-eyes reviewer caught by running the base file
against current src with the assertion restored (21/21 passes). The
assertion is RESTORED in this iteration's follow-up commit; the
zero-collateral discipline means the diff touching an existing test
block must re-include every line it did not intend to change — count
the lines you remove, not just the failures you add.

**Acceptance criteria:**
- [x] A withheld transition renders WHY: the kernel's refusal carries
      code + reason + the missing requirements with a per-requirement
      diagnosis, and the tasks panel renders it verbatim.
- [x] The client never derives the refusal — the kernel computes it
      (structured + prose) and the UI relays.
- [x] The claim-shaped evidence endpoint discovered and queued as its
      own governance item with the guard's citation.
- [x] The refusal transport for /api/transition and /api/tasks/retry
      unchanged (the 409 bodies were already structured — the UI now
      reads them).

### W111 - Web-UI C4: the backend-measured cost headline + the per-session rollup + the lane-coverage disclosure (Complete - the honest slice; per-task attribution queued on the turn-boundary mechanism) (2026-09-24)

**Source:** the pain-point queue's item 9, candidate C4 (the amux
research doc), with its guard carried into the item text: cost display
never gates authorization client-side ("budget exhausted" is a hub
policy decision, not a UI disable) — the usage page is display-only and
adds no client-side disable (the budgetViolation already arrives as
DATA on /api/session).

**The exploration's design-changing facts (verbatim from the audit):**
no per-session/per-task identifier reaches the metering proxy (one
constant placeholder credential; the server-topology path collapses all
sessions into one shared proxy); hub `runUsage` is latest-turn-wins per
run; reviewer-lane and RSI-proposal-lane spend are recorded NOWHERE; no
cache fields exist (the W109 queued gap); no model labels; no
transition timestamps or attention measures. The bigger error direction
is UNDER-attribution, not double-counting — the amux attribution lesson
lands here: a rollup counting only recorded lanes would accuse the
unrecorded ones of being free.

**What landed (the honest slice, backend-measured only):**
- The usage route serves the Workflow-side facts REGARDLESS of the
  analytics key (they are this server's own measurements): (a) the
  headline — `verifiedTasks`/`totalTasks` from the kernel snapshot,
  `sessionCostUsd` from the persisted session readouts, the
  `verifiedTasksPerCostUsd` ratio only when computable, and
  `attention: "unmeasured"` stated explicitly (the run-registry
  precedent); (b) the per-session rollup table (the manager's
  `usageRollup()` — the persisted readouts only, sessions without usage
  excluded, never fabricated); (c) the attribution disclosure naming the
  UNRECORDED lanes verbatim (the amux attribution lesson: a rollup that
  counts only recorded lanes accuses the unrecorded ones of working
  off-ledger).
- The per-TASK rollup is QUEUED on its attribution mechanism
  (turn-boundary deltas paired with the active-task pointer at boundary
  time — the UsageTurnTracker pattern; the server-topology path needs
  new plumbing for per-session split). Cache-read split stays queued on
  the W109 gap; signature-dedup is moot without a persisted event
  ledger (named so the queue knows why).
- The no-key usage route now carries the Workflow-side facts alongside
  the honest analytics-unavailable reason (the W107 bare-route pin's
  no-coverage assertion is unaffected — coverage remains
  analytics-gated).

**Evidence:** red-first (the W111 route test: the headline/rollup/
attribution absent pre-change) then green — web 22, surface 29, the
step-ledger suite, the checker, and hub-runs (81/0 across the touched
files); typecheck/lint exit 0. En-route: the session registry's shape
(#sessions is an array of records) and two self-inflicted route bugs
(a hallucinated helper call) caught by the pins before any commit.

**Acceptance criteria:**
- [x] The headline is backend-measured only: verified count from the
      kernel snapshot, session cost from the persisted readouts, the
      unmeasured axes stated ("attention: unmeasured"), the per-cost
      ratio only when computable.
- [x] The per-session rollup excludes sessions without usage (never
      fabricated) and states its source.
- [x] The attribution disclosure names the unrecorded lanes — the amux
      attribution lesson applied to the metering trail itself.
- [x] The guard holds: no client-side gating added anywhere; the cost
      display is display-only.
- [x] The per-task attribution, cache-read split, and signature-dedup
      recorded as queued with their dependencies (not silently omitted).

### W112 - Web-UI C5: approvals render the complete payload with the review confirmation (Complete - the full payload retained and rendered, not-approvable-with-reason, the confirmation gate; the grant lifecycle queued) (2026-09-24)

**Source:** the pain-point queue's item 9, candidate C5 (the amux
research doc), with its guard carried into the item text: the approval
UI is a display-and-submission surface; no affordance bypasses the
application layer's authority.

**The exploration's decisive fact:** the broker ALREADY retains the full
proposal at parking (the action is in scope there) — the surface just
truncated it to a 2 KiB preview and dropped taskId/mutating/
requiredCapabilities/readFingerprints. Rendering the complete payload is
a surface change, not a retention change. Also decisive: the card
renders on policy-ALLOWED asks only (denials never prompt), and the
guard runs AFTER the operator answer on this lane (an approval can still
be tightened by a guard deny — the M3 posture, fail-closed).

**What landed:**
- The broker's `PendingPermissionRequest` carries the COMPLETE proposal
  payload: `input` (full, untruncated), `taskId`, `mutating`,
  `requiredCapabilities`, `readFingerprints` (as the inspected paths) —
  alongside the compact `inputPreview` (unchanged cap).
- The approval card renders the metadata row (mutating / capability /
  taskId / requires / reads), the FULL input up to the 64 KiB inspection
  cap, and the two C5 disciplines: the explicit "I have reviewed the
  full payload" confirmation REQUIRED before Allow (a UI affordance
  gating the existing answer() route only — it produces no kernel
  evidence, per the W110 hazard adjacency), and
  NOT-APPROVABLE-WITH-REASON when the payload exceeds the cap (Allow
  disabled, the reason states the cap verbatim, Deny never disabled —
  never approvable-with-warning).
- The grant lifecycle (expiry/ownership/consumption) is QUEUED as its
  own item: today's `allow_always` is tool-name-wide, immortal,
  in-memory (the opposite corner of the C5 grant design); the nearest
  building blocks are the opencode-server authority's single-use
  consumption maps and the provenance-store's fingerprint discipline.
  The degraded-hub behavior is mostly moot (the approval path is
  in-process, not hub-proxied) — recorded. Transport note (review round
  1 P3): the full input ships over the 1 s permission poll UNCAPPED at
  transport (the 64 KiB cap is render-side only) — a transport cap
  belongs to the evidence-endpoint governance item's scope.
  SUPERSEDED (W115, 2026-09-24): the poll now transports under the
  inspection cap — the broker classifies the payload once at parking and
  the poll route strips flagged payloads (see the W115 item); the
  answer-route approvability posture is unchanged.

**Evidence:** the broker pin (the parked request carries the full
payload — taskId/mutating/requiredCapabilities/readFingerprints mapped
to paths, the FULL input retained, the compact preview riding along),
the two card pins (the metadata + the confirmation gate statically
rendering Allow disabled pre-confirmation; the oversized payload
NOT-APPROVABLE-WITH-REASON with deny available), 85/0 across the
touched suites (permission-broker + web + surface + web-sessions +
step-ledger + operator-surfaces); typecheck/lint exit 0.
   CORRECTION (review round 1, 2026-09-24): the "typecheck/lint exit 0"
claim was FALSE at the reviewed tip — lint FAILED (the dead `rendered`
pre-computation assigned but never used) and the same line was a
reachable render crash (`payloadRenderText(undefined)` throws on an
optional ACP rawInput; the card has no error boundary). Both fixed in
this iteration's follow-up commit (the payload text computes INLINE in
the guarded render branch), the pin weaknesses the reviewer flagged
fixed (both allow affordances asserted gated), and the records
corrected here. Second lesson recorded: the pins caught the missing
render but NOT the dead variable — a pin proves what it asserts, never
that the rest of the file is clean; lint is the verifier for dead code
and must run at every tip.

**Acceptance criteria:**
- [x] The approval card renders the complete proposal payload (the full
      input + the authorization-relevant metadata previously dropped).
- [x] Allow requires the explicit "I have reviewed the full payload"
      confirmation (a UI affordance gating answer(); no kernel-evidence
      endpoint).
- [x] An uninspectable payload is NOT-APPROVABLE-WITH-REASON (Allow
      disabled with the cap stated; Deny available) — never
      approvable-with-warning.
- [x] The existing disciplines preserved (deny-on-cancel/switch, one
      prompt per session, the answer route's guards, policy still
      applies on remembered allows).
- [x] The grant lifecycle (expiry/ownership/consumption) queued with
      the building blocks named; the guard-overturn and degraded-hub
      facts recorded.

### W114 - Evidence-endpoint governance: the claim-shaped evidence endpoint removed, not gated (Complete - the fabrication path closed; the authorized-attach design stays queued) (2026-09-24)

**Source:** W110's discovered-and-queued trap — `POST /api/evidence`
accepted client-chosen `subject`+`result` as
HARDCODED-authority:"reviewer" kernel evidence from any same-origin
tab, satisfying a task's evidence gate from a claim. That is the exact
prohibition the W110 guard carried ("never a UI surface accepting prose
as kernel-gate evidence").

**What landed:**
- The `POST /api/evidence` route is REMOVED (src/ui/web.ts), not gated:
  the kernel's authority vocabulary (`environment|host|mcp|reviewer`,
  src/kernel/contracts.ts:17) has no honest class for an operator-typed
  claim, so no gate or re-scope could make the claim-shaped endpoint
  honest. The route's absence — the catch-all 404 for every origin, the
  removed route's own cross-origin 403 check having gone with it — plus
  an unchanged evidence snapshot are the closure observables
  (test/web.test.ts pins rewritten strong-only; the replaced pins
  asserted the hole-y behavior and are superseded, not silently
  weakened: the new set is strictly stronger for the closure).
- The webapp's `RecordEvidenceForm` is removed (src/ui/webapp/app.tsx);
  the Evidence panel stays read-only with an honest note (evidence
  records are produced by the hub's own flows; operator claims are not
  recorded). The honest producers are untouched: the run registry's
  `run:<id>` reviewer verdicts and the hub test runner's environment
  evidence.
- Deliberately NOT done: no kernel authority-vocabulary change (an
  operator/claim authority class is a kernel design with gate semantics
  of its own — its own iteration); the authorized-attach machinery
  (surface the producing flow per missing artifact) stays queued as the
  follow-on this unblocks.

**Acceptance criteria:**
- [x] No request shape can mint kernel evidence: POST /api/evidence
      returns the catch-all 404 for every origin, and the snapshot
      evidence list is unchanged by any attempt (the discriminating
      closure observables).
- [x] Red-first: with only the rewritten pins on the pre-change tree,
      21 pass/1 fail (exactly the closure pins fail against the live
      endpoint); green after: web 22/22, webapp family 47/0, the other
      web suites 57/0, lint + typecheck exit 0.
- [x] The read-only evidence panel remains, with the honest note that
      operator claims are not recorded.
- [x] The honest producers (run-registry verdict flow, test runner)
      unchanged — verified by the untouched src outside the removed
      route/form and the held-out suites.

### W115 - The permission-poll transport cap: an oversized parked payload stops riding the 1 s poll (Complete - the amplify vector dead; the answer-route posture unchanged) (2026-09-24)

**Source:** W112's queued transport note (the poll ships the parked FULL
input UNCAPPED at transport; the 64 KiB cap was render-side only) — the
exact gap W112's review round 1 flagged, named as belonging to the
evidence-endpoint governance scope.

**What landed:**
- The broker classifies the payload ONCE at parking (`classifyInput` —
  one pass producing the 2 KiB preview and the over-cap flag with the
  SAME measure the approval card renders: strings by length, objects by
  pretty-printed JSON length vs the 64 KiB PAYLOAD_INSPECTION_CAP) — so
  transport-strip and NOT-APPROVABLE-WITH-REASON are one classification,
  never two divergent ones. The parked in-memory request is untouched
  for the answer path.
- GET /api/permission shapes the pending through `transportPermissionView`:
  flagged payloads lose `input` and keep the explicit `inputOverCap` flag;
  unflagged requests pass through untouched (the VIEW is identity; the
  wire gains the required `inputOverCap: false` field — harmless, the card
  treats false and undefined identically). POST /api/permission's
  next-parked field is shaped through the same view (review round 1 P3).
- The card treats `inputOverCap === true` as NOT-APPROVABLE-WITH-REASON —
  LOAD-BEARING: without it, a stripped payload (input undefined) would
  skip the render-side cap check and render approvable — an approval
  without review, the exact regression the W112 discipline prevents. The
  flag is fail-restrictive only (a pure OR of disabling terms; it can
  never enable Allow).

**Acceptance criteria:**
- [x] The amplify vector is dead: an oversized parked payload (200 KiB in
      the pin) does NOT ride the poll; the response carries the flag and
      no input; the parked request still answers.
- [x] The under-cap path unchanged: the full input still transports (the
      identity-view pin), the card's approvable path untouched.
- [x] Red/green: 4 pins red on the pre-change tree (62 pass/4 fail —
      exactly the W115 pins), green after (67/67 across permission-broker
      + web + webapp-surface); held-out web suites 72/72; lint + typecheck
      exit 0.
- [x] The W112 transport note superseded with a dated note (append-only).

**Residuals (recorded, not fixed):** the answer route performs no
server-side approvability re-check (a direct POST with a valid id allows
an over-cap request regardless of the card) — the documented W112 posture
("a UI affordance gating the existing answer() route only"), unchanged by
W115; the under-cap wire GAINS `inputOverCap: false` (view-identity, not
byte-identity); the full input still parks in memory at the broker (the
agent's own spend — only the per-poll shipping is capped).
  - Dated note (2026-09-25, the base-loop continuation, iteration 49):
    the round-1 P3 above LANDED ONLY TODAY — the "What landed" list
    claimed it on 2026-09-24, but the merged commit (1e62f97) carried
    only the poll shaping; the answer-route line sat UNCOMMITTED in
    src/ui/web.ts until this session (the W134 deferral note "carries
    the operator's uncommitted W115 work" was the honest record). This
    iteration completed it: the answer route's `pending` rides
    `transportPermissionView` (src/ui/web.ts), the in-flight comment's
    race premise CORRECTED to the reachable truth (a concurrent
    same-session park is PROMPT_BUSY-denied and the field is read
    synchronously with the answer — the reachable non-null path is the
    legacy undefined-key shape, oldest parked overall), and the seam's
    own pin added: RED on the pre-change tree (25 pass/1 fail, the raw
    200 KiB payload in the answer response's `pending`), GREEN after
    (web 26/26; held-out permission-broker + webapp-surface +
    web-sessions 62/62; lint + typecheck exit 0). The under-cap identity
    pin rode along (a guard pin, green on both trees — its comment says
    exactly that). Fresh-eyes review: round 1 REJECT (the reviewer
    sandbox had no shell; four items unverified), the four closures
    cited file:line, round 2 APPROVE. LESS-0055 records the lesson.

### W116 - The parked-items and limitations registry file (Complete - the operator-directed re-address queue; the loop's work-picking source) (2026-09-24)

**Source:** the operator's direction closing the contradiction sweep
("parked items and limitations need to be in their own file so we can
readdress with loops in the future") after PR #107's merge. The
inventory existed only scattered across ledger items and lessons — the
operator had approved it (2026-09-24) but nothing made it the loop's
work-picking surface.

**What landed:**
- `docs/PARKED_AND_LIMITATIONS.md` — one canonical file, two sections
  (**P1-P11 at creation; P12-P16 appended by the round-1 review fixes;
  P17-P18 appended by the round-2 completion pass** — 18 parked items,
  8 recorded limitations), every entry
  carrying its source ledger item, dependencies/conditions, TRUTHFUL
  verification status (landed+verified / structural-only / unmeasured /
  dispositioned-not-audited), and its approval record. File rules:
  append-only, dated supersession notes, entries leave only when the
  work lands (PR linked) or the operator retires them, and future loops
  consult it BEFORE picking work.
- The operator's explicit approval of the limitations and parked items
  (2026-09-24) is recorded in the file's approval record — the honest
  chain: earlier entries rode inside merged PRs (#101-#107) implicitly;
  this file's creation is the explicit approval act.
- TASKS.md's header carries the pointer so every loop entry point
  finds it (the loop reads TASKS.md's header; the `guard_next_tasks`
  tool surfaces TASKS.md content).

**Acceptance criteria:**
- [x] Every entry's facts match its source ledger item (the fresh-eyes
      review round 1 — REQUEST_CHANGES — caught a duplicate invariant
      line, three entry drifts (P1/P4/P9), and FIVE missing queued items;
      all fixed in this iteration's follow-up commit and re-verified by
      the round-2 cross-check, recorded below).
- [x] The file is append-only by stated rule; the operator's approval
      date recorded per entry.
- [x] The discoverability pointer exists in TASKS.md.
- [x] Docs-only: lint/typecheck exit 0.

**Review record (round 1, 2026-09-24, REQUEST_CHANGES — all findings
applied):** the reviewer's source cross-check found: the W116 criterion
was ticked before its named verifier ran (this very round); an unintended
duplicate "The invariant is:" line my header edit introduced; P1's
"metering trail verified unaffected" read as completed (it is future
work); P4's cross-reference pointed at the wrong W109 gap; P9 dropped
the corrected pollution nuance (the trail is polluted via zero-token
events, not absent); FIVE queued items were missing from a file claiming
canonicity (W109 gaps 2/4/6, the budget-downgrade consumer, the
W099/W100 unification implementation). All fixed: the criterion unticked
then re-ticked against the round-2 cross-check; the duplicate removed;
the entries corrected/appended as P12-P16; the guard-discoverability
claim in TASKS.md softened to what is true (the pointer exists in
TASKS.md, the header every loop reads).

**Review record (round 2, 2026-09-24 — TWO passes, honestly incomplete
then completed):** the round-2 reviewer hit its step limit mid-sweep and
honestly reported the cross-check INCOMPLETE (the tick cited a verifier
that had not demonstrably run — the same defect round 1 flagged, in a
new form; its interim verdict: REQUEST_CHANGES). The completion pass
(a fresh reviewer, scope-tightened to the remaining pairs) verified
15/16 pairs + all four limitations faithful (P2/P3/P4/P5/P15/P6/P7/
P9/P12/P13/P14/P10/L3/L4/L5/L6 ✓) and found TWO further omissions from
the file claiming canonical completeness: the ci-intelligence-mcp
pre-existing build/typecheck break (W105's queued item) and the open
W102/W103 wrapper/push residual edges (residual #20's queued edges +
#21's still-open part). Both appended as P17/P18; the W113 numbering
skip noted (no ledger item exists — another session's branch never
landed its item; nothing dangles). Interim verdict: REVISE → the
fixes applied in this commit; the criterion's tick stands on BOTH
passes recorded here.

### W117 - The ci-intelligence build-break probe: the queued defect does not reproduce (Complete - the premise falsified in the committed state; P17 retired to the verification record) (2026-09-24)

**Source:** the park file's P17 (W105's queued item: `error TS18046:
'payload' is of type 'unknown'` twice in mcp-toolbox
`apps/ci-intelligence-mcp/src/github-actions-adapter.ts:171,178`) — the
park file's own rule picked it as a high-value candidate (self-contained,
a live build failure). Per LESS-0015/0018 (probe before implementing),
the END-TO-END state was probed first.

**The probe result: the premise is falsified.** (Facts marked
"executed" below were run by this iteration's session; the fresh-eyes
reviewer — no shell — statically corroborated the core claim and
disclosed the rest as execution-only facts.)
- EXECUTED: `tsc --noEmit -p tsconfig.json` exits 0 in the committed
  tree; the app's suite is 28/28 green (npm test: build + test both
  pass). Statically corroborated by the reviewer: `request` is generic
  (`Promise<z.infer<T>>`), so `payload` is typed, not `unknown` —
  TS18046 at 171/178 is implausible on this source.
- EXECUTED: the adapter source is byte-identical to the vendoring
  commit (8053588) — no code drift.
- The toolchain facts: tsc 5.9.3 (EXECUTED via `tsc --version`);
  zod@3.25.76 lockfile-pinned, and the lockfile pins the SAME zod
  before AND after W105's merge (diff empty) — no lockfile drift; a
  single zod@3.25.76 in the pnpm store and NO zod ^4 anywhere in the
  workspace — no hoist/cross-contamination (read-verified by the
  reviewer from the store listing + the package.json manifests).
- Ruled out: code drift, lockfile drift, sibling zod-4 hoisting. The
  W105-era environment's exact zod/tsc resolution could NOT be
  reconstructed — the failure was environment-dependent and honestly
  stays unexplained beyond "does not reproduce in the committed state".

**Deliberately NOT done:** no src change (there is nothing to fix in
the committed state); no speculative type annotation added (adding a
schema-typing workaround for a non-reproducing error would be
manufacturing work and would drift the file from its pinned
toolchain).

**Acceptance criteria:**
- [x] The probe recorded with its discriminating facts (typecheck exit
      0; tests 28/28; the byte-identity of the adapter since vendoring;
      the ruled-out causes enumerated).
- [x] The park file's P17 superseded with the dated re-verification
      (append-only — the entry stays, its premise retired).
- [x] LESS-0039 records the discipline: probe a queued defect's premise
      BEFORE implementing; an environment-dependent non-reproduction
      retires an entry with a dated supersession, and the unexplained
      root cause stays stated, not guessed.

**Residual (recorded, not fixed):** the W105-era failure's root cause
remains unexplained — if the TS18046 class ever reproduces (a
toolchain/zod drift), the exact error cites in W105's record are the
reproduction recipe; a toolchain pin (a committed typescript/zod
resolution the toolbox already has) is what makes this deterministic
going forward.

### W120 - The dist-freshness gate: the vendored seat cannot mount (or test) stale policy (Complete - the W097-queued pin landed; LESS-0010's hazard closed) (2026-09-24)

**Source:** the park file's P6 (the W097 queue's "dist-freshness pin")
+ LESS-0010's en-route hazard: the hub-side tests ran a stale
vendored-guard dist because the test's ensureBuilt rebuilt only on
ABSENCE — a vendored-guard src change after the last build left the
enforcement seat executing pre-change policy; a hash/mtime check was
queued.

**What landed:** `guardDistIsStale(root)` (the app's src walk vs the
dist mtime); the runtime seat throws fail-closed via the injectable-root
`defaultToolboxGuardServerPath` (naming the remedy); the test's
ensureBuilt self-heals (rebuilds when stale — the hazard's origin fixed
at its origin).

**The live-tree probe (LESS-0039, with a probe-design miss recorded):**
the committed dist/server.js mtime predated src/policy.ts by a day (the
mtime staleness fact); the pre-rebuild artifact was overwritten before a
content comparison could run — the semantic staleness is
probable-but-unproven (the timeline supports it: the src's last commit
f95b4c1 landed Sep 23 22:29 (+1200); the pre-rebuild dist (mtime Sep 23
early) predated it — the rebuilt dist carries `pushedProtectedBranchIn`
(the W108 destination-aware rule), so the old seat was probable-stale).
The remedy: the runtime seat throws fail-closed (naming the remedy) and
the test's ensureBuilt self-heals (rebuilds when stale). The mtime
false-positive class (git checkout touches mtimes) is documented —
fail-closed is the deliberate direction.

**Acceptance criteria:**
- [x] The W097-queued dist-freshness pin landed: 5 pins (the stale
      fixture, the fresh fixture, the runtime throw naming the remedy,
      the runtime throw naming `toolbox:build`, and the real-tree
      conditional pin asserting the checked-out dist is fresh).
- [x] Red/green: the pins red at module level (the export absent),
      12/14 after the implementation (the orchestrator's fixture slip —
      the missing mcp-toolbox segment — diagnosed by the executor's
      evidence), 14/14 after the fixture repair; lint + typecheck exit
      0; the consumer suite (hub-guard-interception) green.
- [x] The test's ensureBuilt self-heals: a stale dist rebuilds before
      the suite exercises the server (the LESS-0010 hazard's origin
      fixed at its origin).
- [x] The runtime seat throws fail-closed on staleness (the enforcement
      composition cannot silently run pre-change policy); the mtime
      false-positive class documented.

### W118 - The budget-downgrade consumer, part 1: the warn-tier stage composes at the governed transformBody lane (Partial - the transform + env axes + the no-key-lane composition landed; the OpenRouter-lane variant and the wiring breadth queued) (2026-09-24)

**Source:** the park file's P15 (the W095 budget-downgrade consumer,
queued since the routing design note) — the top self-contained candidate
after P17's retirement: the seam landed (W109's transformBody), the
design recorded (the note's key-2 + the round-3 fail-open posture), the
wiring shape clear.

**What landed (part 1):**
- The warn-tier axes (session-budget.ts): `WORKFLOW_BUDGET_DOWNGRADE_MODEL`
  (required) + `WORKFLOW_BUDGET_DOWNGRADE_FRACTION` (default 0.8, must
  parse to (0,1)) — `budgetDowngradeFromEnv` fails CLOSED to undefined
  (a broken downgrade axis degrades to no-downgrade, the status quo
  ante; unlike parseCap's throw, because a broken CAP must never degrade
  to unenforced while a broken DOWNGRADE degrades to the safe default);
  `budgetDowngradeActive(usage, budget, fraction)` mirrors
  budgetViolation's per-dimension comparison at the warn fraction.
- The transform stage (model-usage-proxy.ts): the `budgetDowngrade`
  option composes a rewrite stage AFTER the caller's transformBody (the
  shaped body's model rewritten to the target when the proxy's OWN
  recorded usage has crossed the warn fraction — a per-request read of
  the mutating metrics object). The FIFTH bounded deviation from pure
  pass-through and the THIRD transformBody consumer (the header
  enumeration synced — it already anticipated this consumer).
- The governed-lane composition (open-model-proxy.ts + acp-runtime.ts):
  the open-source lane's transformBody (the only production
  transformBody consumer per the round-3 review) composes the stage;
  the runtime passes the env-parsed axes and additionally requires
  budget caps to exist (no caps = nothing to warn about).
- The OpenRouter-lane allowed_models-narrowing variant (the auto-router
  downgrade per the design note) and the per-family usage-granularity
  residual (a session spreading traffic across family proxies sums
  separately) are QUEUED.

**Acceptance criteria:**
- [x] Red/green: 4 pins red at compile level (the exports/option did not
      exist), 17/17 after the stage (the executor hit its step limit on a
      pin contradiction — the orchestrator resolved it: the pin's
      timeline model had an off-by-one, the crossing is observable one
      request AFTER the crossing usage records, exactly the W095 note's
      "routes remaining turns" semantics), 29/29 with the budget
      held-outs; lint + typecheck exit 0.
- [x] The governed-lane end-to-end pin (LESS-0030: through the REAL pool
      composition, not a synthetic path): pre-crossing untouched,
      remaining turns rewritten, sticky, and the metering trail records
      identically on both sides of the rewrite.
- [x] The pass-through posture pinned: absent the downgrade config the
      model rides untouched at any usage level.
- [x] The abort tier untouched: budgetViolation's comparison and the
      W045 cancel-at-cap unchanged (the downgrade is the middle step).

**Residuals (recorded, not fixed):** the abort tier is BLIND to the
open lane (the fresh-eyes round-1 P2, pre-existing W045-era:
composeSessionWithBudget wires the guard with the OpenRouter proxy's
metrics only, so the open lane's traffic is invisible to the abort tier
while the W118 downgrade activates on exactly that traffic — feeding
the guard the aggregated pool metrics is the queued design change, and
until then neither tier sees open-lane usage). RESOLVED (W119,
2026-09-24, the next iteration): the guard's usage snapshot AGGREGATES
the pool's metrics with the OpenRouter proxy's
(`composeSessionWithBudget`'s optional `additionalUsage`; the open
lane's runtime wired; the violation reason echoes the aggregated total,
pinned) — the abort tier now sees the open lane and the downgrade warn
tier covers the same usage; the OTHER residuals ((a) the OpenRouter-
lane variant, (b) the per-family granularity, (d) the fail-open
composition semantics, (e) the warn-threshold source, (f) the
fail-closed silence) stand. RESOLVED (W122, 2026-09-24): (f) the
fail-closed silence — `budgetDowngradeFromEnv` now warns `[budget]`
naming the axis and the raw value on the operator-asked fail-closed
paths, honest absence stays silent, and the fail-closed posture is
unchanged (the W122 item).

### W119 - The abort tier sees every lane: the guard's usage snapshot aggregates the open-source pool (Complete - the W118-era blindness residual closed) (2026-09-24)

**Source:** the W118-era recorded residual (park P15 (c); the W118
item's residuals; PR #112's fresh-eyes round-1 P2):
composeSessionWithBudget wired the W045 budget guard with the OpenRouter
proxy's metrics only — the open lane's traffic was invisible to the
abort tier while the W118 downgrade activates on exactly that traffic.

**What landed:** `composeSessionWithBudget` gains an optional
`additionalUsage` snapshot; the field-wise `aggregateUsage` helper
(latestPromptTokens stays the primary lane's — display-only, no cap
reads it); the open-model-pool runtime site wired
(`openPool.metrics()`, the pool's cross-family aggregate); the
cline/goose sites unchanged and recorded (their only lane IS the
OpenRouter proxy — complete by construction); the azure direct path
unchanged (no local metering — the pre-existing honest statement).

**Acceptance criteria:**
- [x] The governed-lane pin: the violation reason echoes the AGGREGATED
      total ("total tokens 2100 > cap 1000" — primary 100 + pool 2000)
      through the real session semantics (submit -> event -> cancel ->
      sticky refusal).
- [x] Absent additional usage the snapshot is exactly as before (the
      helper returns `a` when `b` is undefined; the pre-W119 callers
      unchanged — pin (b) is the regression hold-out, green before AND
      after, NOT a red: the honest prediction correction).
- [x] 31/31 across session-budget (13) + open-model-proxy (6) +
      mutation-budget + opencode-server-budget + hub-rsi; lint +
      typecheck exit 0.

### W121 - The decision record carries the matched surface: G4, the assessment's F6 residual (Complete - matched threaded vendored -> server -> seat; absent-never-fabricated) (2026-09-24)

**Coordination provenance (the concurrent-agent relay, 2026-09-24):** the
W121 number was deliberately left unclaimed by the other agent's stream
(their W122 — the fail-closed-silence logging, my W118 residual (f) —
rides origin/fix/w122-budget-downgrade-logging with LESS-0045); this
iteration's lesson takes LESS-0046 accordingly, and the merge rule is
append-only in id order (LESS-0009) — either merge order leaves the id
sequence hole-free. The regions are independent: W121 is the vendored
guard core (mcp-toolbox/apps/workflow-guard-mcp/src + the seat), W122 is
the session-budget lane.

**Source:** the park file's P6 (the G4 matched-surface field) — the
agents-research assessment's F6 residual: the guard's structured record
carries rule ID + reason but the matched surface (path/command) is
embedded in reason text, not a separate queryable field (src/policy.ts's
decision type).

**What landed:**
- The vendored `GuardDecision` gains `matched?: string` — the concrete
  surface the rule matched (the command for shell/git lanes, the path
  for file/interpreter lanes, the toolName for mcp) — threaded through
  all four sub-modules (boundary/interpreter/git/shell deny returns) and
  policy.ts's own file_write/mcp sites (the composition sites return the
  sub-module objects directly, so matched propagates).
- Absent-never-fabricated: allows, the promotion-gate ask, the network
  ask, and secret-content carry NO matched (secret-content's surface is
  the content itself, not a queryable path/command; the reason carries
  it).
- The server's outputSchema + structuredContent carry it (conditional
  spread); the seat's `GuardDecision` normalization carries it (the
  vendored -> server -> seat chain complete).
- The interpreter lane's matched is the extracted payload path (the
  truthful in-scope variable — the executor's judgment over the spec's
  mis-scoped match[1], accepted).

**Acceptance criteria:**
- [x] Red/green: 3 deny pins red (the field absent), 91/91 after (6 W121
      pins: the protected-path/shell/read-only/interpreter matched + the
      allow/promotion-ask absent hold-outs); the seat suite 16/16 in the
      worktree; lint + typecheck exit 0.
- [x] The matched field is queryable per decision — the F6 residual's
      "embedded in reason text" closed for all five lanes.
- [x] The W120 freshness gate enforced the dist rebuild before hub-side
      verification (the dogfooding moment: the hazard W120 closed would
      have silently left this change unmounted).

**Residuals (recorded, not fixed):** the strict-recorder adjacency
(upstream #167) remains queued; the matched field's DISPLAY (the
webapp's guard-decision rendering) is not part of this slice — queued;
the seat's G2 part 2 (trustedRole) is a separate park entry (P6).

### W122 - The fail-closed silence closes: a malformed downgrade axis warns `[budget]` instead of disabling silently (Complete - the W118 residual (f) / park P15 (d) closed) (2026-09-24)

**Source:** park P15 (d) + the W118 item's residual (f) ("the
fail-closed silence: a malformed axis silently disables the downgrade;
operator-facing logging queued"): W118's `budgetDowngradeFromEnv`
returned undefined silently on the two operator-asked paths — a
malformed fraction with a target set, and a fraction without a target —
so an operator who configured the downgrade never learned it was off
(the W045 guard's own never-silent posture, applied to configuration).

**Prediction (registered before the edit):** the parse fires exactly
one `[budget]`-prefixed warning naming the axis and the raw value on
the two operator-asked fail-closed paths and still returns undefined
(the fail-closed posture unchanged); valid configs, honest absence, and
the blank-target path stay silent; the return semantics and the
runtime shapes are untouched. At-risk regressions: the consumer suites
(open-model-proxy, model-usage-proxy) and the strict compile of the new
optional parameter.

**What landed:** the injectable `warn` parameter (the containment
platform.ts pattern) on `budgetDowngradeFromEnv`, defaulting to
`(message) => console.warn(\`[budget] ${message}\`)`; the two
operator-asked fail-closed paths warn (the malformed fraction names the
axis + the raw value + the configured target; the missing-target path
names the missing axis + echoes the set fraction); honest absence
(nothing set; a blank target with no fraction) stays silent; the stale
in-code residual comment superseded in place.

**Red/green:** the pins authored FIRST against the pre-change src:
3 red (a malformed fraction warns once and still fails closed; a
fraction without a target model warns; the default warn reaches the
operator console) — runtime reds under tsx AND compile-level red
(tsc exit 2: six TS2554 at the red-first snapshot's pin call sites —
the final pin set carries 8 two-arg call sites); 1 regression hold-out
green before (runtime-scoped: tsx strips the ignored second argument —
at compile level the hold-out too would be TS2554 against the
one-param signature) AND after by design (valid configs and honest
absence stay silent); the 13 pre-existing pins green throughout. After the
implementation: 17/17 session-budget; 21/21 consumers (open-model-proxy
+ model-usage-proxy); lint exit 0; typecheck exit 0.

**Acceptance criteria:**
- [x] The operator-asked fail-closed paths warn (`[budget]` prefix; the
      axis named; the value echoed; once per parse — the single
      runtime-composition call site keeps it non-spammy).
- [x] The fail-closed return is UNCHANGED (pinned per raw value: 1.5,
      0, abc all still return undefined — the warn never softens it).
- [x] Honest absence stays silent (nothing set; a blank target with no
      fraction; a whitespace-only fraction is unset per parseCap's
      convention — the hold-out pins freeze the interpretation).
- [x] The production default is operator-facing through the real
      console.warn (pinned through the un-injected default path).
- [x] The recording sites updated in the same change: park P15 (d), the
      W118 item's residual (f), the in-code comment.

**Deliberately NOT done:** the remaining P15 residuals ((a) the
OpenRouter-lane allowed_models-narrowing variant, (b) the per-family
usage-granularity residual, (c)/(e) the warn-threshold source decision)
stay queued — each is an operator/design decision, not a logging fix;
no composition-level wiring change (the default warn fires at the
existing createOpencodeRuntime call site, once per runtime
composition). Region note: the id gap is deliberate — W121 (and the
LESS-0044 slot, which the concurrent W120 stream's branch carried and
which has since merged as PR #114) left for that stream; this item
rebases onto main@d2fce29 so the docs tails splice in id order
(W120 → W122, LESS-0044 → LESS-0045 — LESS-0009).

### W123 - The anthropic Messages lane meters honestly: the extraction's shape key corrected (P9 part 1 - the pollution closed; the transform-governance half stands) (2026-09-24)

**Source:** the operator-starred stream (P9 → P12 → P4, directed
2026-09-24); park P9's recorded nuance (the W109 review round-1
correction): the metering pipeline gates on /chat/completions — the
anthropic messages path passed through UNTRANSFORMED, and the
OpenAI-shaped extraction keyed `prompt_tokens`/`completion_tokens`
against the anthropic usage shape (`input_tokens`/`output_tokens`/
`cache_creation_input_tokens`/`cache_read_input_tokens`), so every
anthropic event landed as `usageEvents += 1` with ZERO tokens — the
budget tiers' input was polluted, not absent.

**The two prerequisite records the park entry demanded (recorded in
this change):** the anthropic usage shape (the non-stream message
response's `usage`; the stream splits it across message_start's
`message.usage` and message_delta's `usage`, CUMULATIVE — "not a
delta", summing double-counts; the recorded cautionary instance is
langchainjs #10249); the replay policy's Messages-schema compatibility
(`enforceReplayPolicy` stays chat-completions-scoped; the
anthropic-messages transport is W070b's sanctioned synthetic-tool-call
path and remains replay-ungated — the Messages-schema integrity check
is the queued successor decision).

**What landed:** the extraction keyed on the anthropic wire type
(`type: "message"` JSON; `message_start`/`message_delta` SSE) — the
type the chat-completions lane never carries, so no misclassification;
the cache components normalize INTO the prompt side (the cross-lane
normalization recorded on the page: anthropic excludes them from
`input_tokens`, OpenAI includes them in `prompt_tokens` — the W045/W118
caps and the metering trail mean the same thing on both lanes, and the
W119-aggregated abort tier now sees the anthropic lane's real token
mass); the SSE stream accumulates last-observed-per-field and emits ONE
usage event per message at stream end (usageEvents semantics unchanged:
1/message on both lanes); the raw anthropic fields ride `onUsage`
untouched (P12's seam); the cost boundary (the anthropic usage carries
no cost field — the lane's local cost stays unmeasured, bounded
server-side by the OpenRouter per-key credit limit) and the transform
boundary (the lane stays untransformed — the governance half of P9
stands) recorded in the extraction's docs.

**Red/green:** the pins authored FIRST against the pre-change src:
2 red (the JSON lane's real-token sums: prompt 220 / completion 30 /
total 250 from input 120 + cache 40/60; the SSE lane's one-event-per-
message accumulation: usageEvents 1 with prompt 79 / completion 23 /
total 102 from the cumulative start+delta pair — NOT the naive += 88/24)
— runtime reds only (no new exports, so no compile-level red this
iteration, unlike W122); 2 regression hold-outs green before AND after
by design (an anthropic error payload meters nothing; a chat-completions
usage with anthropic-style keys still records zeros — the type-keyed
boundary frozen as-found); the 15 pre-existing pins green throughout.
After: 19/19 model-usage-proxy; 23/23 consumers (session-budget 17 +
open-model-proxy 6); lint exit 0; typecheck exit 0.

**Acceptance criteria:**
- [x] The anthropic JSON lane records real tokens (the zero-token
      pollution closed; usageEvents unchanged at 1/message).
- [x] The anthropic SSE stream emits ONE usage event per message from
      the cumulative events (the double-count hazard discriminated by
      exact sums).
- [x] The cache components normalize into the prompt side with the
      rationale on the page; the raw fields ride onUsage (P12's seam —
      no wire re-derivation needed later).
- [x] The two prerequisite records landed (the usage shape; the replay
      policy's Messages-schema compatibility) plus the cost and
      transform boundaries.
- [x] The chat-completions lanes are untouched (the two existing frozen
      pins + the type-keyed hold-out).

**Deliberately NOT done:** the transform-governance half of P9
(shaping/markers/downgrade on the messages lane) — decision-first,
stands as the recorded residual; the Messages-schema replay integrity
check — the queued successor decision; the metrics model's first-class
cache fields — P12's next loop (the operator-starred order), now
unblocked since the trail is trustworthy. Recorded residual (the
review round-1 P3): a mid-stream reader failure on the anthropic SSE
lane loses the buffered pending record (no emit) where the
chat-completions lane keeps partial parse-time usage — the failure-
path asymmetry is unmeasured and unpinned, left to P12's loop (the
pre-W123 baseline on that path was zero-token pollution, so no
regression). Region note: W121 (and the
LESS-0046 slot) stay free for the concurrent stream; this lands as
W123/LESS-0047 off main@74a13a0.

### W124 - The compiled launcher's web surface: the webapp bundle entry is layout-aware (Complete - the src-vs-dist skew closed; the operator's live failure reproduced and fixed) (2026-09-24)

**Source:** the operator's live failure during launcher testing (PR #116's
post-merge): `npm run build && node dist/cli/workflow.js` surface 1
failed esbuild with "Could not resolve
/var/home/hunter/Workflow/dist/ui/webapp/main.tsx" — the webapp bundle
seam resolved its entry as a SIBLING of the module file, which is true in
source mode (tsx runs src/ui/webapp/bundle.ts beside main.tsx) but broken
in the compiled layout (tsc emits dist/ui/webapp/main.js; a .tsx never
exists in dist). The LESS-0012 dual-surface parity rule (the src-vs-dist
skew returns as behavioral divergence between seats) applied to the
webapp bundle seam.

**What landed:** `resolveWebappEntry(moduleUrl)` in
src/ui/webapp/bundle.ts — LAYOUT-AWARE: the source sibling first, then
the src copy three directories up from a dist location (the
tsconfig.build rootDir/outDir math verified against the real layout),
then an error naming BOTH candidates (fail-closed, diagnosable);
`buildWebappBundle` calls it lazily with `import.meta.url` (not
module-load — the error surfaces where it is actionable). The compiled
launcher's web surface is the only affected path (source mode
`npm run web` was never broken).

**Acceptance criteria:**
- [x] Red/green: the pins red at module level (the export absent — the
      operator's tree reproduced the failure live), 4/4 after (the src
      sibling, the dist fallback, the named-candidates error, the real
      repo in both layouts); the fix's commit state verified (the
      reviewer's reflog P1 — the fix rode a mislabeled test(webapp)
      commit, split into properly-labeled commits and the
      fixture-mkdir/regex corrections re-applied on top).
- [x] The both-candidates regex per review (the pin asserts the ordered
      pair — the dist candidate, then " and ", then the src candidate; a
      message dropping either fails the pin).
- [x] The interim workaround recorded: `npm run web` (tsx mode) was never
      affected; the compiled path is what this closes.

**Residuals (recorded, not fixed):** the "real compiled layout" pin is a
simulated dist-shaped module URL — the operator's live
`node dist/cli/workflow.js` repro is the live verification; the
"real compiled layout" wording corrected to "a dist-shaped module URL"
per review (the pin exercises the fallback logic, not a built
artifact); the fixture prefixes all renamed to w124-* per review.

### W125 - The compiled-artifact smoke: the dist seat becomes a test seat (Complete - the W124 recorded residual closed: the real compiled bundle and the compiled launcher are executed by the suite, not only by the operator) (2026-09-24)

**Source:** W124's recorded residual — "the pin exercises the fallback
logic, not a built artifact." The W124 pins ran `resolveWebappEntry` over
simulated dist-shaped module URLs; no suite test had ever imported the
real compiled module or executed a compiled bin, and every webapp test
sat in the source seat (they load `../src/ui/webapp/bundle.js` under
tsx, where the sibling resolution is valid). The operator's manual UAT
(`npm run build && node dist/cli/workflow.js`) was the only compiled
runner — which is exactly how the W124 skew was found live. LESS-0048's
two-seats rule (a fix verified in one seat only is "Partial") made
executable; LESS-0012's dual-surface parity rule generalized from the
toolbox's in-process import to a compiled-smoke pin for the main dist.

**What landed:** `test/webapp-bundle-dist.test.ts` — two pins, both
self-healing via the W120 conditional-pin pattern generalized to the
main dist (`ensureBuilt`: a missing artifact is the rebuild's job, not
staleness — the same two-error-class split; any src file newer than the
artifact under test is stale; the mtime false-positive class is W120's
recorded deliberate fail-closed, the rebuild idempotent): (1) the
webapp-bundle pin imports the REAL `dist/ui/webapp/bundle.js` and
executes `buildWebappBundle()`, asserting js (the `composer-chips`
markup hook — a literal that survives minification) and css (the
`--accent` design tokens — the css side-effect import must resolve in
the dist graph); (2) the compiled-launcher smoke spawns
`node dist/cli/workflow.js doctor` end-to-end — the suite's first
compiled-bin execution — asserting the report renders with its checks
and that exit 0/1 are the only honest outcomes (warns and fail rows are
environment truth; a signal, a timeout, or any other status is a
compiled-runtime crash).

**Acceptance criteria:**
- [x] Red/green across the seat boundary: the pre-fix dist (the
      operator's UAT build, still on disk when this loop began) rejected
      `buildWebappBundle()` with the operator's live failure verbatim
      ("Could not resolve /var/home/hunter/Workflow/dist/ui/webapp/
      main.tsx"); the post-fix dist produced js=1,032,865 / css=53,304.
- [x] The self-heal exercised, not assumed: touching a src/ui/webapp
      mtime triggered the in-pin `npm run build` and the pins passed on
      the rebuilt artifact (the rebuild path runs green under the test
      runner).
- [x] Hold-outs 29/29: the four W124 pins, the source-seat web tests
      (incl. the /app.js bundle-serving check), the uncommitted W115
      poll pins.
- [x] lint + typecheck exit 0 — which surfaced six no-useless-escape
      lint errors in the W124 pin file's review-round regex (trunk lint
      was red despite LESS-0048's "lint exit 0" evidence; the gate was
      not re-run on the final commit state) — fixed here as the lint
      gate's own finding.
- [x] The round-1 fresh-eyes review (five axes) accepted; its P2 fixed
      pre-recording: the staleness walk omitted the build's CONFIG
      inputs (tsconfig.json, tsconfig.build.json, package.json,
      package-lock.json) — a config-only change with no src mtime bump
      would have skipped the rebuild, the walk-narrower-than-input-graph
      lie LESS-0049(4) declares, applied to the pin itself; the config
      inputs now ride the staleness comparison (6/6 pins + lint +
      typecheck re-run green after the fix). The reviewer's second P2 is
      recorded, not actionable: its sandbox had no shell, so the gate
      runs are operator-attested (its static inspection confirmed the
      structural claims).
- [x] The round-2 fresh-eyes review (the committed-state re-review the
      PR preflight's fingerprint rule demanded) accepted with one P2,
      fixed pre-recording: the bundle pin's staleness walk covered only
      src/ui/webapp while the bundle's real input graph could extend
      cross-tree (all cross-tree imports are type-only today — erased by
      esbuild — so the walk was correct by unasserted invariant), the
      walk-narrower-than-input-graph lie again; resolved STRUCTURALLY by
      widening both walks to all of src — the whole-dist remedy's true
      input graph (`npm run build` rebuilds everything, so the walk
      cannot be narrower than what the remedy consumes). The P3s
      recorded: ensureBuilt copies W120's shape (the W120 predicate is
      hardwired to the vendored-app layout); the doctor probe is
      deliberately non-hermetic — stated in the pin's comment with both
      probe bounds now verified in source (probeHub's and the gateway
      probe's 2s AbortSignals, hub-client.ts:49 / opencode-health.ts:43,
      plus the 120s spawn timeout); execFileSync("npm") is POSIX-shaped
      (the repo is Linux/bubblewrap-targeted).

**Residuals (recorded, not fixed):** the launcher smoke covers the
`workflow.js` dispatcher and doctor's compiled graph (arg parsing, hub
client, settings, fleet, probe verdicts, posture); the other nine bins
(`workflow-web`, `workflow-tui`, `workflow-hub`, …) carry the same
zero-execution gap until a per-bin smoke or a doctor-style sweep covers
them. The dist seat still presumes devDependencies (esbuild is a
devDependency — a packaged install cannot run the webapp bundle at all;
adjacent to the P6 npm-pack verifier debt, unchanged by this loop).

### W126 - The per-bin compiled smoke: every bin executes its compiled artifact (Complete - the nine-bin zero-execution residual closed; the sweep's first red closed a live defect: the standalone monitor died on first render) (2026-09-24)

**Source:** W125's recorded residual — the launcher smoke covered the
`workflow.js` dispatcher + doctor, and "the other nine bins carry the
same zero-execution gap." Each bin's first compiled execution in the
suite.

**What landed:** `test/compiled-bins-smoke.test.ts` — a per-bin sweep,
every probe SAFE by construction (no agent or daemon outlives the probe;
every homedir write lands under a redirected HOME; no browser opens; no
PTY is ever allocated; the monitor never auto-spawns a hub —
`WORKFLOW_AUTOHUB=0`): five fail-fast probes (tui refuses an unknown
driver at the composition seam BEFORE any driver spawn; shell boots its
banner and exits cleanly on stdin EOF; attach fails closed with the
actionable remedy under `--no-autostart`; the opencode-server rejects
unknown arguments BEFORE any guard/runtime composition; rsi prints its
usage), and four daemon probes that start, wait for the startup banner,
SIGTERM, and pin the TEARDOWN exit the surface's own handler produces
(web 0, hub 0 with the W120-fresh vendored guard seat, admin 0,
ephemeral ports throughout). The shared compiled-dist freshness gate
moved to `test/fixtures/compiled-dist.ts` (a third inline copy was the
round-1 cleanliness P3, preempted).

**Discovered and fixed — the sweep's first live defect:** the monitor's
standalone fallback (no hub) died on first render with "no active
workflow task selected" — the mode bar installs its gate on mount
(tui.tsx's mount effect calls `onModeChange` unconditionally) and
`applySkillGating` reads the active task, but the standalone seed was
never activated (universal-tui survives because its session start
activates; the monitor never starts a session; the operator's hub is
always running, so this path was never exercised live). Fixed:
`ink-tui.tsx` standalone calls `application.startInteractiveTask()`
before rendering. What remains in a non-TTY seat is ink's own honest
limit (`Raw mode is not supported`) — the monitor probe pins it as the
environment truth it is.

**Discovered and queued (not fixed):** `workflow-opencode-server --help`
returns args without exiting (parseDaemonArgs) — the flag STARTS THE
DAEMON instead of printing usage. The fix is its own item (help must
print and exit before composition).

**Acceptance criteria:**
- [x] Red/green across the sweep: the monitor's first red was the live
      crash (the defect above); after the fix, its remaining red is ink's
      honest raw-mode boundary — pinned as the environment truth it is.
      9/9 bins green.
- [x] Every probe is safe by construction: no agent spawns, redirected
      HOME (fresh tmp per probe), ephemeral ports (port 0 / hub bridge
      port 0), controlled SIGTERM with the surface's own teardown exit
      pinned.
- [x] Hold-outs 29/29 (web + W124); lint + typecheck exit 0 (after
      fixing the strict-mode exitInfo finding typecheck itself caught).
- [x] The hub probe self-heals the vendored guard seat (the W120 gate's
      own remedy) before composing.
- [x] The PR preflight's manifest/lockfile check caught a PRE-EXISTING
      drift the W127 build-script edit surfaced: the lockfile's root bin
      map still recorded `workflow → dist/cli/web-launch.js` (a stale
      pre-restructure entry) while the manifest carries the real ten-bin
      map; the lock-only install synced it and dropped a drifted optional
      peer row — recorded as the preflight's own finding (no dependency
      changes: the audit stays 426 packages, 0 vulnerabilities).
- [x] The round-3 fresh-eyes review (committed-state) accepted with three
      P3s, all fixed pre-recording: the freshness gate now covers the
      prebuilt emitter script (a script-only edit rebuilds — the gate's
      walk previously missed scripts/build-webapp-bundle.mjs); probeDaemon
      spawns detached and kills the child's PROCESS GROUP (the
      broken-teardown scenario the hub probe exists to catch cannot orphan
      the hub's guard child — the kill-group pattern of
      opencode-attach's terminateProcessGroup); the hub probe's pnpm
      remedy failure now names the actionable fix (and the repo's own
      preserve-caught-error lint rule caught the missing cause
      attachment). The reviewer's honest residue is recorded: its sandbox
      could not read the ledger/lessons tails or four CLI sources, so
      those claims are operator-attested (its verified set — the six
      safety seams it traced — held fully).

**Residuals (recorded, not fixed):** universal-tui's real-driver path
remains unexercised (it spawns an agent — out of the default suite's
bounds by the operator resource directive); the opencode-server `--help`
latent bug is queued (above); a headless monitor snapshot mode (ink
Static) is a possible future surface, not queued.

### W127 - The packaged seat: the webapp bundle is prebuilt into dist (Complete - the W125 recorded limitation closed: the packaged install serves the operator UI without esbuild and without src) (2026-09-24)

**Source:** W125's recorded residual — "the dist seat presumes
devDependencies (esbuild is a devDependency — a packaged install cannot
run the webapp bundle at all)." A packaged install ships `dist/` only:
no `src/` (so W124's three-up fallback entry is absent) AND no
devDependencies (so runtime esbuild bundling fails — worse, the STATIC
esbuild import failed the compiled module's LOAD itself).

**What landed:** `scripts/build-webapp-bundle.mjs` — the build emits
`dist/ui/webapp/prebuilt.js` + `prebuilt.css` beside the compiled module
(options mirroring bundle.ts's runtime build; the npm build script gains
the step); `bundle.ts` serves the prebuilt artifacts when present (the
dist seat, and therefore the packaged seat) and falls back to the
runtime build otherwise (the source seat keeps that path); the esbuild
import went LAZY so the prebuilt seat never loads the devDependency at
all. Two new pins: the runtime fallback executed by the REAL compiled
module (the W124 resolution, no prebuilt beside it), and the packaged
seat — dist/ui/webapp copied WITHOUT src and WITHOUT node_modules —
serving the prebuilt bundle verbatim.

**Acceptance criteria:**
- [x] Red/green: the packaged pin's first red was the missing prebuilt
      artifacts (copyFileSync ENOENT — the build emitted none); the
      static-import hazard it guards is the module-load mechanism
      ("Cannot find package 'esbuild'") the lazy import removes by
      design. Post-fix: the packaged seat assembles and serves verbatim;
      the fallback pin proves the W124 resolution still executes in the
      compiled seat.
- [x] The dist seat now serves the prebuilt artifact in ~6ms (the
      runtime esbuild build took ~100ms) — the compiled launcher's web
      surface gets faster in the same change.
- [x] Hold-outs 29/29; lint + typecheck exit 0; 13/13 across the
      compiled-seat files (9 bins + 2 W125 + 2 W127).
- [x] The W125 residual updated: the "presumes devDependencies"
      limitation is closed; the npm-pack verifier debt (P6, human-gated)
      remains adjacent and untouched.

**Residuals (recorded, not fixed):** the prebuilt options and the
runtime options are two sets that must stay in sync (the mirroring is
comment-bound, not enforced); the packaged seat's OTHER flows (fleet
install, hub composition from a packaged tree) remain unmeasured —
adjacent to the P6 npm-pack verifier debt, still human-gated.

### W128 - The e2e stream: the hub contract, the compiled web service's API, and the real packaged install (Complete - three surfaces, three parallel subagents; the packaged e2e's first run found and fixed a real shipped-nowhere postinstall target) (2026-09-24)

**Source:** the operator's direction ("a set of sub agents start to
write e2e testing to start catching bugs"), landing on the honest gaps
W125-W127 left: the compiled seats proved START + teardown (the sweeps)
but not BEHAVIOR (the source seat's API tests never ran against dist —
LESS-0012's divergence class), and the packaged install had never been
run at all (W127 recorded the residual).

**What landed:** three e2e files written by three parallel subagents
(each owning exactly one file, each under the LESS-0051 safety
contract):
- `test/e2e-hub.test.ts` — the compiled hub's discovery contract and
  HTTP surface: the discovery file's shape per workflow-hub.ts's write,
  the /health probe, the authenticated canonical route, the honest
  refusal of the unauthenticated shape, and the clean teardown's
  discovery/verifier/lock unlink, all under the redirected HOME with the
  vendored guard seat self-healed per W120.
- `test/e2e-web-service.test.ts` — the compiled web service's API flow:
  the shell page, /api/snapshot's observed shape, a kernel transition
  through POST /api/transition reflected in the next snapshot, and
  /app.js + /app.css served BYTE-FOR-BYTE equal to the W127 prebuilt
  artifacts (the composition executed over real HTTP).
- `test/e2e-packaged-seat.test.ts` — the real tarball: `npm pack`, the
  shape pin (the prebuilt artifacts and the launcher bin present; no
  src/ or test/ trees), the extracted tarball's webapp module executing
  with ZERO dependencies (a tree outside the repo, so node_modules can
  never resolve — the W127 laziness executed for real), and the full
  `npm install` of the tarball into a prefix followed by the packaged
  doctor from the installed bin.

**Discovered and fixed — the e2e stream's first shipped-nowhere
defect:** the packaged e2e's runs found that `package.json`'s
`postinstall` runs `node scripts/prepare-tool.mjs` but `files[]` shipped
no `scripts/` entry — every lifecycle-executing tarball install would
fail at postinstall with ENOENT (masked in this environment only by
npm 12's install-scripts gate, which skips lifecycle scripts by
default). Fixed: `files[]` ships `scripts/prepare-tool.mjs`; the shape
pin now enforces the postinstall target's presence. The hook's own
execution remains an npm-12-gated residual (recorded, not faked).

**Discoveries recorded (observed truth, pinned):** the hub's
authenticated snapshot serves an EMPTY tasks projection on a fresh hub
— the seeded "interactive" placeholder is suppressed by run-registry's
hiddenSnapshotTaskIds (the doctor-era seed is not user-facing state);
hub-http refuses every non-POST method with 401 — the health probe is
POST+Bearer, never GET (hub-client.ts's probeHub); the web service's
seed literals read BLOCKED but the live API serves W001 READY (the
kernel's dependency recompute — correct-by-design, a source-reader trap
worth naming).

**Acceptance criteria:**
- [x] 5/5 e2e green (hub, packaged ×3, web service); 18/18 across the
      whole compiled-seat suite (9 sweep bins + 2 W125 + 2 W127 + 5
      W128); lint + typecheck exit 0.
- [x] The postinstall target ships and the shape pin enforces it (the
      defect fixed in the loop that found it).
- [x] Every file under the LESS-0051 safety contract (no agent/PTY
      spawns; redirected HOME; ephemeral ports; controlled SIGTERM with
      pinned teardown exits; spawnSync-timeout only for self-exiting
      processes).
- [x] Hold-outs 29/29 (web + W124).

**Residuals (recorded, not fixed):** the postinstall hook's own
execution is npm-12-gated (the pin proves the shipped tree, not the
lifecycle run); the TUI surfaces' real-driver e2e stays out of bounds
(agent spawns); the fleet-install flow from a packaged tree is now
partially covered (install + doctor) — its remaining flows queue behind
the P6 npm-pack verifier debt (human-gated).

### W129 - The help contract: every bin resolves --help before any side effect (Complete - W126's discovered-and-queued defect closed as a class; previously six bins started their surface on --help, one printed a token, one could start the agent) (2026-09-25)

**Source:** W126's discovered-and-queued defect —
`workflow-opencode-server --help` started the daemon instead of printing
usage. The survey for this loop showed it was a CLASS: only
`acp-remote.ts` resolved help correctly (parse → `help: true` → print
USAGE → return); `opencode-attach --help` proceeded into
`ensureDiscovery`, whose autostart path could START THE DAEMON;
`universal-tui --help` fell through to `composeDriver` and could START
THE AGENT; the module-level daemons (`hub`, `admin`) started on ANY
argv; `web-launch`, `ink-tui`, and `contained-shell` ignored the flag;
`rsi --help` was rejected as an unknown command.

**What landed:** the help contract — every bin resolves `--help`/`-h`
to a usage block and exit 0 BEFORE any composition:
- parser-level (the acp-remote pattern): `opencode-server`
  (`parseDaemonArgs`), `opencode-attach` (`parseAttachArgs`),
  `universal-tui` (`parseUniversalArgs`), `rsi` (`--help`/`-h` map to the
  help command). The `help?: true` field is ADDITIVE (present only when
  requested), so the existing parser deep-equal pins stay valid
  (driver-registry, opencode-server-launcher, pretrust-parsing-audit).
- pre-composition guards for the module-level daemons and script
  surfaces: `hub`, `admin`, `ink-tui`, `contained-shell`, and `web-launch`
  (the guard lives INSIDE `runWebLaunch` — see the round-1 review note
  below).
- the dispatcher: a leading `workflow --help`/`-h` prints the surface
  list and exits 0; a verb's own `--help` resolves at that surface's own
  seam — `web` inside `runWebLaunch` (shared by the in-process call and
  the script entry), `settings`/`doctor`/`install` in their dispatch
  branches (`helpExit`), and the spawned verbs (`tui`, `hub`) in their
  bins' guards.

**The captured red:** `node dist/cli/admin.js --help` (pre-fix) printed
"Workflow admin listening at http://127.0.0.1:4180" plus a FRESHLY
GENERATED admin token and served until a 5s timeout killed it (exit
124) — the module-level daemon started where usage belonged, and the
token printed for a command that should touch nothing. The agent-spawn
reds (universal-tui, opencode-server) were cited from source, never
executed during development (spawning an agent is outside the suite's
bounds).

**Acceptance criteria:**
- [x] Red/green: the live admin red above; post-fix 24/24 in the sweep
      file (expanded by the round-1 review: 9 W126 probes + 15 W129 rows
      × BOTH flags — the original 10-pin cut and its 19/19 count stand
      recorded in the round-1 bullet below), each pinning exit 0 + the
      usage marker + EMPTY stderr.
- [x] Regressions 58/58: the three parser suites whose deep-equals guard
      the additive help field, the web/W124 hold-outs, the W125/W127
      pins, and the three W128 e2e files.
- [x] lint + typecheck exit 0.
- [x] The dangerous paths named honestly: universal-tui's `--help` no
      longer composes the agent; opencode-attach's `--help` no longer
      reaches the autostart discovery path; opencode-server's `--help`
      no longer composes the guard or runtime.
- [x] The round-1 fresh-eyes review REVISE'd the first cut with a real
      P1: the claim `workflow web --help` routes to the bin's guard was
      FALSE — the dispatcher calls `runWebLaunch` IN-PROCESS, bypassing
      the runnable-script guard, so it started the service (same class:
      `settings`; P2: rsi's `--help` only resolved in argv[0], so
      `start … --help` could reach the verifier POST). Fixed
      pre-recording: web's guard moved INSIDE `runWebLaunch`; the
      in-process verbs (settings/doctor/install) guard in their dispatch
      branches; rsi resolves `--help`/`-h` anywhere (including the
      single-dash token the flags loop previously rejected). The pins
      now run BOTH flags per row and cover the in-process verb paths and
      rsi's non-leading help (24/24). LESS-0053's lesson gained the
      in-process-bypass clause.

**Residuals (recorded, not fixed):** the usage text is per-bin minimal
(the first-line banner + key flags), not exhaustive flag docs; help
resolves anywhere in WELL-FORMED argv — a malformed value pairing
(`workflow web --cwd --help`, `workflow-rsi --help start`) fails closed
with the value error before any side effect (the seam's hard line holds;
the anywhere-nicety leaks, recorded by the round-2 review as note-level).

### W130 - The admin control plane's HTTP contract e2e (Complete - the credential-custody surface's token gate, mutation validation, audit trail, and value-never-echoed rule are executable for the first time) (2026-09-25)

**Source:** the operator's standing e2e direction ("continue with e2e
testing setup"), landing on the stream's security surface: the admin
control plane holds the operator's secrets (credential custody), and
W126's sweep had only proved boot + teardown — the token gate, the
trusted-mutation refusal, the body validation, and the audit trail were
never exercised over the compiled seat.

**What landed:** `test/e2e-admin.test.ts` — the compiled
`dist/cli/admin.js` driven end to end (WORKFLOW_ADMIN_PORT=0 +
WORKFLOW_ADMIN_TOKEN as the env seam, redirected HOME so the credential
config lands in a tmp tree): the public page (200, CSP with
frame-ancestors 'none'), the token gate (anonymous → 401 "admin
capability required"; a WRONG token of the right length → 401 — the
timing-safe comparison path; unknown route → 404), the trusted-mutation
gate (an authed cross-origin PUT → 403 BEFORE the body is read), the
content-type (415) and body (400) validation, the happy path (store →
list METADATA ONLY — the secret value never echoed, asserted
field-by-field and against the whole process output — → revoke → the
definition deleted per credentials.ts:145), the audit trail's set/revoke
lines, and the clean SIGTERM shutdown (exit 0).

**Acceptance criteria:**
- [x] Green on the first run against the observed contract; the
      post-revoke pin tightened from a compound OR to the real semantic
      (revoke DELETES the definition — credentials.ts:145) after reading
      the source.
- [x] The value-never-echoed rule is a first-class pin: the listing's raw
      body never contains the secret (the channel-completeness check) and
      the parsed entry carries metadata only — plus the process-output pin.
- [x] 1/1 e2e green; lint + typecheck exit 0.
- [x] The LESS-0051 safety contract: no agent/PTY spawns, redirected
      HOME (the credential config isolated), ephemeral port,
      process-group SIGTERM with a SIGKILL backstop, no spawnSync for the
      daemon.
- [x] The round-2 review REVISE'd the after-hook with a verified blocker:
      the comment claimed node:test runs after hooks in REVERSE
      registration order — FALSE (the runner executes them in declaration
      (FIFO) order; verified against lib/internal/test_runner/test.js and
      nodejs/node#48736), so the revoke ran AFTER the home rmSync. Fixed:
      the registration order is now revoke → kill → rmSync (FIFO = the
      intended execution order), the comment states the verified truth,
      and the revoke's gating (storedCredential + a live server) is
      unchanged. The round-2 P3s: the revoke audit line is now bound to
      the credential id, the listing's raw body is checked whole for the
      secret (channel completeness), and the "field-by-field" wording
      corrected.

**Residuals (recorded, not fixed):** the audit's rollback path
(credentials.ts:146-149 — a failed onDefinitionsChanged) is unexercised;
the admin page's browser-side flows (the editor dialog) are pinned only
at the API contract level; the browser-style same-origin PUT variant is
unpinned (node fetch's no-Origin shape is the pinned trusted path).
**The keyring honesty (the round-1 review's P2):** the redirected HOME
confines only the credential CONFIG file — the secret MATERIAL is stored
by createSecretServiceStore through `secret-tool` into the operator's
LIVE system keyring; the e2e stores one w130-prefixed test credential
whose cleanup is the in-test DELETE plus an after-hook best-effort
revoke, and a failure between the PUT and the cleanup can orphan that
keyring entry. The surface is also MACHINE-GATED on secret-tool + an
unlocked keyring (without them the PUT 400s and the test fails closed —
visible, never skipped).

### W131 - The settings panel's settings-document HTTP contract e2e (Complete - the second background wave's first file: the merged-document shape, the fail-closed write refusals, the value-never-echoed rule for the management key, and the advertised deep link's honest 404) (2026-09-25)

**Source:** the operator's standing e2e direction (the second background
wave: three parallel agents; this file from the settings agent). The
settings document (MCP servers + agent preferences, merged
global/workspace) had no behavioral coverage over the compiled seat, and
the settings verb's browser-open behavior had never been e2e-driven
headlessly.

**What landed:** `test/e2e-settings.test.ts` — the compiled
`workflow settings` driven end to end (PORT=0; the browser suppressed
through the discovered seam — the verb has NO --no-browser flag, so the
e2e uses WORKFLOW_NO_BROWSER=1 (open-browser's pre-lookup env gate) and
strips DISPLAY/WAYLAND_DISPLAY/DBUS_SESSION_BUS_ADDRESS as
defense-in-depth; the honest "No browser opener available" line is
pinned): the settings-document API's read shapes (/api/settings/mcp —
the merged servers where the workspace overlay wins per server name —
plus the vendored catalog; /api/settings/agents — the merged preferences
with presence-booleans only; /api/settings/mcp/live — the honest
unavailable state), the write refusals (a cross-site origin → 403
cross-origin mutation denied; text/plain → 415; a non-array servers body
→ 400), the valid writes (a malformed server is dropped fail-closed; the
on-disk documents land 0600-in-0700 under the redirected HOME and the
redirected workspace overlay — the real repo untouched), the
management-key value-never-echoed pin (a fake key set in the child env;
the response body greps clean), and the whole-stdout equality pin at
teardown (banner + no-opener line, exit 0).

**Discovered and queued (product finding):** `workflow settings` prints
AND opens `${service.url}/settings`, but the server has NO /settings
page route — it answers 404 JSON; the settings surface is the SPA's
settings dialog behind GET /. A real browser opening the advertised URL
lands on an error. The fix belongs in product (serve the shell at
/settings, or print the bare URL); the test pins the observed 404 until
then.

**Observation (recorded for the threat model):** the settings mutations
authenticate only via the trusted-mutation gate (origin /
Sec-Fetch-Site) — no management key, no session scope; any local
process can read/write the operator's settings document. Consistent
with the loopback-only bind (arguably by-design), stated rather than
assumed.

**Acceptance criteria:**
- [x] 2/2 green (the W130 admin e2e + this file; ~250ms each), plus the
      agent's four stability runs; lint + typecheck exit 0 for this file
      (the whole-project typecheck is transiently red from a concurrent
      agent's untracked WIP file — its gate lands with its integration).
- [x] The browser never opens (the suppression seam proven by the pinned
      stdout equality).
- [x] The settings document writes are confined to the redirected
      HOME/workspace overlay (asserted against the real repo).
- [x] The round-2 review's notes dispositioned: the no-Origin trusted path
      is now EXERCISED (the global MCP write drops its origin header —
      the prose/behavior mismatch closed), and the whole-stdout equality
      pin carries the flush-timing caveat in a comment (node flushes pipe
      stdout before exit; if a flush race ever appears, await stream
      close first).

**Residuals (recorded, not fixed):** the browser-side settings dialog
flows are pinned only at the API contract level; the same-origin PUT
variant is unpinned (node fetch's no-Origin shape is the pinned trusted
path); the dead deep link is queued (above).
  - Dated note (2026-09-25, W134): the dead deep link FIXED — the CLI
    advertises and opens the shell root (the Settings dialog lives there);
    the /settings route still 404s as the server truth (serving the shell
    at /settings is deferred because src/ui/web.ts carries the operator's
    uncommitted W115 work). The banner pin and its parse regex flipped
    with the fix.

### W132 - The contained-shell's behavioral lane e2e + the guard-deny session-death repair (Complete - the containment contract driven over stdin pipes: ALLOW→ENFORCED→VERIFIED, the nonzero lane's persistence, and the guard-deny lane repaired to W022's contract) (2026-09-25)

**Source:** the second background wave's contained-shell agent; the
contained shell is the containment contract's user-facing surface, and
its behavioral lanes (ALLOW → ENFORCED → VERIFIED; the nonzero lane;
the guard-deny lane) had never been driven over the COMPILED seat —
LESS-0012's divergence class on the surface that executes operator
commands inside bubblewrap.

**What landed:** `test/e2e-contained-shell.test.ts` (three lanes over
stdin pipes, no PTY, every execution inside the product's own bubblewrap
boundary, HOME redirected): (1) the benign allow — blank line executes
nothing, Policy: ALLOW → Containment: ENFORCED (bwrap 0.11.0 — the
observed truth) → the command's output → Task: VERIFIED, strict order,
clean exit 0; (2) the nonzero lane — `false` → Task: FAILED (exit 1) and
the session SURVIVES (the next command verifies — W022's persistence
contract); (3) the guard-deny lane — Workflow's own lane prints Policy:
ALLOW first, then the vendored guard denies INSIDE
WorkflowContainedProcess.execute.

**Discovered and fixed — the wave's second live product defect:** the
guard-deny lane's denial THREW out of the unguarded per-command loop and
TERMINATED the persistent session (exit 1, no Containment/Task lines
ever printed) — violating W022's recorded contract ("a denied command
does not terminate the persistent session"; the nonzero lane held, the
guard lane did not). Fail-closed (the denial fires BEFORE any spawn:
nothing executed, nothing mutated) but honest death instead of
per-command reporting. Fixed: contained-shell.ts catches the failure
per-command, reports `Task: FAILED (execution refused: …)` — the label
deliberately SEAT-NEUTRAL per the round-3 review's P2 (execute's throw
classes are the guard seat, the second authorization seat, and
containment failures; a bwrap-less operator must not read a false seat
attribution) — transitions the task FAILED, and keeps the loop alive;
the pin now asserts the repaired contract (the FAILED report carries the
denial's message, no containment verdict prints, and the NEXT command
still verifies, exit 0). W022's ledger line carries the dated
contradiction note.

**Discoveries recorded (observed, pinned):** the shell's own Policy:
DENY branch is DEAD CODE from its only input surface — every stdin line
flows the same hardcoded proposal (subjects fixed [], workspaceRoot
never set, the capability set includes process, a fresh
WorkflowApplication + fresh MutationBudget(100) per command) — so the
only reachable deny is the guard seat's, which the fix now surfaces
honestly. The environment truth: bwrap 0.11.0 present → ENFORCED is the
live lane; the bwrap-less and non-Linux degradations are recorded from
source, never faked.

**Acceptance criteria:**
- [x] Red/green: the lane-3 red was the live session death (the agent's
      observed run: exit 1, no Task line); post-fix 3/3 green with the
      repaired pin (the FAILED report + the surviving session's next
      VERIFIED).
- [x] The LESS-0051 safety contract: no agent/PTY spawns; the payloads
      execute INSIDE the product's own bubblewrap boundary (echo/false
      only; the guard-deny probe assembled from fragments so the file's
      own authoring guard never matches the literal); HOME redirected;
      the guard MCP server dies with the child's process group; SIGTERM
      only as the stuck-exit backstop.
- [x] Hold-outs: the W126 sweep's contained-shell boot/EOF pin holds
      alongside; lint + this file's typecheck clean (the whole-project
      typecheck is transiently red from the concurrent hub-routes agent's
      untracked WIP — its gate lands with its integration).

**Residuals (recorded, not fixed):** the shell's own DENY branch remains
unreachable from stdin (a coverage gap in the surface's design, not the
test — recorded for the surface's next design pass); the bwrap-less
Linux and non-Linux degradations are recorded from source and must be
pinned by their own environments; the guard-deny probe's fragment
assembly is environment-coupled to the vendored policy corpus's
destructive-operation rule; a POST-SPAWN containment failure (the
command possibly executed) would skip recordMutation where the nonzero
lane records it — the mutation-accounting question for the catch lane
is queued (the round-3 review's P2 follow-up); the ShellSession exit
await has no SIGKILL escalation deadline (note-level: a plain node child
never ignores SIGTERM — the round-3 review's P3).

### W133 - The hub's route-level contract e2e (Complete - the third background wave file: the operator/verifier token-class matrix, the schedule lifecycle, the self-improvement route shapes, and the empty-body 500 recorded) (2026-09-25)

**Source:** the second background wave's third agent (the hub-routes
deep-dive). W128 pinned discovery + snapshot + teardown; the ROUTE-level
contract — the two-credential class split, the composed schedule and
self-improvement route shapes, the refusal classes — had never been
exercised over the compiled multi-process seat.

**What landed:** `test/e2e-hub-routes.test.ts` — the compiled hub's
route contract (W128's spawn/discovery/teardown skeleton reused, not
reinvented): the token-class split BOTH directions (a verifier credential
on an operator route → 401; the operator credential on a verifier-only
route → 401 — authorization precedes body parsing AND dispatch, so those
pins move no hub state), the schedule routes' live lifecycle
(list→save→delete through the W074 registry; both refusal classes — the
route-level 400 and the registry-level 400 surfaced through the route's
client-error catch; a rejected save never partially admits), the
self-improvement routes (composed even with WORKFLOW_RSI_AGENT=0 — the
fail-closed stub arms only the loop RUNNER: zero records, an explicit
null for an unknown id, a false cancel — never a 404), the trailing 404,
and the teardown truth: the persisted schedule table is operator state
that hub.close() deliberately does NOT unlink (only discovery.json,
verifier.json, and the instance lock go).

**Discovered and queued (product finding):** an EMPTY-body request earns
a 500 from the route dispatch's catch-all — hub-http's readJson
JSON.parses a zero-byte body, so every route except /health requires a
JSON body ("{}" suffices) even for reads, and the client payload error is
classified as a server fault. Product polish queued: a 400 naming the
body requirement instead of a 500 "Unexpected end of JSON input".
Recorded honestly in the file's header, not fixed here — and the 500 pin
flips alongside that polish (it characterizes the current contract, not
a blessing of it; the round-4 review's P3).

**Acceptance criteria:**
- [x] Red/green: the agent's debugging found the 500 was ITS helper's
      omitted-body default, not a hub defect (the minimal in-process
      replica ran green; the fix was supplying the JSON body) — LESS-0054
      formalizes the protocol.
- [x] The dangerous verifier routes (/rsi/start, /schedule/run-now) are
      NEVER called with the verifier credential — pinned with the wrong
      token class only, which authorizes nothing; /rsi/start is never
      called at all.
- [x] 1/1 green (356ms first run, ~600ms after the retitle); lint +
      typecheck exit 0 (the whole-project typecheck now green — the WIP
      resolved).
- [x] The LESS-0051 safety contract: no agent/PTY spawns; all hub state
      under the redirected HOME (the schedule lifecycle mutates only the
      probe's own WORKFLOW_HUB_SCHEDULES file); port 0; process-group
      SIGTERM with the pinned exit + unlink truth.
  - Dated note (2026-09-25, W134): the empty-body 500 FIXED — see the note
    in the W133 residuals below; the pin now characterizes the repaired
    contract (the W133 entry's "pin flips alongside that polish" note
    came due).

**Residuals (recorded, not fixed):** the unreproduced one-off 400
"invalid snapshot request" mid-sequence (suspected rare
keep-alive/unconsumed-body interaction — noted by the agent, never
reproduced in ~12 runs, deliberately not pinned).

### W134 - The two queued product fixes: the hub's body-error classification and the settings verb's dead deep link (Complete - the wave's findings closed; the empty-body 500 is now an honest 400 and the settings verb points at the shell, not a 404) (2026-09-25)

**Source:** the e2e wave's two recorded queued findings — W133's
empty-body 500 (the hub's catch-all classified a client payload error as
a server fault) and W131's dead /settings deep link (the settings verb
printed and opened a 404). The operator's "continue tasks + e2e testing
coverage and fixes" direction.

**What landed:**
- `hub-http.ts`: a typed `HubRequestError` (the request-BODY fault class)
  thrown by `readJson` for oversized or unparseable bodies, with a NAMED
  requirement message ("a JSON request body is required (send {} for read
  routes)") — the catch-all's 400/500 split answers 400 for the client
  class and keeps 500 for genuine server faults. The W133 pin flipped
  (500 → 400 + the message).
- `workflow.ts` (the settings verb): prints and opens the SHELL ROOT —
  where the Settings dialog actually lives — instead of the dead
  `/settings` URL; the parenthetical names the seam ("the Settings
  dialog lives on the operator shell"). The W131 banner pin and its
  parse regex flipped. The deeper option (serving the shell AT /settings
  in src/ui/web.ts) is deferred: that file carries the operator's
  uncommitted W115 work (a coordination note, recorded).

**Acceptance criteria:**
- [x] Red/green: the pre-fix observations (the 500 "Unexpected end of
      JSON input"; the `/settings` 404 the verb advertised) were the
      wave's recorded findings; post-fix the flipped pins run green
      (2/2).
- [x] Regressions 80/80 across the hub unit suites (hub-rsi/hub-review/
      hub-runs), the compiled-bin sweep, the W128 hub e2e, and the web
      tests — the body-classification change did not disturb any other
      hub consumer, and the dispatcher change kept the help pins valid.
- [x] lint + typecheck + build exit 0.

**Residuals (recorded, not fixed):** the /settings route still 404s as
the server truth (the CLI no longer advertises it; serving the shell
there awaits the operator's W115 work clearing src/ui/web.ts); the
unreproduced one-off 400 remains unpinned (W133's residual); a
NON-HubRequestError body-read fault — a client aborting mid-body inside
readJson's for-await — still lands 500 through the catch-all (the
review's P3): the "body faults are client errors" claim covers oversize
+ parse failure only, exactly as stated, and the mid-abort class is
recorded here as an adjacent residual.
  - Dated note (2026-09-25, W134): the empty-body 500 FIXED — hub-http
    classifies a request-BODY fault as a CLIENT error (a HubRequestError
    answered 400 with "a JSON request body is required (send {} for read
    routes)"), and the catch-all's 400/500 split leaves 500 to genuine
    server faults. The W133 pin flipped (500 → 400 + the named
    requirement).

### W135 - The web service's static/PWA asset contract e2e (Complete - the shell's CSP verbatim, the service worker's hash-derived cache version computed against the bytes the same service served, the manifest deepEqual, and all six SHELL entries answering 200) (2026-09-25)

**Source:** the third background wave (the webapp-assets agent). The
PWA/service-worker surface — the shell page's static contract, /sw.js
(built in-memory by pwa.ts), /manifest.webmanifest, the generated icons —
had no compiled-seat e2e; the browser the offline shell serves has never
had its routes proven from outside.

**What landed:** `test/e2e-webapp-assets.test.ts` — the compiled web
service's static contract: GET / (200, the html()-helper CSP VERBATIM —
default-src/script-src/style-src/img-src/manifest-src/worker-src — and
the PAGE markers: doctype, lang, charset, viewport, theme-color,
`<title>Workflow Control</title>`, the manifest link, #root, the /app.js
script); a cachebusted GET (/?cachebust=) byte-identical to / (static
routes match on pathname); /app.js + /app.css no-cache (byte-equality
stays W128's pin); **/sw.js's cache name `workflow-shell-<12hex>` where
the version equals sha256(served /app.js ‖ /app.css).slice(0,12)**
computed against the bytes the SAME service just served — a rebuilt
bundle provably retires the old cache; the exact SHELL list
(["/", "/app.js", "/app.css", "/manifest.webmanifest", "/icon-192.png",
"/icon-512.png"]); the verbatim handler pins (install addAll + skipWaiting,
activate retirement + clients.claim, the /api/ + cross-origin bypass,
network-first with the hit ?? Response.error fallback); **all six SHELL
entries answer 200** (the offline shell is only as real as its routes);
/manifest.webmanifest deepEqual against PWA_MANIFEST; the icons' PNG
signature + IHDR (192×192 / 512×512, RGBA — generated in-memory by
renderIconPng, never served from disk, so there is no icons-absent 404
scenario); the JSON 404 shape; GET-only static routes.

**Findings recorded (not fixed):** the manifest route carries NO
cache-control while every sibling static asset is no-cache — a
heuristic-cached manifest can lag a theme/icon change (a polish
candidate); the CSP rides only the document route (the assets and the
JSON 404 carry no nosniff/XFO — same-origin fixed shapes, a residual
stated rather than assumed).

**Acceptance criteria:**
- [x] 1/1 green twice (503-524ms); lint + typecheck exit 0.
- [x] The SW version derivation verified against the observed hash
      (c303105a02fb = the computed sha256 slice).
- [x] The LESS-0051 safety contract: no agent/PTY spawns; redirected
      HOME; ephemeral port; async spawn → banner → SIGTERM → pinned exit.

**Residuals (recorded, not fixed):** the manifest cache-control polish;
the asset/404 header residuals (above).

### W136 - The `workflow-rsi` CLI's client-side flow against a live hub e2e (Complete - the multi-process CLI contract: the operator-token reads, the verifier gate refusing client-side before any request, and the refusal shapes through the CLI's stdout/exit contract) (2026-09-25)

**Source:** the third background wave (the rsi-CLI agent). W133 pinned
the hub's route bodies; the CLI's discovery → authentication → request
flow — and its refusal shapes — against a live compiled hub had never
been driven.

**What landed:** `test/e2e-rsi-cli.test.ts` — the compiled CLI against a
spawned compiled hub (the operator token from discovery.json, the
verifier token from verifier.json, all state under redirected HOMEs):
`status` (the operator token) answers EXACTLY `{ loops: [] }`
pretty-printed with an empty stderr and exit 0; `status --id <missing>`
answers `{ loop: null }`; `cancel --id/--workspace <absent>` answers
`{ cancelled: false }` — safe refusals leaving the registry untouched;
`start` with verifier.json ABSENT refuses CLIENT-side before any request
("no Workflow hub verifier discovery at … (is the hub running?)") with a
follow-up status proving NOTHING ARMED — /rsi/start is never called;
`status` against a crafted verifier-token seat answers the 401 through
the CLI's call-error shape ("hub /rsi/status failed: unauthorized") —
proving status/cancel authenticate with exactly the discovery token; the
refusal shapes (missing and MALFORMED discovery are indistinguishable —
readHubDiscovery returns undefined either way; a dead endpoint surfaces
as bare "fetch failed"; the parse refusals fire before hub resolution);
the seam precedence (--discovery-dir > WORKFLOW_HUB_DIR > ~/.workflow,
each named verbatim in the failure); the teardown re-observes W128's
unlink contract.

**Findings recorded (not fixed):** malformed discovery is
INDISTINGUISHABLE from missing (hub-client.ts swallows the parse error —
an operator with a corrupt seat sees the no-daemon message; fail-closed
but ambiguous — a polish candidate); the dead endpoint surfaces as bare
"fetch failed" (the CLI prints only error.message, dropping the
ECONNREFUSED cause chain — note-level; the preserve-caught-error rule
would suggest printing the cause).

**Acceptance criteria:**
- [x] 2/2 green three consecutive runs (1.2-1.3s); lint + typecheck
      exit 0.
- [x] The verifier gate pinned CLIENT-side with a follow-up status
      proving nothing armed; /rsi/start never sent.
- [x] The LESS-0051 safety contract: no agent/PTY spawns; three
      ephemeral mkdtemp HOMEs; port 0; the hub never spawnSync-killed
      (async spawn → banners → CLI spawnSyncs → group SIGTERM → pinned
      exit 0 + unlink truth).

**Residuals (recorded, not fixed):** the two findings above; W133's
route-level contract remains the deeper seat (this file re-projects it
through the CLI's stdout/exit contract rather than re-pinning it).

### W137 - The shipped postinstall target's execution e2e (Complete - scripts/prepare-tool.mjs driven in the packaged seat and through stub lanes; the workspace-upwalk mutation blast radius found) (2026-09-25)

**Source:** the third wave's prepare-tool agent. W128's packaged e2e
found the postinstall target shipped NOWHERE (fixed) and its shape pin
enforces presence; the hook's EXECUTION had never been tested.

**What landed:** `test/e2e-prepare-tool.test.ts` (5 tests): the LIVE
packaged seat (pack → extract → `node <extracted>/package/scripts/
prepare-tool.mjs`: exit 0 UNCONDITIONALLY; the built lane asserts the
toolbox install landed inside the installed tree + the vendored guard
seat's dist/server.js exists; the skipped lane (offline) asserts the
warn shape — exactly one class per run); the npm-repair rerun in the
same tree; and three stub-pnpm lanes (success → stdout EXACTLY
`prepare: toolbox ok\n`, argv EXACTLY ["--dir", <root>/mcp-toolbox,
"run", "build"], cwd = root, and a byte-identical second invocation;
exit 1 → exit 0 with the EXACT skipped message; missing pnpm → exit 0
with the ENOENT message). Finding (c) — the dead `existsSync` import in
the shipped script — FIXED in this loop.

**Findings recorded (not fixed):**
- **(a) The postinstall is heavyweight and network-dependent** — a
  consumer approving install scripts unknowingly installs the 391-entry
  vendored toolbox tree (~9.5s warm). Polish shape: a gate env (e.g.
  WORKFLOW_PREPARE_TOOL=1) or honest docs.
- **(b) THE WORKSPACE UPWALK MUTATION BLAST RADIUS** — the child pnpm
  resolves workspaces by walking UP from its cwd: when the target is not
  itself a workspace root, pnpm can mutate an ANCESTOR workspace's
  node_modules. OBSERVED during this agent's research (2026-09-25): the
  run pruned 135 stale entries from `/var/home/hunter/node_modules` (the
  operator's $HOME-level pnpm workspace — reconciled to its own lockfile,
  the same effect its own `pnpm install` would produce, but unintended).
  The PACKAGED seat is immune (the extracted toolbox IS a workspace —
  pinned), but the escape class is real; queued (remedy direction: refuse
  when the target is not a workspace root, or the (a) gate env).

**Acceptance criteria:**
- [x] 5/5 green twice (15.8-16.1s — the live lane's ~9.5s toolbox build
      dominates); lint + typecheck exit 0.
- [x] The packaged lane's writes confined to the extracted mkdtemp tree +
      a redirected-HOME store (with the ambient XDG/PNPM_HOME/NPM_CONFIG_*
      overrides stripped so HOME is authoritative — the round's P3); the
      repo's mcp-toolbox/scripts trees OBSERVED porcelain-clean around the
      live runs (the in-test canary is the mcp-toolbox/node_modules mtime).
- [x] The LESS-0051 safety contract: no agent/PTY spawns; the script's
      own pnpm child is short-lived (spawnSync-captured); all scratch
      under mkdtemp.

**Residuals (recorded, not fixed):** the two findings above; a hung
pnpm child could survive a parent timeout-kill (never observed); npm
12's install-scripts gate still means the hook does not run during a
real tarball install (this file drives it directly — W128's residual
stands).

### W138 - The control-plane hidden-Unicode strip at the prompt seat (Complete - the named-class sanitize covers every prompt crossing WorkflowCodingSession.submit, and the web transcript shows what the agent receives) (2026-09-25)

**Source:** the operator's base-loop direction ("add something to the
control plane that strips out hidden unicode characters — help prevent
prompt injection"). THREAT_MODEL item 2 records the injection-pressure
class as a residual (reviewer/candidate lanes read agent-authored text);
no strip existed anywhere (greps for unicode/bidi/zero-width/homoglyph
across docs+src+test: empty before this item).

**What landed:**
- `src/application/text-hygiene.ts` — `sanitizeControlPlaneText`: a
  NAMED-CLASS denylist strip (control = C0 minus tab/newline/CR + DEL +
  C1; bidi = U+061C/200E/200F/202A-202E/2066-2069; zero-width = U+200B/
  2060/FEFF; tag = U+E0000-E007F; noncharacters = U+FDD0-FDEF + every
  plane's xxFFFE/xxFFFF) returning EVERY hit (kind + code point) so a
  surface can show what was removed. Idempotent, allocation-local, zero
  imports.
- The seat: `WorkflowCodingSession.submit` sanitizes BEFORE the
  queue/turn (the queue holds clean text) — every prompt crosses it
  (web channel, TUI, hub turn lanes hub.ts:143/219/300, the reviewer
  lane hub-run-gates.ts:58), so the THREAT_MODEL item-2 class is
  covered once. `SessionChannel.submit` sanitizes BEFORE storing the
  transcript item — the operator's transcript shows exactly what the
  agent receives, never a raw projection of stripped text.
- Pins: `test/text-hygiene.test.ts` (9 — per-class strip, the preserved
  classes byte-for-byte, the emoji-ZWJ overstrip guard, idempotence, hit
  shapes) + one web behavioral pin in `test/web.test.ts` (POST
  /api/prompt with one hit from every named class → the DRIVER receives
  the sanitized text AND the transcript item matches it).

**Acceptance criteria:**
- [x] Red-first: with only the two src changes stashed, exactly ONE pin
      is red (the W138 web pin — the raw payload with bidi/zero-width/
      tag/control/noncharacter chars reached the driver verbatim);
      green after: 36/36 (9 + 27).
- [x] Held-out submit consumers 27/27 (coding-session-queue,
      session-port, driver-registry, error-surfacing); lint + typecheck
      exit 0.
- [x] Fresh-eyes review APPROVE (five axes named; the class table
      verified complete; seat universality verified across five
      surfaces; kernel purity clean).

**Residuals (recorded, not fixed):** (i) the empty-prompt
validation-order gap — `isPromptRequest`'s trim catches U+FEFF but not
bidi/ZWSP/U+2060, so an all-invisible prompt passes the route, sanitizes
to "" at the seat, and runs an EMPTY turn (pre-change the same input ran
a turn carrying hidden text, so the change is fail-restrictive; the
queued fix is a sanitized-emptiness recheck); (ii) the strip's hits are
computed but never surfaced (silent mutation from the operator's view —
a strip notice is a queued UX decision); (iii) the TUI's Ctrl+E markdown
export writes the raw composer text (tui.tsx:599-607) — export parity
queued; (iv) the honest boundary of the denylist itself: ZWNJ/ZWJ and
variation selectors are PRESERVED (load-bearing for scripts/emoji) and
can still smuggle low-bandwidth data, and unlisted future glyphs pass —
a strict mode could queue; (v) the TUI composer echo/promptHistory keeps
the operator's raw text (their own input, not an agent-state projection).

### W139 - The hub schedule WRITE lifecycle e2e (Complete - save echo → list deep-equal → delete, both refusal classes, the W134 body contract, a verifier-gated run-now that refuses before any agent work, and the table's persistence across a hub restart) (2026-09-25)

**Source:** the first wave of the operator's "get sub agents to
continue e2e coverage" direction (report-only agent, LESS-0051 safety
contract). W133 pinned the route-LEVEL contract on a fresh hub; this
wave drove the write lifecycle and its persistence against the live
multi-process seat.

**What landed:** `test/e2e-hub-schedule.test.ts` (2 tests, 101
assertions; green 3× consecutive, 1.24-1.26s warm): save echo → list
deep-equal with the `{version:1, schedules:[…]}` table file asserted
after every write; the token-class matrix per hub-http.ts:92-97
(verifier refused 401 on save/list/delete; operator refused 401 on
run-now BEFORE body parse); six registry-level plus two route-level 400
refusals (bad cron minute/day-of-month, whitespace title, empty id,
non-string workspace, bad taskClass) leaving the list unchanged; the
W134 body contract on a WRITE route (empty/malformed → 400 with the
named requirement; >1 MiB → 400); run-now on an absent id → 200
`{fired:false}`, on a present id fired with the verifier token → 200
`{fired:true}` with the fire landing on a workspace that cannot
canonicalize so `fireOnce` refuses at controller.begin (the hub log
line observed; /snapshot pins ZERO run tasks — no ACP runtime ever
composes; cron Feb-31 + enabled:false belt-and-braces); the default
seat `<HOME>/.workflow/scheduler.json` surviving clean teardown AND a
hub restart with freshly re-issued credentials; delete lands the empty
table.

**Findings recorded (not fixed):**
- **(a) Unknown definition fields persist verbatim** — POST /schedule/
  save with an extra `unknownField` answers 200 and writes it to the
  table (hub-scheduler.ts:246-286 validates known keys only); a
  schema-rejection gap.
- **(b) A begin-failing run-now is indistinguishable from a successful
  fire at the route** — 200 `{fired:true}` either way; the only signal
  is the hub's stdout log; an observability gap.
- **(c) Delete of an unknown id is a silent 200 no-op**
  (schedule-registry.ts:62-65) — idempotent, but never surfaces an id
  typo.
- Asymmetry (pinned, not filed): the save route's shape check admits an
  empty id (hub-http.ts:202) that sibling delete/run-now refuse (:216,
  :223); the registry catches it.

**Acceptance criteria:**
- [x] 2/2 green three consecutive runs; lint + typecheck exit 0 with
      the file present.
- [x] The LESS-0051 safety contract: no agent/PTY spawns; the fireable
      path was made to refuse at controller.begin BEFORE any runtime
      composition; redirected mkdtemp HOMEs; port 0; clean teardown
      pinned.

**Residuals (recorded, not fixed):** run-now on a fireable schedule and
the clock-fired tick path are out of LESS-0051's bounds (either would
compose a real ACP agent run); the paused-schedule-is-still-fireable
rule is documented from hub-scheduler.ts:294-297,424, not live-driven;
off-peak deferral and run budgets are scheduler-internal, unreachable
through the write-lifecycle routes without a live turn.

### W140 - The web multi-session isolation e2e (Complete - two parallel fake-runtime sessions behind one server: transcript/config/prompt isolation per session, the guard set per session, and the cross-session answer-consumption FINDING pinned as-found) (2026-09-25)

**Source:** the second wave of the operator's "get sub agents to
continue e2e coverage" direction (report-only agent, LESS-0051 safety
contract, in-process tsx seat — no dist build, no agent/PTY spawns).
The ?session= routing contract was unit-pinned against ONE session
(W114-era); this wave drives the isolation contract with TWO real
parallel sessions.

**What landed:** `test/web-scoping.test.ts` (11 tests, green twice
consecutively at 571-731ms; the mirrored suites still green — web 27/27,
web-sessions 20/20): transcript isolation both directions with the
unscoped route answering the focused session; config options isolated
per driver; the unknown-id 404 shape against TWO real sessions across
six routes (upgrading test/web.test.ts:688's single-session pin);
permission scoping (B's poll null while A parks); cancel scoping (only
A's park resolves PROMPT_CANCELLED, B's park survives and stays
answerable); PROMPT_BUSY per session (A's second park denies while B's
first park is accepted); rename/retry/add guards per session; focus
switch (activating B spawns nothing, disposes nothing in A, denies no
parks); the per-session busy contract (A 409 + B 202 in the same
window; B's completion never unbusy A).

**FINDING (recorded, not fixed):** the permission poll is
session-scoped (`pendingRequest(sessionKey)`, permission-broker.ts:77-80)
but the ANSWER path is not — `PermissionBroker.answer` matches the
parked id alone (:83-106) and the route never checks ownership, so
answering through B's route with A's parked id returns 200, resolves
A's park (OPERATOR_REJECTED), and A's poll afterwards shows null. Pinned
as-found (the FINDING test); the fix shape is a session-scoped refusal
on the answer route, which flips that pin deliberately. Mitigating
posture: the same-origin trusted-mutation guard still applies and the UI
never surfaces another session's id.
  - Dated note (2026-09-25, W141): the finding FIXED — the pin flipped
    deliberately (the test now pins the repaired contract: cross-session
    404, the park survives B's attempt, the owning session still
    answers). See the W141 entry.

**Acceptance criteria:**
- [x] 11/11 green twice consecutively; lint + typecheck exit 0; the
      mirrored suites (web, web-sessions) still green.
- [x] The LESS-0051 safety contract: in-process only (tsx), fake drivers,
      mkdtemp registry paths, port 0, no agent/PTY spawns, no dist build.

**Residuals (recorded, not covered):** full /api/image cross-session
store isolation (only the lookalike 404 is pinned — a cheap follow-up);
the live-cap eviction path and dismiss-with-parked-prompts (need seven
parallel runtimes / dismiss flows; the keyed-cancel wiring is already
manager-pinned at test/web-sessions.test.ts:531); /api/sessions/compact
per-session agent-id mapping (rides the v2 data-lane gateway, outside
the in-process contract); registry-restart isolation over HTTP (covered
at manager level in web-sessions.test.ts, not duplicated).

### W141 - The permission answer path is as session-scoped as the poll (Complete - broker.answer's ownership check ends the cross-session answer consumption the W140 wave observed; the FINDING pin flipped deliberately) (2026-09-25)

**Source:** the W140 wave's finding (recorded 2026-09-25, this branch's
wave round): GET /api/permission filters the parked set by the session's
permission key, but POST /api/permission resolved by parked id ALONE —
answering through session B's route with session A's parked id returned
200, resolved A's park (OPERATOR_REJECTED), and A's poll afterwards
showed null. The operator's "fix the next item" direction.

**What landed:**
- `PermissionBroker.answer` gains an optional `sessionKey` ownership
  check: a caller-scoped key must OWN the parked request (the parked
  entry's sessionKey is fixed at parking from the action's correlation
  id); a mismatched key answers nothing. `undefined` keeps the legacy
  unscoped shape — consistent by construction: the keyless channel's
  poll surfaces the OLDEST parked request overall, so what it shows is
  what it may answer.
- `SessionChannel.answerPermission` passes its own key — the channel is
  the only src caller (web.ts:709), so the refusal rides the route's
  EXISTING 404 branch ("unknown or stale permission request"); no route
  logic changed. `cancelPending` was already keyed; the answer now
  mirrors it.
- Pins: a broker-level ownership pin (mismatched key refuses; the park
  survives; the owning key resolves; B's park answers independently) +
  the W140 FINDING test FLIPPED DELIBERATELY (cross-session 404 + the
  park survives + the positive control through A's own route; the file
  header and the in-test comment record the flip with the pre-fix truth
  pointer).

**Acceptance criteria:**
- [x] Red-first: with only the two src changes stashed, exactly the two
      W141 pins are red (the broker pin: answer ignored the key → true ≠
      false; the web pin: cross-session 200 ≠ 404); green after:
      101/101 across permission-broker + web-scoping + web +
      web-sessions + webapp-surface; lint + typecheck exit 0.
- [x] Fresh-eyes review: [APPROVE] on the code (the ownership check
      verified airtight — the only src caller is the channel; the
      web-sessions pin stays green by construction; the residual-shape
      audit found no second unscoped consumption seam; the ACP answer
      path never touches broker.answer), with two P2 record defects
      (the stale in-file FINDING block; the missing ledger rows) repaired
      before this entry.

**Residuals (recorded, not fixed):** the keyless window (a channel whose
driver reports neither permissionSessionKey nor agentSessionId) still
polls and answers the oldest parked request OVERALL — poll and answer
AGREE in that window, so the "as scoped as the poll" contract holds, but
cross-session consumption remains reachable there by design (the legacy
single-session posture); the window only opens for degenerate drivers
(the manager always wires a key function, web-sessions.ts:460). A parked
entry with sessionKey === undefined can never be answered by a keyed
caller (fail-closed on degenerate data).

### W142 - The hub /bash + /run/begin lanes e2e (Complete - the contained-shell contract on the live compiled seat, every refusal class, and the run-record lifecycle with exactly one task that never composes) (2026-09-25)

**Source:** the third wave of the operator's e2e-coverage direction
(report-only agent, LESS-0051 safety contract; this wave owned the dist
build). Greps found no /bash coverage anywhere in test/ before it.

**What landed:** `test/e2e-hub-bash.test.ts` (1 test, green 3×
consecutively, subtest 0.6-1.5s): the token-class matrix against
hub-http.ts:92-97 — /bash and /run/begin are OPERATOR routes (verifier
refused 401, both directions pinned) while the run lifecycle's
verifier-gated lane is /run/finish (pinned both directions); the happy
contract EXACTLY `{output: string}` (stdout+stderr concatenated with no
separator and no exit-code field, contained-shell-executor.ts:62) with
echo/pwd/printf pins, pwd === the requested cwd, the structured
{command,args} direct-exec form, and a 200,000-char output returned
verbatim; every refusal class (empty body → 400 with the W134 named
requirement; `{}` → 400; empty command → 500; relative/empty cwd →
canonicalization refusal; cross-workspace cwd → WORKSPACE_PATH_DENIED;
guard non-allow → promotion-gate 500); the /run/begin record lifecycle —
exactly ONE run task created (run:w141-e2e-run-record), the
cannot-canonicalize attempt refused BEFORE composition (the snapshot
stays empty), and the observed removal path `/run/finish
{outcome:"failed"}` hides the task (never deletes; one failed
environment evidence remains); the bwrap confinement signature pinned
(cleared environment, synthesized PATH, no HOME, the runtime probe
before every execute).

**Findings recorded (not fixed, each with its reproducing request):**
(a) a nonzero exit is represented only as a 500 with no exit-code field
on the wire; (b) an empty command string passes the route check and 500s
in the executor; (c) NO timeout anywhere in the /bash chain
(grep-verified across hub-http.ts, contained-shell-executor.ts,
linux-bwrap.ts — the hung-command lane was deliberately NEVER sent, the
finding is the record); (d) no response-side output cap (asymmetric with
the 1 MiB request cap); (e) /run/begin client-shaped faults classify
500; (f) no true deletion path for a run record (finish-failed hides;
evidence remains).
  - Dated note (2026-09-25, W144): finding (c) FIXED — the lane is
    bounded (the W144 entry; the hung-command lane can no longer exist
    to observe).
  - Dated note (2026-09-25, W145): findings (a) and (b) FIXED — a
    nonzero command exit answers 422 {error, exitCode} (the command's
    result is data, never a server fault) and an empty/invalid command
    answers 400 at the route; the pins flipped deliberately (see the
    W145 entry).
  - Dated note (2026-09-25, W146): finding (e) PARTIALLY FIXED — the
    non-canonical-workspace member now answers 400 (the typed
    WorkspaceDeclarationError; three pins flipped deliberately, see the
    W146 entry); empty runId and duplicate runId remain recorded 500s.

**Acceptance criteria:**
- [x] 1/1 green three consecutive runs; lint + typecheck exit 0 with
      the file present.
- [x] The LESS-0051 safety contract: the only spawned processes are the
      compiled hub and innocuous one-liners (echo/pwd/printf) with
      captured output; no agents/PTYs/network; redirected mkdtemp HOMEs;
      port 0; clean teardown re-observed.

**Residuals (recorded, not covered):** the hung-command boundary (no
timeout exists to bound it — finding (c)); /rsi/start, /schedule/run-now,
requiresReview begins, and any ACP/agent composition were never
exercised; the seat's enforcement marker is not surfaced over HTTP
(recorded as a limitation in the header).

### W143 - The `workflow doctor` e2e (Complete - the verb's honest-output contract on the TSX lane: the uninstalled 8-check shape, the probe-verdict register tally byte-for-byte, and the exit-code matrix) (2026-09-25)

**Source:** the fourth wave of the operator's e2e-coverage direction
(report-only agent, LESS-0051 safety contract; TSX lane only — never
dist, no builds, no network). doctor had smoke-level coverage only
(compiled-bins-smoke); its rendering contract had no e2e.

**What landed:** `test/e2e-doctor.test.ts` (10 tests, green twice
consecutively, ~3.4-3.7s): the honest UNINSTALLED shape — all 8 checks
rendering 10 report rows (credentials expands to three), exit 1, fleet
the fail row on a fresh home (`0/15 entries current`, manifest-derived);
the register tally derived from the repo's real docs/PROBE_VERDICTS.json
(42 verdicts: 27 green / 1 red / 1 negative / 2 pending / 11 blocked)
matched byte for byte against the CLI output; the exit-code matrix —
provisioned (byte-identical fleet copy, fake agent binaries, canonical
upstream key env, fake cline on the child PATH) = 0; corrupt settings /
stale hub discovery / stale topology discovery each singly flip 0 → 1;
doc-drift and the guard-plugin posture stay warns at 0; crafted-state
overlays (global+workspace settings parse detail via --cwd, stale
discovery against a dead loopback port refusing instantly, guard-plugin
host config).

**Findings recorded (not fixed):**
- **F-1: the register seat is not CLI-reachable** — checkProbeVerdicts()
  is called with no options (src/cli/doctor.ts:344) and resolves its root
  from the module's own location (probe-verdicts.ts:76-83);
  runDoctor never forwards DoctorOptions.root; the fail-closed shapes
  (corrupt/missing register) are pinned at the programmatic seat via a
  tsx child, and the CLI-side proof the seat is the repo file is the
  tally match.
- **F-2: the armed count counts register ROWS, not distinct gates** —
  arming WORKFLOW_ACP_GOOSE_METERED (named by two rows, one green one
  blocked) renders "2 gate(s) armed now" naming one gate (doctor.ts:225,
  233); the test faithfully reproduces the quirk it records.
- **F-3 (cosmetic):** "1 agent prefs" / "1 servers" pluralization.
- **F-4: cline availability has no `*_BIN` seam** in listWebAgents
  (resolves ambient `which cline`, cline-launch.ts:62-74), unlike
  opencode/goose; a cline-free seat can only be crafted on PATH.

**Acceptance criteria:**
- [x] 10/10 green twice consecutively; lint + typecheck exit 0 with the
      file present.
- [x] The LESS-0051 safety contract: TSX lane only (never dist, no
      builds); no network (the only traffic is a dead loopback
      127.0.0.1:1 refusing instantly); every write confined to mkdtemp
      trees; no agent/PTY spawns; focused runs only.

**Residuals (recorded, not covered):** corrupt-register rendering
through the CLI verb (F-1's seat resolution — no env/cwd override; the
programmatic seat carries the fail-closed pins); the non-Linux
containment row (the machine is Linux with /usr/bin/bwrap present —
pinned to all three honest shapes instead).

### W144 - The /bash lane is bounded (Complete - the contained-shell execute takes a wall-clock cap: the backend kills the process group at the expiry and rejects with the named timeout error; the agent tool lane's posture untouched) (2026-09-25)

**Source:** the W142 wave's finding (c) — NO timeout anywhere in the
/bash chain (grep-verified across hub-http.ts, contained-shell-executor.ts,
linux-bwrap.ts); a hung command would hold the hub's executor
indefinitely. The operator's "solve this problem" direction.

**What landed:**
- `ContainedProcessRequest.timeoutMs` (optional): a bounded wall-clock
  execute at the containment contract level. The kill lives in the
  BACKEND (only it holds the child handle): both backends spawn
  DETACHED so the child leads a process group, arm a timer, and on
  expiry SIGKILL the group (ESRCH falls back to child.kill) — the
  review's P3 defense destroys the held stdio streams so `close` fires
  instead of waiting on the dead group's descriptors — and reject with
  `contained command timed out after Nms (process group SIGKILL):
  <partial output>`.
- The executor FORWARDS the option only (it never sees the child
  handle); the hub /bash route passes `bashTimeoutMs(process.env)` —
  DEFAULT_BASH_TIMEOUT_MS 120s, WORKFLOW_HUB_BASH_TIMEOUT_MS a positive
  integer CLAMPED to MAX_BASH_TIMEOUT_MS (3.6e6; an operator-explicit
  env cannot smuggle the unbounded lane back), garbage falls back to the
  default. shellExecutorFor gains the optional 5th param.
- The AGENT TOOL LANE is untouched: run-controller's own
  createContainedShellExecutor call passes no cap, pinned by the
  no-field assertion (the lane's unbounded posture is a separate queued
  decision); the streaming spawn() lane untouched (interactive ACP).
- Pins: the executor forwarding contract (test/
  contained-shell-timeout.test.ts — the cap reaches the backend as
  request.timeoutMs; no option → NO field; the unbounded guard), the env
  seam (test/bash-timeout-env.test.ts — the default, the override,
  garbage fallbacks, the clamp), both backends' kill pins
  (containment/platform — the kill lands at the cap, never at the
  sleep's full duration; the in-cap symmetry guard), and the live-hub
  e2e (test/e2e-hub-bash.test.ts — 750ms cap, `echo partial; sleep 30`
  → 500 with the named timeout error carrying the partial output, the
  hub stays alive and serves the next command, clean shutdown).

**Acceptance criteria:**
- [x] Red-first: with the six src files stashed, exactly the W144 pins
      are red (the forwarding pins, the env seam's import, the two
      backend kill pins, the e2e pin); green after: 39/39 across the
      five pin files; held-out hub-protocol + e2e-contained-shell +
      interactive-containment-cli 8/8; lint + typecheck exit 0.
- [x] Fresh-eyes review APPROVE (five axes; the kill-safety trace —
      detached + group kill + ESRCH fallback + the streaming lane
      untouched — verified; the three strengthening P3s applied
      post-review: the stdio-destroy defense, the clamp, the passthrough
      pin's message clause).

**Residuals (recorded, not fixed):** Number-parse laxity in the override
("0x10" → 16, " 750 " → 750 — bounded either way, cosmetic); the agent
tool lane keeps its unbounded posture (its own queued decision); the
wire shape on timeout is a 500 carrying the message (finding (a)'s
exit-code/representation gap remains its own item); the hung-command
lane can no longer exist to observe (finding (c) is closed, not
superseded).

### W145 - The /bash error contract (Complete - a nonzero command exit answers 422 {error, exitCode} and client-shaped command faults answer 400; the W142 wave's findings (a) and (b) closed with deliberate pin flips) (2026-09-25)

**Source:** the W142 wave's findings (a) (a nonzero exit answers 500
with no exit-code field on the wire) and (b) (an empty command string
passes the route check and 500s in the executor) — the next loop
iteration per the operator's direction.

**What landed:**
- The /bash route's catch classifies the executor's exit error (the
  commandExitError factory attaches {exitCode} — run-controller.ts) as
  422 {error, exitCode}: the command's result is data, never a server
  fault. Server faults, the W144 timeout error, and guard/authorization
  denials carry no exitCode and keep the catch-all's 500.
- The route's command validation classifies the client-shaped faults
  400: an empty string command, an empty structured command, and
  non-string structured args (mirroring containedRequest's TypeErrors —
  the W134 route-classifies precedent).
- The four affected W142 pins flipped DELIBERATELY (3× 422 now asserting
  exitCode — strictly stronger; 1× 400), each with a dated note in the
  file header and at the pin.

**Acceptance criteria:**
- [x] Red-first: with hub-http.ts stashed, the flipped pins are red
      (422/400 asserted against the 500 answers); the W144 timeout pin
      stays green; green after 6/6 (e2e-hub-bash + hub-protocol); lint +
      typecheck exit 0.
- [x] Fresh-eyes review APPROVE (the classification closed — only
      run-controller.ts attaches exitCode to a thrown Error, so no
      non-exit error can misclassify; the route validation mirrors
      containedRequest exactly; the reviewer independently reproduced
      the red-first and the green run).

**Residuals (recorded, not fixed):** cwd-declaration faults (empty,
relative, nonexistent — a canonicalWorkspace TypeError outside the
W145 try) still answer 500 (client-shaped; the pre-existing W142 pin
stands; the fix shape is the same route-classification move and is
queued); /run/begin's client-shaped registry faults (W142's finding
(e)) need the typed-error refactor (the HubRequestError precedent) and
stay queued; the response-side output cap (finding (d)) stays queued.
  - Dated note (2026-09-25, W146): the cwd-declaration faults FIXED —
    the typed WorkspaceDeclarationError answers 400 at /bash and
    /run/begin (the W146 entry); the /run/begin registry-fault part of
    this residual (empty/duplicate runId) remains queued.

### W146 - The workspace-declaration classification (Complete - canonicalWorkspace's two faults throw the typed WorkspaceDeclarationError and /bash + /run/begin answer 400; the W142 wave's cwd findings closed with three deliberate pin flips) (2026-09-25)

**Source:** the W145 residual's queued cwd-declaration faults and the
third member of W142's finding (e) family (the non-canonical
workspace). The next loop iteration per the operator's base-loop
direction.

**What landed:**
- `run-registry.ts`: `WorkspaceDeclarationError extends TypeError` —
  thrown by `canonicalWorkspace` for BOTH faults (non-absolute;
  not-an-existing-directory), messages unchanged. Subclassing TypeError
  preserves `.name === "TypeError"` so message-format pins elsewhere
  survive, and any external `instanceof TypeError` catch keeps working
  (none exist in-repo, grep-verified at landing time).
- `hub-http.ts`: /bash wraps `context.resolveApplication` and /run/begin
  wraps `runController.begin` in try/catch → 400 `{error: message}` for
  WorkspaceDeclarationError, everything else rethrown to the catch-all.
  Empty runId and duplicate runId keep their 500s (recorded, not fixed,
  still queued under W142's finding (e)).
- Refusal semantics unchanged: canonicalization runs BEFORE composition
  (begin validates → duplicate check → canonicalize → compose/addTask),
  so nothing composes and no run task is created — the W139 run-now
  safety story (the fire refuses at controller.begin on a
  non-canonicalizable workspace) depends on the refusal, not the status
  code, and is preserved.
- Three W142 pins flipped DELIBERATELY (dated notes at the pins and in
  the file header): /bash emptyCwd 500→400, /bash relativeCwd 500→400,
  /run/begin non-canonical 500→400. The e2e-hub-schedule.test.ts
  refusal-message pin (the scheduler's "could not begin run: declared
  workspace is not an existing directory") needed NO flip — the message
  and the refusal are unchanged.

**Acceptance criteria:**
- [x] Red-first: with the two src files stashed, the first flipped pin
      is red (expected 400 / actual 500 at emptyCwd; the single-block
      suite aborts there); green after: e2e-hub-bash 2/2, held-out
      hub-protocol + e2e-hub-routes + e2e-hub-schedule 7/7; lint (the
      W146 files clean; one unrelated error in an uncommitted wave
      file) + typecheck exit 0.
- [x] Fresh-eyes review APPROVE (five axes; the classification closed —
      WorkspaceDeclarationError is thrown at exactly two sites, and a
      plain TypeError from begin's empty-runId does not satisfy
      instanceof, so the 500 pins stay honest; refusal-before-composition
      verified in source).

**Residuals (recorded, not fixed):** /snapshot's resolveApplication has
the SAME client-fault exposure and still answers 500 (pre-existing,
unpinned — the review's P3); /run/begin's empty-runId and
duplicate-runId 500s remain queued (W142 finding (e)); the
try/catch-rethrow shape is now duplicated at two call sites — extract a
helper if a third route adopts the classification (the review's P3
nit).

### W150 - The operator posture strip and unified decision inbox (Planned - Paperclip borrow wave 1; spec: docs/superpowers/specs/2026-09-26-paperclip-dashboard-borrowings.md Wave 1) (2026-09-26)

**Source:** the Paperclip borrowings spec, mapping rows 1/2/9 (dashboard overview cards, approvals queue, watchdog recovery surfacing). Four posture counts above the two-region layout — runs awaiting review/decision, open budget incidents (W045/W118 tiers), orphaned runs needing recover-or-discard, schedules whose last run failed — above one decision list merging run-gate reviews, recorded review decisions, budget incidents, and orphaned-run recovery, each row with actor + authority basis + an action link into an existing panel.

**Acceptance criteria:**
- [ ] Posture strip renders counts computed only from registry state; a fail-closed empty/degraded state when a registry is absent (focused test).
- [ ] Zero mutations on render; every row's action is a link into an existing panel (no new write routes; test).
- [ ] Decision-list coverage and attribution pinned by a focused projection-function test.
- [ ] lint + typecheck + focused webapp tests green.

**Residuals (recorded, not built):** if the dashboard is ever served beyond loopback, the new action dispatch must be token-gated per the azure spec's Easy Auth track.

### W151 - Budget state as agent posture with incident actions (Planned - Paperclip borrow wave 2; spec Wave 2) (2026-09-26)

**Source:** Paperclip costs/dashboard guides, mapped onto W045 session-budget guard state (mechanism, caps, sticky violation), W118 warn-tier stage, W111 usage views. Per-session budget bar with tier colorization (green under warn, amber at warn, red at abort), a paused-by-budget badge when the sticky violation is installed, and an incident card with two authority-gated actions: keep stopped (acknowledge) and raise cap and resume — dispatched as application-authority proposals, never direct mutations.

**Acceptance criteria:**
- [ ] Posture badge renders only from recorded tier state; no configured caps renders an honest "no local cap" state (not a fabricated 0%).
- [ ] Raise-cap and resume fail closed when the authority withholds the capability (test proves the denial renders).
- [ ] Tier boundaries derived from the same constants the guard enforces (no duplicated thresholds in the UI).

**Residuals (cut):** no three-layer budget scopes, month-rollover, finance ledgers, or provider quota windows — no subscription billing model exists here.

### W152 - Unified activity timeline with actor/authority attribution (Planned - Paperclip borrow wave 3; spec Wave 3) (2026-09-26)

**Source:** Paperclip's activity log (every mutation with actor + entity + before/after), mapped onto the kernel transition log + run registry records via the existing History panel. One chronological feed: kernel transitions, run begin/review/finish, review verdicts, budget tier crossings, schedule fires — each row naming actor (operator/agent/system) and authority basis (kernel transition or authorization record).

**Acceptance criteria:**
- [ ] Every rendered row's actor/authority comes from the underlying record; missing attribution renders an explicit "unattributed" state (test — the UI never synthesizes attribution).
- [ ] Append-only: a test proves no feed mutation path exists.
- [ ] Retention wording matches the hub's actual persistence behavior (asserted in the same test).

**Residuals (cut):** CSV export, permission tiers, "responsible user" (single operator), Paperclip's "permanent record" claim (the panel copies the hub's actual retention verbatim).

### W153 - Schedules as routines with per-schedule run lineage and origin attribution (Planned - Paperclip borrow wave 4; spec Wave 4) (2026-09-26)

**Source:** Paperclip routines (scheduled trigger creates a run with originKind attribution; per-routine run history), mapped onto W074 schedule-registry + hub-scheduler + schedules-view. The gap is the origin link and per-schedule history, not trigger mechanics: schedules-view gains last-run outcome, caused-run count with links, next fire, and a recent-runs filter; run rows anywhere carry "fired by schedule S" origin attribution. If the run registry lacks a schedule-origin field, the change lands in the hub integration layer first (schedule-registry.ts / run-registry.ts), view projects it — never the kernel.

**Acceptance criteria:**
- [ ] A schedule's caused runs and outcomes are registry-sourced, not UI-computed from timestamps (focused test).
- [ ] Run-now stays the only manual trigger path and records origin attribution.
- [ ] Deleting a schedule tombstones its origin rather than dangling historical runs (asserted).

**Residuals (cut):** webhook triggers, variable templating, concurrency/catch-up policies, revision history with restore, cron-picker editor.

### W154 - Work products over evidence, and the RSI objective lineage view (Planned - Paperclip borrow wave 5; spec Wave 5) (2026-09-26)

**Source:** Paperclip's artifacts shelf + work-timeline discipline, mapped onto the Evidence/Changes panels and W073's self-improvement registry. Two panels, one wave: (a) an artifact strip in the Evidence and Changes panels — screenshots render inline, test outputs render as text, each linked to the owning run/evidence record; durable inspectable outputs are first-class while in-worktree paths are signposts and must not present as durable artifacts; (b) the RSI lineage view — objective → iteration → verdict → commit-ref chain projected from self-improvement registry records, one row per iteration, verdict and commit ref clickable into the run record.

**Acceptance criteria:**
- [ ] Evidence with image content renders a preview in place; without previewable content renders a plain record with its freshness state (no silent fallback).
- [ ] The RSI lineage view renders the full chain for a registry objective with honest empty states for absent verdicts/commit refs.
- [ ] A test proves the artifact strip refuses to render a bare filesystem path as a durable artifact.

**Residuals (cut):** agent-initiated uploads (different trust model — Workflow evidence is environment-captured), anchored document comments, workspace file browser, cross-task stacks.

**Design conventions for W150-W154 (from Paperclip DESIGN.md, projection-compatible):** one semantic status token set (running/paused/blocked/awaiting-review/over-budget) shared across badge/row/chart/log (styles.css/theme.ts before W150 lands); machine values monospace with shared formatters (presenters.ts); no redundant toasts; late terminal outcomes refresh silently. No Paperclip vocabulary (hire/CEO/board/company/heartbeat) enters Workflow copy — runs, schedules, reviews, evidence, objectives stay canonical.

### W147 - Open core / deployment-instance repo split (Complete - the placement decision recorded with a gated extraction sequence; MIT root license, split spec, the instances/azure seed with the fail-closed pin check, recorded two-round five-axis review; the strip waits on the work instance repo per W148) (2026-09-26)

**Source:** the operator's 2026-09-26 placement decision — the control plane
stays an open GitHub project; the Azure deployment material (bicep params,
pipelines, service connections, secrets) becomes a separate project on the
work Azure DevOps account, with work paying hosting and inference
(`azure_foundry` provider) while the tools stay the operator's.

**Objective:** Resolve repo placement before deployment work rides the
C-track: record the open-core / instance seam and seed the instance template,
so the work repo starts thin instead of accumulating operator-specific
material in the open repo.

**Depends on:** none directly; complements the 2026-09-25 remote-sandbox
design spec (`docs/superpowers/specs/2026-09-25-azure-container-jobs-remote-sandbox-design.md`,
which owns the plane design, not repo placement).

**Acceptance criteria:**
- [x] Root `LICENSE` (MIT, copyright ultus-net) and `package.json`
      `"license": "MIT"` present — the work tenant has a grant to run the
      code (the root was previously all-rights-reserved). Evidence: the
      21-line MIT text plus the license field landed in f7df818; JSON parse
      valid.
- [x] Spec `docs/superpowers/specs/2026-09-26-deployment-instance-split.md`
      records: the seam table (open core vs instance), the one-way dependency
      rule (instance consumes pinned open artifacts; nothing work-specific
      flows open-side), the pinning scheme (image by digest, modules at a
      pinned tag, no work-side image rebuilds), the `infra/c0/` disposition
      (stays open-side as the qualified reference probe with its append-only
      verdicts), and the local-first guarantee (local surfaces never depend
      on the instance). Landed in f17273a with the dated supersession notes
      below.
  - Dated note (2026-09-26, operator direction): the `infra/c0/` disposition
      recorded in this criterion is superseded same-day — the test-deploy
      folder EXTRACTS to the work instance repo once that repo exists (spec
      §7 dated note and the §11 gated sequence); W148 carries the extraction.
      The verdict-preservation duty (append-only records; git history as the
      archive) is unchanged.
- [x] `instances/azure/` seed exists: README contract + checklist, draft
      two-checkout pipeline skeleton, draft `.bicepparam` skeleton — every
      instance-specific value is a TODO marker, and the seed contains no real
      org, subscription, digest, or secret values (greppable). The refinement
      loop added the fail-closed `verify-pin.sh` skeleton (the §10 Q2
      mechanism) and the pipeline's step-1 script invocation.
- [x] Independent five-axis review of the branch. Two recorded approvals: the
      initial slice, and the extraction-direction delta in two rounds —
      round 1 REVISE with three P2 + two P3 (the seed contradicted itself on
      module sourcing; the recorded sweep list missed .gitignore, the §2
      cell, and the Evidence-base line; the dated note sat under the wrong
      criterion), all repaired in a51963e, round 2 APPROVE per-finding.
      Both verdicts recorded and fingerprint-bound.

W147 is complete. The placement decision is recorded with its extraction
sequence gated behind W148: MIT at the root closes the all-rights-reserved gap
the work tenant would have hit; the seam table, one-way dependency rule, and
digest/tag pinning scheme are recorded; the operator's same-day extraction
direction superseded the original infra/c0 disposition via dated notes (§7,
§11, and the dated note under the disposition criterion) with verdict
preservation as the unchanged duty. The seed ships the README contract +
checklist, a draft two-checkout pipeline, a draft .bicepparam, and — refinement
loop — a fail-closed verify-pin.sh skeleton that concretizes the §10 Q2
mechanism (digest expectation shipped with the open release; the instance
asserts equality pre-deploy). Remaining open question: §10 Q1 (registry
choice), which decides W149's push target.

**Verification:** npm run typecheck exit 0, npm run lint exit 0 (docs/
decision slice, no runtime surface); package.json JSON parse valid;
git diff --name-only origin/main..HEAD confined to the declared file set;
security sweep grep over the new files green (no real org/subscription/
digest/secret values — TODO markers only); verify-pin.sh bash -n syntax check.

### W148 - Extract `infra/c0/` into the work instance repo (strip)

**Source:** the operator's 2026-09-26 direction — the C0 test deploy leaves
the open repo once the work Azure DevOps instance repo is ready to receive it.

**Depends on:** W147 (the recorded seam + seed) and the existence of the work
instance repo consuming the material.

**Acceptance criteria:**
- [ ] The work instance repo holds the extracted material: the bicep modules,
      deploy script, probe, and the C0 pinned-recipe + verdict tables as
      living instance docs.
- [ ] The 2026-09-25 remote-sandbox spec's C-track gains the dated C0
      verdict-preservation note naming the pre-strip sha; the 2026-09-26
      split spec §7/§11 match what actually executed.
- [ ] The strip commit deletes `infra/c0/`, fixes every reference (grep sweep
      re-run at execution time), and closes this entry with the pre-strip sha
      in the message.
- [ ] Independent five-axis review of the strip.

### W149 - The open-side publish workflow (tag → image push + recorded digest expectation)

**Source:** the 2026-09-26 split spec §10 Q2 resolution — the fail-closed pin
check has two halves; the instance half is the seed's verify-pin.sh, the open
half is this workflow.

**Depends on:** W147 (the recorded pinning scheme) and §10 Q1 (the registry
choice decides the push target).

**Acceptance criteria:**
- [ ] A GitHub Actions workflow builds the product image from the tagged
      commit, pushes it to the chosen registry, and records the pushed digest
      as a RELEASE ASSET or release note at that tag — never as a mutating
      file in the tagged tree (the digest cannot exist before the image is
      pushed). The expectation and the artifact come from the same workflow
      run; no hand-copied digests.
- [ ] The record's format is what verify-pin.sh's contract consumes (a
      sha256:<64-hex> line the instance can materialize at the pinned ref).
- [ ] Adopter-facing docs record the publish/tag flow.
- [ ] Independent five-axis review.
  - Dated note (2026-09-26 loop): the machinery landed —
      `.github/workflows/publish-image.yml` (v* tag push + manual dispatch;
      downloads the operator-attached qualified opencode asset, sha-verifies
      it against `images/control-plane/opencode.sha256`, builds
      `images/control-plane/Dockerfile`, pushes to GHCR, records the pushed
      digest as a release asset + note on the SAME tag's release) and the
      first-cut Dockerfile (single-stage; carries the toolchain + vendored
      opencode; the C-track's C1 refines the in-container composition). NOT
      yet verified live: no GitHub run has executed, and docker was
      unavailable to the authoring session — the Dockerfile is unverified
      until the first tagged build. Operator gate: attach the qualified
      opencode binary as a release asset on each pinned version's release
      (v2.0.10 is not publicly fetchable); without that asset the workflow
      fails closed at the download step. YAML-parse and the sha256sum -c
      fail-closed mechanics verified locally; the digest-record format
      matches verify-pin.sh's contract (sha256:<64-hex>, single line). CI
      placement: tier D of docs/CI.md. Refinement-loop P2 (the review's
      static catch): the Dockerfile's opencode COPY paths were
      Dockerfile-dir-relative while the build context is the repo root —
      fixed in the same commit as this note; exactly the class of defect the
      unverified-until-first-build status exists to surface before a run.

### W155 - CI implementation (tiers per docs/CI.md; C deferred; renumbered from W150 — the Paperclip borrow wave landed W150-W154 first)

  - Dated note (2026-09-26, first live CI run on PR #132): the gate job
      caught the pnpm pin mismatch — the toolbox declares
      `packageManager: pnpm@11.5.2` (mcp-toolbox/package.json:4) while
      corepack's default shim resolved pnpm 12.6.0, which pnpm itself
      refuses (ERR_PNPM_BAD_PM_VERSION); and `npm ci`'s postinstall
      prepare-tool skipped the toolbox build honestly (W137's always-exit-0
      contract), leaving toolbox:verify to fail hard — the fail-closed
      layering worked. Fix: `pnpm/action-setup@v4` reading the nested
      declaration (no duplicated version literal), same discipline in the
      image Dockerfile. The evidence job had not yet run at the time of the
      failure (needs: gate).

**Source:** docs/CI.md (2026-09-26 design) — the operator's "start with CI
design" direction. The repo has no CI at all today; this wires the existing
local discipline into GitHub without violating the full-suite resource
directive.

**Depends on:** W147 (branch context); operator decision 1 (merge-gate scope)
for the evidence job; operator decision 2 (tier C deferral).

**Acceptance criteria:**
- [x] `.github/workflows/ci.yml` runs Tier A (lint, typecheck, build,
      `toolbox:verify`) on every PR and push to main; fail-closed required
      checks. Landed with the `evidence` job alongside (decision 1 = A+B);
      YAML-parse valid; the curated set ran locally against the same steps
      (build → test:ci, 97/97).
- [x] `npm run test:ci` enumerates the curated suites BY NAME (no globs) per
      the curation rule (docs/CI.md §4); 21 suites — the 14
      LESS-0051-contract e2e suites plus 7 unit suites hand-verified this
      loop (no PTY/agent-spawn/env-gate markers); the enumerated set ran
      green locally (97/97).
- [x] Decision 1 = A+B (recorded docs/CI.md §6): both jobs exist and are
      named for required checks; the settings toggle itself is the
      operator's remaining click (residual, recorded in §7).
- [x] Tier C recorded as deferred per decision 2, dated in docs/CI.md §6.
- [ ] Independent five-axis review.
