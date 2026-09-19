# Workflow Threat Model

The executable assurance map binding every material security claim below to its implementation boundary and its automated/gated/manual verification is `docs/SECURITY_ASSURANCE.md` (W042), kept honest by `test/security-assurance.test.ts`.

## Security Boundary

Workflow is primarily an application policy and state-integrity layer. It does not become an OS/container boundary merely because policy allows an action. W019 adds an opt-in Linux Bubblewrap process-containment backend whose narrower guarantees are documented in `docs/RUNTIME_CONTAINMENT.md`; those guarantees apply only when execution actually passes through that backend and it returns enforced runtime evidence. Workflow is still not a VM or a boundary against a hostile kernel/administrator.

An `advisory` host may display the same policy decisions but cannot guarantee that a tool, model, extension, or user process did not act outside Workflow. Prompts and model instructions are never treated as a security boundary.

## Trust Zones

- Kernel and application state are trusted only after validation by Workflow's deterministic contracts.
- Host events are external input. Enforced adapters fail closed on malformed recognized safety-relevant metadata; hosts without authoritative interception remain advisory.
- MCP output is untrusted observation data. It must pass `normalizeMcpEvidence`, and evidence still has to satisfy the task's authority, subject, and freshness requirements. Evidence is admitted only at the current mutation epoch; later mutations stale it only when they affect its subject.
- Browser requests are untrusted commands. The current server bounds JSON bodies and accepts only explicit transition intents; it is a loopback development surface, not an authenticated remote control plane.
- Persistence is local authoritative state after validation. The JSON store uses version checks and writer exclusion, but assumes a private/trusted store directory and does not provide protection against a hostile local OS user, filesystem, or administrator.
- Credential values are a separate custody boundary from Workflow's persisted control-plane state. Persisted configuration may contain opaque `secret://<id>` references and non-secret policy metadata, but never credential values. Production secret stores must fail closed when their backing credential service is unavailable; they must not fall back to plaintext files.

## Capability Withholding

Tool capability is independent from task readiness and prompt/model intent. `WorkflowApplication` defaults to allowing only `read` and `mutation`; `process`, `credentials`, and `network` are denied unless an operator constructing the application explicitly grants them. A task being `IN_PROGRESS` cannot grant a withheld capability.

Host adapters must classify high-blast-radius tools while normalizing host events. The built-in Cline adapter classifies its known command-execution tools as `process`; ACP maps `execute`/`process` kinds to `process` and also accepts an explicit correlated capability classification. Unknown ordinary tools retain read/mutation compatibility, so adapter conformance review is required when a host adds new process or credential-bearing tool schemas.

Capability withholding is useful only when the host's execution environment actually routes the capability through Workflow. `WorkflowContainedProcess` composes application authorization with a runtime containment backend: explicit environment requires `credentials`, host networking requires `network`, and the Linux backend starts with neither ambient environment nor ambient filesystem paths. Production credentials should not be made available merely because a model or prompt requests them.

## Threats And Controls

