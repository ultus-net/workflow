<!-- Ledger fragment: opened 2026-10-09 as the C1 Azure control-plane deploy path, task 5 (the worker job image + entry script + corpus fingerprint). TASKS.md is frozen (post-freeze work tracks in the GitHub Project); write-once — append dated supersession notes, never rewrite. -->

### C1 task 5 — the worker job image + entry script + corpus fingerprint (2026-10-09)

**Source:** task 5 of `docs/ledger/control-plane-c1-deploy-plan.md` §2.d
(spec §3:71-91 Shape A; §11:293-298 the corpus fingerprint). Shape A: ONE
queue message = ONE execution = ONE bounded stock-opencode run in a disposable
pod. `minExecutions: 0` scales to zero between tasks; `replicaTimeout` sizes the
task budget; no ingress (spec §4:94, jobs have none).

#### What was built

- **`images/worker/Dockerfile` (new):** mirrors `images/control-plane/Dockerfile`
  structure + vendoring. Same base (`node:22-bookworm-slim`), same lockfile
  install with install scripts disabled, same toolbox build (`CI=true npm run
  build` + `prepare-tool.mjs` + `npm prune --omit=dev`), and the SAME
  sha-verified vendored stock opencode (v2.0.10, the same release asset + pin as
  the plane image, `images/control-plane/opencode.sha256`). `USER node` from the
  start (D6; no Files mount, no root reason). No `EXPOSE` (no ingress). No
  baked credential or instance value. `CMD ["node", "/opt/workflow/run.mjs"]`.
  The corpus fingerprint is written AFTER the toolbox build
  (`RUN node /opt/workflow/run.mjs --write-fingerprint /opt/workflow/corpus-fingerprint`)
  so it reflects the exact corpus the image ships.
- **`images/worker/run.mjs` (new):** the dependency-free (Node builtins only)
  Shape-A entry. It:
  1. reads its own MI token (IMDS first, azure-cli fallback — the same chain as
     `azure-token.ts`) and pulls ONE message with a visibility timeout;
  2. re-validates the message structurally BEFORE any work (see "schema mirror");
  3. verifies the in-image guard corpus against `mcp.corpusFingerprint`
     (mismatch refuses, fail-closed) AND against the image's own recorded digest
     (a tamper guard, independent of the dispatch);
  4. materializes ONLY the named Key Vault secrets (`model.secretRef`,
     `gitPush.secretRef`) in memory — the ref NAME is logged, the value is not;
     writes nothing to disk, passes the model key only through the declared
     provider env var to the child;
  5. clones `repo.url`@`repo.ref` into a fresh workdir;
  6. runs **stock** `opencode run` headless with a wall-clock SIGKILL at
     `task.budgetSeconds`;
  7. on success pushes a branch (`workflow/<taskId>`) + opens a PR (GitHub),
     then uploads the evidence blob (`<blobPrefix>/<taskId>.json`: opencode
     output, exit code, corpus fingerprint, taskId, branch/PR); exit 0 → message
     delete. A failed run still uploads its evidence (the failure is the
     evidence) and exits non-zero so KEDA/max-retries handles the poison message.
- **`images/worker/run.d.mts` (new):** hand-maintained types for the `.mjs`
  entry (the `scripts/vendor-skills.d.mts` pattern) so the entry stays
  plain-runnable while the pin test imports it with full types.
