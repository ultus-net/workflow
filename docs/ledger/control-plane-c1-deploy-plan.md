<!-- Ledger fragment: opened 2026-10-09 as the ordered implementation plan to
make the C1 control plane + Azure job fleet deployable (the 2026-09-25
remote-sandbox spec, §1–§12). Write-once — append dated supersession notes,
never rewrite. Supersedes nothing; it operationalizes the "two candidate
implementations" recorded in docs/ledger/control-plane-c1-composition.md
(2026-10-09). -->

# C1 deploy plan: control plane in Azure + Azure Container Apps job fleet

**Date:** 2026-09-25 spec / plan authored 2026-10-09 · **Status:** plan for
operator decision — no code accompanies this document. Every load-bearing
claim below cites the verified repo source. Anything unverifiable is in §7.

**Base documents:**
`docs/superpowers/specs/2026-09-25-azure-container-jobs-remote-sandbox-design.md`
(§1–§13, "the spec"),
`docs/ledger/control-plane-c1-composition.md` ("the C1-composition ledger"),
`images/control-plane/Dockerfile`, `infra/c0/README.md` (the green C0 recipe),
`docs/RUNTIME_CONTAINMENT.md`, `THREAT_MODEL.md`, `docs/SECURITY_ASSURANCE.md`,
`docs/FEATURES.md`, `docs/ledger/p20-decision.md`.

## 0. Verified current state (the ground this plan stands on)

| Claim | Evidence |
| --- | --- |
| Image builds+runs green under podman; CMD is `workflow-hub` only | `images/control-plane/Dockerfile:112` (CMD), ledger "Verification" block (`control-plane-c1-composition.md:165-178`) |
| Hub binds an ephemeral loopback port, hardcoded | `src/integrations/hub-http.ts:259` (`server.listen(0, "127.0.0.1", …)` — no option) |
| Gateway binds an ephemeral loopback port, hardcoded | `src/integrations/opencode-server-gateway.ts:125` (`server.listen(0, "127.0.0.1", …)`) |
| The `workflow` launcher spawns separate processes per surface | `src/cli/workflow.ts:32-47` (`spawnSurface`) |
| **Partial supervisor already exists**: `workflow-opencode-server` composes runtime + authority broker + gateway in ONE process | `src/cli/opencode-server.ts:190-331` (runtime `:192`, authority `:277`, gateway `:308`); no hub in it |
| Contained `opencode serve` requires `isolation === "enforced"` | `src/adapters/acp-contained-agent.ts:62-63` (sync path; async twin at `:79-80`) |
| Server runtime defaults the backend to `LinuxBubblewrapContainment`; backend is injectable | `src/integrations/opencode-server-runtime.ts:220` (default), `:67` (the injectable option) |
| `enforced` is TYPE-bound to "a real OS isolation boundary (Linux bubblewrap)"; `network: "mediated"` is a fail-closed stub reserved for P20 | `src/containment/contracts.ts:84-91` (docstring names bubblewrap explicitly); `:28-31, :76-82` (`UNSUPPORTED_UNTIL_SUPERVISOR`); `docs/ledger/p20-decision.md` (P20 resolved 2026-10-02 to option 1 — no true-mediation claim) |
| bwrap fails in a default unprivileged container (`Operation not permitted`) | measured, recorded `control-plane-c1-composition.md:130-134` |
| Container-ingress SSE risk is real; keepalive exists in-repo | spec §7/§10 (idle 4 min, 240 s request timeout); `src/integrations/opencode-server-gateway.ts:76-104` (SSE comment-frame keepalive, default 15 s) |
| C0 (stock `opencode serve` through ACA external ingress) PASSED live 2026-09-25 | `infra/c0/README.md` verdict table + "Pinned C0 recipe" (transport `http`, chunked, targetPort 4096, min/max replicas 1) |
| No Azure job-dispatch code exists (no queue client, no `WORKFLOW_AZURE_JOBS_PROBE`) | grep of `src/` + `test/`: only `azure-devops-provider.ts` (AzDO REST board provider, `src/integrations/azure-devops-provider.ts`) and `key-vault.ts`; zero queue/dispatch matches |
| Attach launcher refuses non-loopback gateway URLs at discovery | `src/cli/opencode-attach.ts:72-85` (`isLoopbackGatewayUrl` gate, protocol v1) |
| Upstream model key is never passed to the contained server; the contained launch env carries the placeholder only | `src/integrations/opencode-server-runtime.ts:152-166` (`opencodeServerLaunchEnvironment`), key held proxy-side in daemon memory `:206-219` |
| Secret-store seam to Azure Key Vault exists, REST+IMDS, no new SDK dependency | `src/integrations/key-vault.ts`, `src/integrations/secret-store.ts`; `docs/FEATURES.md:50` (W156 row, Partial pending live-vault probe) |
| Client gateway password is minted randomly every daemon start | `src/cli/opencode-server.ts:312` (`newTuiPassword()`), `src/integrations/opencode-server-gateway.ts:388` |

One prompt-claim correction to record: "there is no single-port supervisor
today; src/cli/workflow.ts spawns separate processes" is true **for the full
C1 set {hub, daemon, gateway, broker, serve}**, but the repo is not at zero:
`workflow-opencode-server` already composes runtime + broker + gateway
in-process (`src/cli/opencode-server.ts`). The plane supervisor work is an
extension of that daemon, not a greenfield build.

## 1. The target, stated precisely

### 1.1 Plane container (one Container App, `minReplicas=1`, external ingress on 4096)

Single revision, single container, single TCP port. All inter-process traffic
is loopback. The container FS/net boundary is the only isolation boundary
inside the pod.

