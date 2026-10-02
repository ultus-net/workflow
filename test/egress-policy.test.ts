import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assessPolicyChange,
  classifyDestination,
  decideEgress,
  EGRESS_DENYLIST,
  isBlockedAddress,
  validateEgressPolicy,
} from "../src/integrations/egress-policy.js";
import type { EgressPolicy, EgressRiskFindingKind } from "../src/integrations/egress-policy.js";

const kinds = (findings: readonly { kind: EgressRiskFindingKind }[]): EgressRiskFindingKind[] =>
  findings.map((finding) => finding.kind);

test("validateEgressPolicy rejects two rules that share host:port but disagree on mode", () => {
  const policy: EgressPolicy = {
    rules: [
      { id: "audit-all", host: "api.example.com", port: 443, mode: "audit" },
      { id: "enforce-v1", host: "api.example.com", port: 443, paths: ["/v1"], mode: "enforce" },
    ],
  };

  const validation = validateEgressPolicy(policy);

  assert.equal(validation.valid, false);
  assert.equal(validation.issues.length, 1);
  assert.equal(validation.issues[0]?.code, "mode_conflict");
  assert.deepEqual(validation.issues[0]?.ruleLabels, ["audit-all", "enforce-v1"]);
});

test("validateEgressPolicy rejects a mode conflict when either rule omits the port (wildcard overlap)", () => {
  const validation = validateEgressPolicy({
    rules: [
      { host: "api.example.com", mode: "enforce" },
      { host: "api.example.com", port: 443, mode: "audit" },
    ],
  });

  assert.equal(validation.valid, false);
  assert.equal(validation.issues[0]?.code, "mode_conflict");
});

test("validateEgressPolicy accepts same-mode rules that share an endpoint with additive scopes", () => {
  const validation = validateEgressPolicy({
    rules: [
      { host: "api.example.com", port: 443, paths: ["/v1"], mode: "enforce" },
      { host: "api.example.com", port: 443, paths: ["/v2"], mode: "enforce" },
    ],
  });

  assert.deepEqual(validation, { valid: true, issues: [] });
});

test("validateEgressPolicy accepts same host on different ports", () => {
  const validation = validateEgressPolicy({
    rules: [
      { host: "api.example.com", port: 443, mode: "enforce" },
      { host: "api.example.com", port: 8443, mode: "audit" },
    ],
  });

  assert.equal(validation.valid, true);
});

test("validateEgressPolicy reports duplicate ids, malformed hosts, and invalid ports", () => {
  const validation = validateEgressPolicy({
    rules: [
      { id: "dup", host: "a.example.com", mode: "audit" },
      { id: "dup", host: "b.example.com", port: 70000, mode: "audit" },
      { host: "", mode: "audit" },
    ],
  });

  assert.equal(validation.valid, false);
  const codes = validation.issues.map((issue) => issue.code);
  assert.ok(codes.includes("duplicate_rule_id"));
  assert.ok(codes.includes("invalid_host"));
  assert.ok(codes.includes("invalid_port"));
});

test("decideEgress allows a request inside an enforce rule's L4+L7 scope", () => {
  const policy: EgressPolicy = {
    rules: [{ id: "openai", host: "api.openai.com", port: 443, methods: ["POST"], paths: ["/v1"], mode: "enforce" }],
  };

  const decision = decideEgress({ host: "API.OpenAI.com", port: 443, method: "post", path: "/v1/chat/completions" }, policy);

  assert.equal(decision.allowed, true);
  assert.equal(decision.mode, "enforce");
  assert.equal(decision.reason, "rule_matched");
  assert.equal(decision.matchedRule?.id, "openai");
});

test("decideEgress is additive-allow: matching allows union their access regardless of rule order", () => {
  const policy: EgressPolicy = {
    rules: [
      { id: "v2", host: "api.example.com", paths: ["/v2"], mode: "enforce" },
      { id: "v1", host: "api.example.com", paths: ["/v1"], mode: "enforce" },
    ],
  };

  assert.equal(decideEgress({ host: "api.example.com", path: "/v1/models" }, policy).matchedRule?.id, "v1");
  assert.equal(decideEgress({ host: "api.example.com", path: "/v2/models" }, policy).matchedRule?.id, "v2");
});

