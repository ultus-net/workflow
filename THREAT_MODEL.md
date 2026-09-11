# Workflow Threat Model

## Security Boundary

Workflow is primarily an application policy and state-integrity layer. It does not become an OS/container boundary merely because policy allows an action. W019 adds an opt-in Linux Bubblewrap process-containment backend whose narrower guarantees are documented in `docs/RUNTIME_CONTAINMENT.md`; those guarantees apply only when execution actually passes through that backend and it returns enforced runtime evidence. Workflow is still not a VM or a boundary against a hostile kernel/administrator.

An `advisory` host may display the same policy decisions but cannot guarantee that a tool, model, extension, or user process did not act outside Workflow. Prompts and model instructions are never treated as a security boundary.

## Trust Zones

- Kernel and application state are trusted only after validation by Workflow's deterministic contracts.
- Host events are external input. Enforced adapters fail closed on malformed recognized safety-relevant metadata; hosts without authoritative interception remain advisory.
- MCP output is untrusted observation data. It must pass `normalizeMcpEvidence`, and evidence still has to satisfy the task's authority, subject, and freshness requirements. Evidence is admitted only at the current mutation epoch; later mutations stale it only when they affect its subject.
- Browser requests are untrusted commands. The current server bounds JSON bodies and accepts only explicit transition intents; it is a loopback development surface, not an authenticated remote control plane.
- Persistence is local authoritative state after validation. The JSON store uses version checks and writer exclusion, but assumes a private/trusted store directory and does not provide protection against a hostile local OS user, filesystem, or administrator.

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
| Allowed process inherits ambient host authority | Linux Bubblewrap backend uses an empty environment, explicit filesystem binds, and isolated network by default | Direct/uncontained process execution remains outside this guarantee; Bubblewrap is not VM/kernel isolation |
| Stale actor overwrites workflow state | Version conflict plus exclusive local writer lock | Store is not a distributed/HA consensus system |
| Malformed/tampered persisted state | Persisted domain fields, graph invariants, verification evidence, and transition records are validated on restore | Private store-directory assumption remains; history is validated for legal transitions but is not a cryptographically authenticated audit log |
| Remote browser drives transitions | Current server binds to loopback in the CLI and accepts only application commands | No authentication; exposing/reverse-proxying it beyond loopback is unsupported |

## Operator Rules

1. Treat `advisory` as observability, never enforcement.
2. Grant `process` or `credentials` only when the runtime also constrains the resulting authority to the intended scope.
3. Keep production credentials and destructive infrastructure permissions outside agent environments by default.
4. Treat MCP, host, UI, model, and persisted bytes as boundary inputs rather than sources of workflow truth.
5. Route allowed processes through `WorkflowContainedProcess` with the Linux backend when relying on W019 containment; direct process APIs bypass that boundary.
