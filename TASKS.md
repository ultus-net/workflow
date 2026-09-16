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
- [ ] goose is reported `enforced` for its proven launch mode only if the permission probe proves pre-mutation interception with denials honored; otherwise it is honestly capped advisory.
- [ ] Spawn classification covers goose's delegation tool names when applicable; unknown high-blast-radius tools fail closed.

W048 scaffolding is complete; the live qualification is pending the operator's probe runs. What landed: `AcpAgentKind` gains `goose` (`WORKFLOW_ACP_AGENT` validation message grown), `src/integrations/goose-agent-config.ts` composes the hub-owned launch profile — `resolveGooseLaunch` (WORKFLOW_GOOSE_BIN override, else ambient PATH; goose is a stock AAIF binary, never vendored), `gooseLaunchEnvironment` (`GOOSE_MODE=approve` so mutating tools cross `session/request_permission` — the guard dispatcher and bwrap remain the hard backstops because goose's write classification is LLM-interpreted best-effort; `GOOSE_TELEMETRY_ENABLED=false`; `GOOSE_PATH_ROOT` = the per-runtime config dir with `config.` prefix for prune parity; the provider fork: OpenRouter composes OPENROUTER_HOST → loopback metering proxy with the placeholder-only credential inside the boundary — parity with the Cline/OpenCode paths, real key proxy-side; azure_foundry composes direct with hub-injected AZURE_FOUNDRY_* env — ambient az-CLI and Entra auth cannot survive the scratch-HOME boundary, and a missing endpoint/key throws fail-closed), and `gooseConfigYaml` (the skills-mcp stdio extension mount candidate — no native `.agents/skills` in composed workspaces; the config.yaml schema under GOOSE_PATH_ROOT is a research-record unknown, so the candidate is labeled probe-pending and the MOUNT probe is the instrument that resolves it, with NO_MCP_TOOLS recorded as an honest negative finding per the Cline MCP-mount precedent). `createGooseRuntime` (acp-runtime) wires it all: contained bwrap launch, the skills mount's readablePaths dual-bind, budget composition via the shared guard on the OpenRouter path (the azure direct path carries no local metering — its mechanism record states provider-side spend limits honestly), and dispose/cleanup parity. The six probe files exist (`test/acp-goose-{permission,subagent,mcp-mount,resume,metered,hooks}-probe.test.ts`, gates `WORKFLOW_ACP_GOOSE_{PERMISSION,SUBAGENT,MCP_MOUNT,RESUME,METERED,HOOKS}=1`, family conventions: env-gate skip, mkdtemp workspaces, SIGKILL cleanup, agentInfo version evidence, end_turn gating) with the goose-specific mechanics per the plan: the PERMISSION probe asserts usable reject options AND denial-honored (the pivotal enforcement probe), the SUBAGENT probe asserts absence-or-denial (a different Green than OpenCode's permission-gated spawn — subagents are disabled in approve mode), the MOUNT probe's honest-negative rule, the RESUME probe shares the scratch home across phases (goose state lives under GOOSE_PATH_ROOT), the METERED probe runs per provider and asserts the usage_update channel projection (W047 made the goose custom notification observable), and the HOOKS probe composes a project-scope deny plugin with NO_HOOK_EFFECT as the honest negative for the Cline-seam decision. `test/goose-agent-config.test.ts` (5) pins the composition surface (provider validation fail-closed, launch resolution errors, the approve profile env, azure missing-env refusals, the config candidate); the six probes skip cleanly without their gates (11 tests: 5 pass, 6 skip). Spawn classification: `KNOWN_SPAWN_TOOLS` is UNCHANGED — goose's delegate/load names enter only if the SUBAGENT probe shows them projecting (under approve mode they are expected absent); until evidence, an unknown delegation tool is mutation-classified and fails closed to a session teardown (the existing unknown-mutation gate), which satisfies the fail-closed criterion — the enforcement-classification criterion and the live-verdict criteria stay unchecked until the operator runs the probes with provider credentials and records the per-probe verdicts in `docs/HOST_ADAPTERS.md` (the goose row is scaffolded with "No verdict — wired and gated, no live runs yet"). Honest unknowns carried forward from the research record: the config.yaml schema/location under GOOSE_PATH_ROOT, which usage channel carries usage_update, the hook plugin manifest format, the reject-option shapes goose presents, and goose's ACP protocol revision — each is resolved by exactly one of the six probes, and a negative outcome is recorded as a finding, never smoothed.

**Verification:** the composition unit tests (5/5) and the probe family's clean gate-skips are green; the LIVE probe runs with evidence logs and `docs/HOST_ADAPTERS.md` verdicts pend the operator's credentials and gates — goose is not reportable `enforced` or `advisory`-with-verdicts until they run.

### W049 - Goose as the operator's general-purpose daily agent

**Objective:** Dogfood goose (contained, hub-composed) in the general-purpose/ops-plus-development workload on the universal surface, as the qualification plan's daily-driver criterion.

**Depends on:** W048

**Acceptance criteria:**
- [ ] A recorded dogfood matrix covers representative real work: repo edits, shell/ops tasks, MCP participation, resume across restart, and a denial case.
- [ ] Material gaps versus the current opencode+plugin setup are recorded with severity/workaround; no critical gap is hidden by the result.
- [ ] Cost/usage visibility from W044/W045 is exercised in real sessions on both operator providers.

**Verification:** the dogfood record plus full gates on any code changes it produces.

### W050 - Cline fallback-slot retirement and SDK-seam decision

**Objective:** Remove the vendored-Cline runtime — patched-TUI build, `.workflow-cline` checkout, Cline drivers/probes — once the two separate, probe-gated decisions resolve: the backup-slot takeover (goose) and the SDK seam's host-hook retention.

**Depends on:** W048, W049

**Acceptance criteria:**
- [ ] The backup-slot takeover resolves: the six probes pass and the W049 dogfood period holds, so goose demonstrably covers the fallback/insurance role the vendored-Cline runtime holds today.
- [ ] The SDK-seam retention resolves: the hooks probe proves PreToolUse deny + `on_failure: block` under containment AND subagent-internal tool calls demonstrably fire hooks — or, if they do not, the operator records an explicit accepted-risk decision in the decision doc that the seam's unique subagent-internal visibility is no longer required; the seam is not retired by silence or enthusiasm.
- [ ] Removal removes: the `.workflow-cline` vendored checkout, the patched-TUI build/pretest, `WORKFLOW_ACP_AGENT=cline`, Cline session drivers/adapters, the Cline probe family and their tests — with all references updated (`docs/HOST_ADAPTERS.md`, `docs/FEATURES.md`, `docs/TUI_INTEGRATION.md`, `docs/ACP_DECISION.md`) and the plugin-era findings archived, not silently dropped.
- [ ] The repository's full gates pass on the removal diff; the ACP conformance family still passes for the remaining agent kinds.

**Verification:** the removal diff plus the full suite and an independent five-axis review; the decision record cites the probe evidence and (where applicable) the operator's written accepted-risk record.

### Checkpoint D - Daily Driver Replaced

- [ ] Fresh full verification (complete suite plus typecheck/lint/build) and an independent review pass on the final merged tree.
- [ ] The operator's default harness is the hub-owned surface (OpenCode coding lead, goose general-purpose/backup), the opencode workflow-guard plugin is retired from daily use, and the switch is recorded with the honest delta list (G7 control, per-session escalation counters, any accepted risks).
- [ ] No critical daily-driver gap is hidden: every remaining delta versus the plugin is fixed, accepted in writing, or tracked with severity.
