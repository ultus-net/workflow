/**
 * W178: egress policy decision core + SSRF classification.
 *
 * This is the pure decision module Wave A hangs the egress boundary on
 * (`docs/NVIDIA_ADOPTION_PLAN.md` Wave A item A1). NVIDIA OpenShell enforces
 * these semantics in Rust; we adopt the *semantics*, reimplemented here in
 * TypeScript (build-first: `docs/AI_LANDSCAPE_RESEARCH.md` §3.6, §5.2). The
 * reference patterns are:
 *
 * - OpenShell network-rules: deny-by-default, L4 (host, port) then L7
 *   (method, path) evaluation, unordered rules, additive-allow union,
 *   deny-precedence, per-endpoint `audit` (log + forward, still validate) vs
 *   `enforce` (reject), and load-time rejection of conflicting endpoint
 *   definitions.
 * - OpenShell advisor: the four-finding proposal-risk taxonomy
 *   (`link_local_reach`, `l7_bypass_credentialed`, `credential_reach_expansion`,
 *   `capability_expansion`), here reimplemented as plain set logic for the
 *   L4+REST subset the Z3 prover itself limits to (no SMT dependency).
 * - NemoClaw `ssrf.ts` / `private-networks.ts` / `private-networks.yaml`: the
 *   purpose-annotated SSRF denylist (NAT64, 6to4, Teredo, IPv4-mapped, and
 *   reserved names), scheme allowlist and no-userinfo handled by callers.
 *
 * No IO, no clock, no SDK imports: the proxy and its tests share one decision
 * (the `src/integrations/egress-credential.ts:1-17` discipline). This module
 * does **not** resolve DNS and does **not** pin a validated IP: a pin cannot
 * survive TLS SNI across a runtime boundary (the NemoClaw lesson, parked as
 * P22 / issue #446), so `classifyDestination` reports names as
 * `requires-resolution` and leaves the resolver to the wiring wave (W180).
 *
 * Enforcement boundary (do not overclaim): `audit` mode is observability;
 * `enforce` mode gates **proxy-passed** traffic only. Direct sockets remain
 * the `THREAT_MODEL.md` residual until the mediated network posture lands
 * (W183).
 */

export type EgressMode = "audit" | "enforce";

/**
 * One endpoint grant. Rules are unordered; all rules that match a request
 * union their access (additive-allow). A rule matches at L4 on `host` and, if
 * given, `port`; at L7 on, if given, `methods` and `paths`. Omitted L7 fields
 * mean "any" for that rule but a rule that restricts a field only matches a
 * request that states the corresponding value (a request with no method cannot
 * be shown to satisfy a method-restricted rule). Endpoints that share
 * `host:port` must agree on `mode` (load-time conflict rejection, see
 * `validateEgressPolicy`).
 */
export interface EgressRule {
  /** Stable rule identity; unique within a policy. */
  readonly id?: string;
  /** Exact, case-insensitive host match (no wildcard in W178). */
  readonly host: string;
  /** Concrete port; omitted means "any port". */
  readonly port?: number;
  /** Allowed HTTP methods, case-insensitive; omitted means "any". */
  readonly methods?: readonly string[];
  /** Allowed path prefixes on a segment boundary; omitted means "any". */
  readonly paths?: readonly string[];
  /** `enforce` rejects out-of-policy L7 requests; `audit` logs and forwards. */
  readonly mode: EgressMode;
}

/** A versioned, ordered-by-insertion list of egress rules. */
export interface EgressPolicy {
  /** Monotonic policy revision, for durable-approval bookkeeping (W182). */
  readonly version?: number;
  readonly rules: readonly EgressRule[];
}

/** A proposed L4/L7 egress request. */
export interface EgressRequest {
  readonly host: string;
  readonly port?: number;
  readonly method?: string;
  readonly path?: string;
}

export type EgressDecisionReason =
  | "rule_matched"
  | "denied_by_enforce_rule"
  | "audit_only"
  | "no_matching_rule";

export interface EgressDecision {
  readonly allowed: boolean;
  readonly mode: EgressMode;
  readonly reason: EgressDecisionReason;
  /** The rule whose host+port+function scope the request satisfied. */
  readonly matchedRule?: EgressRule;
  /** The L4 rule that governs a request rejected or reported out-of-policy. */
  readonly endpointRule?: EgressRule;
}