| Threat | Workflow control | Residual risk |
| --- | --- | --- |
| Host bypasses a denied mutation | Enforced/advisory capability is explicit; enforced adapters translate denials to host controls | Advisory or dishonest hosts can act outside Workflow |
| Malformed host subject metadata hides a mutation | Recognized safety-relevant metadata fails closed in enforced adapters | Unknown host/tool schemas require adapter support before they can be claimed enforced |
| MCP response self-certifies success | MCP data is normalized as evidence and cannot mutate task state directly | Compromised evidence authority can lie about the environment; choose authorities accordingly |
| Prompt requests shell/process or credentials | `process` and `credentials` capability classes are default-deny | OS-level access outside the intercepted host is outside Workflow's boundary |
| Agent or MCP requests an unrelated stored credential | Credential brokering checks the declared consumer and workspace before materialization and exposes no general-purpose secret-read tool | A consumer can inspect a credential intentionally materialized into its own process; use narrowly scoped credentials per consumer |
| Browser/API lists credential configuration | Control-plane responses expose credential metadata/configured state only; there is no reveal operation | A privileged same-user process or compromised unlocked OS keyring remains outside Workflow's confidentiality boundary |
| Allowed process inherits ambient host authority | Linux Bubblewrap backend uses an empty environment, explicit filesystem binds, and isolated network by default | Direct/uncontained process execution remains outside this guarantee; Bubblewrap is not VM/kernel isolation |
| Stale actor overwrites workflow state | Version conflict plus exclusive local writer lock | Store is not a distributed/HA consensus system |
| Malformed/tampered persisted state | Persisted domain fields, graph invariants, verification evidence, and transition records are validated on restore | Private store-directory assumption remains; history is validated for legal transitions but is not a cryptographically authenticated audit log |
| Poisoned durable agent state replays every session | W054 provenance stamps on project-memory records (writer, authority, origin surface, timestamp) and a deterministic attestation that flags missing/forged stamps, unexpected writers, untrusted origins, and canary hits; wherever a surface injects that recall before the first turn it is suppressed and reported (`src/integrations/durable-state-attestation.ts`, `mcp-toolbox/apps/project-memory-mcp`). The W050 removal of the vendored-Cline runtime removed the sole pre-first-turn call site; the pass is currently reachable via `npm run durable-state:attest` | Attestation validates structure and provenance, not truth — a validly-stamped writer can still record a false or malicious assertion, and a local user with store access can forge or strip stamps. See the residual note below |
| Remote browser drives transitions | Current server binds to loopback in the CLI and accepts only application commands | No authentication; exposing/reverse-proxying it beyond loopback is unsupported |
| Agent spawns internal subagents the hub cannot gate | `spawn` capability is default-deny; spawn tool proposals classify as `spawn` and host metadata cannot relax it | Agents whose internal subagents emit no permission requests are capped `advisory` or spawn-denied unless probe-verified per pinned version (`docs/HOST_ADAPTERS.md`) |
| Agent or prompt switches a bypass/auto-approve mode at runtime | Enforcement-altering config options are denied client-side before any wire call; agent-originated `config_option_update` is rejected from retained config with a visible status | An agent that ignores its own permission surface entirely degrades to the OS containment boundary — the denial is observable but the agent cannot be forced to ask |
| Review-gated run promoted without a real review | Hub-owned reviewer records distinct-run evidence under the anti-rubber-stamp rules; fail-closed verdict parsing — extended by the W039-W041 control plane: the deterministic coverage manifest with the `[COVERAGE]` fail-closed approval gate, W040 risk-aware partitioning into per-unit reviewers (plus an integration review for multi-unit scopes), and W041 fingerprinted provenance journaling before every record with exact-fingerprint resume (`docs/SECURITY_ASSURANCE.md` S8) | Verdict quality is process discipline (gamable summary conventions), not determinism; evidence validates shape, not truth |
| Run verifies on stale or inherited test results | `begin()` stales the workspace test subject; the hub runs the test command itself and records environment evidence at the current epoch | The test command is only as honest as the project's configured `verifyCommand`; a compromised workspace can pass its own tests |

## Operator Rules

1. Treat `advisory` as observability, never enforcement.
2. Grant `process` or `credentials` only when the runtime also constrains the resulting authority to the intended scope.
3. Keep production credentials and destructive infrastructure permissions outside agent environments by default.
4. Treat MCP, host, UI, model, and persisted bytes as boundary inputs rather than sources of workflow truth.
5. Route allowed processes through `WorkflowContainedProcess` with the Linux backend when relying on W019 containment; direct process APIs bypass that boundary.
6. Treat startup attestation as advisory observability, never a truth oracle: a clean attestation means "no structural or provenance anomaly was detected", not "the durable state is correct".

## Residual Risk: Model-Channel Exfiltration (C3)

