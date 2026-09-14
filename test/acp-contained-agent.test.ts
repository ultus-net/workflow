import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { test } from "node:test";

import { launchContainedAcpAgent } from "../src/adapters/acp-contained-agent.js";
import type { ContainedProcessRequest, ProcessContainment } from "../src/containment/contracts.js";

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
    readablePaths: ["/opt/agent"],
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

test("contained ACP launch omits readablePaths when none are given", () => {
  const captured: { request?: ContainedProcessRequest } = {};
  launchContainedAcpAgent(capturingContainment(captured), baseOptions);
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
