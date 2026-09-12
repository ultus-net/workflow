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
| `protocol` | number | Contract version. Clients must check `protocol === 1`. |
| `hubId` | string | 16 hex chars; unique per hub instance. |
| `endpoint` | string | Loopback HTTP base URL (`http://127.0.0.1:<port>`). |
| `token` | string | 64 hex chars; bearer capability for all requests. |

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

Every request carries the discovery token:

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

Request: `{ "runId": "schedule:<uuid>", "title": "Nightly audit", "workspace": "/abs/dir" }`
(`workspace` optional; same validation as `/before-tool`.)

Response `200`: `{}`. Duplicate `runId` → authority error (fail closed).

### `POST /run/finish` — close a run with evidence

Request: `{ "runId": "schedule:<uuid>", "outcome": "verified" | "failed" }`

The hub records a mutation, records run evidence (`passed`/`failed`), and
transitions the run task to `VERIFIED`/`FAILED`. Unknown `runId` → authority
error (fail closed).

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

Request: `{ "command": "<string|argv record>", "cwd": "<absolute path>" }`

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