test("decideEgress denies deny-precedence: L4 endpoint match but L7 out-of-scope under enforce", () => {
  const policy: EgressPolicy = {
    rules: [{ id: "restrict", host: "api.example.com", methods: ["GET"], paths: ["/v1"], mode: "enforce" }],
  };

  const decision = decideEgress({ host: "api.example.com", method: "POST", path: "/v1/admin" }, policy);

  assert.equal(decision.allowed, false);
  assert.equal(decision.mode, "enforce");
  assert.equal(decision.reason, "denied_by_enforce_rule");
  assert.equal(decision.endpointRule?.id, "restrict");
});

test("decideEgress reports audit-but-not-denied for an out-of-scope request on an audit endpoint", () => {
  const policy: EgressPolicy = {
    rules: [{ id: "audit", host: "api.example.com", paths: ["/v1"], mode: "audit" }],
  };

  const decision = decideEgress({ host: "api.example.com", path: "/admin" }, policy);

  assert.equal(decision.allowed, true);
  assert.equal(decision.mode, "audit");
  assert.equal(decision.reason, "audit_only");
  assert.equal(decision.endpointRule?.id, "audit");
});

test("decideEgress reports no_matching_rule (allowed-but-reported) for an out-of-policy host", () => {
  const policy: EgressPolicy = { rules: [{ host: "api.example.com", mode: "enforce" }] };

  const decision = decideEgress({ host: "evil.example.net", path: "/" }, policy);

  assert.equal(decision.allowed, true);
  assert.equal(decision.mode, "audit");
  assert.equal(decision.reason, "no_matching_rule");
});

test("decideEgress path scopes respect segment boundaries", () => {
  const policy: EgressPolicy = { rules: [{ host: "api.example.com", paths: ["/v1"], mode: "enforce" }] };

  assert.equal(decideEgress({ host: "api.example.com", path: "/v1" }, policy).allowed, true);
  assert.equal(decideEgress({ host: "api.example.com", path: "/v1/chat?x=1" }, policy).allowed, true);
  assert.equal(decideEgress({ host: "api.example.com", path: "/v1foo" }, policy).allowed, false);
  assert.equal(decideEgress({ host: "api.example.com", path: "/v2" }, policy).allowed, false);
});

test("EGRESS_DENYLIST: every entry carries a non-empty purpose and a unique id (purpose parity)", () => {
  const ids = new Set<string>();
  for (const entry of EGRESS_DENYLIST) {
    assert.equal(typeof entry.purpose, "string", `${entry.id} purpose must be a string`);
    assert.ok(entry.purpose.trim().length > 0, `${entry.id} purpose must be non-empty`);
    assert.ok(!ids.has(entry.id), `denylist id ${entry.id} must be unique`);
    ids.add(entry.id);
    assert.ok(entry.cidr !== undefined || entry.names !== undefined, `${entry.id} must match a cidr or names`);
  }
});

test("isBlockedAddress blocks loopback, link-local, private, and transition addresses", () => {
  const blocked = [
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254", // cloud metadata
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1", // IPv4-mapped
    "64:ff9b::a00:1", // NAT64 -> 10.0.0.1
    "2002:0a00:0001::", // 6to4
    "2001:0:0:0:0:0:0:1", // Teredo
  ];

  for (const address of blocked) {
    assert.equal(isBlockedAddress(address), true, `${address} must be blocked`);
  }
});

test("isBlockedAddress leaves global unicast addresses alone", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isBlockedAddress(address), false, `${address} must not be blocked`);
  }
});

test("classifyDestination blocks reserved names and reports the matching purpose", () => {
  for (const name of ["localhost", "LOCALHOST", "local", "internal", "metadata"]) {
    const classification = classifyDestination(name);
    assert.equal(classification.blocked, true, `${name} must be blocked`);
    assert.equal(classification.kind, "name");
    assert.ok(classification.purpose && classification.purpose.length > 0);
  }
});

test("classifyDestination reports non-reserved names as requiring resolution", () => {
  const classification = classifyDestination("api.example.com");
  assert.equal(classification.blocked, false);
  assert.equal(classification.kind, "name");
  assert.equal(classification.reason, "requires-resolution");
});

