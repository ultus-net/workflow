# C0 — Remote Plane Transport Probe

Status: **DEPLOYED, C0 PROBE PASS** (2026-09-25, australiaeast).

C0 is the first milestone of the remote-sandbox design
(`docs/superpowers/specs/2026-09-25-azure-container-jobs-remote-sandbox-design.md`,
§8 C-track): prove that a **stock** `opencode serve` works over Container Apps
external ingress — health, auth rejection, and the SSE event stream — before any
Workflow code rides on the transport. No Workflow code is in this image.

## Layout

    infra/c0/
      image/Dockerfile   node:22-slim + VENDORED stock opencode v2.0.10 binary
      infra.bicep        VNet + workload-profiles env + ACR + MI + acrpull
      app.bicep          container app (external ingress, pinned C0 recipe)
      deploy.sh          three-phase deploy; writes c0.env (gitignored)
      probe.mjs          health / negative-auth / SSE round-trip gates
      c0.env             FQDN + server password + vendored sha (never commit)

## Deploy

    bash infra/c0/deploy.sh

Idempotent: existing resources reconcile; the vendored binary is re-staged and
re-hashed each run. Connection material lands in `infra/c0/c0.env` (chmod 600).

## Probe

    node infra/c0/probe.mjs

Gates: `/api/info` health (version-tolerant fallback to v1 `/global/health`),
unauthenticated 401, SSE `text/event-stream` open, session create, stream bytes
after create, session cleanup. Exit 0 only when all pass.

## Operator attach (the point of all this)

From a machine with the stock opencode TUI:

    cd infra/c0
    set -a; source c0.env; set +a
    opencode attach "$C0_BASE_URL" -u opencode -p "$C0_SERVER_PASSWORD"

The stock web UI is also served at `$C0_BASE_URL` (basic-auth prompt in
browser). Easy Auth (Entra ID) is deliberately NOT here yet — that is C1.5.

## Pinned C0 recipe (what actually worked)

| Setting | Value | Note |
| --- | --- | --- |
| Ingress | external, targetPort 4096 | TLS terminated at ingress |
| Transport | `http` (HTTP/1.1 chunked) | SSE needs chunked, not h2 upgrades |
| Session affinity | **absent** | unsupported at this revision mode; pointless at `maxReplicas 1`; revisit only if scaled >1 |
| Scale | minReplicas 1, maxReplicas 1 | always-on posture (spec §10, operator-decided) |
| Resources | 0.5 vCPU / 1 GiB | consumption plan |
| Auth | `OPENCODE_SERVER_PASSWORD` as ACA secret | Key Vault deferred to C1 |
| opencode | v2.0.10 standalone, vendored | sha256 `c2fe3b18be9e67222d136c818512e3a07213d86ffd5d9176919965d08ac9b9db`; not a published release — dev-channel build the control plane qualified against |

## Verdicts (append-only, per the honest-claims culture)

| Date | Check | Verdict | Evidence |
| --- | --- | --- | --- |
| 2026-09-25 | health `/api/info` | PASS | `{"version":"2.0.10",...}` — pinned build confirmed in-container |
| 2026-09-25 | unauthenticated rejected | PASS | 401 through ingress |
| 2026-09-25 | SSE stream open | PASS | `content-type text/event-stream` through external ingress |
| 2026-09-25 | session create | PASS | `ses_f2822b94fffeEVeikiGTJYFocy` |
| 2026-09-25 | SSE activity round-trip | PASS | 528 stream bytes received after create over the same ingress |
| 2026-09-25 | session cleanup | PASS | 204 |

Image build: ACR run `cr3` (vendored binary verified in-container).
Probe session created + deleted over the live plane.

## Honest gaps (not yet proven)

- **Quiet-stream idle survival unproven**: the 4-minute default ingress idle
  timeout reaps silent streams; opencode's own keepalive behavior under a real
  attached session is the next observation (operator attach session). The probe
  proves activity-flow, not silence-survival. The event-stream keepalive recipe
  at the bottom of this file is the Workflow-side mitigation — transport
  liveness only, still not a deployed-ingress qualification.
- **State is ephemeral**: no Azure Files volume yet (C2 durability drill).
- **Secret is an ACA-managed secret**, not Key Vault (C1 upgrade).
- **No Easy Auth** (C1.5), **no gateway/broker** (C1) — stock serve only, by design.

## Rebuild/redeploy

    az acr build --registry $(jq -r .C0_ACR /dev/null 2>/dev/null || cat infra/c0/c0.env | grep C0_ACR | cut -d= -f2) ...
    # or simply: bash infra/c0/deploy.sh

# c0 — event-stream keepalive recipe

The pinned recipe for keeping the `/api/event` SSE stream alive behind ingress
proxies that destroy an idle response after roughly 4 minutes, so an attached
session survives a quiet period instead of dying with the proxy's idle timer.

This file records the recipe only. The keepalive half lives in
`src/integrations/opencode-server-gateway.ts` and the client-side reconnect in
`src/integrations/remote-acp/engine.ts`; the numbers and strings below are
pinned to those sources by `test/infra-c0-recipe.test.ts`, so the recipe cannot
drift from the code it describes.

## The interval

The keepalive interval defaults to **15s** and must sit well inside the
~4-minute ingress idle window — 15s leaves ~16 consecutive intervals of margin
before the proxy's idle timer fires, which is what makes a single missed frame
harmless.

- `DEFAULT_SSE_KEEPALIVE_MS = 15000` (15s) — the default, exported from the
  gateway module.
