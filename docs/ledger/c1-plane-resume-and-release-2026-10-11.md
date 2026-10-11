# C1 plane: post-merge verification, resume harness, and release/deploy cut (2026-10-11)

Dated record; append, do not rewrite. Scope: what landed on `main` (PR #522),
the exact plane env matrix the merge alone does NOT set, the resumable
workspace/state method for driving tests from inside the plane, and the
release + AzDO deploy cut.

Grounding: `docs/ledger/control-plane-c1-deploy-plan.md` §3-§4;
`docs/ledger/c1-operator-runbook-2026-10-09.md` (release mechanics);
`test/c1-plane-probe.test.ts` (the live instrument).

## 0. What merged (the fixes this runbook exercises)

PR #522 (`fix/c1-authority-denial-and-live-test-hardening`) merged to `main`;
tip `3268bf5c`. The commit set:

- `133edc5d` in-band deny feedback: a reject attaches `message` on the v2
  permission reply, so the model sees `CorrectedError({feedback})` and could
  have continued.
- `e1db45e7` configurable `WORKFLOW_MUTATION_BUDGET` (fail-closed parse).
- `c78e2c31` Key Vault upstream-key source (`WORKFLOW_UPSTREAM_KEY_FROM`),
  daemon `/proc` doctor exposure check.
- `4c5e1c2c` secret-store seam is authoritative (a lingering env/file key does
  NOT win when `WORKFLOW_UPSTREAM_KEY_FROM` is set) — review P2.
- `3268bf5c` reap guard on a fail-closed secret-store throw; de-brittle the
  `/proc` test.

Root cause fixed: `MUTATION_BUDGET_EXHAUSTED` (default cap 100; a
`process`/shell action counts as a mutation), not the circuit breaker.

## 1. Ground truth: what the merge does NOT change

Merging changes code. It does not configure the deployed plane. These are
INSTANCE-side settings; each must be set on the next deploy or the lane stays
blocked or misread.

| Setting | Default today | Must set for | Evidence |
| --- | --- | --- | --- |
| `WORKFLOW_OPENCODE_ENFORCEMENT` | `advisory` | 403 on non-forward routes (F1 posture) | `enforcementFromEnv`, `src/cli/opencode-server.ts:96-100`; enforced 403 at `opencode-server-gateway.ts:276-285` |
| `WORKFLOW_MUTATION_BUDGET` | `100` | a deliberate cap (unset re-hits 100 in a long session) | `mutationBudgetFromEnv`, `src/application/mutation-budget.ts` |
| `WORKFLOW_UPSTREAM_KEY_FROM` | unset (env/file) | Key Vault custody (F2) | `loadUpstreamApiKeyFromSecretStore`, `src/integrations/upstream-key.ts:144-170` |
| `WORKFLOW_UPSTREAM_KEY` | may be set | must be UNSET when `..._FROM=azure-kv` | the seam is authoritative, not a fallback (review P2) |
| `WORKFLOW_SECRET_STORE` | `keyring` | `azure-kv` for a real vault | `resolveSecretStore`, `src/integrations/secret-store.ts` |
| `WORKFLOW_KEYVAULT_NAME` / `_URI` | unset | names the vault when `azure-kv` | `secret-store.ts` `azure-kv` arm |
| `WORKFLOW_SESSION_BUDGET_INPUT_TOKENS` | unset | cap input tokens per session | `sessionBudgetFromEnv`, `src/integrations/session-budget.ts:48-64` |
| `WORKFLOW_SESSION_BUDGET_OUTPUT_TOKENS` | unset | cap output tokens | same |
| `WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS` | unset | cap total tokens | same |
| `WORKFLOW_SESSION_BUDGET_COST_USD` | unset | cap spend (USD) | same |
| `WORKFLOW_BUDGET_DOWNGRADE_MODEL` / `_FRACTION` | unset | warn/downgrade before the abort cap | `budgetDowngradeFromEnv`, `session-budget.ts:160` |
| `WORKFLOW_PLANE_REVISION` | unset | per-revision state-home isolation | `opencodeServerStateHome`, `opencode-server-discovery.ts:73-91` |

**Session-budget recommendation (decision, 2026-10-11).** No new plane cap is
needed. "Make the session budget configurable" is satisfied by the existing
W045 caps, wired as `WORKFLOW_SESSION_BUDGET_*`:

- The mechanism already exists and is fail-closed: `sessionBudgetFromEnv`
  (`session-budget.ts:48-64`) parses the four axes and throws on a malformed
  value; unset on all axes yields no local guard.
- Crossing a cap aborts in-flight turns and denies later mutations, and is
  operator-visible (`opencode-server.ts:319-333`).
- It is already per-session overridable: a web override replaces the env cap per
  axis (`mergeSessionBudget`, `session-budget.ts:96-114`; `describeBudgetMechanism`
  names the EFFECTIVE caps, never the env's).
- The backstop when unset is the OpenRouter per-key credit limit on the metering
  proxy's upstream key (`session-budget.ts:79`). That is the same key F2 moves
  into Key Vault, so "unset" is not "unenforced" once F2 lands.

Action: set explicit caps on the plane revision. Recommend a conservative
`WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS` and `WORKFLOW_SESSION_BUDGET_COST_USD`
as the two axes that bound a runaway session, with
`WORKFLOW_BUDGET_DOWNGRADE_FRACTION` to warn before the abort. Setting a second,
independent plane-level cap would duplicate this guard and split the effective
cap across two mechanisms, so it is not recommended.

**Trap to state in the handoff:** F1 is NOT unblocked by the merge. Without
`WORKFLOW_OPENCODE_ENFORCEMENT=enforced` the gateway stays advisory and
non-forward routes forward upstream → 404, exactly what the prior run observed.
An agent re-running the route matrix without setting the env will see 404 again
and misread it as an unfixed bug.

**Note on the two "enforced" axes (F1):** the broker hook
(`onPermissionReply`) is passed unconditionally (`opencode-server.ts:391`),
independent of `enforcement`. Permission interception already runs when
advisory. `enforced` only gates the route-matrix fail-closed and arms
`assertAskRuleset` (`:305-307`). The prior run's `404` was the route matrix, not
the broker.

**F2 ordering (fail-closed):** `azure-kv` with a missing secret makes the daemon
throw at startup. Store the secret in the vault BEFORE setting
`WORKFLOW_UPSTREAM_KEY_FROM=azure-kv`, or the redeploy fails closed.

## 2. Managing local files/projects on the remote plane (resumable method)

The plane pod filesystem is ephemeral. A replica roll wipes the workspace and
the default state home. Resumability comes from making the durable parts
external and re-provisioning deterministically.

### 2.1 Where things live

- **Workspace root** = `WORKFLOW_PLANE_WORKSPACE` (absolute; defaults to cwd).
  Resolved in `src/cli/plane-config.ts:51-54`, passed to the daemon as
  `--workspace`. This is the agent's mutable working dir.
- **State home** = `WORKFLOW_OPENCODE_SERVER_HOME` (override) else
  `~/.workflow/opencode-server`. Holds the discovery file and the OpenCode DB.
  `opencode-server.ts:191-193`.
- **Per-revision scoping** = `WORKFLOW_PLANE_REVISION` appends one safe segment
  to the state home (`opencode-server-discovery.ts:73-91`), so two Container App
  revisions sharing one Azure Files mount do not clobber each other's discovery
  file or DB.
- **Azure Files share** = the C2 state volume (deploy plan §3, task 10). The
  INSTANCE sets `WORKFLOW_OPENCODE_SERVER_HOME` to the mount path; the image
  never bakes it.

### 2.2 The durable pattern

1. **Code belongs in git, never the pod FS.** Treat the workspace as a checkout
   of the target repo. Re-provision on restart by clone/checkout, not by
   preserving the FS.
2. **Bind the state dir to Azure Files.** Point `WORKFLOW_OPENCODE_SERVER_HOME`
   (and the hub state root) at the mounted share, with
   `WORKFLOW_PLANE_REVISION` set to the ACA revision value. This is what makes
   sessions and discovery survive a roll. Watch Files-mount ownership: the
   `USER node` image relies on the mount honoring `uid`/`gid` (deploy plan §5
   friction note).
3. **Persist the resume anchors, not the container.** The resume set is: plane
   FQDN, `WORKFLOW_AZURE_PLANE_CLIENT_PASSWORD`, the session IDs, and the hub
   run registry. SSE does NOT replay the gap
   (`src/integrations/remote-acp/engine.ts` comment), so the hub run registry +
   session replay is the source of truth after a redeploy.
4. **Re-provision deterministically.** After redeploy: clone workspace → start
   plane → re-run the gated probe → replay the recorded sessions. A cycle is
   then idempotent and resumable.

## 3. Verification harness (ordered, gated)

Run each from a plain shell. `WORKFLOW_AZURE_PLANE_URL` is the plane base URL
(`https://<fqdn>`); `WORKFLOW_AZURE_PLANE_CLIENT_PASSWORD` is the gateway
credential.

```sh
export WORKFLOW_AZURE_PLANE_URL="https://<plane-fqdn>"
export WORKFLOW_AZURE_PLANE_CLIENT_PASSWORD="<client gateway password>"

# Lanes 1-4 below are the fault/posture/budget/custody gates.
# The transport instrument (401, /api/info, cred split, SSE, route matrix):
WORKFLOW_AZURE_PLANE_PROBE=1 \
  node --import tsx --test test/c1-plane-probe.test.ts

# The idle arm (holds a 240 s stream; run on its own):
WORKFLOW_AZURE_PLANE_PROBE=1 WORKFLOW_AZURE_PLANE_PROBE_IDLE=1 \
  node --import tsx --test test/c1-plane-probe.test.ts

# The discovery arm needs the in-pod discovery file (in-container run only):
WORKFLOW_AZURE_PLANE_PROBE=1 \
  WORKFLOW_AZURE_PLANE_DISCOVERY="/<stateHome>/<workspace-tag>.json" \
  node --import tsx --test test/c1-plane-probe.test.ts
```

Ordered lanes (each depends on the ones above it):

1. **Regression on the fault (must pass first).** New session: exhaust the
   budget with `WORKFLOW_MUTATION_BUDGET` set low (e.g. `3`), confirm the deny
   reason is visible via SSE + the audit route, confirm a benign `/workspace`
   read still succeeds. Then confirm the model-side feedback (the in-band
   `message`) is what the reject carried. The SSE reject reason is the provable
   signal; the model-visible feedback stays advisory until the v2 PERMISSION
   live probe.
   - The audit read: `GET /api/workflow/authority` (the
     `OPENCODE_V2_WORKFLOW_AUTHORITY_ROUTE` constant,
     `opencode-v2-route-class.ts:55`), served only when the journal hook is
     wired (always, on the daemon).
2. **F1 posture.** Redeploy with `WORKFLOW_OPENCODE_ENFORCEMENT=enforced`.
   Re-run the route matrix and assert 403 (not 404) on non-forward routes.
   Assert the operator surface reports gateway posture distinctly from the hub
   authority axis (`gatewayPosture` in the discovery record,
   `opencode-server-discovery.ts:36-47`).
3. **F3 budget.** Drive a crossing; assert abort + a subsequent-mutation deny.
4. **F2 custody.** Redeploy with `WORKFLOW_UPSTREAM_KEY_FROM=azure-kv`, the
   vault secret stored, and `WORKFLOW_UPSTREAM_KEY` UNSET. Assert the key is
   absent from the uid-shared env and the daemon starts (KV resolution worked).
   Run the doctor exposure check INSIDE the daemon's namespace/uid, else
   `/proc/<pid>/environ` is unreadable and reports "cannot measure" (a pass
   that asserted nothing).

Then the never-started lanes in order: guarded-deny probe → session resume
(`WORKFLOW_ACP_RESUME` / `session/load` across restart) → egress enforcement →
web session-management → skills/spawn → hub-side → browser UI.

## 4. Release cut (open repo)

Preconditions: `main` carries the merge; the qualified `opencode` asset is
attached to the release; `.pr-body-*` files are operator-only.

1. Cut a real release in the `v[0-9]` namespace, target `main` (so the tagged
   tree carries `images/control-plane`). Next after `v0.1.7` is `v0.1.8`.
   Attach `images/control-plane/opencode` and
   `images/control-plane/opencode.sha256`
   (`c2fe3b18be9e67222d136c818512e3a07213d86ffd5d9176919965d08ac9b9db`).
2. Publish: the first tagged run of `publish-image.yml` IS the verification
   (task 12 / Phase 0). `gh workflow run publish-image.yml -f tag=<tag>`, then
   `gh run watch`.
3. Capture the digest recorded at the SAME tag from the SAME run: exactly one
   `sha256:<64hex>` line in `image-digest.txt`.

Guard blocks `gh release create` / workflow dispatch; the operator runs these
from a plain shell (mechanics in `c1-operator-runbook-2026-10-09.md` §B-§C).

## 5. Deploy via the AzDO repo (instance-side, operator-only)

All VALUES (subscription/tenant IDs, resource names, service connections,
FQDNs, secrets) stay in the work repo; none enter the open repo.

1. In the csh-dev instance repo, fill `infra/params/dev.bicepparam`:
   `planeImage` = `ghcr.io/ultus-net/workflow@sha256:<digest>`.
2. Set the plane env/mounts this runbook requires on the new revision:
   `WORKFLOW_OPENCODE_ENFORCEMENT=enforced` (only AFTER lane 2's enforced
   permission probes pass — honest-claims gate), `WORKFLOW_MUTATION_BUDGET`,
   `WORKFLOW_UPSTREAM_KEY_FROM=azure-kv` with the vault secret stored and
   `WORKFLOW_UPSTREAM_KEY` unset, `WORKFLOW_SECRET_STORE=azure-kv` +
   `WORKFLOW_KEYVAULT_NAME`, `WORKFLOW_SESSION_BUDGET_TOTAL_TOKENS` +
   `WORKFLOW_SESSION_BUDGET_COST_USD` (+ `WORKFLOW_BUDGET_DOWNGRADE_FRACTION`),
   `WORKFLOW_OPENCODE_SERVER_HOME` = the Files mount path, and
   `WORKFLOW_PLANE_REVISION` = the ACA revision value.
3. Run the pipeline. It runs `bash verify-pin.sh` against the digest from the
   pinned release before deploy.
4. Residual instance gaps before a full end-to-end deploy (deploy plan §3):
   worker job module, queue + evidence blob container, storage/ACR RBAC, Easy
   Auth. Confirm which are landed before claiming the deploy complete.

## 6. Honest residuals (dated, append-only)

- The in-band deny `message` is source-anchored on pinned OpenCode v2, not yet
  live-probed. Treat model-visible feedback as advisory until the v2 PERMISSION
  probe runs (deploy plan §4 task 8).
- The doctor `/proc` exposure check is Linux-scoped and reports "cannot
  measure" when the daemon namespace/uid differs from the reader.
- `enforced` posture is withheld for pods until the P2 model-key probe passes
  (spec §6:127-128). Setting the env is necessary, not sufficient, for the
  label.