- **`test/worker-image.test.ts` (new):** 14 pins. Structural: `USER node` +
  pre-created state root; **no `||`-swallowed RUN** (a draft chained
  `chown /workspace 2>/dev/null || chown /home/node` so the RUN would exit 0 with
  `/workspace` absent — the review-floor cleanliness pin); the vendored binary is
  sha-verified and never staged at `/tmp/opencode`; the fingerprint step follows
  the toolbox build; no `EXPOSE`/baked token/instance value. Behavioral
  (hermetic, injected fetchers + fakes): the schema mirror agrees with the hub
  contract on the accept case and six reject classes; the ref-envelope mirror
  agrees; the corpus fingerprint is deterministic, order-independent, and
  content/addition-sensitive; a missing/empty corpus refuses; `verifyCorpus`
  refuses a declared mismatch AND an image/local mismatch; config names every
  missing/invalid value; an empty queue exits 0; an invalid config refuses
  before any network call; **a corpus mismatch refuses before any clone or run**
  (the plan's task-5 acceptance).

#### The schema mirror (recorded, deliberate)

`run.mjs` re-implements `validateAzureJobMessage`/`validateRefEnvelope` from
`src/integrations/azure-jobs-schema.ts` rather than importing it. The runtime
image is built from a Dockerfile, not `npm ci` of the repo, so importing the
TypeScript module would drag a build step (and the whole product tree) into a pod
whose spec footprint is "zero SDK" (spec §3:87-88). The copy is pinned by
`test/worker-image.test.ts`, which asserts the two validators agree on the accept
case and every reject class that matters at the seam — so drift fails a test,
not a live run.

#### The corpus fingerprint algorithm (recorded)

One deterministic digest over the toolbox's EXECUTABLE corpus: only `.js` files
under `mcp-toolbox/apps`, POSIX-relative paths sorted by byte order, each
contributing `"<relpath>\0<sha256(content)>\n"`. Identical algorithm at build
time and run time (one implementation, `fingerprintCorpus`). It is a DRIFT
detector binding a run's evidence to the corpus it executed under, NOT a
security boundary on its own (an attacker who can edit the image can edit the
digest) — stated plainly so no claim overreaches (spec §11:296-298).

#### Verification (measured, this session)

- `node --import tsx --test test/worker-image.test.ts` → 17/17 (14 initial
  pins + 3 added in the review round).
- Wider focused set (`worker-image` + the three task-4 suites +
  `control-plane-dockerfile` + `kernel-purity` + `text-hygiene`) → 59/59.
- `npm run typecheck`, `npm run lint` → exit 0.
- **Build (measured, podman):** `podman build -f images/worker/Dockerfile -t
  workflow-worker:c1 .` → **green**, rebuilt after the review fixes to
  `de6a21ce2fc0802dcfc0e965f2926316b55e7ce00d67a19103002ff07fdf0789` (the first
  green build of the pre-review script was
  `baebab91b255eca8afbce41d2e9bc4addbc9d84816b788b674c5abca54ca3e17`). The
  build's fingerprint step writes
  `385b30eb36edeec1236c65b6cb6f73b9c966f09cdbf13ea09cd78ba4b8d02ad9` (63 `.js`
  files) into `/opt/workflow/corpus-fingerprint`. The FIRST-ever build failed
  closed at that step on a wrong corpus-root default (`/opt/workflow/...` where
  the toolbox is built at `/app/mcp-toolbox/apps`) — the correction is the
  fail-closed behavior working, recorded so the fix is not mistaken for luck.
- **In-container checks (measured):** `podman run --rm <image> cat
  /opt/workflow/corpus-fingerprint` → the recorded digest; a live recompute of
  the in-image corpus (`fingerprintCorpus("/app/mcp-toolbox/apps")`) equals the
  recorded digest (`match true`); `podman run --rm <image>` with no config →
  exit **1** naming `WORKFLOW_AZURE_QUEUE_URL, WORKFLOW_KEYVAULT_NAME,
  WORKFLOW_AZURE_ACCOUNT_URL` (fail-closed).

#### Independent review round (2026-10-09)

Fresh-eyes review of the committed diff (`independent-reviewer-task5`). Verdict
round 1: **REJECT** with one P1 + three P2 + four P3. All addressed before this
fragment's "DONE":

- **P1 (security) — git token could reach stderr.** The push/clone embedded the
  token in the URL argv, which git echoes on failure (`fatal: ... x-access-token:<TOKEN>@...`),
  reaching the pod's Log Analytics. Fixed: the credential now rides an
  env-scoped `http.<origin>/.extraheader` (`gitAuthEnv`, git >= 2.31
  `GIT_CONFIG_*` injection) — never argv, never on disk; git error text carries
  only the clean URL. Belt-and-braces: `redactSecret` scrubs the token from any
  clone/push error before it can be logged. Pinned by two tests.
- **P2 — token persisted to `.git/config`.** A token-in-clone-URL is written to
  `<checkout>/.git/config`, readable by the untrusted agent (cwd = checkout).
  Fixed by the same `gitAuthEnv` change (the clean URL is what git stores).
- **P2 — visibility timeout not coupled to `budgetSeconds`.** The dequeue-time
  visibility (default 60s) could expire mid-run, letting a second pod redeliver
  the message while the stale receipt fails its delete. Fixed: `renewMessage`
  extends visibility to `budgetSeconds + 30` before any work and returns the
  NEW popReceipt, which the delete uses.
- **P2 — untrusted agent shares the pod MI.** `opencode run` inherits
  `process.env` (MI endpoints), so the agent could fetch its own storage/KV
  tokens. This is the recorded residual below (plan §6.1), not closable in task
  5's file set; kept on the security axis explicitly.
- **P3s fixed:** the `.d.mts` now declares every public export; the dead
  `encoded` return + wrong comment on `dequeue` removed; an unmapped
  `WORKFLOW_WORKER_MODEL_ENV_VAR` now refuses keyless (fail-closed) instead of
  fetching a key it never passes; the schema-mirror test grew from six to twelve
  reject classes (empty taskId, non-advisory posture, bad evidenceContainer,
  non-integer/zero budget, empty fingerprint).

Verdict round 2: **APPROVE** (recorded by the reviewer subagent against the
fixed commit; all P0/P1 clear, P2s addressed or recorded).

#### Residuals (recorded, not claimed)

- **The live e2e is task 6** (🛰 probe-gated, `WORKFLOW_AZURE_JOBS_PROBE=1`):
  queue message → job pod → stock `opencode run` → branch+PR + evidence blob on
  a throwaway repo. Nothing live is claimed here — the hermetic tests prove the
  fail-closed SEAMS, not a live run.
- **The P0 e2e's evidence-ingest path** (the hub reading the evidence blob and
  checking `declaredEvidence` coverage, `validateDispatch(taskId)`) is a later
  slice; task 5 only writes the blob.
- **The untrusted agent shares the pod managed identity** (the review's P2):
  `opencode run` inherits `process.env`, including the IMDS endpoint, so the
  agent can mint the pod's own storage/KV tokens and read the same secrets it
  was given. The "secrets are memory-only" mitigation is therefore narrowed to
  "not written to disk by the WORKER", not "unreachable by the agent". This is
  plan §6.1's recorded residual (least-privilege RBAC on the worker MI is the
  instance-side lever); restated here so no claim overreaches. A future slice
  could scrub the MI endpoints from the child env.
- **`gitAuthEnv`/`publishResult`** are proven structurally, not live: the
  env-scoped extraheader + GitHub PR API are pinned by construction and unit
  tests, but no live GitHub push happened in task 5 (the live path is task 6).
- **Browser-verification-mcp is not in the worker manifest** (spec §11:299-303):
  it needs a browser runtime the worker image does not carry; the plane keeps it.