Whole-agent Bubblewrap containment retains `network=host` for model egress
(the contained agent must reach its provider). With ambient filesystem paths
hidden but the network path open, **data exfiltration through the model
channel is the main residual risk**: a prompted or poisoned agent can fold
workspace contents into model requests that leave the machine. The
containment boundary limits what the process can *read*, not what the model
*is asked to send*.

Current state: the metering proxy (`createModelUsageProxy`) is the only
mandatory egress point for agent model traffic — it holds the real key and
can observe request volume, but it does not inspect or filter payloads.
Shipped control: per-run budget caps (scheduler, plan Task C2) bound the
channel's capacity — a violating event cancels the turn and fails the run
with the budget as its recorded blocking reason (`src/integrations/hub-scheduler.ts`,
`src/cli/hub.ts`). Still-planned control: the proxy is the natural
egress-policy point for payload policy (destination allow-lists, size
ceilings, content filtering). Until payload policy exists,
operators should treat model egress as unmonitored and keep the most
sensitive material out of agent-readable workspaces.

## Residual Risk: Durable-State Attestation Validates Structure, Not Truth (W054)

Startup attestation and provenance stamps raise the cost and visibility of
persistent memory poisoning: an unstamped, forged-writer, untrusted-origin, or
canary-bearing record is flagged, and where a surface injects project-memory
recall before the first turn its recall is suppressed. But attestation checks
*structure and provenance only* — the same
admission principle Workflow applies to evidence. A writer holding valid
launch configuration can still record a false or malicious assertion and pass
attestation, and a local user with write access to the store can forge a
plausible stamp or strip provenance entirely (the stamp is not a signature and
the store is not an authenticated log). Coverage is also partial today:
collectors exist for project memory, while skills, scheduled-agent state, ACP
session history, and task artifacts are inventoried but not yet attested
(`docs/DURABLE_STATE_INVENTORY.md`). The W054 pre-first-turn wire rode the
vendored-Cline runtime, which W050 removed; no current ACP/hub surface injects
project-memory recall yet, so attestation currently runs on demand via the
operator CLI (`npm run durable-state:attest`) rather than at a live session
boundary. Treat a clean attestation as "no
structural anomaly detected", never as "this durable state is safe to trust".

## Residual Risk: Egress Is a Capability Grant, Not a Destination Filter (W052, 2026-09-19)

`docs/AI_LANDSCAPE_RESEARCH.md` §3.1 records the approved-domain incident:
Cowork's egress allowlist permitted `api.anthropic.com`, and a malicious
workspace file made Claude upload files through the attacker's own API key.
The lesson, stated verbatim there, is that an allowlist "may be better
conceptualized as a **capability grant**. Every function reachable through any
domain on an allowlist is now an attack surface." This section records the
capability-grant posture and its residuals; it does not change any
`advisory`/`enforced` status and does not replace the C3 residual above.

**What is now enforced (proxy boundary only).** The metering proxy
(`createModelUsageProxy`) and each W070a open-model vendor proxy apply
`checkEgressCredential` (`src/integrations/egress-credential.ts`) before
forwarding: a request may carry the hub-provisioned placeholder
(`workflow-metered`) or no credential (the proxy injects the real key), but a
`foreign` credential in `authorization`, `x-api-key`, `api-key`, or
`x-goog-api-key` is rejected `403` (`policy: "egress-credential"`) and never
reaches the upstream. This blocks the specific Cowork pattern — routing an
attacker-supplied key off the machine through an approved domain — for
traffic that actually passes through a proxy. The destination/function
inventory and the full bypass note are in
`docs/EGRESS_CAPABILITY_AUDIT.md`.

**Residuals, stated plainly.**

1. **Direct egress bypasses every proxy.** The contained agent runs with
   `network=host` for model egress, so an agent that opens a connection
   straight to a host is not blocked at any Workflow-controlled boundary.
   Token binding is blocking only at an interposed proxy and detection only
   where a proxy (or another reporter) observes the traffic. There is no
   network-layer egress control today, and none is claimed.
