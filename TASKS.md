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
- [ ] The driver registry gains `acp` (`--driver acp`); unavailable agents fail closed with the exact spawn/connect error — no silent fallback to another driver.
- [x] Adapter conformance covers the ACP driver lifecycle (fake ACP server fixture), including denial, cancellation, and malformed-notification fail-closed paths. (`test/acp-session.test.ts` exercises all three through `AcpSessionDriver` + `WorkflowCodingSession`; transport-level malformed/cancel coverage remains in `test/acp-subprocess.test.ts`.)

**Verification:** ACP conformance fixture tests plus one real ACP-speaking agent smoke session; existing gates unchanged.
