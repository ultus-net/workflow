/**
 * OpenCode v2 route-class qualification.
 *
 * `docs/OPENCODE_V2_MIGRATION_SPEC.md` §2.2 requires that no v2 endpoint bypass
 * the Workflow gateway/authority boundary, and §2.4 that every operation carry
 * an explicit qualification. This module is the single, pure source of truth
 * for that classification: it maps an HTTP method + pathname to a route class
 * and a gateway disposition. The production gateway and the qualification
 * probes share it so the tested contract is the enforced contract.
 *
 * Fail-closed rule: an operation that is not explicitly classified here is
 * `unknown` with disposition `deny`. Adding a route class is a deliberate,
 * reviewed change, never an implicit read-only default.
 */

export type OpenCodeV2RouteClass =
  | "read-only"
  | "permission-authority"
  | "session-input"
  | "filesystem-mutation"
  | "mcp-config-mutation"
  | "pty"
  | "app-shell"
  | "unknown";

/**
 * How the gateway must treat the route:
 * - `forward` — proxy to the upstream under the hub credential.
 * - `broker`  — Workflow's broker owns the decision; never forward the client
 *               reply upstream as a client credential.
 * - `deny`    — refuse the client outright (fail closed). The operation must
 *               cross Workflow authorization through a qualified path instead.
 */
export type OpenCodeV2RouteDisposition = "forward" | "broker" | "deny";

export interface OpenCodeV2RouteQualification {
  readonly routeClass: OpenCodeV2RouteClass;
  readonly disposition: OpenCodeV2RouteDisposition;
}

/** The broker-owned permission reply route. Shared with the gateway. */
export const OPENCODE_V2_PERMISSION_REPLY_ROUTE =
  /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Read-only observation classes (§2.4 "Read-only observation" row). */
const READ_ONLY_ROUTE = /^\/(?:api\/)?(?:experimental\/)?(?:info|agent|plugin|model|provider|project|form|event|mcp|skill|vcs|debug|migration|websearch|reference|config|session|location|filesystem|shell|integration|command|rpc|fs)(?:\/|$)/;

interface MutationRule {
  readonly routeClass: OpenCodeV2RouteClass;
  readonly disposition: OpenCodeV2RouteDisposition;
  readonly pattern: RegExp;
  /** Methods this rule applies to; any mutation method when omitted. */
  readonly methods?: readonly string[];
}

/**
 * Mutation rules, first match wins. Every entry corresponds to a row in the
 * §2.4 qualification matrix.
 */
const MUTATION_RULES: readonly MutationRule[] = [
  // Permission authority: the reply route is brokered for every verb by the
  // early check in `qualifyOpenCodeV2Route`; every other permission mutation
  // (saved-permission create/update/remove) must not be answered by a v2 client
  // directly.
  {
    routeClass: "permission-authority",
    disposition: "deny",
    pattern: /permission/,
  },
  // Filesystem/mutation: fs write, session shell, shell lifecycle, worktree and
  // vcs mutation equivalents cross authorization + guard + containment, never a
  // direct client call.
  {
    routeClass: "filesystem-mutation",
    disposition: "deny",
    pattern: /\/(?:filesystem|experimental\/fs|fs|shell|worktree|vcs)(?:\/|$)/,
  },
  // PTY/persistent PTY is an explicit operator capability, never implicit.
  {
    routeClass: "pty",
    disposition: "deny",
    pattern: /\/(?:pty|persistent-pty|persistentPty)(?:\/|$)/i,
  },
  // MCP/integration/config mutation is subordinate to the credential/policy
  // boundary.
  {
    routeClass: "mcp-config-mutation",
    disposition: "deny",
    pattern: /\/(?:mcp|integration|credential|config|plugin|location)(?:\/|$)/,
  },
  // Session input/control: operator/agent input the surface needs is forwarded;
  // it cannot advance canonical state on its own. Destructive session
  // lifecycle changes are held back.
  {
    routeClass: "session-input",
    disposition: "forward",
    pattern: /^\/api\/session\/[^/]+\/(?:prompt|command|synthetic|interrupt|abort|wait|background|inbox|message|instructions|generate|switch|skill)$/,
    methods: ["POST"],
  },
  {
    routeClass: "session-input",
    disposition: "deny",
    pattern: /^\/api\/session\/[^/]+\/(?:compact|fork|move|revert|remove)$/,
  },
  // Removing a session is destructive and releases claims/budget, so it must
  // run through the Workflow lifecycle path rather than a raw client DELETE.
  {
    routeClass: "session-input",
    disposition: "deny",
    pattern: /^\/api\/session(?:\/|$)/,
    methods: ["DELETE"],
  },
  // Session create / update / import: explicit input operations only. There is
  // deliberately no session catch-all — a newly added session operation must be
  // classified (and tested) before an enforced gateway will forward it.
  {
    routeClass: "session-input",
    disposition: "forward",
    pattern: /^\/api\/session\/import$/,
    methods: ["POST"],
  },
  {
    routeClass: "session-input",
    disposition: "deny",
    pattern: /^\/api\/session\/import(?:\/|$)/,
    methods: ["PATCH", "PUT", "DELETE"],
  },
  {
    routeClass: "session-input",
    disposition: "forward",
    pattern: /^\/api\/session$/,
    methods: ["POST"],
  },
  {
    routeClass: "session-input",
    disposition: "forward",
    pattern: /^\/api\/session\/[^/]+$/,
    methods: ["PATCH", "PUT"],
  },
];

