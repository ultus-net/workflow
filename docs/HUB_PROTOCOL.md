# Workflow Hub Protocol (v1)

The Workflow hub is the universal authorization authority for any agent
surface. This document is the **versioned contract** an agent SDK/harness
integrates against; it is deliberately SDK-neutral. Conformance is enforced
by `test/hub-protocol.test.ts`, which exercises the hub using only this
document (plain HTTP + the discovery file, no Cline-derived code).

## 1. Discovery

The hub publishes its identity at a well-known path:

```
<data-dir>/hub/discovery.json        # default data-dir: ~/.workflow
```

Written atomically (temp file + rename) with mode `0600`:

```json
{
  "protocol": 1,
  "hubId": "577f4066848d0f24",
  "endpoint": "http://127.0.0.1:34401",
  "token": "9469a60f…(64 hex chars)"
}
```

| Field | Type | Meaning |
|---|---|---|
| `protocol` | number | Contract version. Clients should treat any `protocol` value other than `1` as unknown and fail closed. (Note: the hub writes `protocol: 1`; the repo's reference client currently validates `hubId`/`endpoint`/`token` shape rather than asserting the protocol number — treat this field as reserved for future contract versioning.) |
| `hubId` | string | 16 hex chars; unique per hub instance. |
| `endpoint` | string | Loopback HTTP base URL (`http://127.0.0.1:<port>`). |
| `token` | string | 64 hex chars; ordinary Cline bearer capability. Verifier-only endpoints use a separate capability. |

Client requirements:

- **Resolve per call**, not once at process start. Detached/long-lived
  processes must tolerate hub restarts and token rotation.
- A missing file means the hub is not running. A file whose endpoint rejects
  the token (401) or is unreachable is **stale**: delete it and fail closed.
- The hub removes the discovery file on clean shutdown.
- The hub is **single-instance per data-dir**: it holds an atomic lock at
  `<data-dir>/hub/lock` (containing the owning pid). A second daemon with a
  live lock holder refuses to start; a lock owned by a dead pid is reclaimed.

## 2. Authentication

Ordinary Cline requests carry the discovery token. Verifier-only endpoints
(`/team-task/verify`, `/run/review`, and `/run/finish`) require the separate
verifier capability described below:

```
Authorization: Bearer <token>
```

Comparison is constant-time. Any request with a missing or wrong token, or a
non-POST method, returns `401`.

## 3. Endpoints

### `POST /health` — liveness probe

No request body. Response `200`: `{ "status": "ok" }`. Clients use this to
validate a discovery file (200 = live hub, 401/unreachable = stale). It is
also the recommended readiness check for service managers.

### `POST /run/begin` — open a dedicated run task

Registers a scheduled/attended run as its own Workflow task, so the run's
tool calls authorize against an `IN_PROGRESS` task and the run records its
own evidence (instead of sharing the interactive task).

Request: `{ "runId": "schedule:<uuid>", "title": "Nightly audit", "workspace": "/abs/dir", "requiresReview": true, "taskPrompt": "the ask the run was launched with" }`
(`workspace`, `requiresReview`, and `taskPrompt` optional; workspace validated
as in `/before-tool`. `requiresReview` makes the run task require `reviewer`
evidence before it can reach `VERIFIED` — the review gate — and, when the
hub is configured with a real `WORKFLOW_TEAM_TASK_VERIFY_COMMAND` (never the
`"true"` default), it also declares fresh passing `environment` evidence for
the workspace's own tests at subject `test:<workspace>`; `begin()` stales
that subject so a later run cannot verify on a predecessor's green tests.
`taskPrompt`
(additive, W041) declares the run's ask: the hub-owned reviewer binds it into
its provenance fingerprint, so the same diff under a different ask is
reviewed fresh and never replays a prior approval; the scheduler always
declares its schedule's prompt.)

Response `200`: `{}`. Duplicate `runId` → authority error (fail closed).

### `POST /review/rubric` — fetch the 5-axis review rubric

Request: `{ "diffText": "<unified diff>", "taskPrompt": "optional context" }`
Response `200`: `{ "rubric": "<prompt for an independent reviewer subagent>" }`.
The rubric embeds the diff (capped at 30k chars), the 5 review axes (test
integrity, task completeness, cleanliness, security, platform), P0–P3
severities, and the verdict format. Ported from opencode-workflow-guard.

### `POST /run/review` — record an independent review verdict

Request: `{ "runId": "schedule:<author>", "reviewerRunId": "schedule:<reviewer>", "verdict": "approved" | "changes_requested" | "rejected", "summary": "<findings>" }`

Requires the verifier capability. The ordinary discovery token cannot submit
reviewer evidence.

Anti-rubber-stamp rules (authority errors → clients fail closed):

- `reviewerRunId` must name an existing run **different** from `runId`.
- `approved` verdicts must reference **at least 3 of the 5 axes** by name.

An approved verdict records fresh `reviewer` evidence for the run (enabling
`VERIFIED` for review-gated runs). Other verdicts record nothing and return
`{ "recorded": false }`.

### `POST /run/finish` — close a run with evidence

Request: `{ "runId": "schedule:<uuid>", "outcome": "verified" | "failed" }`

Requires the verifier capability. The ordinary discovery token cannot submit
environment evidence or finish a run. For `verified`, the hub records **no**
fabricated evidence — promotion is decided by the kernel on the run task's
declared `requiredEvidence`: plain runs (empty requirements, the default)
advance on the finish call alone, while `requiresReview` runs advance only
on fresh reviewer evidence (and, when a real verify command is configured,
fresh passing `test:<workspace>` evidence) — reviewer evidence first, then
test evidence, then `VERIFIED`. When the hub owns a reviewer (production
wiring wires a reviewer factory unconditionally), a finishing review-gated
run that is still missing reviewer evidence auto-launches the contained
hub-owned reviewer inside the finish call — that reviewer's approval IS a
mutation and IS recorded through the same `/run/review` machinery (a
finish call can therefore take minutes: reviewer turn plus, when
configured, the workspace test command). A fail-closed reviewer outcome or
failing/crashing tests leave the run `VERIFYING` with a surfaced blocking
reason — never a silent pass. For `failed`, it records a mutation and fresh
failed environment evidence before transitioning the run task to `FAILED`.
Unknown `runId` → authority error (fail closed).

### `POST /team-task/verify` — verify a Cline team task from external evidence

Request: `{ "taskId": "task_0001", "workspace": "/abs/dir", "evidence": { ... } }`
(`workspace` is optional and follows the same validation rules as `/before-tool`.)

Cline `team_task complete` moves its canonical task to `VERIFYING`; it may then
advance in-process only when Workflow already holds fresh passing environment evidence
from a trusted source. What "already holds" means is verify-command-owned:
the production hub defaults `WORKFLOW_TEAM_TASK_VERIFY_COMMAND` to `"true"`,
so completion runs that command, records passing evidence at the
`test:<workspace>` subject, and auto-promotes immediately; an empty value
disables in-process promotion (the task stays `VERIFYING` until a
verifier-token call supplies evidence); a real command gates promotion on its
exit status (`docs/HUB.md`). For a
workspace-scoped hub application, that task is namespaced as
`cline-team:<encoded-workspace>:<taskId>` so Cline task IDs cannot collide
across workspaces in the shared graph. A bridge without a workspace root uses
the legacy-local `cline-team:<taskId>` form.
A verifier supplies a full Workflow evidence observation to this endpoint.
This endpoint requires a separate verifier capability token generated by the
bridge and returned only to the trusted hub creator; it is not written to hub
discovery, and the ordinary hub token exposed to Cline is rejected. The daemon
also provisions the verifier capability in `hub/verifier.json` (mode `0600`),
separate from Cline's `hub/discovery.json`, for trusted local verification
workers. The evidence must have
`authority: "environment"`, `subject` equal to that canonical task ID, and satisfy the
kernel's normal passing/freshness/mutation-epoch checks. Only an already
`VERIFYING` task can advance to `VERIFIED`. Unknown tasks, mismatched evidence,
and failed or stale evidence fail closed.

### Workflow-internal endpoints (not part of the SDK contract)

The hub also serves two Workflow-internal endpoints used by its own UI/bridge
machinery. SDK clients integrating per §5 must not depend on them; they are
listed here so the running surface is fully observable:

- `POST /snapshot` — returns the projected task snapshot of the resolved
  application for a surface-declared `workspace`. Finished scheduled-run tasks
  and the hub's hidden interactive seed task are excluded from the projection.
  Used by the Workflow monitoring surfaces.
- `POST /team-task` — projects a Cline `team_task` create/claim/complete/block
  update into Workflow's canonical task namespace (before any verifier
  advances it). Completion only moves the task to `VERIFYING`; promotion to
  `VERIFIED` requires Workflow-owned verification. This endpoint answers
  Cline's all-in-one team-task sync, not SDK integration.

Both are ordinary-token endpoints and are versioned informally alongside the
Workflow bridge implementation, not as part of the v1 contract.

### `POST /before-tool` — authorization gate

Called before **every** tool execution.

Request:

```json
{
  "toolCall": { "toolName": "read_file", "toolCallId": "optional-id" },
  "input": { "...": "tool-specific payload" },
  "workspace": "/absolute/path/to/surface-workspace",
  "runId": "schedule:<uuid>"
}
```

`runId` (optional, additive in v1): binds the tool call to a run opened via
`/run/begin`; authorization then targets the run's task. Unknown `runId` →
authority error (fail closed).

`workspace` (optional, additive in v1): the surface's own workspace root. When
present, the hub authorizes path subjects against the declared workspace
instead of the hub daemon's cwd — this is what makes one hub correct for many
concurrent surfaces in different projects. Requirements:

- Must be an absolute path to an existing directory, otherwise the hub
  responds with an authority error (clients fail closed per §4).
- When omitted, authorization falls back to the hub daemon's own workspace.
- Clients must send their real workspace (the agent cannot influence what the
  trusted client shim sends; the bearer token remains the capability).

Response `200`:

- `{}` (or no `stop` field) — the tool is **allowed**.
- `{ "stop": true, "reason": "..." }` — the tool is **denied**; the reason is
  human-readable and safe to surface to the operator.

Error responses:

- `401` — bad/missing token.
- `5xx` — the authority itself failed (e.g. malformed request, internal
  error). Clients must treat any non-200 as a denial (fail closed).

### `POST /bash` — contained shell execution

Routes shell execution through Workflow containment (bubblewrap isolation,
workspace limits).

Request: `{ "command": "<string|argv record>", "cwd": "<absolute path>", "workspace": "<optional absolute path>", "teamTaskId": "<optional active Cline task id>" }`

`workspace` (optional) is the surface's workspace root, validated exactly as
in `/before-tool`; when present, authorization targets the declared
workspace's application (defaults to `cwd`). `teamTaskId` is an ordinary-client lifecycle hint only. When present, Workflow
does not start the generic interactive seed task. Workflow resolves the hint into
its workspace-canonical task namespace and permits process authorization only when
that already-observed task is `IN_PROGRESS`. A known task that is no longer in
progress is treated as a stale lifecycle hint and shell execution falls back to
ordinary interactive authorization; an unknown task still fails closed. The hint
cannot select an evidence subject, record task evidence, or authorize a verification
transition; the ordinary client has no verifier credential.

Response `200`: `{ "output": "<combined stdout/stderr>" }`.
Non-zero exit codes surface as `500` with `{ "error": "<output>" }`.

## 4. Fail-closed requirements (mandatory)

| Condition | Required client behavior |
|---|---|
| No discovery file | Do not execute tools; surface "hub not running". |
| Stale discovery (401/unreachable) | Delete the file; fail closed. |
| `/before-tool` non-200 or network error | Deny the tool. |
| `/before-tool` unreachable mid-session | Deny until the authority returns. |

A client that "fails open" on any of these is non-conformant.

## 5. Integrating a new SDK

1. Read the discovery file (per §1, per call).
2. Before each tool execution, POST `/before-tool`; honor `stop`.
3. If the SDK shells out, route it via `/bash` to inherit containment.
4. Never execute when the authority is unavailable (per §4).

Reference implementations (Cline): `apps/cli/src/utils/workflow-bridge.ts`
(launcher surfaces) and `sdk/packages/core/src/hub/daemon/workflow-hooks.ts`
(hub-side sessions) in the vendored checkout, derived from
`patches/cline-cli-v3.0.61-workflow.patch`.

## 6. Versioning

- `protocol` is bumped only on breaking changes to this document.
- Additive response fields are not breaking; clients must ignore unknown
  fields.
- Additive request fields are not breaking; the hub ignores unknown fields.
