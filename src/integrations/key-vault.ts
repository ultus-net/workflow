import type { SecretStore } from "./credentials.js";

// W156: the Azure Key Vault secret-store backend. Implements the same
// SecretStore port as the D-Bus keyring store (secret-service.ts) so the
// selection seam (secret-store.ts) can swap them per environment. Auth is
// DefaultAzureCredential-equivalent without the SDK dependency: managed
// identity on Azure (the deployment-instance posture — the vault sits in the
// app's resource group with get/list RBAC on the app identity), the
// azure-cli credential locally.
//
// Fail-closed: a missing vault name throws at construction (never silently
// falls back to the keyring); vault API errors surface as "credential
// service unavailable" with the underlying status attached. Token-fetch
// failures (no IMDS endpoint reachable, azure-cli missing or unauthenticated)
// DO propagate raw — still fail-closed, with the real cause visible; the
// "unavailable" label is scoped to the vault API path, and the token-path
// behavior is pinned in test/key-vault-store.test.ts.

const API_VERSION = "7.4";
// The cache floor when the token source states no expiry. A fabricated
// lifetime is worse than a short one: refetching costs a round trip, while a
// dead cached token costs availability for the whole fabricated TTL.
const DEFAULT_TOKEN_TTL_MS = 300_000;

export type KeyVaultFetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type AccessTokenFetcher = (
  scope: string,
) => Promise<string | { token: string; expiresInSeconds?: number }>;

export function createKeyVaultSecretStore(options: {
  vaultName?: string;
  vaultUri?: string;
  fetcher?: KeyVaultFetcher;
  getToken?: AccessTokenFetcher;
} = {}): SecretStore {
  const vaultUri = (options.vaultUri ?? `https://${options.vaultName ?? ""}.vault.azure.net`).replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net$/.test(vaultUri)) {
    throw new TypeError(
      "WORKFLOW_KEYVAULT_NAME/WORKFLOW_KEYVAULT_URI required for the azure-kv secret store (missing or invalid vault name)",
    );
  }

  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  let cachedToken: { token: string; expiresAt: number } | undefined;

  const getToken: AccessTokenFetcher =
    options.getToken ??
    (async (scope) => {
      // Managed identity / developer credential chain, without importing the
      // full Azure SDK: IMDS on Azure, azure-cli token locally.
      const imds =
        process.env.MSI_ENDPOINT ?? process.env.IDENTITY_ENDPOINT ?? "http://169.254.169.254/metadata/identity/oauth2/token";
      const imdsResponse = await fetcher(
        `${imds}?resource=${encodeURIComponent(scope)}&api-version=2018-02-01`,
        { headers: { Metadata: "true" } },
      ).catch(() => undefined);
      if (imdsResponse?.ok) {
        const body = (await imdsResponse.json()) as { access_token?: string; expires_in?: number | string };
        if (body.access_token) {
          const seconds =
            typeof body.expires_in === "number" ? body.expires_in : Number.parseInt(body.expires_in ?? "", 10);
          if (Number.isFinite(seconds) && seconds > 0) {
            return { token: body.access_token, expiresInSeconds: seconds };
          }
          return body.access_token;
        }
      }
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const az = await promisify(execFile)("az", [
        "account",
        "get-access-token",
        "--resource",
        scope,
        "--query",
        "accessToken",
        "-o",
        "tsv",
      ]);
      const token = az.stdout.trim();
      if (!token) throw new Error("azure-cli returned no access token");
      return token;
    });

  async function token(): Promise<string> {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.token;
    const acquired = await getToken("https://vault.azure.net/.default");
    const token = typeof acquired === "string" ? acquired : acquired.token;
    const seconds = typeof acquired === "string" ? undefined : acquired.expiresInSeconds;
    cachedToken = {
      token,
      // The source's real expiry when it states one (capped at an hour so a
      // bogus value can never pin a dead token); the conservative floor
      // otherwise.
      expiresAt: now + (seconds !== undefined && seconds > 0 ? Math.min(seconds, 3_600) * 1000 : DEFAULT_TOKEN_TTL_MS),
    };
    return token;
  }

  // A vault 401/403 means the cached token is dead (or the identity lost
  // access); drop the cache so the next call refetches instead of failing
  // until the TTL runs out.
  function noteAuthFailure(response: Response): void {
    if (response.status === 401 || response.status === 403) cachedToken = undefined;
  }

  async function request(method: string, secretId: string, body?: string): Promise<Response | undefined> {
    const url = `${vaultUri}/secrets/${encodeURIComponent(secretId)}?api-version=${API_VERSION}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${await token()}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify({ value: body }) }),
    };
    return fetcher(url, init);
  }

  async function lookup(id: string): Promise<string | undefined> {
    const response = await request("GET", id);
    if (!response) throw unavailable(404);
    noteAuthFailure(response);
    if (response.status === 404) return undefined;
    if (!response.ok) throw unavailable(response.status);
    const payload = (await response.json()) as { value?: string };
    return payload.value;
  }

  return {
    async has(id): Promise<boolean> {
      return (await lookup(id)) !== undefined;
    },
    get: lookup,
    async put(id, value): Promise<void> {
      const response = await request("PUT", id, value);
      if (response) noteAuthFailure(response);
      if (!response || !response.ok) throw unavailable(response?.status ?? 0);
    },
    async delete(id): Promise<void> {
      const response = await request("DELETE", id);
      if (response) noteAuthFailure(response);
      if (!response || !(response.ok || response.status === 404)) throw unavailable(response?.status ?? 0);
    },
  };
}

function unavailable(status: number): Error {
  const error = new Error("credential service unavailable");
  (error as Error & { status?: number }).status = status;
  return error;
}