interface NormalizedRequest {
  readonly host: string;
  readonly port: number | undefined;
  readonly method: string | undefined;
  readonly path: string | undefined;
}

function stripQuery(path: string): string {
  const cut = path.search(/[?#]/);
  return cut < 0 ? path : path.slice(0, cut);
}

/**
 * True when `path` falls under `prefix` at a path-segment boundary, so `/v1`
 * matches `/v1` and `/v1/chat` but not `/v1foo`. `/` (or empty) matches all.
 */
function pathScopeMatches(prefix: string, path: string): boolean {
  const p = stripQuery(prefix);
  const t = stripQuery(path);
  if (p === "" || p === "/") return true;
  if (t === p) return true;
  return t.startsWith(p.endsWith("/") ? p : `${p}/`);
}

function normalizeRequest(request: EgressRequest): NormalizedRequest {
  return {
    host: request.host.trim().toLowerCase(),
    port: request.port,
    method: request.method === undefined ? undefined : request.method.toUpperCase(),
    path: request.path,
  };
}

function ruleHost(rule: EgressRule): string {
  return rule.host.trim().toLowerCase();
}

function ruleMethodMatches(rule: EgressRule, request: NormalizedRequest): boolean {
  if (rule.methods === undefined) return true;
  if (request.method === undefined) return false;
  return rule.methods.some((method) => method.toUpperCase() === request.method);
}

function rulePathMatches(rule: EgressRule, request: NormalizedRequest): boolean {
  if (rule.paths === undefined) return true;
  const path = request.path;
  if (path === undefined) return false;
  return rule.paths.some((prefix) => pathScopeMatches(prefix, path));
}

/** L4 endpoint (host + port) match. A concrete rule port requires a concrete request port. */
function ruleEndpointMatches(rule: EgressRule, request: NormalizedRequest): boolean {
  if (ruleHost(rule) !== request.host) return false;
  if (rule.port === undefined) return true;
  return rule.port === request.port;
}

/** L4 + L7 match. */
function ruleScopeMatches(rule: EgressRule, request: NormalizedRequest): boolean {
  return ruleEndpointMatches(rule, request) && ruleMethodMatches(rule, request) && rulePathMatches(rule, request);
}

/**
 * The one decision both the future proxy (W180) and these tests use.
 *
 * Semantics (documented, not guessed):
 *
 * - A request that satisfies a full L4+L7 rule is allowed; its `mode` is the
 *   strongest covering rule (`enforce` wins if an invalid unvalidated policy
 *   mixes modes on one endpoint).
 * - Deny-precedence: a request that matches an endpoint at L4 but falls
 *   outside that endpoint's L7 function scope is denied **iff** the endpoint
 *   is governed by an `enforce` rule.
 * - Out-of-policy with only `audit` rules, or with no matching rule at all,
 *   is allowed-but-reported (`reason: "audit_only"` / `"no_matching_rule"`).
 *   That is the honest posture: this decision module never denies unless an
 *   explicit `enforce` rule covers the endpoint. Deny-by-default is the policy
 *   *direction* the proxy wiring (W180) applies; the decision core reports it
 *   rather than assuming it.
 */
export function decideEgress(request: EgressRequest, policy: EgressPolicy): EgressDecision {
  const normalized = normalizeRequest(request);
  let fullEnforce: EgressRule | undefined;
  let fullAudit: EgressRule | undefined;
  let l4Enforce: EgressRule | undefined;
  let l4Audit: EgressRule | undefined;

  for (const rule of policy.rules) {
    if (!ruleEndpointMatches(rule, normalized)) continue;
    if (rule.mode === "enforce") {
      l4Enforce ??= rule;
      if (ruleScopeMatches(rule, normalized)) fullEnforce ??= rule;
    } else {
      l4Audit ??= rule;
      if (ruleScopeMatches(rule, normalized)) fullAudit ??= rule;
    }
  }

  if (fullEnforce !== undefined) {
    return { allowed: true, mode: "enforce", reason: "rule_matched", matchedRule: fullEnforce };
  }
  if (fullAudit !== undefined) {
    return { allowed: true, mode: "audit", reason: "rule_matched", matchedRule: fullAudit };
  }
  if (l4Enforce !== undefined) {
    return { allowed: false, mode: "enforce", reason: "denied_by_enforce_rule", endpointRule: l4Enforce };
  }
  if (l4Audit !== undefined) {
    return { allowed: true, mode: "audit", reason: "audit_only", endpointRule: l4Audit };
  }
  return { allowed: true, mode: "audit", reason: "no_matching_rule" };
}

export type EgressPolicyIssueCode =
  | "duplicate_rule_id"
  | "invalid_host"
  | "invalid_port"
  | "mode_conflict";

export interface EgressPolicyIssue {
  readonly code: EgressPolicyIssueCode;
  readonly message: string;
  /** Human-readable rule labels (`id` when present, else `#index`). */
  readonly ruleLabels: readonly string[];
}

export interface EgressPolicyValidation {
  readonly valid: boolean;
  readonly issues: readonly EgressPolicyIssue[];
}

function ruleLabel(rule: EgressRule, index: number): string {
  return rule.id ?? `#${index}`;
}

function isValidHost(host: string): boolean {
  return host.trim().length > 0 && !/[\s/]/.test(host);
}

function portsOverlap(a: EgressRule, b: EgressRule): boolean {
  if (a.port === undefined || b.port === undefined) return true;
  return a.port === b.port;
}

function endpointsOverlap(a: EgressRule, b: EgressRule): boolean {
  return ruleHost(a) === ruleHost(b) && portsOverlap(a, b);
}

/**
 * Load-time policy validation. Returns typed issues rather than throwing:
 * `validateCredentialDefinition` (`src/integrations/credentials.ts:211`) throws,
 * but the egress module prefers a machine-readable result so the loader can
 * surface *every* conflict at once. Callers that want fail-closed behavior
 * treat `valid === false` as a startup failure (OpenShell blocks startup on an
 * invalid image policy rather than falling back).
 *
 * The safety-relevant field for endpoint agreement is `mode`: two rules that
 * overlap on `host:port` with different `mode` are rejected because the
 * endpoint's posture would be ambiguous. `methods`/`paths` are intentionally
 * additive and may differ.
 */
export function validateEgressPolicy(policy: EgressPolicy): EgressPolicyValidation {
  const issues: EgressPolicyIssue[] = [];
  const seenIds = new Map<string, string>();

  policy.rules.forEach((rule, index) => {
    const label = ruleLabel(rule, index);
    if (!isValidHost(rule.host)) {
      issues.push({ code: "invalid_host", message: `rule ${label} has an empty or malformed host`, ruleLabels: [label] });
    }
    if (rule.port !== undefined && (!Number.isInteger(rule.port) || rule.port < 1 || rule.port > 65535)) {
      issues.push({ code: "invalid_port", message: `rule ${label} has a port outside 1..65535`, ruleLabels: [label] });
    }
    if (rule.id !== undefined) {
      const first = seenIds.get(rule.id);
      if (first !== undefined) {
        issues.push({
          code: "duplicate_rule_id",
          message: `rule id '${rule.id}' is used by both ${first} and ${label}`,
          ruleLabels: [first, label],
        });
      } else {
        seenIds.set(rule.id, label);
      }
    }
  });

  for (let i = 0; i < policy.rules.length; i += 1) {
    for (let j = i + 1; j < policy.rules.length; j += 1) {
      const a = policy.rules[i] as EgressRule;
      const b = policy.rules[j] as EgressRule;
      if (!endpointsOverlap(a, b)) continue;
      if (a.mode === b.mode) continue;
      issues.push({
        code: "mode_conflict",
        message: `rules ${ruleLabel(a, i)} and ${ruleLabel(b, j)} overlap on ${ruleHost(a)} but disagree on mode (${a.mode} vs ${b.mode})`,
        ruleLabels: [ruleLabel(a, i), ruleLabel(b, j)],
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

/* -------------------------------------------------------------------------- */
/* SSRF stage                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One denylist entry. Every entry carries a human-auditable `purpose`
 * (enforced by the purpose-parity test) and matches either a CIDR block or a
 * set of reserved names. Data is modelled on NemoClaw's
 * `private-networks.yaml`; NAT64/6to4/Teredo/mapped-IPv6 entries are copied as
 * *data*, not code.
 */
export interface EgressDenylistEntry {
  readonly id: string;
  readonly purpose: string;
  readonly cidr?: string;
  readonly names?: readonly string[];
}

export const EGRESS_DENYLIST: readonly EgressDenylistEntry[] = [
  // IPv4.
  { id: "ipv4-unspecified", cidr: "0.0.0.0/8", purpose: "'this network' / unspecified source; never a routable destination" },
  { id: "ipv4-loopback", cidr: "127.0.0.0/8", purpose: "IPv4 loopback; reaches host-local services" },
  { id: "ipv4-link-local", cidr: "169.254.0.0/16", purpose: "IPv4 link-local, including cloud metadata 169.254.169.254" },
  { id: "ipv4-private-10", cidr: "10.0.0.0/8", purpose: "RFC1918 private range" },
  { id: "ipv4-private-172", cidr: "172.16.0.0/12", purpose: "RFC1918 private range" },
  { id: "ipv4-private-192", cidr: "192.168.0.0/16", purpose: "RFC1918 private range" },
  { id: "ipv4-cgnat", cidr: "100.64.0.0/10", purpose: "RFC6598 shared address space (carrier-grade NAT)" },
  { id: "ipv4-reserved-240", cidr: "240.0.0.0/4", purpose: "reserved for future use; not a valid unicast destination" },
  { id: "ipv4-broadcast", cidr: "255.255.255.255/32", purpose: "limited broadcast" },
  // IPv6.
  { id: "ipv6-unspecified", cidr: "::/128", purpose: "unspecified IPv6 address" },
  { id: "ipv6-loopback", cidr: "::1/128", purpose: "IPv6 loopback; reaches host-local services" },
  { id: "ipv6-link-local", cidr: "fe80::/10", purpose: "IPv6 link-local" },
  { id: "ipv6-unique-local", cidr: "fc00::/7", purpose: "IPv6 unique-local (private) range" },
  { id: "ipv6-mapped", cidr: "::ffff:0:0/96", purpose: "IPv4-mapped IPv6; an IPv4 destination in disguise" },
  { id: "ipv6-nat64", cidr: "64:ff9b::/96", purpose: "NAT64 well-known prefix; translates to an IPv4 destination" },
  { id: "ipv6-6to4", cidr: "2002::/16", purpose: "6to4 transition; embeds an arbitrary IPv4 destination" },
  { id: "ipv6-teredo", cidr: "2001:0::/32", purpose: "Teredo transition; embeds an IPv4 destination" },
  { id: "ipv6-documentation", cidr: "2001:db8::/32", purpose: "documentation-only range; never a real destination" },
  // Reserved names.
  { id: "name-loopback", names: ["localhost", "local"], purpose: "loopback alias; resolves to 127.0.0.0/8" },
  { id: "name-metadata", names: ["metadata"], purpose: "cloud metadata service alias (link-local 169.254.169.254)" },
  { id: "name-internal", names: ["internal"], purpose: "internal/private DNS zone suffix" },
];

interface ParsedAddress {
  readonly version: 4 | 6;
  readonly value: bigint;
}

interface ParsedCidr {
  readonly version: 4 | 6;
  readonly network: bigint;
  readonly prefix: number;
}

const CIDR_CACHE = new Map<string, ParsedCidr | null>();

function parseIpv4(text: string): bigint | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6(input: string): bigint | undefined {
  let host = input;
  const zone = host.indexOf("%");
  if (zone >= 0) host = host.slice(0, zone);
  if (host.length === 0) return undefined;

  if (host.includes(".")) {
    const lastColon = host.lastIndexOf(":");
    if (lastColon < 0) return undefined;
    const embedded = parseIpv4(host.slice(lastColon + 1));
    if (embedded === undefined) return undefined;
    const hi = ((embedded >> 16n) & 0xffffn).toString(16);
    const lo = (embedded & 0xffffn).toString(16);
    host = `${host.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const compressed = host.split("::");
  if (compressed.length > 2) return undefined;
  const headText = compressed[0] ?? "";
  const tailText = compressed.length === 2 ? (compressed[1] ?? "") : "";
  const head = headText.length === 0 ? [] : headText.split(":");
  const tail = tailText.length === 0 ? [] : tailText.split(":");
  if (compressed.length === 1) {
    if (head.length !== 8) return undefined;
  } else if (head.length + tail.length > 7) {
    // `::` must stand for at least one 16-bit group.
    return undefined;
  }

  const groups: number[] = [];
  for (const group of head) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    groups.push(Number.parseInt(group, 16));
  }
  const missing = 8 - head.length - tail.length;
  for (let i = 0; i < missing; i += 1) groups.push(0);
  for (const group of tail) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    groups.push(Number.parseInt(group, 16));
  }
  if (groups.length !== 8) return undefined;

  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

function parseAddress(text: string): ParsedAddress | undefined {
  const v4 = parseIpv4(text);
  if (v4 !== undefined) return { version: 4, value: v4 };
  const v6 = parseIpv6(text);
  if (v6 !== undefined) return { version: 6, value: v6 };
  return undefined;
}

function cachedCidr(cidr: string): ParsedCidr | undefined {
  const cached = CIDR_CACHE.get(cidr);
  if (cached !== undefined) return cached ?? undefined;
  const slash = cidr.indexOf("/");
  let parsed: ParsedCidr | undefined;
  if (slash >= 0) {
    const prefixText = cidr.slice(slash + 1);
    const prefix = /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : Number.NaN;
    const v4 = parseIpv4(cidr.slice(0, slash));
    if (v4 !== undefined && prefix >= 0 && prefix <= 32) {
      parsed = { version: 4, network: v4, prefix };
    } else {
      const v6 = parseIpv6(cidr.slice(0, slash));
      if (v6 !== undefined && prefix >= 0 && prefix <= 128) parsed = { version: 6, network: v6, prefix };
    }
  }
  CIDR_CACHE.set(cidr, parsed ?? null);
  return parsed;
}

function addressInCidr(address: ParsedAddress, cidr: ParsedCidr): boolean {
  if (address.version !== cidr.version) return false;
  const bits = address.version === 4 ? 32 : 128;
  const shift = BigInt(bits - cidr.prefix);
  return (address.value >> shift) === (cidr.network >> shift);
}

/**
 * The embedded IPv4 destination of a mapped/NAT64 IPv6 address, if any. Only
 * `::ffff:0:0/96` and `64:ff9b::/96` embed an IPv4 destination; treating every
 * IPv6 low word as one would flag arbitrary public IPv6 as private.
 */
function embeddedIpv4(address: ParsedAddress): bigint | undefined {
  if (address.version !== 6) return undefined;
  const high = address.value >> 32n;
  if (high === 0xffffn || high === 0x0064ff9bn) return address.value & 0xffffffffn;
  return undefined;
}

function matchDenylist(address: ParsedAddress): EgressDenylistEntry | undefined {
  const embedded = embeddedIpv4(address);
  for (const entry of EGRESS_DENYLIST) {
    if (entry.cidr === undefined) continue;
    const cidr = cachedCidr(entry.cidr);
    if (cidr === undefined) continue;
    if (addressInCidr(address, cidr)) return entry;
    if (embedded !== undefined && cidr.version === 4 && addressInCidr({ version: 4, value: embedded }, cidr)) {
      return entry;
    }
  }
  return undefined;
}

function normalizeName(host: string): string {
  return host.replace(/\.$/, "");
}

function matchReservedName(host: string): EgressDenylistEntry | undefined {
  const name = normalizeName(host);
  for (const entry of EGRESS_DENYLIST) {
    if (entry.names?.includes(name)) return entry;
  }
  return undefined;
}

function stripBrackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

export type DestinationKind = "ipv4" | "ipv6" | "name" | "invalid";

export interface DestinationClassification {
  readonly host: string;
  readonly kind: DestinationKind;
  readonly blocked: boolean;
  readonly entryId?: string;
  readonly purpose?: string;
  readonly reason?: string;
}

/**
 * Classifies a destination host. IP literals are matched against the
 * purpose-annotated denylist; reserved names are blocked by name; any other
 * name is reported `blocked: false, reason: "requires-resolution"` because
 * this module does not resolve DNS. The caller must resolve all answers and
 * reject if any is blocked (NemoClaw rule), and must not assume a pinned IP
 * survives TLS SNI (P22). An empty host fails closed.
 */
export function classifyDestination(rawHost: string): DestinationClassification {
  const host = stripBrackets(rawHost.trim().toLowerCase());
  if (host.length === 0) return { host, kind: "invalid", blocked: true, reason: "empty-host" };

  const nameEntry = matchReservedName(host);
  if (nameEntry !== undefined) {
    return { host, kind: "name", blocked: true, entryId: nameEntry.id, purpose: nameEntry.purpose, reason: "reserved-name" };
  }

  const parsed = parseAddress(host);
  if (parsed === undefined) {
    return { host, kind: "name", blocked: false, reason: "requires-resolution" };
  }

  const entry = matchDenylist(parsed);
  const kind: DestinationKind = parsed.version === 4 ? "ipv4" : "ipv6";
  if (entry !== undefined) {
    return { host, kind, blocked: true, entryId: entry.id, purpose: entry.purpose, reason: "denylisted-address" };
  }
  return { host, kind, blocked: false, reason: "public-address" };
}

/** True when `address` is an IP literal in the SSRF denylist. Names return false. */
export function isBlockedAddress(address: string): boolean {
  const parsed = parseAddress(stripBrackets(address.trim().toLowerCase()));
  return parsed !== undefined && matchDenylist(parsed) !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Four-finding proposal-risk report                                           */
/* -------------------------------------------------------------------------- */

export type EgressRiskFindingKind =
  | "link_local_reach"
  | "l7_bypass_credentialed"
  | "credential_reach_expansion"
  | "capability_expansion";

export interface EgressRiskFinding {
  readonly kind: EgressRiskFindingKind;
  readonly severity: "high" | "medium" | "low";
  readonly detail: string;
  readonly hosts: readonly string[];
  readonly ruleIds: readonly string[];
}

/**
 * An endpoint binding a credential may reach. Mirrors the shape
 * `CredentialDefinition.allowedEndpoints` will carry in W179
 * (`{ host, port?, pathPrefix? }`); kept as an input parameter so this module
 * stays decoupled from the proxy and the credential store.
 */
export interface CredentialEndpointBinding {
  readonly host: string;
  readonly port?: number;
  readonly pathPrefix?: string;
}

interface AllowScope {
  readonly host: string;
  readonly port: number | undefined;
  readonly methods: readonly string[] | undefined;
  readonly paths: readonly string[] | undefined;
  readonly ruleId: string | undefined;
}

function toScope(rule: EgressRule): AllowScope {
  return {
    host: ruleHost(rule),
    port: rule.port,
    methods: rule.methods === undefined ? undefined : rule.methods.map((method) => method.toUpperCase()),
    paths: rule.paths,
    ruleId: rule.id,
  };
}

/** Whether `scope` grants the single (method, path) point on `host`/`port`. */
function pointCovered(
  scope: AllowScope,
  host: string,
  port: number | undefined,
  method: string | undefined,
  path: string | undefined,
): boolean {
  if (scope.host !== host) return false;
  if (port === undefined) {
    if (scope.port !== undefined) return false;
  } else if (scope.port !== undefined && scope.port !== port) {
    return false;
  }
  if (scope.methods !== undefined) {
    if (method === undefined) return false;
    if (!scope.methods.includes(method)) return false;
  }
  if (scope.paths !== undefined) {
    if (path === undefined) return false;
    if (!scope.paths.some((prefix) => pathScopeMatches(prefix, path))) return false;
  }
  return true;
}

/**
 * Whether the union of `current` covers every (method, path) point that
 * `scope` grants. Enumerating the candidate's points (rather than requiring a
 * single current rule to subsume the whole scope) makes re-packaged but
 * equivalent rules compare equal, so `capability_expansion` reports real
 * capability growth, not formatting.
 */
function scopeCovered(scope: AllowScope, current: readonly AllowScope[]): boolean {
  const methods: (string | undefined)[] = scope.methods === undefined ? [undefined] : [...scope.methods];
  const paths: (string | undefined)[] = scope.paths === undefined ? [undefined] : [...scope.paths];
  for (const method of methods) {
    for (const path of paths) {
      if (!current.some((cur) => pointCovered(cur, scope.host, scope.port, method, path))) return false;
    }
  }
  return true;
}

function ruleIdsOf(scope: AllowScope): string[] {
  return scope.ruleId === undefined ? [] : [scope.ruleId];
}

function describeScope(scope: AllowScope): string {
  const methods = scope.methods === undefined ? "*" : scope.methods.join("|");
  const paths = scope.paths === undefined ? "*" : scope.paths.join("|");
  const port = scope.port === undefined ? "*" : String(scope.port);
  return `${scope.host}:${port} [${methods}] ${paths}`;
}

function l4OverlapsBinding(scope: AllowScope, binding: CredentialEndpointBinding): boolean {
  if (scope.host !== binding.host.trim().toLowerCase()) return false;
  if (scope.port === undefined || binding.port === undefined) return true;
  return scope.port === binding.port;
}

function scopeExceedsPrefix(scope: AllowScope, prefix: string): boolean {
  if (scope.paths === undefined) return true;
  return scope.paths.some((path) => !pathScopeMatches(prefix, path));
}

/**
 * Compares a candidate egress policy against the current one and reports the
 * four OpenShell advisor findings as plain set logic. Findings are not
 * mutually exclusive (a newly reachable metadata endpoint is both
 * `link_local_reach` and `capability_expansion`).
 *
 * Data boundary: `l7_bypass_credentialed` and `credential_reach_expansion`
 * need the credential endpoint bindings. When `credentials` is empty this
 * function returns none of those two rather than guessing; the caller supplies
 * the bindings once W179 carries them on `CredentialDefinition`.
 */
export function assessPolicyChange(
  current: EgressPolicy,
  candidate: EgressPolicy,
  credentials: readonly CredentialEndpointBinding[] = [],
): EgressRiskFinding[] {
  const currentScopes = current.rules.map(toScope);
  const candidateScopes = candidate.rules.map(toScope);
  const expansion = candidateScopes.filter((scope) => !scopeCovered(scope, currentScopes));

  const linkLocal: EgressRiskFinding[] = [];
  const l7Bypass: EgressRiskFinding[] = [];
  const credentialReach: EgressRiskFinding[] = [];

  for (const scope of expansion) {
    const classification = classifyDestination(scope.host);
    if (!classification.blocked) continue;
    linkLocal.push({
      kind: "link_local_reach",
      severity: "high",
      detail: `candidate grants egress to ${describeScope(scope)}, blocked by the SSRF denylist (${classification.purpose ?? classification.reason ?? "denylisted"})`,
      hosts: [scope.host],
      ruleIds: ruleIdsOf(scope),
    });
  }

  for (const binding of credentials) {
    const bindingHost = binding.host.trim().toLowerCase();
    const candidateReaches = candidateScopes.some((scope) => l4OverlapsBinding(scope, binding));
    const currentReaches = currentScopes.some((scope) => l4OverlapsBinding(scope, binding));
    if (candidateReaches && !currentReaches) {
      credentialReach.push({
        kind: "credential_reach_expansion",
        severity: "high",
        detail: `candidate newly reaches credential-bound endpoint ${bindingHost}${binding.port === undefined ? "" : `:${binding.port}`}`,
        hosts: [bindingHost],
        ruleIds: candidateScopes
          .filter((scope) => l4OverlapsBinding(scope, binding))
          .flatMap((scope) => ruleIdsOf(scope)),
      });
    }

    const prefix = binding.pathPrefix ?? "/";
    const candidateBypass = candidateScopes.some((scope) => l4OverlapsBinding(scope, binding) && scopeExceedsPrefix(scope, prefix));
    const currentBypass = currentScopes.some((scope) => l4OverlapsBinding(scope, binding) && scopeExceedsPrefix(scope, prefix));
    if (candidateBypass && !currentBypass) {
      l7Bypass.push({
        kind: "l7_bypass_credentialed",
        severity: "high",
        detail: `candidate permits paths outside '${prefix}' on credential-bound endpoint ${bindingHost}${binding.port === undefined ? "" : `:${binding.port}`}, so L7 gating no longer bounds the credential`,
        hosts: [bindingHost],
        ruleIds: candidateScopes
          .filter((scope) => l4OverlapsBinding(scope, binding) && scopeExceedsPrefix(scope, prefix))
          .flatMap((scope) => ruleIdsOf(scope)),
      });
    }
  }

  const capability: EgressRiskFinding[] = expansion.map((scope) => ({
    kind: "capability_expansion",
    severity: "medium",
    detail: `candidate grants ${describeScope(scope)}, which the current policy does not cover`,
    hosts: [scope.host],
    ruleIds: ruleIdsOf(scope),
  }));

  return [...linkLocal, ...l7Bypass, ...credentialReach, ...capability];
}
