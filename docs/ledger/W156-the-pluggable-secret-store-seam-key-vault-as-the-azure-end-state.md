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
- [ ] W130's custody e2e gains an azure-kv lane gated on env
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
