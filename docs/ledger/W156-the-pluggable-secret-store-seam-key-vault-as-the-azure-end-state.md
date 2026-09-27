<!-- Ledger fragment: W156, opened 2026-09-26 (not extracted from TASKS.md —
opened directly as a fragment per the post-migration rule; issue and Project
card carry live status). Live status lives in the GitHub Project; this file
is a write-once landed record — append dated supersession notes, never
rewrite. -->

### W156 - The pluggable secret-store seam: Key Vault as the Azure end-state (keyring stays local-first)

**Source:** the operator's 2026-09-26 direction — "if deployed in Azure we
could configure it to connect to a Key Vault in the same resource group";
rides the deployment-instance split (docs/superpowers/specs/2026-09-26-deployment-instance-split.md
§10 Q3, recorded: Key Vault references are the end-state; ACA secrets were
the C0 probe shortcut only).

**Objective:** Make the secret-store backend pluggable so the same open core
runs local-first (D-Bus keyring via secret-tool, the current default) and in
Azure (Key Vault via managed identity) with an env-selected backend —
without embedding any work-specific values open-side (the one-way rule).

**Acceptance criteria:**
- [x] A `WORKFLOW_SECRET_STORE` selection seam resolves `keyring` (default,
      current behavior unchanged) and `azure-kv` (new
      `KeyVaultSecretStore`), selected in `src/cli/admin.ts` and
      `src/cli/hub.ts` (both currently hardcode `createSecretServiceStore()`).
- [x] `KeyVaultSecretStore` implements the existing `SecretStore` port
      (`has/get/put/delete`) against the vault's REST API via
      `DefaultAzureCredential` (managed identity on Azure; developer
      credential chain locally). Vault name comes from env
      (`WORKFLOW_KEYVAULT_NAME` + optional `WORKFLOW_KEYVAULT_URI`); the
      client dependency is added to package.json.
- [x] `WORKFLOW_SECRET_STORE=azure-kv` with a missing vault name fails
      closed at startup (never silently falls back to the keyring).
- [x] W130's custody e2e gains an azure-kv lane gated on env
      (`WORKFLOW_TEST_KEYVAULT_*`), so the store is verifiable without
      gnome-keyring — the D-Bus machine-gate stays for the keyring lane.
- [x] `docs/FEATURES.md` records the seam honestly (azure-kv = Partial until
      a live vault exercises it; keyring = the current posture, unchanged).
- [ ] The work instance's bicep (instance repo, not here) adds the vault +
      managed-identity `get/list` RBAC and sets `WORKFLOW_SECRET_STORE=azure-kv`
      — the seed checklist already carries the Key Vault line.
- [ ] Independent five-axis review.

