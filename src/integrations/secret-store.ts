import { createKeyVaultSecretStore } from "./key-vault.js";
import { createSecretServiceStore } from "./secret-service.js";
import type { SecretStore } from "./credentials.js";

export type SecretStoreBackend = "keyring" | "azure-kv";

// W156: the secret-store selection seam. `WORKFLOW_SECRET_STORE` picks the
// backend; the default stays `keyring` (local-first, current behavior
// unchanged). `azure-kv` requires the vault name — a missing one fails
// closed at startup rather than silently falling back to the keyring.
export function resolveSecretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  const backend = (env.WORKFLOW_SECRET_STORE ?? "keyring").trim();
  switch (backend) {
    case "keyring":
      return createSecretServiceStore();
    case "azure-kv": {
      const options: Parameters<typeof createKeyVaultSecretStore>[0] = {};
      if (env.WORKFLOW_KEYVAULT_NAME !== undefined) options.vaultName = env.WORKFLOW_KEYVAULT_NAME;
      if (env.WORKFLOW_KEYVAULT_URI !== undefined) options.vaultUri = env.WORKFLOW_KEYVAULT_URI;
      return createKeyVaultSecretStore(options);
    }
    default:
      throw new TypeError(
        `WORKFLOW_SECRET_STORE '${backend}' is not a known backend (expected "keyring" or "azure-kv")`,
      );
  }
}

export function secretStoreBackend(env: NodeJS.ProcessEnv = process.env): SecretStoreBackend {
  const backend = (env.WORKFLOW_SECRET_STORE ?? "keyring").trim();
  if (backend !== "keyring" && backend !== "azure-kv") {
    throw new TypeError(
      `WORKFLOW_SECRET_STORE '${backend}' is not a known backend (expected "keyring" or "azure-kv")`,
    );
  }
  return backend;
}
