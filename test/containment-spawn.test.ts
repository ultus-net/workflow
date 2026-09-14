import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("bubblewrap spawn hides host process state behind a PID namespace", async () => {
  const containment = new LinuxBubblewrapContainment();
  const hostPid = process.pid;
  const result = await containment.execute({
    executable: process.execPath,
    args: ["-e", "const fs=require('node:fs'); process.stdout.write(String(fs.existsSync('/proc/'+process.argv[1])))", String(hostPid)],
    cwd: "/",
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "false");
});

test("bubblewrap makes external hardlink aliases read-only inside writable trees", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-hardlink-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside.txt");
  mkdirSync(workspace);
  writeFileSync(outside, "host-data");
  linkSync(outside, join(workspace, "alias.txt"));
  try {
    const containment = new LinuxBubblewrapContainment();
    const result = await containment.execute({
      executable: "/bin/bash",
      args: ["-c", "printf changed > alias.txt"],
      cwd: workspace,
      writablePaths: [workspace],
    });
    assert.notEqual(result.exitCode, 0);
    assert.equal(readFileSync(outside, "utf8"), "host-data");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bubblewrap allows hardlinks whose aliases all remain inside the writable tree", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "workflow-internal-hardlink-"));
  const original = join(workspace, "original.txt");
  writeFileSync(original, "workspace-data");
  linkSync(original, join(workspace, "alias.txt"));
  try {
    const containment = new LinuxBubblewrapContainment();
    const result = await containment.execute({ executable: "/usr/bin/true", args: [], writablePaths: [workspace] });
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("bubblewrap keeps external hardlinks read-only across overlapping writable grants", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-overlap-hardlink-"));
  const workspace = join(root, "workspace");
  const nested = join(workspace, "nested");
  const outside = join(root, "outside.txt");
  mkdirSync(nested, { recursive: true });
  writeFileSync(outside, "host-data");
  linkSync(outside, join(nested, "alias-one.txt"));
  linkSync(outside, join(nested, "alias-two.txt"));
  try {
    const containment = new LinuxBubblewrapContainment();
    for (const writablePaths of [[workspace, nested], [nested, workspace]]) {
      const result = await containment.execute({
        executable: "/bin/bash",
        args: ["-c", "printf changed > alias-one.txt || exit $?; printf changed > alias-two.txt"],
        cwd: nested,
        writablePaths,
      });
      assert.notEqual(result.exitCode, 0);
      assert.equal(readFileSync(outside, "utf8"), "host-data");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
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