**Residuals (recorded, not built):** the CI-side fake (an in-memory
SecretStore for W130's azure-kv lane on unauthenticated runners) versus a
gated live-vault probe — decided at implementation.

**Dated note (2026-09-26, independent-review repair):** the fragment shipped
with every checkbox unchecked while the implementation had already landed;
states corrected to the landed truth (seam, store, fail-closed, FEATURES row
checked; the azure-kv W130 lane, the instance-side bicep, and this review
remain open). Criterion 2's "via `DefaultAzureCredential` ... the client
dependency is added to package.json" is superseded by the operator's
same-day decision — IMDS/azure-cli with NO new SDK dependency (TASKS.md
records "DefaultAzureCredential-equivalent"); the hand-rolled token path is
pinned by test/key-vault-store.test.ts. The review also forced two honesty
fixes now in: the token cache honors the token source's real expiry
(conservative floor when absent) and a vault 401/403 clears the cache (a
dead token never outlives one call); and the "credential service
unavailable" claim is scoped to vault API errors — token-fetch failures
propagate raw, pinned by test.

**Dated note (2026-09-26, second loop: the azure-kv lane landed):** the
residual decision is made — the CI-side fake is a fake VAULT TRANSPORT, not
an in-memory store stand-in. The compiled admin bin runs with
`WORKFLOW_SECRET_STORE=azure-kv` against an in-test fake-vault HTTP server,
reached through a preload fetch hook
(`test/fixtures/kv-fetch-hook.cjs`, `NODE_OPTIONS=--require`) that redirects
exactly two hostnames (the lane's canonical `kv-test.vault.azure.net` and
the IMDS endpoint); every other request passes through untouched. Everything
above the transport is real: `resolveSecretStore`'s env selection, the
`KeyVaultSecretStore` token path (IMDS shape + `expires_in` parsing), the
REST PUT/GET/DELETE shapes, and the control plane's contract plus its
fail-closed error path. `test/e2e-admin-azure-kv.test.ts` pins the lane and
joins `test:ci` BY NAME (22 suites; docs/CI.md updated per the curation
rule). The residual's in-memory-store sketch was rejected because a fake
store behind the control plane would never execute the azure-kv code at
all; the gated live-vault probe stays deferred (`WORKFLOW_TEST_KEYVAULT_*`
reserved for it) until a real vault exists. The lane runs ungated in tier B
because it is hermetic — no keyring, no vault credentials, no network — and
unlike the keyring lane it carries no orphan residual (the fake vault lives
inside the test process).

**Dated note (2026-09-27, third loop: the residual decision is MADE — BOTH
lanes):** the criterion's residual ("the CI-side fake versus a gated
live-vault probe") is resolved as BOTH, completing the second loop's pair;
the criterion's "gated on env (`WORKFLOW_TEST_KEYVAULT_*`)" wording is now
genuinely satisfied — the fake lane stays ungated by design (hermetic) and
the live lane carries the gate:

- The hermetic fake-transport lane stands (landed 2026-09-26, PR #304: the
  fake vault lives in the test process; the store's full code path — IMDS
  shape, REST shapes, error surfacing — runs against it; tier-B ungated).
  Its discrimination was re-proven this loop by scratch check, not by a
  committed change: breaking the stub's answer (every PUT 500s) fails the
  lane at the 204 assertion, then reverted — no src or fixture change
  landed.
- The gated LIVE lane lands here (`test/e2e-admin-azure-kv-live.test.ts`):
  the same compiled-bin custody flow with NOTHING faked — the store's real
  token path (live IMDS when the environment provides it, azure-cli
  otherwise; the fake lane's MSI_ENDPOINT/IDENTITY_ENDPOINT clears are
  deliberately absent because managed identity IS the legitimate live
  source) and the real vault REST over real TLS. The gate is exactly
  `WORKFLOW_TEST_KEYVAULT_URL` (the only `WORKFLOW_TEST_KEYVAULT_*`
  variable the lane reads; the child receives it as `WORKFLOW_KEYVAULT_URI`,
  the store seam's own env var): absent → the lane SKIPS with an honest
  message naming the variable; set but malformed → FAILS at the shape
  assert before any spawn or network call (an operator-set gate means "run
  live"; a typo must never degrade into a skip that looks like a pass).
  Live-only discipline: per-run unique `w156-kv-live-<8hex>` credential id
  (runs never clobber each other or a real credential), in-flow revoke, an
  after-hook best-effort revoke declared BEFORE the kill hook (W130's
  verified FIFO ordering), and NO auto-purge — a revoked Key Vault secret
  is soft-deleted and stays recoverable until the vault's retention window
  auto-purges it; an irreversible purge of operator infrastructure is never
  a test's call. Its discriminating evidence is independent of src: a
  direct vault REST read (raw fetch + an azure-cli token) must see the
  value after the PUT and answer 404 after the revoke — a store that lied
  about success fails the lane twice. Scratch check (recorded run, not
  committed): a well-formed bogus vault URL makes the lane RUN and FAIL at
  the 204 assertion (`{"error":"invalid credential"}`, 400 !== 204) —
  never skip.
- CI posture: the live lane is NOT in `test:ci` (the curated tier-B set
  stays hermetic — no live-network side effects from PR CI, the acp-probe
  precedent). It runs when the operator sets the gate env.
- Honesty state: the lane has never run against a real vault (no vault is
  named for the lane — no `WORKFLOW_TEST_KEYVAULT_URL` exists yet; the
  ambient subscription's unrelated vaults are not Workflow's and were not
  touched), so live-vault verification
  REMAINS OPEN and the azure-kv posture stays Partial — the lane's
  existence is not evidence; only its future gated run will be. The
  instance-side bicep (adding the vault + managed-identity `get/list` RBAC
  and setting `WORKFLOW_SECRET_STORE=azure-kv`) is the natural moment the
  first gated run happens. `docs/FEATURES.md` now states both lanes.

Verification evidence (2026-09-27, focused runs only per the resource
directive): `node --import tsx --test test/e2e-admin-azure-kv-live.test.ts
test/e2e-admin-azure-kv.test.ts test/key-vault-store.test.ts` — 7 tests, 6
pass, 1 honest skip (the live lane without the gate), 0 fail; `npm run
lint` exit 0; `npm run typecheck` exit 0. No src/ behavior change (test-tier
+ docs only; the store, the seam, and both lanes' dependencies untouched).
