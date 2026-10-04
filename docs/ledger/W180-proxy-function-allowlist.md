<!-- Write-once ledger fragment. Append dated supersession notes; never rewrite. -->
### W180 — proxy path/function allowlist reject tier + payload extension point

**Source:** issue #440 (W180, NVIDIA adoption Wave A3/A4). W179 scoped *which
destination* a credential may reach; the function-broad grant of
`docs/EGRESS_CAPABILITY_AUDIT.md` §2 still held — every origin-form function on
the upstream origin was reachable with the injected key. W180 adds function
granularity at the proxy boundary.

**Decision.** `src/integrations/model-usage-proxy.ts` gains an optional
`ProxyPayloadPolicy.egressPolicy` (PR #455, `966bdb3f`). When supplied, the
proxy consults W178's pure `decideEgress` for the request's
`(host, port, method, path)` and refuses an out-of-scope function with the named
policy family `egress_policy` plus a value-free event (host, port, method,
pathname, reason — never the secret, the placeholder, or the query string).

Two seams are added alongside it:
- **The tier is dark by default.** With no `egressPolicy` the gate is skipped
  and behavior is byte-identical; the tier is a composition seam, not a new
  default. When a policy IS supplied it is **fail closed** on the no-rule case:
  `decideEgress`'s `no_matching_rule` (allowed-but-reported) is promoted to DENY
  by `applyEgressPolicyTier`, so a supplied policy that names no rule for the
  destination cannot silently re-open the broad grant. `enforce`-mode endpoints
  refuse out-of-scope functions (`denied_by_enforce_rule`); `audit`-mode
  endpoints observe-and-forward (`audit_only`).
- **The ordering invariant is pinned by test, not a comment.** Gate order:
  gate 1 `checkEgressCredential` → the origin-form guard → the W180 policy gate
  → the lane parse/body-transform seam → gate 2 `checkCredentialEndpoint` →
  header injection → forward. A body transform can never observe the resolved
  upstream key, and a policy-refused request never reaches the transform seam.
- **Payload size ceiling (A4).** The same seam carries
  `maxRequestBodyBytes`: an oversize body is refused with the named
  `payload_too_large` error before any transform or injection, with a
  value-free event carrying byte counts only. Default dark.

**Honest boundary.** Narrowing is stated precisely in the audit doc §3b: absent
a policy the function-broad grant is unchanged; the mechanism is scoped to where
a policy is actually supplied (the operator's configuration), and the §5
direct-egress bypass is entirely unaffected.

**Verification.**
- `node --import tsx --test test/model-usage-proxy.test.ts` — in-policy forward,
  out-of-policy refusal with the named label, default dark, deny-by-default
  `no_matching_rule`, log hygiene, the after-policy-before-injection ordering
  invariant, and the size ceiling.
- `node --import tsx --test test/open-model-proxy.test.ts` — the W070a per-family
  proxies inherit the tier by composition, not reimplementation.
- `docs/EGRESS_CAPABILITY_AUDIT.md` §3b/§7 updated in the same PR.
