import assert from "node:assert/strict";
import test from "node:test";

import { PassthroughContainment, selectContainment } from "../src/containment/platform.js";
import { LinuxBubblewrapContainment } from "../src/containment/linux-bwrap.js";

test("selectContainment picks bubblewrap on Linux", () => {
  assert.ok(selectContainment("linux") instanceof LinuxBubblewrapContainment);
});

test("selectContainment degrades to a passthrough on non-Linux with a warning", () => {
  const warnings: string[] = [];
  const containment = selectContainment("darwin", (message) => warnings.push(message));
  assert.ok(containment instanceof PassthroughContainment);
  assert.deepEqual(warnings, ["no process isolation: policy gating only (platform darwin)"]);
});

test("passthrough containment executes with validation but no isolation", async () => {
  const containment = new PassthroughContainment();
  const result = await containment.execute({ executable: "/usr/bin/true", args: [] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.enforcement, "enforced");
});

test("passthrough containment still validates request shape", async () => {
  const containment = new PassthroughContainment();
  await assert.rejects(() => containment.execute({ executable: "true", args: [] }), /absolute/);
});
