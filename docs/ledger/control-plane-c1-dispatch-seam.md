<!-- Ledger fragment: opened 2026-10-09 as the C1 Azure control-plane deploy path, task 4 (the hub-side dispatch seam). TASKS.md is frozen (post-freeze work tracks in the GitHub Project); write-once — append dated supersession notes, never rewrite. -->

### C1 task 4 — the hub-side Azure job dispatch seam (2026-10-09)

**Source:** task 4 of `docs/ledger/control-plane-c1-deploy-plan.md` §2.c (the
plan doc lives on the tasks 1-3 branch until that PR merges; this fragment
records task 4's execution). Decisions D1 (dispatch owner = hub) and D3
(Azure Storage Queue + blob ref).

#### What was built

- **`src/integrations/azure-jobs-schema.ts` (new):** the versioned dispatch
  message contract (the LESS-0061 "schema is the spec" seam, spec §3:76-80 /
  §9:209-212). `validateAzureJobMessage` is fail-closed and structural: unknown
  `specVersion` refuses; absent OR empty `declaredEvidence` refuses (a run with
  no declared evidence never dispatches); a declared `enforced` permission
  posture refuses BY NAME (the pod-enforced claim is gated on the P2 model-key
  probe, task 8); every field fault names its path. It returns a freshly
  constructed typed copy, never the parsed input, so extra fields cannot ride
  through. Secret fields are Key Vault ref NAMES only. A `bodyRef` envelope
  type carries the oversized-body path.
- **`src/integrations/azure-token.ts` (new):** the shared IMDS/azure-cli
  access-token chain, EXTRACTED from `key-vault.ts` on its second use (the
  harvest rule). The extraction is behavior-preserving; `key-vault.ts` now
  imports it and `test/key-vault-store.test.ts` still passes unchanged.
- **`src/integrations/azure-jobs-dispatch.ts` (new):** the Storage Queue REST
  client (no Azure SDK — the key-vault discipline). `azureJobsDispatchFromEnv`
  classifies the opt-in (`WORKFLOW_AZURE_JOBS=1`) + `WORKFLOW_AZURE_QUEUE_URL`
  + `WORKFLOW_AZURE_EVIDENCE_CONTAINER`, naming missing/invalid vars. `enqueue`
  validates BEFORE any wire call, uploads oversized messages as a blob and
  enqueues a small ref envelope, and POSTs the base64 `QueueMessage` XML with
  Entra ID Bearer auth (`x-ms-version` + `x-ms-date`, no SharedKey signature).
  Every request is bounded with `AbortSignal.timeout(5s)`. The configured
  evidence container is authoritative (a message cannot redirect the blob
  write); the declared `artifacts.blobPrefix` is honored
  (`<blobPrefix>/<taskId>.json`); `taskId`/`blobPrefix`/`evidenceContainer` are
  path-safety-validated (no traversal). Structural faults throw a dedicated
  `AzureJobMessageError` — deliberately NOT a bare `TypeError`, because a Node
  fetch transport failure is itself a `TypeError` and the route must not
  misreport it as a 400. The inline size ceiling is 48 KiB of raw JSON (base64
  expands 4/3, and Azure's 64 KiB limit is measured on the wire body, so a raw
  threshold against 64 KiB would send an over-limit body).
- **Hub route `POST /dispatch/azure-job`** (`hub-http.ts` +
  `workflow-hub.ts` + `cli/hub.ts`): operator-token class; capability withheld
  → 404; a structural validation failure → 400 (never a queued job); a transport
  fault → 5xx (never a fabricated success). The composition root builds the
  closure from env at startup and THROWS on a malformed declaration when opted
  in (fail-closed, never best-effort).
- **`docs/HUB_PROTOCOL.md`** §3: the route documented under the internal
  endpoints.

#### Verification (measured, this session)

- `node --import tsx --test test/azure-jobs-schema.test.ts
  test/azure-jobs-dispatch.test.ts test/azure-jobs-hub-route.test.ts` → 21/21
  (the three suites include the review-hardening pins: the transport-TypeError
  vs `AzureJobMessageError` split, the blob-namespace path-traversal refusal,
  the container-authority refusal, and the 64 KiB wire-boundary accounting).
- Wider focused set (the three suites + `key-vault-store` + `kernel-purity` +
  `text-hygiene`) → 38/38.
- `npm run typecheck`, `npm run lint` → exit 0.
- `test:ci` grows by three suites: 44 → 47 against current `main` (the tasks
  1-3 branch separately brings its own four suites, so the two PRs together
  reach 51 once both land).

#### Residuals (recorded, not claimed)

- **The web relay + webapp view is OUT of task 4's declared file set** (the
  plan column names only the two modules + the hub route). The hub route is
  the dispatch seam; a browser relay (`/api/dispatch/azure-job`) and a nav
  entry are a follow-up, recorded here so no surface implies a UI that does not
  exist yet.
- **`validateDispatch(taskId)` result ingest** (the plan §2.c read path that
  pulls the evidence blob and checks `declaredEvidence` coverage) is a later
  task; only the enqueue path is built here.
  **SUPERSEDED 2026-10-09:** the return leg is now built — see
  `docs/ledger/control-plane-c1-dispatch-ingest.md` (the dispatch-record
  registry + `validateDispatch` ingest + `POST /dispatch/azure-job/validate`).
  Only the web relay + webapp view from the residual above remains.
- The live e2e (queue message → job pod → stock `opencode run` → branch+PR +
  evidence blob) is task 6 (🛰 probe-gated); nothing live is claimed.
