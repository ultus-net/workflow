/**
 * W052: token-bound egress.
 *
 * The metering proxy (`createModelUsageProxy`) and the open-model pool proxies
 * are the enforced egress boundary for agent model traffic: agents receive the
 * hub-provisioned placeholder credential and the real upstream key never
 * leaves the proxy. This module is the pure decision that boundary applies
 * before forwarding a request.
 *
 * Enforceable scope (do not overclaim): the check only runs for traffic that
 * actually routes through a proxy. A `network=host`-class path that the agent
 * reaches directly bypasses every proxy, so on that path an attacker-supplied
 * key is detectable only where a proxy is interposed, never blocked here. See
 * `docs/EGRESS_CAPABILITY_AUDIT.md` and `THREAT_MODEL.md`.
 *
 * No IO, no clock, no SDK imports: the proxy and its tests share one decision.
 */

import type { CredentialEndpoint } from "./credentials.js";

/** Placeholder credential agents receive; the proxy ignores it upstream. */
export const METERED_PLACEHOLDER_KEY = "workflow-metered";

export type EgressCredentialKind = "absent" | "session-placeholder" | "foreign";

export interface EgressCredentialDecision {
  readonly allowed: boolean;
  readonly kind: EgressCredentialKind;
  /** Lowercase name of the header carrying a rejected credential. */
  readonly header?: string;
}

/**
 * Credential-bearing request headers. `authorization` is the OpenAI/Anthropic
 * wire convention; the others are common vendor conventions an agent could
 * reach for. All may legitimately be absent (the proxy injects the real key)
 * or carry the session placeholder; any other value is a credential the hub
 * did not provision and is rejected at the boundary.
 */
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "api-key", "x-goog-api-key"] as const;

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : undefined;
  return undefined;
}

/** Normalizes `Bearer <token>` and bare `<token>` forms to the token value. */
function credentialToken(raw: string): string {
  const trimmed = raw.trim();
  const match = /^bearer\s+(.*)$/i.exec(trimmed);
  return (match?.[1] ?? trimmed).trim();
}

/**
 * Decides whether a request's own credentials are consistent with the
 * hub-provisioned session-placeholder discipline. Absent credentials are
 * allowed (the boundary supplies the real key); the placeholder is allowed and
 * labeled `session-placeholder`; anything else is a `foreign` credential and
 * must be rejected proxy-side, because an attacker-controlled key smuggled
 * through agent content could otherwise be used to route the request.
 */
export function checkEgressCredential(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  placeholder: string = METERED_PLACEHOLDER_KEY,
): EgressCredentialDecision {
  let sawPlaceholder = false;
  for (const name of CREDENTIAL_HEADERS) {
    const value = headerValue(headers[name]);
    if (value === undefined || value.trim() === "") continue;
    const token = credentialToken(value);
    if (token === placeholder) {
      sawPlaceholder = true;
      continue;
    }
    return { allowed: false, kind: "foreign", header: name };
  }
  return sawPlaceholder ? { allowed: true, kind: "session-placeholder" } : { allowed: true, kind: "absent" };
}

/**
 * W179 (NVIDIA adoption wave A2): the SECOND credential gate — endpoint
 * coverage. Gate 1 (`checkEgressCredential`) decides whether the request's own
 * credential is the hub-provisioned placeholder; this gate decides whether the
 * credential *binding* covers the destination the request is headed to. Both
 * must pass before the proxy injects the real key: a request may present a
 * perfectly valid placeholder and still be refused because its (host, port,
 * path) falls outside every `allowedEndpoints` entry. Each gate alone grants
 * nothing.
 *
 * The request target is captured as value-free facts only — no header, no
 * query string — so a refusal built from this decision cannot leak secret or
 * request content (OpenShell's logging discipline). Pure: no IO, no clock, no
 * SDK imports; the proxy and its tests share this one decision.
 */
export interface CredentialEndpointRequest {
  readonly host: string;
  readonly port?: number;
  readonly path?: string;
}

export interface CredentialEndpointDecision {
  /** True when the binding grants nothing and the proxy MUST refuse injection. */
  readonly allowed: boolean;
  /**
   * Index of the covering endpoint in `allowedEndpoints`, or `undefined` when
   * no endpoint covers the request. An ABSENT binding is represented by
   * `bindingPresent: false` and always decides `allowed: true` (today's
   * behavior preserved).
   */
  readonly endpointIndex?: number;
  /** False when the credential carried no endpoint binding (gate 2 inactive). */
  readonly bindingPresent: boolean;
}

/**
 * Decides whether a credential's optional endpoint binding covers a request
 * target. `allowedEndpoints` absent (or `undefined`) preserves today's
 * behavior exactly: gate 2 is inactive and the request is allowed without
 * narrowing. An empty array is a present-but-empty binding and matches
 * nothing — fail closed. Host matches case-insensitively and exactly; an
 * absent `port` on either side matches any port; `pathPrefix` matches on a
 * segment boundary and never reads the query string.
 */
export function checkCredentialEndpoint(
  request: CredentialEndpointRequest,
  allowedEndpoints: readonly CredentialEndpoint[] | undefined,
): CredentialEndpointDecision {
  if (allowedEndpoints === undefined) return { allowed: true, bindingPresent: false };
  const host = request.host.toLowerCase();
  const port = request.port;
  const path = request.path ?? "/";
  for (const [index, endpoint] of allowedEndpoints.entries()) {
    if (endpoint.host.toLowerCase() !== host) continue;
    if (endpoint.port !== undefined && endpoint.port !== port) continue;
    if (endpoint.pathPrefix !== undefined && !pathMatchesPrefix(path, endpoint.pathPrefix)) continue;
    return { allowed: true, bindingPresent: true, endpointIndex: index };
  }
  return { allowed: false, bindingPresent: true };
}

/**
 * Segment-boundary prefix match: `/v1` covers `/v1` and `/v1/messages` but not
 * `/v1beta`. The comparison is made against the PATH ONLY (the caller passes a
 * pathname, never a request-target with a query), so a query string can never
 * influence coverage.
 */
function pathMatchesPrefix(path: string, prefix: string): boolean {
  if (prefix === "/") return true;
  if (path === prefix) return true;
  return path.startsWith(`${prefix}/`);
}