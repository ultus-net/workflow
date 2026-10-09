<!-- Ledger fragment: opened 2026-10-09 as the C1 Azure control-plane deploy path, the task-4 return leg (the `validateDispatch(taskId)` evidence-ingest read path + the dispatch-record registry). TASKS.md is frozen (post-freeze work tracks in the GitHub Project); write-once — append dated supersession notes, never rewrite. -->

### C1 task 4 return leg — dispatch record registry + `validateDispatch` evidence ingest (2026-10-09)

**Source:** task 4 of `docs/ledger/control-plane-c1-deploy-plan.md` §2.c, the
recorded residual "`validateDispatch(taskId)` result ingest (the plan §2.c read
path that pulls the evidence blob and checks `declaredEvidence` coverage) is a
later task; only the enqueue path is built here"
(`docs/ledger/control-plane-c1-dispatch-seam.md`). Spec §6:126-130: "Evidence
freshness … stays hub-owned; a run that returns without declared evidence does
not advance state."

#### What was built

- **`src/integrations/azure-jobs-record.ts` (new):** the return leg, in three
  parts.
  - **The dispatch-record registry** (`createDispatchRecordRegistry`) — the
    hub-held DENOMINATOR. When the hub dispatches a job it records what the job
    DECLARED (`declaredEvidence`, `corpusFingerprint`, the evidence blob path,
    the container, the message id). Without a hub-held record, a caller could
    self-satisfy its own coverage check; the record is written by the hub's own
    enqueue wrapper, never supplied by the client. Two bounded (64) journals:
    the dispatch records and the validation outcomes.
  - **`validateWorkerEvidence`** — the structural validator for the worker's
    returned evidence blob (the `images/worker/run.mjs` result record), the
    hub-side intake that the image's own copy mirrors.
  - **`createAzureJobsIngest`** — the `validateDispatch(taskId)` closure.
    Resolves the hub record; an unknown id is `unknown` (fail-closed, never a
    fabricated pass); fetches the evidence blob (a 404 is `missing`); validates
    it (`invalid`); checks the declared evidence is covered (`incomplete` names
    the gap); checks the corpus fingerprint (`stale-corpus`); a nonzero worker
    exit is `failed`; otherwise `covered`. Every RESOLVED outcome is journaled;
    a non-404 transport fault THROWS so the route 5xx's. REST only, no Azure
    SDK — the same shared Bearer chain as the enqueue client.
  - **`createRecordingEnqueue`** — wraps the enqueue closure so a SUCCESSFUL
    dispatch is recorded; a failed enqueue records nothing, and a malformed
    message keeps its `AzureJobMessageError` (the 400 classification).
- **Hub route `POST /dispatch/azure-job/validate`** (`hub-http.ts` +
  `workflow-hub.ts` + `cli/hub.ts`): operator-token class; capability withheld
  → 404; a missing taskId → 400; a resolved outcome → 200 with the structured
  validation; a transport fault → 5xx. The composition root builds the registry
  + ingest closure from the same dispatch env as the enqueue seam, and wraps
  the enqueue closure with the recorder (one registry, both legs).
- **`docs/HUB_PROTOCOL.md`** §3: the validate route documented under the
  internal endpoints.

#### The registry-as-denominator decision (recorded)

The plan left the `declaredEvidence` source implicit. The chosen posture: the
hub RECORDS the declaration at enqueue and the ingest checks the returned blob
against THAT record. The alternative (the client supplies expectations on the
validate call) would let the caller self-satisfy the check — a coverage claim
with no denominator. This is the "evidence freshness stays hub-owned"
discipline applied to the return leg.

#### Verification (measured, this session)

- `node --import tsx --test test/azure-jobs-record.test.ts
  test/azure-jobs-hub-route.test.ts` → 26/26 (the record suite + the four new
  route pins).
- Wider focused set (the two suites + `azure-jobs-schema` + `azure-jobs-dispatch`
  + `kernel-purity` + `text-hygiene` + `cli-entrypoint`) → 56/56.
- `npm run typecheck`, `npm run lint` → exit 0.
- `test:ci` grows by one suite: 53 → 54.

#### Residuals (recorded, not claimed)

- **No live verification.** The blob GET is pinned by an injected fetcher, not
  executed against Azure; the live e2e (queue → pod → stock `opencode run` →
  branch+PR + evidence blob → validate) is task 6 (🛰 probe-gated,
  `WORKFLOW_AZURE_JOBS_PROBE=1`). Nothing live is claimed.
- **The ingest does not mutate task state.** It records an observability
  outcome; wiring a `covered`/`failed` verdict into a kernel transition (does a
  returned run advance the task?) is a later slice — the plan's "no new kernel
  types; Application/Integrations-layer only" is honored literally here.
- **The record is in-memory.** A hub restart loses dispatch records (and their
  outcomes), the same long-horizon gap the run registry records for its own
  in-memory maps. Durability rides C2 (the Files volume, task 10) when the hub
  gets a durable state accessor.
- **The declared-evidence coverage is name-set membership, not deep content
  verification.** The ingest checks that each declared evidence NAME is present
  in the returned record; it does not (yet) open each evidence artifact. The
  plan's "checks `declaredEvidence` coverage" is satisfied at the name level;
  deeper per-artifact checks are a later slice.