test("classifyDestination fails closed on an empty host and describes IP literals", () => {
  const empty = classifyDestination("   ");
  assert.equal(empty.blocked, true);
  assert.equal(empty.kind, "invalid");

  const publicV4 = classifyDestination("93.184.216.34");
  assert.equal(publicV4.blocked, false);
  assert.equal(publicV4.kind, "ipv4");

  const metadata = classifyDestination("169.254.169.254");
  assert.equal(metadata.blocked, true);
  assert.equal(metadata.kind, "ipv4");
  assert.equal(metadata.entryId, "ipv4-link-local");
});

test("assessPolicyChange emits link_local_reach for a newly reachable denylisted endpoint", () => {
  const current: EgressPolicy = { rules: [] };
  const candidate: EgressPolicy = {
    rules: [{ id: "metadata", host: "169.254.169.254", port: 80, mode: "enforce" }],
  };

  const findings = assessPolicyChange(current, candidate);

  assert.ok(kinds(findings).includes("link_local_reach"));
  assert.ok(kinds(findings).includes("capability_expansion"));
  assert.equal(findings.find((finding) => finding.kind === "link_local_reach")?.hosts[0], "169.254.169.254");
});

test("assessPolicyChange emits capability_expansion only for genuinely new reach", () => {
  const current: EgressPolicy = { rules: [{ id: "a", host: "api.a.com", paths: ["/v1"], mode: "enforce" }] };
  const candidate: EgressPolicy = {
    rules: [
      { id: "a", host: "api.a.com", paths: ["/v1"], mode: "enforce" },
      { id: "b", host: "api.b.com", mode: "enforce" },
    ],
  };

  const findings = assessPolicyChange(current, candidate);
  const capability = findings.filter((finding) => finding.kind === "capability_expansion");

  assert.deepEqual(capability.map((finding) => finding.hosts[0]), ["api.b.com"]);
});

test("assessPolicyChange treats re-packaged but equivalent rules as no expansion", () => {
  const current: EgressPolicy = {
    rules: [
      { host: "api.a.com", paths: ["/v1"], mode: "enforce" },
      { host: "api.a.com", paths: ["/v2"], mode: "enforce" },
    ],
  };
  const candidate: EgressPolicy = { rules: [{ host: "api.a.com", paths: ["/v1", "/v2"], mode: "enforce" }] };

  assert.deepEqual(kinds(assessPolicyChange(current, candidate)), []);
});

test("assessPolicyChange emits credential_reach_expansion when a new endpoint reaches a credential binding", () => {
  const current: EgressPolicy = { rules: [] };
  const candidate: EgressPolicy = {
    rules: [{ id: "openai", host: "api.openai.com", port: 443, mode: "enforce" }],
  };

  const findings = assessPolicyChange(current, candidate, [{ host: "api.openai.com", port: 443 }]);

  assert.ok(kinds(findings).includes("credential_reach_expansion"));
});

test("assessPolicyChange emits l7_bypass_credentialed when paths exceed a credential binding's prefix", () => {
  const current: EgressPolicy = {
    rules: [{ id: "scoped", host: "api.openai.com", paths: ["/v1"], mode: "enforce" }],
  };
  const candidate: EgressPolicy = {
    rules: [{ id: "scoped", host: "api.openai.com", paths: ["/v1", "/admin"], mode: "enforce" }],
  };

  const findings = assessPolicyChange(current, candidate, [{ host: "api.openai.com", pathPrefix: "/v1" }]);

  assert.ok(kinds(findings).includes("l7_bypass_credentialed"));
});

test("assessPolicyChange does not emit credentialed findings when no bindings are supplied", () => {
  const current: EgressPolicy = { rules: [] };
  const candidate: EgressPolicy = {
    rules: [{ host: "api.openai.com", paths: ["/v1", "/admin"], mode: "enforce" }],
  };

  const findings = kinds(assessPolicyChange(current, candidate));

  assert.ok(!findings.includes("credential_reach_expansion"));
  assert.ok(!findings.includes("l7_bypass_credentialed"));
});