/**
 * Qualifies one request against the route-class matrix. GET/HEAD/OPTIONS on a
 * known read subtree is read-only; every other method is a mutation candidate
 * and must match a mutation rule or fail closed as `unknown`/`deny`.
 */
export function qualifyOpenCodeV2Route(
  method: string,
  pathname: string,
): OpenCodeV2RouteQualification {
  const normalized = method.toUpperCase();
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  // Review P3: dot-segment paths are never normalized-and-forwarded. The
  // gateway proxies the raw pathname upstream, so classification and forwarding
  // must see the same path; a dot segment could otherwise classify as one route
  // and resolve to another upstream. Fail closed instead.
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    return { routeClass: "unknown", disposition: "deny" };
  }
  // The permission reply route is broker-owned for EVERY verb, reads included:
  // it must never be forwarded under the hub credential regardless of method.
  if (OPENCODE_V2_PERMISSION_REPLY_ROUTE.test(path)) {
    return { routeClass: "permission-authority", disposition: "broker" };
  }
  if (READ_METHODS.has(normalized)) {
    // The stock v2 web UI's static surface (W074a, deliberate §2.5 row): the
    // app shell and its hashed build output, forward for GET/HEAD only. This
    // is an explicit allowlist — anything else under the root stays
    // `unknown`/deny; a POST on the shell path is still a mutation candidate
    // and fails closed below. Verified against opencode v2.0.10: `GET /`
    // serves `text/html`, bundles live under `/_assets/`, icons under
    // `/icons/`, plus `/site.webmanifest` and the unprompted `/favicon.ico`.
    if (path === "/"
      || path.startsWith("/_assets/")
      || path.startsWith("/icons/")
      || path === "/site.webmanifest"
      || path === "/favicon.ico") {
      return { routeClass: "app-shell", disposition: "forward" };
    }
    // A config read is a read, but not one the gateway may serve with the hub
    // credential: the v2 config payload carries provider credentials, so a raw
    // forward leaks them to the client (review P3). The hub serves redacted
    // config itself; direct reads fail closed. Advisory posture preserves the
    // historical pass-through (the enforced check is the only consumer).
    if (path === "/api/config" || path.startsWith("/api/config/") || path === "/config" || path.startsWith("/config/")) {
      return { routeClass: "read-only", disposition: "deny" };
    }
    if (READ_ONLY_ROUTE.test(path)) {
      return { routeClass: "read-only", disposition: "forward" };
    }
    // A read whose subtree we do not recognize is not implicitly safe
    // (§2.4: "an undocumented route is a qualification failure").
    return { routeClass: "unknown", disposition: "deny" };
  }
  for (const rule of MUTATION_RULES) {
    if (rule.methods !== undefined && !rule.methods.includes(normalized)) continue;
    if (rule.pattern.test(path)) {
      return { routeClass: rule.routeClass, disposition: rule.disposition };
    }
  }
  return { routeClass: "unknown", disposition: "deny" };
}