| Process | Runs as | Binds |
| --- | --- | --- |
| **Gateway** | same node process as the plane supervisor | `0.0.0.0:4096` — the ONLY ingress; basic-auth + route-class matrix + SSE keepalive (existing code, needs the fixed-bind option) |
| **Hub HTTP bridge** | same process (in-process factory) | ephemeral loopback (today's shape, unchanged) — kernel tasks/runs/scheduler/review; the dispatch seam lives here (§2.3) |
| **Metering proxy** | in-process loopback server (existing) | ephemeral loopback |
| **`opencode serve`** | child process of the supervisor, launched through the new container-boundary backend (§2.2), hub-only password | fixed loopback port (existing `--hostname 127.0.0.1 --port` args, `opencode-server-runtime.ts:138-140`) |
| **Authority broker** | in-process (existing `createOpencodeServerAuthority`) subscribes the serve SSE with the hub-only `opencode` password | — |
| **`workflow-web` (battlestation)** | NOT in C1 (decision D5) | — |

Ingress serves exactly two surface classes: the **stock opencode web UI**
(proxied by the gateway from the contained serve) and **all `/api/*` lanes**
(TUI attach + broker + future dispatch). One ACA ingress config, one (future)
Easy Auth config with `excludedPaths: /api/*` (spec §10:263-277), one
route-class matrix to probe.

### 1.2 How the plane reaches worker job pods

It does not — jobs have no ingress and are not reachable. Communication is
asymmetric: the plane **enqueues** a task-spec message (§2.3); the job
execution **pulls** the queue, does the work, **pushes** results (branch/PR +
evidence blob) back over standard outbound HTTPS (queue, blob, git remote,
model API). A human merge gate on the PR is the e2e evidence round-trip
(spec §6:126-128). Durable session continuity across pods is explicitly out
of scope (spec §12.2 open; policy: disposable sessions, evidence is the blob).

### 1.3 How a job pod reaches back (Shape B only — deferred, decision D4)

If live steering is ever required: a manual-trigger job holds an execution
open; the pod establishes an OUTBOUND rendezvous (option ranking: a Workflow
run relay behind the existing gateway route-class matrix > WireGuard >
SSH reverse tunnel — the gateway relay keeps one ingress + one credential
split and reuses the existing broker). The pod's in-pod `opencode serve` then
appears to the gateway as a routable upstream. Nothing in §2.4 builds this;
it is designed-but-deferred (spec §4:92-108).

## 2. The open-side code changes

Each change names the file(s), cites the current state, and gives its
acceptance check. None touches `src/kernel/` (kernel purity,
`test/kernel-purity.test.ts` stays the guard). Env gates everywhere; a
missing or malformed pin/value fails at startup, never degrades.

### 2.a Single-port plane supervisor (the composition root)

**New file:** `src/cli/plane.ts` → new bin `workflow-plane`. It is the
`workflow-opencode-server` composition (`src/cli/opencode-server.ts:153-369`)
extended with the hub in-process:

1. Compose the guard (fail-closed precedent `src/cli/opencode-server.ts:166`).
2. Start the hub HTTP bridge in-process via the existing factory in
   `src/integrations/hub-http.ts` — refactor bind into an option (host/port),
   keep `listen(0,"127.0.0.1")` as the default so local behavior is
   byte-identical.
3. Start `createOpencodeServerRuntime({ containment: <backend from §2.b>, … })`
   — the injectable seam at `src/integrations/opencode-server-runtime.ts:67`
   already exists, so the runtime file itself needs no structural change.
4. Start the authority broker (existing `createOpencodeServerAuthority`).
5. Start the gateway with new additive options `host`/`port` on
   `createOpencodeServerGateway` (`src/integrations/opencode-server-gateway.ts:34-59`
   options; bind at `:125`) — in-plane: `{ host: "0.0.0.0", port: 4096 }`;
   CLI/launcher defaults unchanged. Adding options to
   `OpencodeServerRuntimeOptions.port` style is the precedent
   (`opencode-server-runtime.ts:88-89`).
6. Client credential: in-plane the client password MUST come from a stable
   injected value (`WORKFLOW_PLANE_CLIENT_PASSWORD` via the secret-store seam,
   §2.6) instead of a fresh `newTuiPassword()` each boot; a random-per-restart
   password would strand the operator on every replica roll. Fail closed if
   unset in plane mode.
7. Publisher: write the discovery file as today (harmless in-pod) AND print a
   one-line `plane ready https://<fqdn>` log. State root honors
   `WORKFLOW_OPENCODE_SERVER_HOME` (existing, `src/cli/opencode-server.ts:167`)
   pointed at the Azure Files mount (C2).

**Env gate:** `WORKFLOW_PLANE=1` — without it, `workflow-plane` refuses to
start on `0.0.0.0` (a loopback launcher must never silently become a public
one).

**Acceptance:** `node --import tsx --test test/plane-supervisor.test.ts`
(new; lifecycle: binds fixed port, 401 without auth, proxies `/api/info`, SSE
frame survives; shutdown reaps all children). Existing
`test/opencode-server-runtime.test.ts` cases stay green (default bind
unchanged).

### 2.b Containment posture: delegated container-boundary backend

**Recommendation: option A from the C1-composition ledger** ("SupervisorContainment",
`control-plane-c1-composition.md:145-159`) — **over** the namespace-enabled
container (bwrap in-pod) **and over** splitting the plane (option B there).

**Why:**

- Option B (split plane) contradicts the accepted topology ("the container is
  the boundary", spec §10:247-250) and doubles the instance's service
  definitions for an in-pod buyer's-remorse isolation whose threat model the
  delegate already covers.
- The bwrap-in-pod alternative was measured to FAIL in the default
  (unprivileged) container (`control-plane-c1-composition.md:130-134`);
  whether bwrap works under privileged was reported this session from podman
  (`--privileged`) but — critically — **Azure Container Apps does not offer a
  privileged-container knob at all** (its container spec has no `privileged`
  field; ACA runs an unprivileged Kata-style sandbox), so the measured-OK
  path is not even expressible on the target platform. Claiming bwrap in-pod
  is proposing an unreproducible boundary.
- The `enforced` marker promises "a real OS isolation boundary"
  (`src/containment/contracts.ts:84-91`). The pod IS a real OS isolation
  boundary — stricter than bwrap on its outside (no host FS, no host net,
  no other tenants' processes). What it does NOT provide is intra-pod
  narrowing (the contained serve and its agent tool processes share the pod's
  FS/net/proc with the hub, proxy, and toolbox). That delta is recordable
  honestly as a `THREAT_MODEL.md` residual (§6), and it is why the marker
  must carry a discriminator, not a plain `true`.

**The change:**

- **New file** `src/containment/container-boundary.ts`:
  `class ContainerBoundaryContainment implements ProcessContainment` with
  `isolation: "enforced"` — only constructible via `selectContainment` when
  the env gate is set, and it FIRST runs a startup probe that refuses outside
  a container (`/.dockerenv` or `container=` in /proc/1/environ or
  `/run/.containerenv`; fail closed if none present).
- **Type change** `src/containment/contracts.ts`: additive field
  `boundaryKind?: "bwrap" | "container-boundary"` on `ProcessContainment`
  (and echoed on `ContainedProcessResult.enforcement`-adjacent reporting) so
  discovery files, probes, and doc claims can never conflate the two. The
  `enforced` semantics get a dated doc line saying "an isolation boundary the
  backend establishes OR verifies" (the bwrap/pre-container wording is
  preserved; the record is append-only).
- **Selection** `src/containment/platform.ts:119-129` (`selectContainment`):
  `WORKFLOW_CONTAINMENT_BACKEND=container-boundary` selects the new backend;
  any other value / absent keeps `ProxiedBubblewrapContainment` (Linux) —
  explicit opt-in, never a silent default (the ledger's requirement,
  `control-plane-c1-composition.md:150-153`).
- **Grant honesty:** `readablePaths`/`writablePaths`/`writableMountMode`
  cannot be enforced intra-pod. The backend validates the request shape (the
  same absolute-path checks `PassthroughContainment` applies,
  `platform.ts:39-56`) and then delegates; it reports
  `boundaryKind: "container-boundary"` + `credentials: "explicit"` on the
  result, and it REJECTS `network: "mediated"` with the existing
  `UNSUPPORTED_UNTIL_SUPERVISOR` and `network: "proxied"` (no per-process
  netns exists intra-pod) and `read-write-no-delete` (cannot be granted) —
  all fail-closed, copied from the passthrough precedent.
- **Probe-gating the claim:** the plane surfaces its `boundaryKind` in the
  discovery file and the C1 live probe (§4 task 3) asserts
  `container-boundary`; no doc may claim the pod is "enforced" before that
  probe is green — identical to the repo's existing probe-then-claim rule
  (`docs/HOST_ADAPTERS.md` discipline; spec §6:121-128).

**Why this is honest under `docs/RUNTIME_CONTAINMENT.md` + `THREAT_MODEL.md`:**
the worst-case escalation shifts from "agent escapes bwrap to the operator's
host" (local) to "agent has only the pod" (Azure). The pod is disposable,
holds no operator-home state, carries no ambient credentials (§2.4), and its
MI can read only named KV secrets (§2.6). The one genuinely weaker axis —
agent tools reading pod-internal siblings — is bounded by three facts already
in the repo: the model key is never in any env/argv (`opencode-server-runtime.ts:152-166`);
permission interception stays broker-side (`src/cli/opencode-server.ts:277-303`);
credential materialization stays memory-only through the existing
azure-kv seam (`src/integrations/key-vault.ts`). Documented, not hidden,
in §6.

**Optional hardening (recommended, cheap):** `USER node` in the plane image +
0600 state dirs; narrows intra-pod read damage. Tracked as a check in task 2,
operator decides vs `root` (D6).

### 2.c The dispatch seam (hub-side — recommendation D1)

**Owner: the hub.** The hub already owns the journal, run registry, evidence
validation (`docs/SECURITY_ASSURANCE.md` hints at "evidence freshness
hub-owned", spec §6:129-130), and is the only seam that naturally dissolves
the subagent-rooting constraint (spec §9:202-208). Spec §12.5 left this open;
this plan resolves it. (Trade-offs in §5 D1.)

**New module** `src/integrations/azure-jobs-dispatch.ts`:

- **Protocol: REST, no new SDK dependency** — the exact discipline of
  `src/integrations/key-vault.ts` (token via IMDS / `azure-cli`, Bearer auth
  into the data-plane). Storage Queue REST + Queue Service REST needs only
  `x-ms-date` + Bearer; no signature work. Mirrors the W156 precedent.
- **Queue primitive: Azure Storage Queue** (decision D3) named
  `workflow-dispatch`; oversized bodies ride a blob ref in the same storage
  account (the account the C2 Files volume already makes instance-necessary).
  One queue message = one job execution (KEDA queue scaler pattern; pod pulls
  one message, spec §3:75-77).
- **Message schema** (the LESS-0061 "schema is the spec" seam, spec
  §9:209-212): versioned JSON, structurally validated at enqueue AND at pod
  intake — any mismatch refuses. Shape:

  ```text
  { specVersion: 1,
    taskId, repo: { url, ref }, 
    gitPush: { secretRef },          // instance-facing KV ref name, value stays in KV
    model: { id, secretRef },        // instance-facing KV ref name
    task: { message, declaredEvidence[], budgetSeconds, permissionPosture },
    mcp: { manifest[], corpusFingerprint },   // §11:293-298
    artifacts: { evidenceContainer, blobPrefix } }
  ```

  Validation module `src/integrations/azure-jobs-schema.ts` with a
  `test/azure-jobs-schema.test.ts` pin (unknown `specVersion` errors; absent
  `declaredEvidence` errors — a run with no declared evidence never dispatches,
  and a return without it never advances state).
- **Fail-closed posture:** `WORKFLOW_AZURE_JOBS=1` + required env
  (`WORKFLOW_AZURE_QUEUE_URL`, `WORKFLOW_AZURE_EVIDENCE_CONTAINER`); missing
  or malformed → dispatch route throws at startup config load, never best-effort.
- **Result ingest:** a hub `validateDispatch(taskId)` read path (GET + no
  mutation) that pulls the evidence blob and checks `declaredEvidence`
  coverage; outcomes are recorded to the journal. No new kernel types; this is
  Application/Integrations-layer only.

### 2.d The worker job image / recipe

**New** `images/worker/Dockerfile` (mirrors `images/control-plane/Dockerfile`
`structure + vendoring):

- Base `node:22-bookworm-slim`; vendored, sha-verified stock opencode binary
  (the SAME asset + `opencode.sha256` pin as the plane image,
  `images/control-plane/Dockerfile:61-78` — both images pin v2.0.10 from the
  same release asset).
- A single entry script `images/worker/run.mjs` (plain Node, zero
  dependencies — REST-only, matching §2.c):

  1. Read its own MI token (IMDS) → queue → pull ONE message with a
     visibility timeout < `replicaTimeout`; malformed/expired message: exit
     non-zero (KEDA/max-retries handles poison).
  2. Verify the in-image guard corpus against `mcp.corpusFingerprint`
     (the fingerprint file is written at image build after the corpus copy;
     mismatch → refuse, fail-closed; §11:293-298).
  3. Materialize ONLY the named secrets (`model.secretRef`,
     `gitPush.secretRef`) in memory; never write them to disk or env of
     children except `opencode`'s provider env var (required by the binary —
     surface the name in logs only).
  4. Clone `repo.url`@`repo.ref` into a fresh workdir.
  5. Run **stock** `opencode run` headless (spec §3:82-88) with the MCP
     manifest limited to `mcp.manifest`; enforce `task.budgetSeconds` with a
     wall-clock kill.
  6. Push the work as a branch + open a PR; upload the evidence blob
     (opencode output, usage, corpus fingerprint, taskId) to
     `artifacts.blobPrefix`; exit 0 → message delete.

- **`USER node`** from line 1 of this image (no Files mount here; no
  root-path reason to run as root).
- No ingress, no ambient credentials, no baked tokens anywhere (§5 P1 probe).
- ACA job definition consumes this image BY DIGEST (the instance, §3).

### 2.e Shape B: deferred (design only, decision D4)

When un-deferred: new `src/integrations/rendezvous-relay.ts` — a relay the
PLANE exposes behind the gateway's route-class matrix (an authenticated
`/api/rendezvous` lane that pods open as an OUTBOUND upgrade/WebSocket); the
pod connects out to it with its MI bearer; the gateway brokers pod-local
`opencode serve` traffic over it. Design fits the authority broker exactly as
an in-pod broker would. Nothing built now; the seam choice is recorded so the
pod-side launcher contract is not stranded later.

### 2.f `images/control-plane/Dockerfile` changes

| Line | Today | Plan |
| --- | --- | --- |
| CMD (`:112`) | `workflow-hub` (orphan; the honest C1-gap header `:93-111`) | `CMD ["workflow-plane"]`; replace the gap header with a dated supersession note |
| `EXPOSE 4096` (`:91`) | present, honest | keep |
| `WORKDIR /workspace` (`:90`) | present | keep |
| env | absent | `WORKDIR` + the default state root doc — `WORKFLOW_OPENCODE_SERVER_HOME` set by the INSTANCE (Files mount path), never baked |
| `USER` | implicit root | `USER node` + pre-created `/home/node/.workflow` (decision D6) |
| toolbox build (`:56-59`) | green | unchanged (verify-pin / `toolbox:verify` runs at build, spec §11:290-292 already satisfied) |
| vendored binary (`:73-78`) | pinned v2.0.10 | unchanged |

Plus extend `test/control-plane-dockerfile.test.ts` (the existing pins) with
the new CMD/USER/ENV pins.

## 3. The instance-side requirements (values only — `instances/azure/` + the work repo)

The open repo's `instances/azure/` seed (`instances/azure/README.md`,
checklist `:20-35`) grows checklist items; all VALUES (names, IDs, regions)
stay in the work repo. The instance bicep consumes the open `infra/` modules
at a pinned tag and the two images by digest (verify-pin.sh already encodes
the discipline).

What the instance supplies, per C1+P0:

- **Container Apps environment + VNet/workload profile** (reuse
  `infra/c0/infra.bicep` shape).
- **Plane app**: image digest, ingress external `targetPort: 4096`,
  transport `http` (the C0 recipe — SSE-chunked; `infra/c0/README.md`
  "Pinned C0 recipe"), `minReplicas: 1` (standing posture, spec
  §10:226-229), 1 vCPU/2 GiB starting class.
- **Storage account** + **Files share** (C2 state volume:
  `~/.workflow`, opencode data dir) + **queue** `workflow-dispatch` +
  **evidence blob container**.
- **Job definition**: image digest, `replicaTimeout` sized to class,
  KEDA queue scaler (`minExecutions: 0`), no ingress, workload identity
  profile, env = queue/blob URIs only (never secrets).
- **Managed identities** (two): plane-MI (`AcrPull`, KV `get` on named
  secrets, Storage Blob Data Contributor on evidence container, Queue Data
  Contributor) and worker-MI (`AcrPull`, KV `get` on named secrets, Storage
  Queue Data Contributor, Blob Data Contributor) — LB least-privilege,
  work-repo role assignments.
- **Key Vault**: client gateway password, per-task-secret names referenced by
  `secretRef` (model vendor key, git push cred) — KV-secret-ref-or-
  `WORKFLOW_SECRET_STORE=azure-kv` + `WORKFLOW_KEYVAULT_NAME` (the W156
  selection, `docs/FEATURES.md:50`) with the live-vault probe in §4.
- **Easy Auth authConfig** with `excludedPaths: /api/*` (C1.5 — spec
  §10:263-277, one config, one exclusion list).
- **AzDO pipeline** (`instances/azure/azure-pipelines.yml` draft already
  seeds): pre-deploy `bash verify-pin.sh` against the digest from the
  pinned release, approvals/checks, Boards linkage. No work values in the
  seed files.

Explicit stay-out-of-the-open-repo list (the one-way rule): subscription ID,
tenant ID, resource group, app/job/storage/KV names, service-connection
names, FQDNs, secret values, client gateway password, every KL ref name the
instance actually uses (the open schema carries `secretRef` as a string —
naming convention only).

## 4. Ordered task list (acceptance checks; 🛰 = probe-gated, nothing may be claimed before)

| # | Task | Open-side files | Acceptance | Gate |
| --- | --- | --- | --- | --- |
| 1 | Container-boundary backend + type discriminator + selection gate | `src/containment/container-boundary.ts` (new), `contracts.ts`, `platform.ts` | `test/container-boundary.test.ts` (new): refuses outside container env, rejects `proxied`/`mediated`/`read-write-no-delete`, `spawn` reports `boundaryKind` | `npm run lint`, `npm run typecheck`, `node --import tsx --test test/container-boundary.test.ts` |
| 2 | Plane supervisor + gateway fixed-bind + stable client cred. **Acceptance amended 2026-10-09 (DONE):** hub-bind option DROPPED (hub stays loopback; spec §10 needs one container, not one process) and §2.a "in-process hub" landed as a process supervisor — see Appendix C. | `src/cli/plane.ts` (new), `src/cli/plane-config.ts` (new), `src/integrations/opencode-server-gateway.ts`, `src/cli/opencode-attach.ts` (non-loopback explicit URL lane), `package.json` bin, `README.md` | `test/plane-supervisor.test.ts` (new: config fail-closed, supervisor reap/exit-code, env split, gateway fixed bind + 401 + `/api/info` proxy); existing `opencode-server-*` tests green; `test/cli-entrypoint.test.ts` + `test/install-surface-docs.test.ts` green | same trio + focused tests |
| 2b | Launcher plane-awareness (decided, spec §10:230-246, D-rides-C1): health probe → ready/asleep/broken/no-az classify; auto-wake via `az` PATCH; honest state lines | `src/cli/opencode-attach.ts` + new `src/integrations/plane-wake.ts` | `test/plane-wake.test.ts` (new: classification table, no-az never hangs) | focused tests |
| 3 | Image CMD/USER/ENV; podman in-container loopback probe (gateway 401 → /api/info → SSE frame locally). **DONE 2026-10-09** — see Appendix C. | `images/control-plane/Dockerfile`, `.dockerignore`, `test/control-plane-dockerfile.test.ts` | podman build green; `podman run` + curl from inside: 401 without auth, 200 `/api/info`, SSE text/event-stream | measured, recorded in this ledger as a dated supersession of the C1-gap note |
| 3.1 🛰 | **C1 live probe** through ACA ingress: 401, `/api/info`, SSE keepalive past 240 s idle window (the C0 `--idle` gate, mirrored), gateway route-class matrix, broker SSE subscription live, `boundaryKind === "container-boundary"` in discovery, client/upstream cred split over the wire | new `test/c1-plane-probe.test.ts` (env gate `WORKFLOW_AZURE_PLANE_PROBE=1`) | probe exit 0; verdict table in `docs/HOST_ADAPTERS.md` discipline; C1 status Partial (advisory) | deploy-by-the-instance; recorded dated |
| 4 | Dispatch seam: schema + validation + REST enqueue client + hub route/nav seam | `src/integrations/azure-jobs-dispatch.ts`,`azure-jobs-schema.ts` (new), hub route addition in `src/integrations/hub-http.ts` | `test/azure-jobs-schema.test.ts` + `test/azure-jobs-dispatch.test.ts` (new): validation matrix, fail-closed env, no-SDK REST shape | focused tests |
| 5 | Worker image + entry script + corpus fingerprint generation | `images/worker/Dockerfile` + `images/worker/run.mjs` (new) | podman build green; `podman run` against a fake queue (hermetic test): corpus mismatch refuses | `test/worker-image.test.ts` (new pin) |
| 6 🛰 | **P0 e2e**: queue message → job pod → stock `opencode run` → branch+PR + evidence blob on a throwaway repo | instance-side job def; new `test/azure-jobs-probe.test.ts` (env gate `WORKFLOW_AZURE_JOBS_PROBE=1`) | evidence blob cites corpus fingerprint; PR carries taskId; dated verdict recorded | live |
| 7 🛰 | **P1 fail-closed sweep**: image has no ambient creds; no ingress; `minExecutions 0`; KV-refs only; MI least-privilege; budget cap via `replicaTimeout` + watcher | instance checks + probe script section | each check named + result recorded | live |
| 8 🛰 | **P2 authorization seam**: dispatch from the served surface creates a Workflow-authorized task with declared evidence; permission.asked → authorize → reply round trip WITH a model key | hub + probe | permission decisions recorded in journal; `enforced` claim explicitly STILL withheld for pods (spec §6:127-128; §8:P2's model-key probe is the gate) | live + model key |
| 9 🛰 | **C1.5 Easy Auth edge probe** (spec §8): ExcludedPaths `/api/*`; browser redirect; TUI attach through excluded lane; spoofed `X-MS-CLIENT-PRINCIPAL` rejected; unauthenticated app-shell 401 | instance authConfig + probe | 4 gates pass | live |
| 10 🛰 | **C2 durability drill**: Files volume for state; kill replica mid-session; sessions drain/recover per spec | instance bicep + drill script | reconciled sessions list + recording | live |
| 11 🛰 | **P3 lifecycle hardening**: eviction/preemption handling, retry/backoff, poison-queue drill | `images/worker/run.mjs` | poison message lands on poison queue; retry observed | live |
| 12 | Docs hygiene on landing (§6): THREAT_MODEL dated residual, SECURITY_ASSURANCE claim rows, FEATURES rows, supersession notes on both ledgers | the three docs + ledgers | `node --import tsx --test test/security-assurance.test.ts` green | its own focused test |

Probe-name note: `WORKFLOW_AZURE_PLANE_PROBE`/`WORKFLOW_AZURE_JOBS_PROBE`
follow the repo's existing gated-probe convention (`WORKFLOW_ACP_*`,
`WORKFLOW_TEST_KEYVAULT_URL`), skipped honestly without the gate, never in
the default `test:ci` (precedent `docs/FEATURES.md:50`, package.json
`test:ci` listing).

## 5. Decision points for the operator (recommended default + trade-off)

**D1 — Dispatch ownership: hub-side. RECOMMENDED.** The hub already owns
evidence validation, the journal, and the run registry; hub-side dispatch is
what dissolves the subagent-rooting constraint (spec §9:202-208). Trade-off:
the hub takes an Azure control-plane dependency (REST + MI). Cost is small —
`key-vault.ts` already proves the no-SDK discipline inside the boundary.
Broker-side dispatch would push task routing behind the served opencode
surface, which the SDK-boundary section (§2:53) warns is glue, not authority.

**D2 — Containment posture: delegated container-boundary backend
(§2.b). RECOMMENDED.** Only option consistent with "the container is the
boundary" (accepted posture, spec §10:247-250), expressible on ACA (which has
no privileged-container feature), and honest under the type-level rule (the
new `boundaryKind` discriminator instead of a stretched plain `enforced`).
Split-plane (option B) stays on record in the C1-composition ledger as the
alternative; revisit only if a measured intra-pod incident demands it.

**D3 — Queue primitive: Storage Queue + blob-ref. RECOMMENDED.** Cheapest,
zero new services (the C2 Files storage account is instance-mandatory
anyway), KEDA-native, delimiter works with one-message-per-execution pull.
Service Bus adds dead-letter sessions + >64 KiB messages + duplicate
detection — none of which Shape A needs day one; the blob-ref pattern already
covers the size axis. Cost ceiling per run: instance-set, tracked
`replicaTimeout` + W045-style caps on the plane (P1 check).

**D4 — Shape A only for v1. RECOMMENDED.** Shape B fights the job primitive
(records in spec §4:94, §4:105-108 explicitly say so); ship A, revisit B on a
concrete live-steering requirement. The §2.e relay design is recorded so the
decision isn't revisiting a blank page.

**D5 — workflow-web in-plane: defer (not in C1). RECOMMENDED.** C1's operator
surfaces are the stock TUI + stock web UI (spec §1). The battlestation PWA
adds a route-class + hub-API exposure workstream; nothing in the C1 probe
needs it. Re-entry trigger: an operator-facing surface the stock UI cannot
express (spec §2's revisit trigger 1, `:64-65`).

**D6 — Image user: `USER node` in both images. RECOMMENDED.** Cheap
intra-pod narrowing; the only known friction is Files-mount ownership on the
C2 volume (Azure Files mounts honor `uid`/`gid` on the mount — the instance
sets it). If C2 drilling shows a permissions cost, the instance, not the
image, is where this relaxes.

## 6. Honest residuals (dated notes required at landing)

New / updated entries the honest-claims culture requires:

1. **`THREAT_MODEL.md` — new dated residual (next open number, convention
   per SECURITY_ASSURANCE residuals #20/#22/#24/#26): "Delegated
   container-boundary backend (C1, `<date>`)."** The `enforced` marker on
   this lane means "the workload is inside a real container/pod boundary",
   NOT "an intra-pod OS boundary isolates the contained serve from the
   hub/proxy/toolbox". Same-pod agent tool processes share FS, net, and
   `/proc` with the plane. Mitigations on record: model key memory-only
   (`opencode-server-runtime.ts:152-166`), KV secrets via memory-only W156
   seam, `USER node`, no ambient image creds, disposable single-tenant pod,
   intra-pod narrowing unenforced grants are validated-but-delegated
   (§2.b). The marker's boundaryKind discriminates the lane everywhere it is
   reported.
2. **`THREAT_MODEL.md` — new dated residual: "Job pod egress is unfenced
   (P-track)."** ACA does not give Workflow a per-pod egress fence; pod →
   storage/git/model endpoints is identity-gated, not network-gated. Same
   class as the recorded raw-socket residual (W183), different surface.
3. **`docs/SECURITY_ASSURANCE.md` — new claim rows** (table format at
   `:118` precedent): each probe gate from §4 gets a row binding the claim to
   the executing probe (`test/c1-plane-probe.test.ts`, `azure-jobs-probe`,
   Easy Auth, C2 drill) and its recorded dated verdict; the checker
   (`test/security-assurance.test.ts`) pins the honesty statements — row 3
   P1 "no ambient credentials" gets its own executable line.
4. **`docs/FEATURES.md` — new rows** (statuses per the frozen legend `:4`):
   - "Control plane in Azure (C-track)" → **Partial** after task 3.1
     (advisory; stays Partial until P2's model-key probe informs any
     `enforced` label — which even then is *plane-side*, never pod-side).
   - "Azure Container Apps job fleet (P-track)" → **Planned** at merge,
     **Partial** after P0/P1; explicitly "evidence + human merge gate is the
     interception story" (spec §6:126-128).
   - The W071 row (`:89`) gets a dated cross-ref (its advisory label is
     unchanged — C1 does not upgrade it).
5. **Supersession notes, not rewrites:** `docs/ledger/control-plane-c1-composition.md`
   gets a dated append ("plan adopted: option A; see
   control-plane-c1-deploy-plan.md") once approved; the Dockerfile C1-gap
   header (`images/control-plane/Dockerfile:93-111`) gets a dated
   supersession block at task 3; `docs/PARKED_AND_LIMITATIONS.md`'s C1 row
   gets a dated status line. TASKS.md stays frozen — all items above track in
   the GitHub Project.
6. **Already-correct records that stay unchanged:** the 2026-09-25 spec is
   the binding requirements doc — §12.1/§12.5 are resolved by this plan's
   D1/D3 via THIS ledger, not by editing the spec. The launcher
   plane-awareness row (spec §10:230-246) is task 2b, decided posture intact.
7. **`docs/OPENCODE_SERVER_AUTHORITY.md`** gets a dated note that the C1
   probe re-certifies the same route-class/permission matrix at a new
   transport (public ingress vs loopback), mirroring its own M0/M1 probe
   discipline — the probe name + date, no rewrite.
8. **`THREAT_MODEL.md` — new dated residual (task-2 landing, 2026-10-09):
   "Explicit-gateway launcher lane narrows the local attach posture."** The
   remote plane lane makes an operator-exported `WORKFLOW_OPENCODE_GATEWAY_URL`
   (+ `_PASSWORD`, `src/cli/opencode-attach.ts`) take precedence over the
   loopback discovery gate (review P3i). Rationale: env vars are operator
   intent, not local discovery state. Residual: any same-user process that can
   set those env vars in the launcher can point the client at an arbitrary
   http(s) host with a chosen credential — a narrowing from "only loopback is
   reachable locally". Opt-in and not on the plane container itself; the
   discovery loopback gate is unchanged for the ambient path.

## 7. What I could NOT verify (statements to treat as claims-to-measure, not facts)

1. **The privileged-podman bwrap success** (`--privileged` → BWRAP-OK): the
   ledger records only the *failure* in the default container
   (`control-plane-c1-composition.md:130-134`); the success was reported this
   session from outside-repo measurement. Even if true, §2.b argues it is
   inexpressible on ACA (no privileged field), so the plan not hinge on it —
   but I did not re-measure it here.
2. **ACA container capabilities for user namespaces** (whether `unshare`
   works unprivileged on the ACA sandbox, in which case bwrap-in-pod →
   possible): unmeasured on ACA; a future one-line job-op probe
   (`unshare -Ur true`) is the way to know. Plan is structured so the answer
   cannot make it wrong (container-boundary stands either way).
3. **KEDA event-job execution semantics** (scale-per-message → pod-pulls):
   sourced from spec §3's phrasing and Microsoft Learn (transitively, per
   spec's citations), NOT re-verified against live ACA. Task 6's P0 probe is
   the measurement.
4. **ACA Storage/Key Vault REST AAD RBAC names + role IDs** for instance
   bicep: referenced generically (`Queue Data Contributor` etc.), not pinned
   to live ARM IDs in this pass — instance-side work.
5. **The hub → job fleet evidence pull path details** (how the hub learns of
   job completion: poll vs blob-trigger): deliberately left as inside-the
   module-design of §2.c; no repo code constrains it. Marked open in the
   module, not open for the operator.
6. **Whether `workflow-web` can mount as a gateway route class without
   refactor** (`src/cli/web-service.ts` today owns its own relay):
   unassessed — D5 defers it, so the honest answer is "unverified and
   scoped-out", not "easy".
7. **SSE keepalive efficacy behind EASY AUTH specifically** (the C0 idle
   gate pre-dates any auth layer): C1.5's probe (task 9) is the measurement;
   nothing before it may claim the excluded `/api/*` lane survives 240 s
   idle.
8. **csh-dev naming in the Dockerfile comment** (`:110`): appears to be the
   instance's codename; not corroborated by any open-repo instance value
   (correctly so, per the one-way rule).

## Appendix: disagreements with prompts and adjustments, recorded

- Prompt framing "there is no single supervisor; only separate processes" —
  corrected in §0: a 3-of-5 in-process composition already exists
  (`workflow-opencode-server`); task 2 extends it, doesn't create a new class.
- Prompt "verified this session: no Azure dispatch code in any branch or
  stash" — verified in the working tree (grep, §0); branch/stash sweep not
  re-run here (treated as session evidence, consistent with the tree state).
- Everything else in the prompt's "facts already measured" block verified
  true against the cited files.

## Appendix B: operator decisions recorded (2026-10-09) — BUILD AUTHORIZED

The operator approved D1-D6 as recommended, with **one reversal and two
additions**. This is the authorization to implement; task 1 begins on
`feat/control-plane-image-c1`.

| # | Decision | Verdict |
| --- | --- | --- |
| D1 | Dispatch owner | **hub-side**, as recommended |
| D2 | Containment posture | **delegated container-boundary backend**, as recommended |
| D3 | Queue primitive | **Storage Queue + blob ref**, as recommended |
| D4 | Shape A only for v1 (Shape B deferred) | **as recommended** |
| D5 | `workflow-web` in-plane | **REVERSED** — the Workflow hub UI (settings + schedules) IS required in-plane as a gateway route class. It is the management/scheduling surface; the primary coding surface is the vendor UI (below). |
| D6 | `USER node` in both images | **as recommended** |

**Additions from the operator:**

1. **Primary operator surface, settled.** Interactive coding sessions are
   driven primarily from the **OpenCode v2 web UI or the OpenCode v2 desktop
   app**, both attaching to the plane at a fixed hostname. The Workflow hub UI
   (dashboard: settings, schedules, runs) is the **backup / management /
   scheduling** surface. The **Workflow-owned ACP chat interface** (already
   built) is the **third-tier alternative**. This matches the recorded posture
   in `docs/PROTOCOL_PLANES_2026-09-22.md:120-128` (stock UI primary,
   ACP-driven surface retained as backup).
2. **Domain: `control.ultus.net`.** Instance-side value (personal domain,
   `ultus.net` — NOT work), so it stays out of the open repo per the one-way
   rule. The ACA app gets a custom domain with an ACA-managed certificate; the
   desktop/web clients attach at `https://control.ultus.net` with the gateway
   basic-auth password. Easy Auth (Entra) layers on with `/api/*` excluded for
   the client lane (spec §10:268-277).

**Verified against OpenCode v2.0.10 source** (fresh clone `v2.0.10` @
`b8cedc1`, 2026-09-19), answering the "web UI == desktop app?" and "SSH as an
auth method?" questions:

- **Same UI.** The desktop renderer mounts `AppInterface` from
  `@opencode/app/desktop`; `opencode serve` serves that same app (`WebUi.handler`
  serves `index.html` + `_assets/*` for non-`/api` routes). Desktop adds only
  native wrappers (sidecar, WSL, windows, updater, SSH windows).
- **SSH is a transport, not auth, and desktop-only.** The desktop SSH path runs
  `ssh <host>`, discovers/bootstraps a remote `opencode service`, reads a
  `{url,password}` registration, and tunnels `ssh -L 127.0.0.1:<local>:127.0.0.1:<remote>`.
  It needs an SSH-able host. **ACA has no SSH ingress**, so the desktop SSH path
  **cannot reach the ACA plane**; it is viable only on a VM posture. The
  desktop/web "add server" (URL + password, HTTP basic auth) path is the one
  that fits ACA and is what D2's topology uses.
- **SSH is recorded as the VM-only alternative**, not the chosen path.

## Appendix C: execution log (append-only; evidence per task)

### Task 1 — container-boundary backend (DONE 2026-10-09)

- New `src/containment/container-boundary.ts`: `ContainerBoundaryContainment`
  (`isolation: "enforced"`, `boundaryKind: "container-boundary"`), fails closed
  outside a container, refuses `mediated`/`proxied`/`read-write-no-delete`.
- `boundaryKind` discriminator added to `ProcessContainment`
  (`src/containment/contracts.ts`); `boundaryKind: "bwrap"` on
  `linux-bwrap.ts`; opt-in selection via `WORKFLOW_CONTAINMENT_BACKEND=container-boundary`
  (`src/containment/platform.ts`).
- Evidence: `node --import tsx --test test/container-boundary.test.ts` 8/8;
  with the existing containment suites 59/59; `npm run typecheck` exit 0;
  `npm run lint` exit 0.

### Task 2 — plane supervisor (DONE 2026-10-09)

Scope adjustment (recorded, not silent): the plan's §2.a "fold the hub
in-process" was implemented as a **process supervisor** instead. Rationale:
the hub (`src/cli/hub.ts`, 655 lines) and the daemon
(`src/cli/opencode-server.ts`) are each large, individually-tested,
idempotently-tearing-down compositions; `src/cli/workflow.ts` already
supervises surfaces as child processes, and the spec (§10:247-250) requires
"one container speaking loopback", not one process. The gateway stays the only
ingress listener; the hub keeps its loopback bind, so the plan's hub-bind
option was **not** needed (dropped to reduce surface).

- New `src/cli/plane.ts` (`workflow-plane` bin): requires `WORKFLOW_PLANE=1`
  (fail closed), resolves the config, supervises `workflow-hub` +
  `workflow-opencode-server`, forwards SIGINT/SIGTERM/SIGHUP, reaps on any
  child exit with the child's code.
- New `src/cli/plane-config.ts`: `resolvePlaneConfig` fails closed on a missing
  `WORKFLOW_PLANE=1`, a non-absolute workspace, a bad port, or a
  missing/short `WORKFLOW_PLANE_CLIENT_PASSWORD` (the stable injected
  credential — never a random-per-roll `newTuiPassword()`).
- `src/integrations/opencode-server-gateway.ts`: additive `host`/`port`
  options; default remains `127.0.0.1:0` (byte-identical).
- `src/cli/opencode-server.ts`: in plane mode reads the bind + stable
  credential from env, and launches the contained serve through
  `selectContainment()` (the env-selected backend); non-plane path unchanged.
- `src/cli/opencode-attach.ts`: `resolveExplicitGateway` — an operator-exported
  `WORKFLOW_OPENCODE_GATEWAY_URL`+`_PASSWORD` (the remote plane lane) takes
  precedence over discovery; fails closed on a missing credential or a
  non-http(s) scheme. The discovery loopback gate (review P3i) is unchanged.
- `package.json`: `workflow-plane` bin; `test:ci` 47 → 48 suites. `README.md`
  install list gains the `workflow-plane` line (the `install-surface-docs` pin
  requires every declared bin to be named).
- Evidence (measured, local): `node --import tsx --test test/plane-supervisor.test.ts`
  14/14 (config fail-closed, PLANE_ENV_KEYS drift pin, supervised reap + exit-code, signal-death/start-error
  fail-closed, env-split hub-vs-daemon — the hub's env has every `WORKFLOW_PLANE*`
  key scrubbed, pinned against a base env that carries the secret, gateway fixed
  bind + 401 + authenticated
  `/api/info` proxy); `test/install-surface-docs.test.ts` 3/3; the wider
  containment + opencode-server focused set green; `npm run typecheck` exit 0;
  `npm run lint` exit 0; `npm run build` exit 0. Live smoke (measured via a
  direct-child harness, `node dist/cli/plane.js`): the plane started both
  children, the gateway bound the explicit `127.0.0.1:45989`, an unauthenticated
  probe got HTTP 401, and a **direct-child SIGTERM produced exit code 0** (the
  handler path — external signal sets `shuttingDown`, children exit, `done`
  resolves 0). NOTE: an earlier smoke reported exit 143; that was a
  shell/`tsx`-wrapper artifact (the signal hit the wrapper, not the plane), not
  the plane's behavior, and is corrected here.
- Exit-code precision (review follow-up): a child that dies BY SIGNAL carries no
  exit code, so the plane exits **1** in that case (fail-closed); the
  "reaps with the child's code" wording applies to exit-code deaths, and an
  EXTERNAL SIGTERM to the plane itself exits 0 via the handler path.
- **Still open in task 2's neighborhood:** the hub UI (`workflow-web`) as a
  gateway route class (D5 reversal) and the launcher plane-awareness classify +
  auto-wake are **task 2b / a follow-up**, not done here — the supervisor
  currently starts the hub + daemon only. Recorded as a residual, not claimed.

### Task 3 — image CMD/USER/ENV + in-container loopback probe (DONE 2026-10-09)

- `images/control-plane/Dockerfile`: `CMD ["workflow-plane"]` (the superseded
  hub-only CMD and its "honest C1 gap" header replaced by a dated supersession
  note pointing at the delegated backend); `USER node` (D6); a pre-created,
  node-owned `/home/node/.workflow`. No instance value is baked: neither
  `WORKFLOW_OPENCODE_SERVER_HOME` nor `WORKFLOW_CONTAINMENT_BACKEND` is an image
  `ENV` (both are instance-supplied), pinned by test.
- `test/control-plane-dockerfile.test.ts`: the former `CMD ["workflow-hub"]`
  pin is replaced by four pins (plane CMD + hub CMD gone; `USER node` +
  created/chowned state root; instance-values-never-baked; bin-link retained).
  Suite 6 → 9 tests.
- `docs/ledger/control-plane-c1-composition.md`: dated supersession section
  (option A adopted; the earlier "not a deployable C1 plane" conclusion left in
  place per append-only).
- **Build (measured, podman 5.8.4):**
  `podman build -f images/control-plane/Dockerfile -t workflow-cp:c1 .` →
  **green**, `4ada5dce17873770ac157a0d38540cb524ee89d7b3d27856b9848267224603e3`.
- **In-container loopback probe (measured)** — `podman run --rm -d -p
  4096:4096` with env `WORKFLOW_PLANE=1`,
  `WORKFLOW_CONTAINMENT_BACKEND=container-boundary`,
  `WORKFLOW_PLANE_CLIENT_PASSWORD=…`, `WORKFLOW_PLANE_WORKSPACE=/workspace`,
  and `WORKFLOW_UPSTREAM_KEY=dummy` (REQUIRED: the runtime fails closed without
  one at `src/integrations/opencode-server-runtime.ts:186` via
  `loadUpstreamApiKey`, `src/integrations/upstream-key.ts:57-64`; the value is a
  placeholder because the probe exercises the server surface, not a model call,
  and it was passed on the command line, never baked — the image carries no key):
  - plane log: `gateway on 0.0.0.0:4096`; `USER node` (state root
    `/home/node/.workflow`).
  - unauthenticated `GET /api/info` → **401**.
  - authenticated `GET /api/info` → **200**,
    `{"version":"2.0.10","pid":55,…}`.
  - `GET /api/event` → **200**, `content-type: text/event-stream`; the stream
    delivered `server.connected`, `: heartbeat`, and the
    `: workflow-keepalive` frame within 20 s.
  - discovery `/home/node/.workflow/opencode-server/ws-*.json` written by the
    `node` user.
  - Note: with a placeholder key the authority's event subscription can report
    `event stream lost` and shut the surface down on a later model call; the
    probe reads the surface within its first seconds, which is why the four
    checks above passed. This is recorded so the probe is not read as a
    long-idle survival claim.
- **Still open (task 3.1, 🛰 live):** the ACA-ingress probe (SSE past the 240 s
  idle window, the gateway route-class matrix, `boundaryKind` in discovery over
  the wire). The local probe proves the in-container loopback path, not the
  deployed ingress path. No `enforced` label is claimed for pods until P2 (task
  8).

### Task 5 — worker job image + entry script + corpus fingerprint (DONE 2026-10-09)

- New `images/worker/Dockerfile`: `USER node` (D6); no `EXPOSE`; the same
  sha-verified vendored opencode as the plane image; the toolbox built (the
  corpus the worker verifies) with the fingerprint written AFTER the build
  (`RUN node /opt/workflow/run.mjs --write-fingerprint /opt/workflow/corpus-fingerprint`).
  `CMD ["node", "/opt/workflow/run.mjs"]`.
- New `images/worker/run.mjs` (Node builtins only) + hand-maintained
  `images/worker/run.d.mts` types. It re-validates the message structurally
  (a pinned mirror of `azure-jobs-schema.ts`), verifies the corpus against both
  the dispatch's declared fingerprint and the image's recorded digest, resolves
  only the named Key Vault secrets in memory, clones, runs stock `opencode run`
  headless under a wall-clock budget, pushes a branch + opens a PR, and uploads
  the evidence blob; exit 0 deletes the message.
- New `test/worker-image.test.ts` (hermetic pins).
- Evidence: `node --import tsx --test test/worker-image.test.ts` → 14/14; with
  the task-4 suites + `control-plane-dockerfile` + `kernel-purity`, 47/47;
  `npm run typecheck` exit 0; `npm run lint` exit 0.
- Independent review round 1 REJECT (one P1: git token echoed to stderr; three
  P2: token on disk, visibility/budget coupling, MI sharing) — all fixed;
  round 2 verdict recorded in
  `docs/ledger/control-plane-c1-worker-image.md`. Tests 14 → 17.
- **Build (measured, podman):** recorded in the task-5 ledger fragment
  `docs/ledger/control-plane-c1-worker-image.md` (green;
  `baebab91b255eca8afbce41d2e9bc4addbc9d84816b788b674c5abca54ca3e17`, the
  recorded corpus digest `385b30eb36edeec1236c65b6cb6f73b9c966f09cdbf13ea09cd78ba4b8d02ad9`
  over 63 files). The first build failed closed at the fingerprint step on a
  wrong corpus-root default — corrected; the correction is the fail-closed
  behavior working.
- **Still open (task 6, 🛰 live):** the P0 e2e (queue → pod → stock run →
  branch+PR + evidence blob). The hermetic tests prove the fail-closed seams,
  not a live run.

### Task 2b — launcher plane-awareness (DONE 2026-10-09)

Decided posture (spec §10:230-246, "rides C1"): the remote plane is
always-on by posture, but can still be unreachable. The launcher probes
gateway health before attaching and classifies before acting.

- New `src/integrations/plane-wake.ts`: the pure classification table
  (`classifyPlaneState` → `ready`/`asleep`/`broken`/`no-az`; reachability wins,
  the `az` session gates the wake, scale-to-zero is the one wakeable state and
  outranks a stopped running status), the honest `planeStateLine`, the bounded
  `ensurePlaneReady` (prove-ready → classify → wake a proven-asleep plane →
  bounded health poll; every path resolves to an outcome, never throws for a
  transport fault), the fail-closed `resolvePlaneWakeTarget` (both ACA env vars
  or neither), the `az`-backed deps (`account show` / `containerapp show` /
  `containerapp update --min-replicas 1`; argument array, no shell), and the
  `ensureExplicitPlaneReady` lane the launcher calls.
- `src/cli/opencode-attach.ts`: the explicit-gateway lane now classifies via
  `ensureExplicitPlaneReady` and fails closed with the honest state line for
  any non-ready verdict (previously it attached unconditionally); the usage
  text documents the plane + wake env vars.
- **One-way rule kept:** the module names only env VARIABLE names
  (`WORKFLOW_PLANE_ACA_RESOURCE_GROUP`, `WORKFLOW_PLANE_ACA_APP`); the instance
  supplies the values.
- New `test/plane-wake.test.ts` (17 pins): the classification table, the
  scale-to-zero precedence, **no-az never polls (never hangs)**, a ready plane
  never touches `az`, the wake-then-attach path, a wake that never becomes
  healthy resolves `broken` (not thrown), a wake failure carries the az cause,
  a throwing resource read is `broken` (never asleep), the env target's
  fail-closed partial pair, the `az` JSON parse, the honest state lines, the
  three explicit-lane behaviors, the `az` argv shape (the show query + the
  exact `containerapp update --min-replicas 1` wake; a throwing session check),
  and a `main()` source-artifact pin (the LESS-0004 precedent).
- Evidence: `node --import tsx --test test/plane-wake.test.ts` → 17/17; with
  `plane-supervisor` + `opencode-server-launcher` + `workflow-launcher` +
  `kernel-purity` + `text-hygiene`, 66/66; `npm run typecheck` exit 0;
  `npm run lint` exit 0.
- **Not live-verified:** the `az`-backed deps and the real `containerapp
  update` are pinned by construction, not executed here (C1 live is task 3.1,
  🛰 `WORKFLOW_AZURE_PLANE_PROBE=1`). No "plane wakes in Azure" claim is made.

### Task 4 return leg — dispatch record registry + `validateDispatch` ingest (DONE 2026-10-09)

The task-4 residual "`validateDispatch(taskId)` result ingest" (plan §2.c read
path; recorded in `docs/ledger/control-plane-c1-dispatch-seam.md`).

- New `src/integrations/azure-jobs-record.ts`: the dispatch-record registry
  (the hub-held coverage DENOMINATOR, written by the enqueue wrapper),
  `validateWorkerEvidence` (the worker evidence-blob intake), the
  `createAzureJobsIngest` closure (the outcome matrix `unknown`/`missing`/
  `invalid`/`incomplete`/`stale-corpus`/`failed`/`covered`; every resolved
  outcome journaled, a transport fault thrown), and `createRecordingEnqueue`.
- Hub route `POST /dispatch/azure-job/validate` (`hub-http.ts` +
  `workflow-hub.ts` + `cli/hub.ts`): operator-token; withheld → 404; missing
  taskId → 400; a resolved outcome → 200; a transport fault → 5xx. The
  composition root wraps the enqueue closure with the recorder (one registry,
  both legs).
- **Registry-as-denominator (recorded):** the hub records the declaration at
  enqueue and the ingest checks the blob against it — the alternative (client
  supplies expectations) would let the caller self-satisfy the check.
- Evidence: `azure-jobs-record` + `azure-jobs-hub-route` → 26/26; wider focused
  set 56/56; `npm run typecheck` exit 0; `npm run lint` exit 0; `test:ci`
  53 → 54 suites.
- **Not live-verified:** the blob GET is pinned by an injected fetcher; the
  live e2e is task 6 (🛰). The record is in-memory (durability rides C2). The
  coverage check is name-set membership, not deep per-artifact verification.
  No live claim is made.
