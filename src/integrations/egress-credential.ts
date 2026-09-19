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