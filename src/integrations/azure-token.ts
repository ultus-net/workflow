/**
 * The shared Azure access-token chain, used by every data-plane REST client
 * in this repo (Key Vault `key-vault.ts`, Storage Queue
 * `azure-jobs-dispatch.ts`). Managed identity on Azure; the azure-cli
 * developer credential locally. No Azure SDK dependency — the same discipline
 * as key-vault.ts (W156) and azure-devops-provider.ts.
 *
 * The chain is extracted here on its SECOND use (the harvest rule): the
 * function body is the exact one key-vault carried inline, so the extraction
 * is behavior-preserving.
 */

export type AccessTokenFetcher = (
  scope: string,
) => Promise<string | { token: string; expiresInSeconds?: number }>;

export type AzureTokenHttpFetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The default developer/managed-identity chain: IMDS first (Azure), then the
 * azure-cli token locally. Token-fetch failures propagate raw (fail-closed
 * with the real cause visible); a missing IMDS endpoint degrades to the CLI.
 */
export function defaultAzureTokenFetcher(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: AzureTokenHttpFetcher = (url, init) => fetch(url, init),
): AccessTokenFetcher {
  return async (scope) => {
    const imds =
      env.MSI_ENDPOINT ?? env.IDENTITY_ENDPOINT ?? "http://169.254.169.254/metadata/identity/oauth2/token";
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
  };
}

/** A cached token accessor built over an `AccessTokenFetcher` (the key-vault discipline). */
export function createCachedTokenSource(
  scope: string,
  getToken: AccessTokenFetcher,
  defaultTtlMs = 300_000,
): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    const now = Date.now();
    if (cached !== undefined && cached.expiresAt > now + 60_000) return cached.token;
    const acquired = await getToken(scope);
    const token = typeof acquired === "string" ? acquired : acquired.token;
    const seconds = typeof acquired === "string" ? undefined : acquired.expiresInSeconds;
    cached = {
      token,
      // The source's real expiry when it states one (capped at an hour so a
      // bogus value can never pin a dead token); the conservative floor
      // otherwise.
      expiresAt: now + (seconds !== undefined && seconds > 0 ? Math.min(seconds, 3_600) * 1000 : defaultTtlMs),
    };
    return token;
  };
}
