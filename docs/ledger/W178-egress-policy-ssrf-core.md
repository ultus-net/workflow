<!-- Write-once ledger fragment. Append dated supersession notes; never rewrite. -->
### W178 — pure egress policy engine + SSRF core

**Source:** issue #438 (W178, NVIDIA adoption Wave A1). The egress audit
(`docs/EGRESS_CAPABILITY_AUDIT.md` §2) had established that the metering proxy
is function-broad by construction: it forwards every origin-form function on the
upstream origin under the injected key. The NVIDIA OpenShell "network-rules"
algebra and the NemoClaw SSRF denylist were the adopted patterns; W178 is the
build-first TypeScript reimplementation of the pure decision core, with no
IO/clock/SDK and the kernel untouched.

**Decision.** `src/integrations/egress-policy.ts` is the shared, pure decision
module (PR #449, `5d528dbd`):
- `decideEgress` — unordered additive-allow union with deny-precedence and
  per-endpoint `audit` vs `enforce` posture. The honest core contract reports
  `no_matching_rule` as **allowed-but-reported**, not denied; the deny-by-default
  promotion is a proxy-tier concern (W180), not the core's.
- `validateEgressPolicy` — load-time rejection of `host:port` rules that
  disagree, so a contradictory policy fails at startup rather than at request
  time.
- `classifyDestination` / `isBlockedAddress` — the SSRF denylist: loopback,
  link-local (incl. the `169.254.169.254` metadata address), private, NAT64,
  6to4, Teredo, IPv4-mapped, and reserved names, each entry carrying an
  auditable *purpose* with a parity test.
- `assessPolicyChange` — the four-finding risk report
  (`link_local_reach`, `l7_bypass_credentialed`, `credential_reach_expansion`,
  `capability_expansion`) as pure set logic over two policies.

**Honest boundary.** This is a *decision* module: it has no side effects and
enforces nothing by itself. It is the shared vocabulary the proxy tier (W180),
the approval store (W182), and the policy-file loader (W183/W184) compose over.

**Verification.**
- `node --import tsx --test test/egress-policy.test.ts` — the decision algebra,
  load-time conflict rejection, the SSRF denylist purpose-parity test, and the
  four-finding report.
- No IO/clock/SDK imports; `src/kernel/` untouched (PR #449 diff is the one
  module plus its test).
