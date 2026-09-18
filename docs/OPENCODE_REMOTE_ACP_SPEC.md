# Remote ACP Bridge — Specification (OpenCode web/API → ACP)

**Status:** DRAFT — design + M1 scaffold. The M1 bridge landed on
`feat/opencode-remote-acp-bridge` under operator direction, **advisory only**;
enforcement and the remaining milestones wait on the probe plan in §10.
**Date:** 2026-09-18
**Targets:** (1) the server surface exposed by `opencode serve` (HTTP + SSE) as the
first concrete target; (2) OpenWork `openwork-server` as a reference/adjacent surface.
**Source of record:** local checkout `/var/home/hunter/.opencode-src`
(commit `5a83358`, `opencode` 1.18.31). Line citations below are against that checkout.

---

## 1. Motivation and scope

Workflow already drives ACP agents over stdio (`opencode acp`, stock `cline --acp`,
contained `goose acp`). Two gaps motivate a bridge:

1. **Remote agents.** A hosted or self-hosted server may expose only HTTP/WS, not a
   stdio ACP subprocess. Workflow cannot reach it today.
2. **Non-ACP agents with an HTTP API.** A translator implementing the ACP *agent* side
   over a remote API extends Workflow's existing ACP runtime, permission broker,
   metering proxy, and review control plane to surfaces that have no ACP of their own.

**In scope:** an ACP-agent-side bridge process that speaks ACP over stdio to Workflow
and speaks the remote agent's HTTP/SSE API upstream.

**Non-goals (this spec):** changing Workflow's kernel; replacing `opencode acp`;
building an ACP *client*; a general API-translation framework; any claim of
`enforced` without the probe evidence in §10.

**The one-line truth:** the bridge is only as authoritative as the remote API's
pre-mutation interception. Everything below follows from that.

---

## 2. Investigation findings (what already exists)

### 2.1 Native ACP already exists — but only locally

`packages/opencode/src/cli/cmd/acp.ts` starts a **local** server
(`Server.listen(opts)`), builds an SDK client at `http://<hostname>:<port>` with
`ServerAuth.headers()` (acp.ts:24-30), wraps stdio in an NDJSON ACP stream, and runs
`ACP.init({ sdk })` as an ACP agent (acp.ts:55-61).

`opencode run` already supports attaching to a **remote** server:
`createOpencodeClient({ baseUrl: args.attach, headers: attachHeaders })`
(`cli/cmd/run.ts:346-355`). The ACP command does **not** expose `--attach`.

⇒ The remote bridge is close to "the ACP command, pointed at a remote server": reuse
the native ACP layer (below) against a remote `OpencodeClient`.

### 2.2 The native ACP mapping is a thin client over the server event stream

`packages/opencode/src/acp/event.ts` subscribes to the global SSE stream
(`sdk.global.event(...)`, event.ts:152-165) and dispatches:

