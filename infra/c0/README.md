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
    node infra/c0/probe.mjs --idle

Gates: `/api/info` health (version-tolerant fallback to v1 `/global/health`),
unauthenticated 401, SSE `text/event-stream` open, session create, stream bytes
after create, session cleanup. Exit 0 only when all pass. `--idle` adds a fourth
gate: hold the SSE stream open through the full 240s ingress idle window.

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
| 2026-09-27 | idle stream survival (240s) | PENDING | `--idle` gate added; live run required |

Image build: ACR run `cr3` (vendored binary verified in-container).
Probe session created + deleted over the live plane.

## Honest gaps (not yet proven)

- **Quiet-stream idle survival unproven**: the 4-minute default ingress idle
  timeout reaps silent streams; opencode's own keepalive behavior under a real
  attached session is the next observation (operator attach session). The probe
  proves activity-flow, not silence-survival. The `--idle` gate now tests
  silence-survival; live verdict pending.
- **State is ephemeral**: no Azure Files volume yet (C2 durability drill).
- **Secret is an ACA-managed secret**, not Key Vault (C1 upgrade).
- **No Easy Auth** (C1.5), **no gateway/broker** (C1) — stock serve only, by design.

## Rebuild/redeploy

    az acr build --registry $(jq -r .C0_ACR /dev/null 2>/dev/null || cat infra/c0/c0.env | grep C0_ACR | cut -d= -f2) ...
    # or simply: bash infra/c0/deploy.sh