2. **The placeholder is a value discipline, not an identity proof.** The check
   matches a shared constant; it does not cryptographically prove the
   credential was hub-provisioned. A process able to present that constant
   passes.
3. **Payloads are not inspected.** The proxy meters volume and usage; it does
   not read or filter request/response content. Token binding prevents key
   substitution, not content exfiltration under the hub token — the C3
   residual above remains the binding statement on that risk.
4. **The function surface is broad by construction.** The proxy forwards any
   origin-form path on the upstream origin; the grant is function-broad even
   though the code only constructs chat-completion and model-catalog paths.
5. **`egress-audit-mcp` is advisory evidence.** It records reaches reported to
   it (`append_egress_reach`) and computes anomaly flags; it cannot block,
   never enforces, and is not yet wired to proxy events automatically. Its
   coverage is therefore whatever callers feed it.
6. **No live vendor verification was run.** Token binding is verified by
   loopback tests; the env-gated `test/open-model-probe.test.ts`
   (`WORKFLOW_OPEN_MODEL_LIVE=1` plus a vendor key) exercises the same
   placeholder discipline but was not run here because no vendor key was
   available.

## 2026-09-19 — W073 self-improvement loop and W074 scheduled-task manager

Two new surfaces can start autonomous, repo-mutating work. Residuals found by
an adversarial review (dated; several were fixed, the rest are stated here):

1. **The trigger boundary is credential-scoped, not process-scoped.** Starting
   a loop (`/rsi/start`) and firing a schedule (`/schedule/run-now`) require
   the verifier credential from `verifier.json` — the same trust model as
   `/run/finish` — not the ordinary discovery token. That token still sits on
   disk at the same UID as agent processes, and the ordinary token's blast
   radius already includes `/bash` (arbitrary contained shell). A compromised
   agent process that can read `verifier.json` and reach the loopback hub can
   therefore start a loop. What is claimed: the *ordinary surface token* cannot
   start loops or fire schedules. What is not claimed: any protection against a
   same-UID process reading the verifier file. Containment of the discovery/
   verifier files is the binding control and is recorded, not solved.
2. **A candidate can influence its own reviewer.** The reviewer reads a
   candidate-authored diff by definition, and the ≥3-axes anti-rubber-stamp
   check is an output-shape gate, not an independence proof. The loop no longer
   feeds the candidate's hypothesis to the reviewer as the run's ask (the
   operator-authored objective is used instead), but prompt-injection pressure
   through diff content remains. Mitigation in depth: the reviewer verdict is
   recorded evidence, the git history is auditable, and `git reset --hard` can
   revert any accepted commit — but "independent" is a claim with this residual.
3. **Objective/metric gaming is bounded by review, not prevented.** A candidate
   could weaken tests to pass the gate. The reviewer gate is the backstop; no
   automated metric-integrity check exists (e.g. test-count monotonicity).
4. **Destructive git ops are baseline-gated, not sandboxed.** The loop refuses
   to start on a dirty or non-repository workspace, so `git reset --hard` +
   `git clean -fd` can only revert the loop's own candidate changes. What is
   claimed: no pre-existing operator work can be destroyed by the discard path.
   What is not claimed: protection against a workspace that becomes dirty
   mid-loop through an out-of-band actor, or against `git add -A` sweeping
   files an external process wrote during a candidate's apply window.
5. **Loop registry state is in-memory.** A hub restart loses running loops and
   iteration records; a crash between `finish("verified")` and `commit` leaves
   a mutated, uncommitted tree with no resume. This is recorded as the
   long-horizon gap (durable `StateAccessor`-style persistence), not solved.
6. **Run-now bypasses off-peak deferral and the paused flag by design** (an
   explicit operator ask), while review gating and run budgets still apply.
   Cost double-spend is bounded by the per-run budget only if one is
   configured; the loop-level budget (when wired) is separate.
