# C1 live test playbook — proving the integrations actually function

**Authored:** 2026-10-10. **Owner:** operator. **One-way rule:** this file names
only environment VARIABLE names, never an instance value. The plane URL and
credential are supplied at run time through the environment; they live in the
instance repo and Key Vault, never here.

This playbook exists because a deploy that *starts* is not a deploy that
*works*. It is the ordered set of checks that turns "the revision is healthy"
into "the modules do what they claim". Every claim below is either a focused
command with an expected observation, or a gated live arm with a pass criterion.
Nothing is asserted from a green deploy.

## How to run

- Offline (no plane, no secrets): run the focused test files named in the
  module map with `node --import tsx --test <file...>`. These are part of the
  default corpus and never need a gate.
- Live (against a deployed plane): set the gate and the env, then run the probe
  file. A missing required env fails the arm; it never silently skips.

```sh
# Layer B — transport + broker (the deployed control plane)
export WORKFLOW_AZURE_PLANE_URL='https://<plane-host>'      # instance value
export WORKFLOW_AZURE_PLANE_CLIENT_PASSWORD='<client-pw>'   # Key Vault only
export WORKFLOW_AZURE_PLANE_PROBE=1
node --import tsx --test test/c1-plane-probe.test.ts

# Broker arm — spends model tokens, so it holds its own gate
export WORKFLOW_AZURE_PLANE_PROBE_BROKER=1
node --import tsx --test test/c1-plane-probe.test.ts

# Idle arm — holds a stream for the full 240s ingress idle window
export WORKFLOW_AZURE_PLANE_PROBE_IDLE=1
node --import tsx --test test/c1-plane-probe.test.ts
```

**Do not run `npm test`.** The full corpus has long (4-minute) and metered arms.
Run the focused file for the module you are checking.

## Status legend

| Mark | Meaning |
| --- | --- |
| ✅ | green, measured in this session (focused run) |
| 🟡 | authored / pending first live run (probe-gated; honest skip offline) |
| ⬜ | not run this session; needs an instance or credential |

## Layer A — offline module map (CPU-only, no secrets)

Each row: what the module is, the focused test that pins it, the observation
that means PASS. All cited rows were re-run green on 2026-10-10 unless marked.

| Module | What it does | Focused test(s) | PASS means | Status |
| --- | --- | --- | --- | --- |
| v2 event envelope (`remote-acp/engine.ts`) | parses `/api/event` frames from v1 contract, v1 `payload`, and v2 `data` shapes into one contract event | `test/remote-acp-engine.test.ts` | `normalizeEventEnvelope` resolves `sessionID`/`id` from a `data` frame; `permissionToolCallId` reads `source.id` | ✅ |
| Authority broker (`opencode-server-authority.ts`) | intercepts `permission.asked`, maps → authorizes → replies; consumes coverage; bypass alarm | `test/opencode-server-authority.test.ts` | data-wrapped ask answered (`once`); v2 `session.tool.success` records the mutation; undecided v2 mutation alarms under `enforced` | ✅ |
| v2 event journal (`opencode-v2-event-log.ts`) | consumes the SSE stream into a deduped, ordered log | `test/opencode-v2-event-log.test.ts` | a `data`-envelope frame resolves `sessionId` and is appended | ✅ |
| Gateway / route class (`opencode-server-gateway.ts`, `opencode-v2-route-class.ts`) | auth precedes classification; forwards allowed routes; broker owns the permission reply route | `test/opencode-server-gateway.test.ts`, `test/opencode-v2-route-class.test.ts` | 401 without auth; allowed routes forwarded; reply route not client-forwardable | ✅ |
| Ask/enforcement end-to-end (offline) | the full ask path with a fake engine | `test/opencode-server-ask-e2e.test.ts` | allow/deny decisions journaled; denials honored pre-mutation | ✅ |
| Projection (`remote-acp/projection.ts`) | maps engine messages/events to ACP session updates | `test/remote-acp-projection.test.ts` | tool kinds/statuses map conservatively; idle detection exact | ✅ |
| ACP bridge (`remote-acp/agent.ts`) | `opencode run --attach` client | `test/remote-acp-agent.test.ts` | modes/models/commands negotiated | ✅ |
| Route-class + permission matrix | live route classification | `test/opencode-v2-route-class.test.ts` | the matrix is pinned by construction | ✅ |
| Budget / metering (`opencode-server-budget.ts`, `model-usage-proxy.ts`) | caps, downgrade, usage accounting | `test/opencode-server-budget.test.ts`, `test/model-usage-proxy.test.ts` | cap math and proxy forwarding pinned | ⬜ |
| Session claims (`opencode-v2-session-claims.ts`) | session ownership claims | `test/opencode-v2-session-claims.test.ts` | claim match/deny pinned | ⬜ |
| Stats (`opencode-v2-stats.ts`) | session statistics | `test/opencode-v2-stats.test.ts` | derived stats pinned | ⬜ |
| Circuit breaker (`opencode-v2-circuit-breaker.ts`) | provider failover lane | `test/opencode-v2-circuit-breaker.test.ts` | trip/reset thresholds pinned | ⬜ |
| Plane supervisor (`cli/plane.ts`) | one-port composition root, reap/exit, env split, fixed bind | `test/plane-supervisor.test.ts` | config fail-closed; gateway bind + 401 + `/api/info` proxy | ⬜ |
| Plane awareness (`integrations/plane-wake.ts`) | health → ready/asleep/broken classify; auto-wake | `test/plane-wake.test.ts` | classification table; no-az never hangs | ⬜ |
| Container boundary (`containment/container-boundary.ts`) | refuses non-container backends; reports `boundaryKind` | `test/container-boundary.test.ts` | outside-env refused; `spawn` reports `container-boundary` | ⬜ |
| Key Vault (`integrations/key-vault.ts`) | secret resolution | `test/key-vault-store.test.ts` | fetch/cache/fail-closed pinned | ⬜ |
| Azure jobs dispatch (`azure-jobs-*.ts`) | enqueue client + schema + record | `test/azure-jobs-schema.test.ts`, `test/azure-jobs-dispatch.test.ts`, `test/azure-jobs-record.test.ts`, `test/azure-jobs-hub-route.test.ts` | validation matrix; fail-closed env; no-SDK REST shape | ⬜ |
| Guard (`integrations/mcp-toolbox-guard.ts`) | policy decision provider | `test/mcp-toolbox-guard.test.ts` | guard input mapping; fail-closed | ⬜ |
| Probe verdict register (`docs/PROBE_VERDICTS.json`) | anti-drift between probes and claims | `test/probe-verdict-register.test.ts` | every gate has a row; every row names its file+gate | ✅ |
| Security assurance (`test/security-assurance.test.ts`) | claim honesty | `test/security-assurance.test.ts` | no claim outruns its evidence | ⬜ |