- Frame written on each idle interval: `SSE_KEEPALIVE_FRAME`, the SSE comment
  frame `": workflow-keepalive\n\n"`.

The timer is re-armed on every upstream chunk, so a busy stream is never
interleaved with a keepalive frame, and it is cleared on upstream
end/error/close and on response finish/close, so no timer outlives a
disconnect. It is `unref()`ed.

A comment frame carries no `event:` and no `data:` field, so a conforming
parser ignores it: the client sees byte activity, never a phantom event.

## The override

`WORKFLOW_SSE_KEEPALIVE_MS` overrides the interval. It must parse as a
**positive integer**; **any** non-positive-integer value falls back to the
15s default rather than arming a broken timer:

| `WORKFLOW_SSE_KEEPALIVE_MS` | Effective interval |
| --- | --- |
| unset | 15000 (the default) |
| `40000` | 40000 |
| `""`, `0`, `-1`, `1.5`, `abc` | 15000 (the default) |

Failing closed here is deliberate: a malformed override degrades to the known-good
default, and a zero or negative interval would otherwise be a busy loop that
writes frames as fast as the socket allows.

## Coverage: identity encoding only

The keepalive is applied to `text/event-stream` responses whose
`content-encoding` is empty or `identity`. **gzip streams are deliberately
excluded**: a plaintext comment frame spliced into a compressed byte stream
would break the client's decoder, and a broken stream is strictly worse than a
drop-prone one. A `content-encoding: gzip` event stream is therefore proxied
byte-identical and gets no keepalive timer at all — it stays drop-prone at the
ingress. That residual is stated, not hidden.

## The client-side reconnect (the other half)

The frame is best-effort: a gzip stream gets none by design, and a proxy may
destroy an idle response anyway. So the SSE client
(`src/integrations/remote-acp/engine.ts`) treats a subscription that stopped
without being told to as a fault, not as the end of the session. A premature
end — a clean early close or a reset read, which is how a dropped ingress
connection actually shows up — re-opens the route after a capped backoff, up to
a max-attempt bound. A caller abort is not a fault, so an aborted subscription
never re-opens the route.

- `DEFAULT_EVENT_RECONNECT_ATTEMPTS = 10` re-opens after the initial
  subscription; the next premature end ends the generator, and the caller's
  authority loss is recorded exactly as before.
- `DEFAULT_EVENT_RECONNECT_BACKOFF_MS = 250`, doubled per attempt and capped at
  `EVENT_RECONNECT_MAX_BACKOFF_MS = 5000` — 250, 500, 1000, 2000, 4000, 5000, …
- Every attempt re-runs the route choice — v2 `/api/event`, then the v1
  `/global/event` fallback by content type — so a reconnect never inherits a
  stale route decision.
- `eventReconnect: { maxAttempts, backoffMs }` overrides the bounds. A
  non-integer or negative value falls back to the default rather than arming a
  broken bound, and `maxAttempts: 0` is the old one-shot subscription.

Opening the route still fails loudly: a non-OK or non-event-stream answer
throws, so a wrong credential surfaces instead of being retried into silence. A
read fault is rethrown once the bound is spent rather than swallowed into a
quiet end, so the caller's stream-error path stays honest.

## Re-verify

All three commands are hermetic (loopback only, stub upstream, no live host, no
credentials) and run in the ordinary suite. Per `AGENTS.md`, run these focused
rather than the full `npm test`.

```
node --import tsx --test test/opencode-server-gateway-ingress-probe.test.ts
node --import tsx --test test/opencode-server-gateway.test.ts
node --import tsx --test test/remote-acp-engine.test.ts
```

- The **ingress probe** stands a real idle-timeout ingress in front of the
  production gateway and proves the frame buys survival: keepalive inside the
  proxy idle window survives; the control arm (keepalive past the window) is
  destroyed by the proxy, so the first arm is not vacuous; and the gzip
  residual arm keeps the exclusion above honest.
- The **gateway unit test** proves the frame reaches the wire: repeated frames
  during quiet, none on a busy stream, none past a self-ending stream, none in a
  gzip stream, and the interval/override table above.
- The **client unit test** proves the reconnect is bounded and honest: the event
  before a dropped stream and the one after the re-open both reach the caller,
  the v1 fallback is re-decided on a reconnect, the attempt cap terminates
  instead of looping, an aborted subscription never re-opens, a spent cap
  rethrows the read fault, a failed open still throws, and nonsense bounds fall
  back to the defaults instead of arming a hot loop.

## Honest residual (advisory)

**This is transport liveness only, and it is not a deployed-ingress
qualification.** The keepalive holds a connection open and nothing more: it is
never evidence that upstream is alive and never evidence that the hub is the
authority. The probe is hermetic on loopback — a real proxy hop, a stub
upstream, no live host, no credentials — so it is ungated and claims no dated
gate verdict and no `docs/PROBE_VERDICTS.json` row.

What remains unproven: a real nginx/ALB/Cloudflare read-timeout configuration in
front of a live `opencode serve`. Until that is probed, any surface may claim
this recipe as **advisory** and no more. See `docs/HOST_ADAPTERS.md`
(2026-09-26 entries) for the dated record.

The reconnect is the same kind of claim as the frame: transport liveness only. A
re-opened route is never evidence that upstream is healthy, that the hub is the
authority, or that nothing was lost — an SSE resume does not replay: it starts
where the re-opened route starts, so an event emitted while the route was down
is missed. A consumer that needs that gap must re-read state (for example
`messages()`); nothing here replays it.
