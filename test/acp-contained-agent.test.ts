import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { test } from "node:test";

import { launchContainedAcpAgent, launchContainedAcpAgentAsync } from "../src/adapters/acp-contained-agent.js";
import type { ContainedProcessRequest, ProcessContainment } from "../src/containment/contracts.js";
import type { EgressPolicy } from "../src/integrations/egress-policy.js";

function capturingContainment(captured: { request?: ContainedProcessRequest }): ProcessContainment {
  return {
    isolation: "enforced",
    async execute() {
      throw new Error("not used");
    },
    spawn(request) {
      captured.request = request;
      return {} as unknown as ChildProcessWithoutNullStreams;
    },
  };
}

const baseOptions = {
  executable: "/usr/bin/node",
  script: "/opt/agent/bin/agent.js",
  args: ["--acp"],
  workspace: "/work/repo",
  home: "/work/home",
} as const;

test("contained ACP launch builds a streaming spawn request with workspace and scratch-home writes", () => {
  const captured: { request?: ContainedProcessRequest } = {};
  launchContainedAcpAgent(capturingContainment(captured), {
    ...baseOptions,
    environment: { CLINE_API_KEY: "redacted", CLINE_PROVIDER: "openrouter" },
    readablePaths: ["/opt/agent"],
  });
  assert.deepEqual(captured.request, {
    executable: "/usr/bin/node",
    args: ["/opt/agent/bin/agent.js", "--acp"],
    cwd: "/work/repo",
    readablePaths: ["/opt/agent", "/opt/agent/bin/agent.js"],
    writablePaths: ["/work/repo", "/work/home"],
    // Model API egress is required; the enforced property is filesystem isolation.
    network: "host",
    environment: { CLINE_API_KEY: "redacted", CLINE_PROVIDER: "openrouter", HOME: "/work/home" },
  });
});

test("contained ACP launch always wins HOME over caller environment", () => {
  const captured: { request?: ContainedProcessRequest } = {};
  launchContainedAcpAgent(capturingContainment(captured), {
    ...baseOptions,
    environment: { HOME: "/evil/host/home" },
  });
  assert.equal(captured.request?.environment?.HOME, "/work/home");
});

test("contained ACP launch omits readablePaths when no script or extra paths are given", () => {
  const captured: { request?: ContainedProcessRequest } = {};
  const withoutScript = {
    executable: baseOptions.executable,
    args: baseOptions.args,
    workspace: baseOptions.workspace,
    home: baseOptions.home,
  };
  launchContainedAcpAgent(capturingContainment(captured), withoutScript);
  assert.equal("readablePaths" in (captured.request ?? {}), false);
});

test("contained ACP launch fails closed on a policy-only backend", () => {
  const policyOnly: ProcessContainment = {
    isolation: "policy-only",
    async execute() {
      throw new Error("not used");
    },
    spawn() {
      throw new Error("must not spawn");
    },
  };
  assert.throws(() => launchContainedAcpAgent(policyOnly, baseOptions), /enforced containment boundary/);
});

test("contained ACP launch fails closed when the backend has no streaming spawn", () => {
  const noSpawn: ProcessContainment = {
    isolation: "enforced",
    async execute() {
      throw new Error("not used");
    },
  };
  assert.throws(() => launchContainedAcpAgent(noSpawn, baseOptions), /enforced containment boundary/);
});

test("contained ACP launch rejects relative paths before spawning", () => {
  const captured: { request?: ContainedProcessRequest } = {};
  assert.throws(
    () => launchContainedAcpAgent(capturingContainment(captured), { ...baseOptions, workspace: "repo" }),
    /workspace must be an absolute path/,
  );
  assert.throws(
    () => launchContainedAcpAgent(capturingContainment(captured), { ...baseOptions, home: "home" }),
    /home must be an absolute path/,
  );
  assert.throws(
    () => launchContainedAcpAgent(capturingContainment(captured), { ...baseOptions, script: "agent.js" }),
    /script must be an absolute path/,
  );
  assert.equal(captured.request, undefined);
});

/** A backend advertising proxied support, capturing request + async spawn use. */
function proxiedContainment(captured: { request?: ContainedProcessRequest; asyncUsed?: boolean }): ProcessContainment {
  return {
    isolation: "enforced",
    supportsProxiedNetwork: true,
    async execute() {
      throw new Error("not used");
    },
    spawn(request) {
      captured.request = request;
      return {} as unknown as ChildProcessWithoutNullStreams;
    },
    spawnAsync(request) {
      captured.request = request;
      captured.asyncUsed = true;
      return Promise.resolve({} as unknown as ChildProcessWithoutNullStreams);
    },
  };
}

test("W183: a proxied-capable backend with a policy launches on the proxied posture", async () => {
  const captured: { request?: ContainedProcessRequest; asyncUsed?: boolean } = {};
  const policy: EgressPolicy = { rules: [{ id: "allow", host: "api.example.invalid", mode: "enforce" }] };
  await launchContainedAcpAgentAsync(proxiedContainment(captured), { ...baseOptions, proxiedEgressPolicy: policy });
  assert.equal(captured.asyncUsed, true);
  assert.equal(captured.request?.network, "proxied");
  assert.deepEqual(captured.request?.proxiedEgressPolicy, policy);
});

test("W183: without a policy the launcher keeps the pre-W183 host posture (activation-pending)", async () => {
  const captured: { request?: ContainedProcessRequest; asyncUsed?: boolean } = {};
  await launchContainedAcpAgentAsync(proxiedContainment(captured), { ...baseOptions });
  assert.equal(captured.asyncUsed ?? false, false);
  assert.equal(captured.request?.network, "host");
  assert.equal(Object.hasOwn(captured.request ?? {}, "proxiedEgressPolicy"), false);
});

test("W183: requiring proxied mediation fails closed when the backend cannot provide it", () => {
  const captured: { request?: ContainedProcessRequest } = {};
  assert.throws(
    () => launchContainedAcpAgent(capturingContainment(captured), { ...baseOptions, requireProxiedNetwork: true }),
    /requires a backend that supports the proxied network posture/,
  );
  assert.equal(captured.request, undefined);
});

test("W183: an egress policy on a backend without proxied support fails closed, never silently degrades", () => {
  const captured: { request?: ContainedProcessRequest } = {};
  const policy: EgressPolicy = { rules: [{ id: "allow", host: "api.example.invalid", mode: "enforce" }] };
  assert.throws(
    () => launchContainedAcpAgent(capturingContainment(captured), { ...baseOptions, proxiedEgressPolicy: policy }),
    /does not support the proxied posture/,
  );
  assert.equal(captured.request, undefined);
});

test("W183: the synchronous launch path refuses a proxied request (async spawn is required)", () => {
  const captured: { request?: ContainedProcessRequest; asyncUsed?: boolean } = {};
  const policy: EgressPolicy = { rules: [{ id: "allow", host: "api.example.invalid", mode: "enforce" }] };
  assert.throws(
    () => launchContainedAcpAgent(proxiedContainment(captured), { ...baseOptions, proxiedEgressPolicy: policy }),
    /requires the async path/,
  );
});