- `permission.asked` → `ACPPermission.Handler` (event.ts:98-100);
- `message.part.updated` / `message.part.delta` → ACP `session/update`
  (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`);
- `session.status` idle → turn completion (event.ts:95-97, 184-189).

`packages/opencode/src/acp/permission.ts` maps a permission request into ACP
`session/request_permission` with options `once`/`always`/`reject`
(permission.ts:20-24), auto-rejects when the client cannot request permission
(permission.ts:56-58), rejects on error/cancel (permission.ts:71-74, 78-82), and
replies through the SDK (`sdk.permission.reply`, permission.ts:91-97).

### 2.3 The permission engine is a genuine pre-mutation seam

`packages/opencode/src/permission/index.ts`:

- `ask()` evaluates the ruleset; a `deny` returns immediately **before** the tool runs
  (index.ts:75-76). If any pattern needs asking, it publishes `Event.Asked` and
  **awaits a `Deferred`** (index.ts:100-102) — the tool is blocked until a reply.
- `reply()` accepts `once` / `always` / `reject`; `reject` fails the deferred
  (`RejectedError`) **and rejects every other pending request in that session**
  (index.ts:115-160).

Wire contract (current v2), `packages/protocol/src/groups/permission.ts`:

| Route | Meaning |
|---|---|
| `GET /api/permission/request` | list pending requests (location-scoped) |
| `POST /api/session/:sessionID/permission` | evaluate + create a request |
| `GET /api/session/:sessionID/permission` | list a session's pending requests |
| `GET /api/session/:sessionID/permission/:requestID` | get one request |
| `POST /api/session/:sessionID/permission/:requestID/reply` | `{ reply: once\|always\|reject, message? }` → 204 |

Event definitions: `permission.v2.asked` / `permission.v2.replied`
(`packages/schema/src/permission.ts:43-52`); `Reply = once | always | reject`
(`:40`); `Effect = allow | deny | ask` (`:54-55`). The SDK `Event` union dispatched in
event.ts uses `type: "permission.asked"`; **pin the exact wire type by probe** (§10).

SSE: `GET /global/event` (`groups/global.ts:70,88-94`) and `GET /event`
(`groups/event.ts`), both `text/event-stream`.

Legacy v1 surface (deprecated): `POST /session/:sessionID/permissions/:permissionID`
(`groups/session.ts:395-408`, `deprecated: true`).

### 2.4 OpenWork `openwork-server` (reference)

From `github.com/different-ai/openwork` (`dev` branch; MIT outside `ee/`, EE License
under `ee/`): `apps/server` is a filesystem-backed HTTP API for remote clients over
OpenCode. Relevant pieces:

- Reverse proxy to the engine: `GET|POST|... /opencode/*` and `/w/:id/opencode/*`.
- Per-workspace SSE: `GET /workspace/:id/events`.
- **Host approval layer:** "All writes are gated by host approval"; `GET /approvals`,
  `POST /approvals/:id {"reply":"allow"|"deny"}`; `OPENWORK_APPROVAL_MODE=auto|manual`
  with a timeout. Coarser than the engine's `once`/`always`/`reject`.
- Token scopes: `owner` / `collaborator` / `viewer`; host token `X-OpenWork-Host-Token`.

This is a strong architectural precedent (proxy + approvals + SSE + scoped tokens).
Treat it as **reference, not a dependency**, and do not copy `ee/` code.

---

## 3. Enforcement truthfulness (non-negotiable)

Per `docs/HOST_ADAPTERS.md:57`: `authoritativePreMutation: true` is a runtime-integration
claim, never a transport feature. ACP carrying permission events is not enough.

A remote API bridge may claim **`enforced`** only when **all** hold:

1. **The remote's effective ruleset emits `ask`** for every mutating tool class the
   bridge classifies (`edit`/`write`/`patch`, `bash`, `webfetch`, `task`, …). The
   engine's defaults are permissive (`allow`), which bypasses interception. The bridge
   must pin or verify the ruleset, or treat "mutation proceeded without an `ask`" as a
   **bypass failure** and fail closed/stop the run.
2. **A denial is honored pre-mutation.** Probe-proven: the canary mutation is never
   written after a `reject`.
3. **Workflow controls the launch/config** (locally launched server with a
   Workflow-written ruleset), or the operator has attested the remote configuration.
4. **Spawn scope is probe-resolved.** Like goose/Cline, subagent-internal activity may
   be projection-invisible; spawn stays default-deny unless a per-version probe says
   otherwise (`docs/HOST_ADAPTERS.md:96,105-116`).

Otherwise the surface is advertised **`advisory`** and must be labeled as such. An
`advisory` host may display decisions but guarantees nothing.

**Consequence:** a bridge to an **untrusted remote** is `advisory` unless the remote's
ruleset is pinned to `ask` and independently attested. There is no "enforced because
it's over HTTP/SSE."

---

## 4. Containment boundary

`SECURITY_ASSURANCE.md:253` (residual 18): a network-served agent (`goose serve`
HTTP/WS) is **outside the current containment composition**; enforcement targets stdio
subprocess agents. A remote server is the same class.

- A bridge can enforce **authorization** semantics (permission interception) but
  **cannot contain a process it does not own**.
- `enforced` **containment** requires the upstream process inside a boundary Workflow
  controls (bwrap/container on the same host, loopback-only), exactly as
  `src/containment/` does for stdio agents.
- For a genuinely remote host: the bridge is at best `advisory` for containment, and
  must state that residual in its HOST_ADAPTERS row.

---

## 5. Architecture

```
Workflow (ACP client)                     Remote/attached server
      │  ACP over stdio (NDJSON)                 ▲
      ▼                                          │ HTTP + SSE (basic auth)
┌────────────────────────────┐                   │
│ workflow-acp-remote bridge │───────────────────┘
│  · ACP agent side          │
│  · OpencodeClient (SDK)    │
│  · event → ACP projector   │
│  · permission → reply      │
└────────────────────────────┘
```

- **Transport:** stdio ACP upward (identical to `opencode acp`); HTTP/SSE downward via
  `@opencode-ai/sdk/v2` `createOpencodeClient({ baseUrl, headers, directory })`.
- **Two implementation options (decide in §13):**
  - **(A) Upstream a flag:** add `--attach <url>` (+ `--password`/`--username`) to
    `opencode acp` upstream. Smallest code; depends on upstream accepting it.
  - **(B) In-repo bridge:** a Workflow-side ACP agent that reuses the native ACP
    mapping (event.ts/permission.ts) against a remote client. Self-contained; more
    code; no upstream dependency. **Recommended first** because it can be built and
    probed without waiting on upstream.
- **Turn lifecycle:** `session/prompt` → `session.prompt(...)`; completion on
  `session.status = idle` (mirror `runUntilIdle`, event.ts:74-91). `session/cancel`
  → `session.abort(...)`.
- **Session id mapping:** ACP `sessionId` ↔ server session id (created via
  `session.create`, or `session.load` for resume).
- **Backpressure/fail-closed:** if the SSE stream drops mid-turn, reject outstanding
  prompts and surface "authority lost"; never silently continue.

---

## 6. Envelope mapping (ACP ↔ server, derived from `packages/opencode/src/acp/`)

| ACP (agent side) | Server HTTPS/SSE | Notes |
|---|---|---|
| `initialize` | `GET /global/health`, provider/agent config | Advertise only implemented capabilities |
| `session/new` | `POST /session` | return session id + config options |
| `session/load` | `GET /session/:id` + replay | replay via `message.part.*` |
| `session/prompt` | `POST /session/:id/message` or `.../prompt_async` | wait for idle |
| `session/cancel` | `POST /session/:id/abort` | |
| `session/update` (text/thought) | `message.part.updated` / `message.part.delta` | → `agent_message_chunk` / `agent_thought_chunk` |
| `session/update` (tool) | `message.part.updated` (tool part) | → `tool_call` / `tool_call_update` (`packages/opencode/src/acp/tool.ts`) |
| `session/request_permission` | `permission.asked` event + `POST /api/session/:id/permission/:requestID/reply` | options `once`/`always`/`reject` |
| `session/update` (config) | session config options | `config_option_update` |
| `fs/read_text_file`, `fs/write_text_file`, `fs/list_directory` | `GET /file`, `GET /file/content`, `POST /session/:id/...` | Only if the ACP fs server is implemented; see §10. |

Event wire types to pin by probe: `permission.asked` vs `permission.v2.asked`,
`session.status`, `message.part.updated`, `message.part.delta`.

---

## 7. Permission interception flow

```
tool about to mutate
  → Permission.ask() in the engine evaluates the ruleset
      deny  → DeniedError (pre-mutation)                      [index.ts:75-76]
      ask   → publish Event.Asked; await Deferred             [index.ts:100-102]
  → bridge (SSE) sees permission.asked
  → bridge asks Workflow via ACP session/request_permission
  → Workflow authorizes (kernel state, capability, workspace, guard)
      allow → bridge POSTs reply once|always → Deferred succeeds → tool runs
      deny  → bridge POSTs reply reject → RejectedError; all pending same-session
              requests also rejected → tool does NOT run              [index.ts:115-160]
```

Fail-closed rules: no SSE → reject; no permission capability → reject; malformed
event → reject; reply error → reject; **mutation observed without an `ask` while in
enforced mode → bypass alarm (stop/record), never "assume allowed."**

---

## 8. Credentials and metering

- **Auth:** `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` basic auth
  (`src/server/auth.ts:18-19`), passed via `ServerAuth.headers()` (acp.ts:29). Never
  log or inline the password.
- **Credentials stay in Workflow:** the upstream model key belongs in the existing
  loopback metering proxy; the agent receives only a placeholder, as with the
  OpenCode/Cline/goose runtimes. Duplicate the `--opencode-url`/metering precedent,
  not a new key path.
- **Remote trust:** a remote server holds its own provider credentials; Workflow's
  proxy can only meter traffic it terminates. Record the residual honestly.

---

## 9. Fail-closed rules (mandatory)

| Condition | Behavior |
|---|---|
| SSE stream unavailable | refuse to start (or stop mid-run); no mutations |
| Upstream 401/unreachable | fail closed; surface "authority lost" |
| Permission event malformed/unmappable | reply `reject`; never auto-allow |
| Client (Workflow) cannot answer permission | reply `reject` (mirror event.ts:56-58) |
| Mutation proceeds with no `ask` in enforced mode | bypass alarm; stop; do not certify |
| Unknown ACP/remote version | start `advisory` only |

---

## 10. Version pinning and probe plan

New gated probes (mirror the `test/acp-*-probe.test.ts` family; no date-gating):

1. **PERMISSION (pivotal).** Ruleset pinned to `ask` for a mutating tool; bridge
   intercepts and Workflow denies; assert the canary was **not** written and the tool
   call failed pre-mutation. Green ⇒ `enforced` authorization for this launch.
2. **BYPASS.** Configure the remote to `allow` a mutation; assert the bridge detects
   the unasked mutation and refuses to certify (advisory or hard stop).
3. **RULE-CONFIG VERIFY.** Confirm the bridge can read/pin the effective ruleset
   (`GET /config`) and that a mutation class maps to `ask`.
4. **SUBAGENT.** `task` projection + permission reach (or spawn-denied fallback).
5. **SSE/TURN.** stream text/thought/tool updates and turn completion via idle.
6. **AUTH/METERED.** basic-auth against a protected server; placeholder-only credential
   inside the agent, usage recorded by the proxy.
7. **CONTAINMENT (only if claiming enforced).** server process launched under a
   Workflow-controlled boundary (loopback-only), canary proves no ambient access.

Record per-version verdicts in `docs/HOST_ADAPTERS.md`. Without PERMISSION + RULE-CONFIG
green, the row is **`advisory`**.

---

## 11. OpenWork reuse assessment

- **What to reuse:** architecture patterns — engine reverse proxy, per-workspace SSE,
  host-approval API, scoped tokens, explicit approval mode/timeouts. Its approval
  vocabulary (`allow`/`deny`) is coarser than the engine's `once`/`always`/`reject`.
- **What not to do:** do not depend on OpenWork as a runtime; do not copy `ee/`
  (EE License). MIT code outside `ee/` is usable, but prefer reimplementing the small
  patterns.
- **Worth a separate probe:** whether `openwork-server`'s approval API can be a second
  upstream for the same bridge (target B), and whether its `/opencode/*` proxy already
  surfaces the v2 permission routes.

---

## 12. Milestones (proposed, operator-gated)

- **M0 (this spec):** design + investigation. No code.
- **M1 (landed, advisory):** bridge (option B) with `advisory` posture only. ACP
  surface: `initialize` (loadSession + session list/resume/close capabilities),
  `newSession`, `loadSession` (assistant replay), `resumeSession`, `listSessions`,
  `closeSession`, `setSessionMode`, `setSessionConfigOption`, `prompt` (threads the
  selected mode/model), `cancel`, and permission interception. Gated probe stubs:
  SSE/turn (`WORKFLOW_ACP_REMOTE_SSE`) and basic auth (`WORKFLOW_ACP_REMOTE_AUTH`),
  both skipping by default. HOST_ADAPTERS row `advisory`.
- **M2:** probes 1–4 (PERMISSION, BYPASS, RULE-CONFIG, SUBAGENT). Promote to `enforced`
  only on green evidence.
- **M3:** option A upstream `--attach` if desired; optional OpenWork target B.
- **M4:** containment launch path + probe 7 iff `enforced` containment is claimed.

**Coverage notes (M1):** ACP `fs/*` are agent→client delegation requests; the bridge
is the agent side and the remote server owns its own filesystem, so the bridge does
not implement an fs server. Metering: a remote server holds its own provider
credentials and Workflow's loopback proxy cannot terminate remote traffic, so the
bridge forwards authentication only; the in-process runtime proxy still applies to a
locally-attached server. Both are honest scope boundaries, not gaps to paper over.

---

## 13. Open questions

- Option A (upstream `opencode acp --attach`) vs option B (in-repo bridge)?
- Exact SSE wire type for permission events (`permission.asked` vs `permission.v2.asked`)
  and the v2 reply route's stability.
- Does the local server spawned by `opencode acp` already support attaching to a
  running server, or always spawn one? (acp.ts always calls `Server.listen`.)
- Which mutating tool classes can the bridge guarantee map to `ask` under a pinned
  ruleset, including `external_directory` and `doom_loop`?
- How much of `packages/opencode/src/acp/` can be vendored/reused under MIT vs
  reimplemented?

---

## 14. Risks and residuals

- **False enforcement** if the remote ruleset is permissive but the bridge reports
  `enforced`. Mitigated by BYPASS probe + fail-closed.
- **Containment gap** for remote servers (residual 18); state it, never bury it.
- **Version drift** (the API is versioned/experimental v2); probe every bump.
- **Double authority** if the remote independently enforces; Workflow must remain the
  sole authority, or the bridge must prove equivalence.
- **Credential exposure** on remote hosts; keep keys in Workflow's proxy.
- **Spawn/subagent invisibility**; default-deny spawn.

---

## 15. References

Local checkout `.opencode-src` @ `5a83358` (opencode 1.18.31):
`packages/opencode/src/cli/cmd/acp.ts`, `packages/opencode/src/cli/cmd/run.ts`,
`packages/opencode/src/acp/{event,permission,tool,session,agent}.ts`,
`packages/opencode/src/permission/index.ts`, `packages/protocol/src/groups/permission.ts`,
`packages/schema/src/permission.ts`, `packages/opencode/src/server/auth.ts`,
`packages/opencode/src/server/routes/instance/httpapi/groups/{permission,global,session,event}.ts`.

Workflow: `docs/HOST_ADAPTERS.md` (probe rules), `docs/SECURITY_ASSURANCE.md`
(residuals 10, 18), `docs/RUNTIME_CONTAINMENT.md`, `src/adapters/acp.ts`,
`src/adapters/acp-subprocess.ts`, `src/integrations/acp-runtime.ts`.

OpenWork: `github.com/different-ai/openwork` (`dev`), `apps/server/README.md`,
`AGENTS.md`, `DESIGN.md`, `LICENSE` (MIT outside `ee/`).