Re-run a row with:

```sh
node --import tsx --test test/<file>.test.ts
```

## Layer B — live plane arms (`test/c1-plane-probe.test.ts`)

| Arm | Gate | What it proves | PASS means | Status |
| --- | --- | --- | --- | --- |
| Transport | `WORKFLOW_AZURE_PLANE_PROBE` | ingress auth, liveness, credential split, route matrix, discovery boundary | 401 unauth; `/api/info` 200; `boundaryKind === "container-boundary"`; matrix holds | 🟡 |
| Idle | `WORKFLOW_AZURE_PLANE_PROBE_IDLE` | SSE survives the full 240s ingress idle window | one hold; no drop; no silent resume | 🟡 |
| Broker | `WORKFLOW_AZURE_PLANE_PROBE_BROKER` | a REAL mutating tool turn is intercepted and settles | a `permission.asked` for the session appears AND the tool part leaves `running` for a terminal status | 🟡 |

The broker arm is the live proof of the 2026-10-10 envelope fix
(`docs/OPENCODE_SERVER_AUTHORITY.md` addendum). It is `pending` until a rebuilt
image carrying `fix/opencode-v2-event-envelope` is deployed; on the old image it
is expected to FAIL (the tool hangs at `running`).

## Layer C — manual interactive drill (the model-key path)

Use when you want human eyes on the round trip, or to triage a broker arm
failure. Drive the same session the broker arm drives, and watch both the
stream and the logs.

1. Open the event stream (authenticated): `GET /api/event` (accept
   `text/event-stream`). Keep it open.
2. Create a session: `POST /api/session` body `{}` → `data.id`.
3. Prompt a mutating tool:
   `POST /api/session/<id>/prompt` body `{"text":"Use the shell tool to run: echo PROBE"}`.
4. Read the stream: expect `session.tool.input.*` → `session.tool.called` →
   (a `permission.asked`) → `session.tool.success|failed`. A stream that stops at
   `session.tool.called` with no `permission.asked` or no terminal event is the
   defect signature.
5. Cross-check the broker log line:
   `az containerapp logs show ... | grep authority`. A healthy run shows
   `[authority] allow ... delivered=true` with a real `session=` value. The
   defect shows `deny unknown session=undefined delivered=false ... unmappable`.

## What each result is allowed to claim

- A focused green in Layer A pins the code path, not a deployment.
- A green Layer B transport arm earns **C1 Partial (advisory)** only.
- A green broker arm proves **advisory mediation** (the broker answered). It is
  never an enforcement-bypass claim.
- No arm in this playbook upgrades an `enforced` label for pods. That gate is
  the P2 model-key probe (deploy plan task 8) plus the enforced-posture ruleset
  check (`assertAskRuleset`), which still turns on a v2-shaped config read.

## Honest residuals

- The v2 `session.tool.success` terminal event was never observed live on the
  old image (every mutating tool hung before settlement). The observer's
  terminal-event assumption is grounded in the v2 source (`packages/schema/src/
  session-event.ts`, `Tool.Success`) and the app reducer, and is pinned by
  focused tests; the live confirmation rides the broker arm on the fixed image.
- Layer A rows marked ⬜ were not re-run this session. Run them before treating
  their claims as current.
- The engine's non-broker REST helpers (`createSession`, `messages`, `config`)
  still use v1 path spellings (`/session`, `/config`) that v2 serves under
  `/api/...`. They are off the plane's broker path; the ACP-bridge session-load
  lane is the surface that would exercise them. Flagged, not fixed here.
- `src/integrations/opencode-session.ts` (`OpenCodeSessionDriver.#translate`,
  `:79`) reads `value?.properties` only, and its stream is raw JSON from
  `createOpenCodeSessionClient`/`sseFrames` (`opencode-client.ts:44`) that never
  calls `normalizeEventEnvelope`. A v2 `data` frame drops there too. Pre-existing
  and off the plane's broker path (the driver also uses v1 REST spellings), so it
  is an undeclared residual, not a regression of this fix. The `engine.ts`
  comment "every consumer reads ONLY the contract shape" holds for the consumers
  that go through `HttpRemoteEngine.events`; this driver does not.
