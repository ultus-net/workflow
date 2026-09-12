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

## 2. Authentication

Every request carries the discovery token:

```
Authorization: Bearer <token>
```

Comparison is constant-time. Any request with a missing or wrong token, or a
non-POST method, returns `401`.

## 3. Endpoints

### `POST /before-tool` — authorization gate

Called before **every** tool execution.

Request:

```json
{
  "toolCall": { "toolName": "read_file", "toolCallId": "optional-id" },
  "input": { "...": "tool-specific payload" }
}
```

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
