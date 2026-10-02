/**
 * W184: resolve the proxy's gate-2 credential binding (W179) from the loaded
 * credential definitions.
 *
 * The metering proxy injects one shared upstream key (custody:
 * `upstream-key.ts`) on behalf of every lane. Gate 2 (`checkCredentialEndpoint`)
 * closes the function-broad grant by refusing injection outside a declared
 * `allowedEndpoints` binding. Until now no launcher passed a binding, so gate 2
 * was inert in production; this resolves the binding for the proxy's single
 * origin from the definitions the operator already manages for the credential
 * broker.
 *
 * Pure and value-free: it reads only destination facts (`host`, `port`,
 * `pathPrefix`) and the upstream URL — never a secret. A definition with no
 * `allowedEndpoints` contributes nothing, so an unconfigured operator keeps the
 * pre-W179 posture byte-identical.
 */

import type { CredentialDefinition, CredentialEndpoint } from "./credentials.js";

/** The proxy's origin facts. `port` is the scheme-default when unspecified. */
export interface UpstreamOrigin {
  readonly host: string;
  readonly port: number;
}

/**
 * The (host, port) an upstream URL normalizes to. Mirrors the proxy's own
 * port resolution: an explicit port wins, else the scheme default (443/80).
 */
export function upstreamOrigin(upstream: string): UpstreamOrigin {
  const url = new URL(upstream);
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return { host: url.hostname.toLowerCase(), port };
}

/**
 * The gate-2 binding for the proxy's upstream origin, from every definition's
 * `allowedEndpoints`. Empty when no definition binds the origin — the caller
 * then leaves `credentialEndpoints` absent so the proxy stays byte-identical.
 *
 * An endpoint binds the origin when its host matches (case-insensitive) and its
 * port is absent or equals the origin port. A binding naming a DIFFERENT
 * host/port is dropped: the single-origin proxy can only ever reach its own
 * upstream, so a mismatched binding would refuse every request rather than
 * scope it. `pathPrefix` is preserved verbatim as the L7 narrowing.
 */
export function upstreamCredentialBinding(
  upstream: string,
  definitions: readonly CredentialDefinition[],
): CredentialEndpoint[] {
  const origin = upstreamOrigin(upstream);
  const binding: CredentialEndpoint[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    for (const endpoint of definition.allowedEndpoints ?? []) {
      if (endpoint.host.trim().toLowerCase() !== origin.host) continue;
      if (endpoint.port !== undefined && endpoint.port !== origin.port) continue;
      const key = `${endpoint.host.toLowerCase()}\u0000${endpoint.port ?? "*"}\u0000${endpoint.pathPrefix ?? "*"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      binding.push({
        host: endpoint.host,
        ...(endpoint.port === undefined ? {} : { port: endpoint.port }),
        ...(endpoint.pathPrefix === undefined ? {} : { pathPrefix: endpoint.pathPrefix }),
      });
    }
  }
  return binding;
}

/**
 * A value-free, order-stable digest of every credential definition's
 * `allowedEndpoints`, for the hub's anti-stale provider fingerprint. Two
 * different bindings yield different strings; the same bindings in a different
 * order yield the same string. Never carries secret material.
 */
export function credentialBindingFingerprint(definitions: readonly CredentialDefinition[]): string {
  return definitions
    .flatMap((definition) => definition.allowedEndpoints ?? [])
    .map((endpoint) => `${endpoint.host.toLowerCase()}:${endpoint.port ?? "*"}${endpoint.pathPrefix ?? ""}`)
    .sort()
    .join("|");
}
