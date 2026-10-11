import type { SecretStore } from "./credentials.js";

/**
 * The board provider PATs (GitHub + Azure DevOps) are operator credentials the
 * hub reads to project the external-task board. Historically they rode the
 * hub's process environment (`WORKFLOW_GITHUB_TOKEN` /
 * `WORKFLOW_AZURE_DEVOPS_TOKEN`, task-provider.ts / azure-devops-provider.ts).
 * On the deployed plane the hub and every agent tool process share one uid, so
 * a PAT in the process environment is readable at `/proc/<pid>/environ` by any
 * shell the agent runs — the same uid-shared leak class as the C1 F2 upstream
 * key (upstream-key.ts).
 *
 * This module is the durable custody seam for those tokens: when
 * `WORKFLOW_BOARD_TOKEN_FROM=<backend>` is set, the configured
 * {@link SecretStore} (Azure Key Vault in the deployed plane) is the ONLY
 * source and the ambient token variables are scrubbed from the effective
 * environment the provider classifiers read. The token then never enters a
 * uid-shared process environment. Unconfigured, the overlay is a no-op that
 * returns the environment byte-identical (env-first, current behavior
 * unchanged). The seam is AUTHORITATIVE, never a fallback: a lingering
 * `WORKFLOW_GITHUB_TOKEN` does NOT short-circuit it, or the uid-shared leak the
 * seam exists to close would silently win.
 */

/** The vault secret NAME convention per lane (instance-facing only; the vault
 * value is per-instance). The default matches the token env name so the
 * operator has one mental model. */
export const PROVIDER_TOKEN_SECRET_NAMES = {
  github: "workflow-github-token",
  azure_devops: "workflow-azure-devops-token",
} as const;

export type ProviderTokenKind = keyof typeof PROVIDER_TOKEN_SECRET_NAMES;

/** The ambient token variables the seam scrubs when it is authoritative. */
export const PROVIDER_TOKEN_ENV_NAMES: Readonly<Record<ProviderTokenKind, string>> = {
  github: "WORKFLOW_GITHUB_TOKEN",
  azure_devops: "WORKFLOW_AZURE_DEVOPS_TOKEN",
};

// The recognized backends. `azure-kv` is the deployed-plane Key Vault store;
// `keyring` is the local D-Bus keyring. A closed set so a typo fails closed
// rather than silently selecting nothing.
const PROVIDER_TOKEN_BACKENDS = ["azure-kv", "keyring"] as const;

/**
 * Resolves the board PATs from the configured {@link SecretStore} and returns
 * the EFFECTIVE provider environment the classifiers read. When
 * `WORKFLOW_BOARD_TOKEN_FROM` is unset the environment is returned
 * byte-identical (env-first, current behavior). When it is set the seam is
 * authoritative: the ambient token variables are removed first, then any token
 * the store holds is applied. A lane whose secret is absent is left
 * unconfigured — the classifier fails closed naming the token variable, never
 * degrading to a uid-shared environment.
 *
 * Fail-closed at parse: an unknown backend throws rather than selecting
 * nothing. The value is never logged. `storeFor` is injected so the source is
 * testable without a live vault.
 */
export function providerEnvWithStoredTokens(options: {
  readonly env: NodeJS.ProcessEnv;
  /** Resolves the named backend; the injected seam (defaults to ambient selection). */
  readonly storeFor: (backend: string) => SecretStore;
}): Promise<NodeJS.ProcessEnv> {
  const env = options.env;
  const from = (env.WORKFLOW_BOARD_TOKEN_FROM ?? "").trim();
  if (from === "") return Promise.resolve(env);
  if (!(PROVIDER_TOKEN_BACKENDS as readonly string[]).includes(from)) {
    return Promise.reject(
      new TypeError(`WORKFLOW_BOARD_TOKEN_FROM '${from}' is not a known backend (expected "azure-kv" or "keyring")`),
    );
  }
  const store = options.storeFor(from);
  // The store is authoritative when the seam is set: scrub every ambient token
  // variable before applying the stored ones.
  const effective: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.values(PROVIDER_TOKEN_ENV_NAMES)) delete effective[name];
  return Promise.all(
    (Object.keys(PROVIDER_TOKEN_SECRET_NAMES) as ProviderTokenKind[]).map(async (kind) => {
      const value = (await store.get(PROVIDER_TOKEN_SECRET_NAMES[kind])) ?? "";
      const trimmed = value.trim();
      if (trimmed.length > 0) effective[PROVIDER_TOKEN_ENV_NAMES[kind]] = trimmed;
    }),
  ).then(() => effective);
}
