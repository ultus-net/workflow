import assert from "node:assert/strict";
import test from "node:test";

import { PassthroughContainment, selectContainment } from "../src/containment/platform.js";
import { LinuxBubblewrapContainment } from "../src/containment/linux-bwrap.js";
import { ProxiedBubblewrapContainment } from "../src/containment/proxied-bwrap.js";

test("selectContainment picks bubblewrap on Linux", () => {
  assert.ok(selectContainment("linux") instanceof LinuxBubblewrapContainment);
});

test("selectContainment picks the proxied-capable backend on Linux (W183)", () => {
  const containment = selectContainment("linux");
  // Directly pin the W183 selection, not a subclass-satisfied `instanceof`: the
  // proxied posture is only reachable when the selected backend advertises it.
  assert.ok(containment instanceof ProxiedBubblewrapContainment);
  assert.equal(containment.supportsProxiedNetwork, true);
});

test("selectContainment degrades to a passthrough on non-Linux with a warning", () => {
  const warnings: string[] = [];
  const containment = selectContainment("darwin", (message) => warnings.push(message));
  assert.ok(containment instanceof PassthroughContainment);
  assert.deepEqual(warnings, ["no process isolation: policy gating only (platform darwin)"]);
});

test("passthrough containment executes with validation but reports policy-only, never enforced", async () => {
  const containment = new PassthroughContainment();
  const result = await containment.execute({ executable: "/usr/bin/true", args: [] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.enforcement, "policy-only");
});

test("passthrough containment still validates request shape", async () => {
  const containment = new PassthroughContainment();
  await assert.rejects(() => containment.execute({ executable: "true", args: [] }), /absolute/);
});

test("passthrough containment refuses read-write-no-delete it cannot enforce", async () => {
  const containment = new PassthroughContainment();
  await assert.rejects(
    () => containment.execute({ executable: "/usr/bin/true", args: [], writableMountMode: "read-write-no-delete" }),
    /cannot enforce read-write-no-delete/,
  );
  assert.throws(
    () => containment.spawn({ executable: "/usr/bin/true", args: [], writableMountMode: "read-write-no-delete" }),
    /cannot enforce read-write-no-delete/,
  );
});

test("W183: the mediated network posture fails closed with UNSUPPORTED_UNTIL_SUPERVISOR", async () => {
  const containment = new PassthroughContainment();
  await assert.rejects(
    () => containment.execute({ executable: "/usr/bin/true", args: [], network: "mediated" }),
    /UNSUPPORTED_UNTIL_SUPERVISOR/,
  );
  assert.throws(
    () => containment.spawn({ executable: "/usr/bin/true", args: [], network: "mediated" }),
    /UNSUPPORTED_UNTIL_SUPERVISOR/,
  );
  await assert.rejects(
    () => containment.execute({ executable: "/usr/bin/true", args: [], network: "proxied" }),
    /passthrough containment cannot establish a proxied network boundary/,
  );
});

// W144: the passthrough (policy-only) backend honors the same bounded
// execute — detached + process-group kill, the named timeout error. The
// policy-only marker never becomes an unbounded-lane excuse.
test("W144: a bounded execute kills the child at the cap (passthrough)", { timeout: 15_000 }, async () => {
  const containment = new PassthroughContainment();
  const started = Date.now();
  await assert.rejects(
    () => containment.execute({ executable: "/bin/sleep", args: ["30"], timeoutMs: 500 }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /timed out after 500ms/);
      assert.match(error.message, /process group SIGKILL/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 10_000, `the kill lands at the cap — took ${Date.now() - started}ms`);
});
