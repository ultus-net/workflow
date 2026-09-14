import assert from "node:assert/strict";
import { test } from "node:test";

import { LinuxBubblewrapContainment } from "../src/containment/linux-bwrap.js";
import { PassthroughContainment } from "../src/containment/platform.js";

function roundTrip(child: ReturnType<LinuxBubblewrapContainment["spawn"]>, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve(stdout);
      else reject(new Error(`contained child exited ${exitCode}`));
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

test("bubblewrap spawn streams stdio for interactive protocols", async () => {
  const containment = new LinuxBubblewrapContainment();
  assert.equal(containment.isolation, "enforced");
  const child = containment.spawn({ executable: "/usr/bin/cat", args: [], cwd: "/" });
  try {
    assert.equal(await roundTrip(child, "hello-contained\n"), "hello-contained\n");
  } finally {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
});

test("bubblewrap spawn clears host environment and applies explicit entries", async () => {
  const containment = new LinuxBubblewrapContainment();
  const child = containment.spawn({
    executable: "/usr/bin/env",
    args: [],
    cwd: "/",
    environment: { WORKFLOW_PROBE: "present" },
  });
  try {
    const output = await roundTrip(child, "");
    assert.match(output, /(^|\n)WORKFLOW_PROBE=present(\n|$)/);
    assert.equal(/(^|\n)HOME=/.test(output), false);
  } finally {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
});

test("bubblewrap spawn validates requests before spawning", () => {
  const containment = new LinuxBubblewrapContainment();
  assert.throws(() => containment.spawn({ executable: "cat", args: [] }), /absolute path/);
  assert.throws(
    () => containment.spawn({ executable: "/usr/bin/cat", args: [], network: "invalid" as "host" }),
    /network must be isolated or host/,
  );
});

test("passthrough spawn streams stdio but stays marked policy-only", async () => {
  const containment = new PassthroughContainment();
  assert.equal(containment.isolation, "policy-only");
  const child = containment.spawn({ executable: "/usr/bin/cat", args: [], cwd: "/" });
  try {
    assert.equal(await roundTrip(child, "hello-passthrough\n"), "hello-passthrough\n");
  } finally {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
});
