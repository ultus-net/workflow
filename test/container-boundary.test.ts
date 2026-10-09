import assert from "node:assert/strict";
import test from "node:test";

import { ContainerBoundaryContainment, detectContainer } from "../src/containment/container-boundary.js";
import type { ProcessContainment } from "../src/containment/contracts.js";
import { LinuxBubblewrapContainment } from "../src/containment/linux-bwrap.js";
import { PassthroughContainment, selectContainment } from "../src/containment/platform.js";

// The backend is constructed with an injected detector in tests so the suite
// is hermetic: it never depends on whether the test host happens to be a
// container, and it exercises BOTH the positive and fail-closed paths.

test("container-boundary refuses to construct outside a container (fail closed)", () => {
  assert.throws(() => new ContainerBoundaryContainment(() => false), /requires a container environment/);
});

test("container-boundary constructs and reports the discriminated enforced marker inside a container", () => {
  const containment = new ContainerBoundaryContainment(() => true);
  assert.equal(containment.isolation, "enforced");
  assert.equal(containment.boundaryKind, "container-boundary");
  assert.equal(containment.supportsProxiedNetwork, false);
});

test("bubblewrap reports boundaryKind 'bwrap' so the two enforced kinds cannot be conflated", () => {
  assert.equal(new LinuxBubblewrapContainment().boundaryKind, "bwrap");
  const passthrough: ProcessContainment = new PassthroughContainment();
  assert.equal(passthrough.isolation, "policy-only");
  // A policy-only backend carries no boundary kind (it established none).
  assert.equal(passthrough.boundaryKind, undefined);
});

test("container-boundary executes a real child and reports enforced/container-boundary", async () => {
  const containment = new ContainerBoundaryContainment(() => true);
  const result = await containment.execute({ executable: "/usr/bin/true", args: [] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.enforcement, "enforced");
});

test("container-boundary validates request shape (absolute executable)", async () => {
  const containment = new ContainerBoundaryContainment(() => true);
  await assert.rejects(() => containment.execute({ executable: "true", args: [] }), /absolute/);
  assert.throws(() => containment.spawn({ executable: "true", args: [] }), /absolute/);
});

test("container-boundary refuses postures it cannot enforce intra-pod (fail closed)", async () => {
  const containment = new ContainerBoundaryContainment(() => true);
  // mediated → the shared stub; proxied → no per-process netns.
  await assert.rejects(
    () => containment.execute({ executable: "/usr/bin/true", args: [], network: "mediated" }),
    /UNSUPPORTED_UNTIL_SUPERVISOR/,
  );
  assert.throws(
    () => containment.spawn({ executable: "/usr/bin/true", args: [], network: "proxied" }),
    /cannot establish a per-process proxied network namespace/,
  );
  // read-write-no-delete cannot be granted intra-pod.
  await assert.rejects(
    () => containment.execute({ executable: "/usr/bin/true", args: [], writableMountMode: "read-write-no-delete" }),
    /cannot enforce read-write-no-delete/,
  );
  assert.throws(
    () => containment.spawn({ executable: "/usr/bin/true", args: [], writableMountMode: "read-write-no-delete" }),
    /cannot enforce read-write-no-delete/,
  );
});

test("selectContainment only picks the container boundary on explicit opt-in", () => {
  const previous = process.env.WORKFLOW_CONTAINMENT_BACKEND;
  try {
    // Absent → the Linux proxied backend, never the delegated boundary.
    delete process.env.WORKFLOW_CONTAINMENT_BACKEND;
    assert.ok(!(selectContainment("linux") instanceof ContainerBoundaryContainment));
    // Explicit opt-in → the delegated boundary (constructed with the real
    // detector, forced positive so the test is host-independent).
    process.env.WORKFLOW_CONTAINMENT_BACKEND = "container-boundary";
    process.env.WORKFLOW_CONTAINER_BOUNDARY_FORCE = "1";
    const selected = selectContainment("linux");
    assert.ok(selected instanceof ContainerBoundaryContainment);
    assert.equal(selected.boundaryKind, "container-boundary");
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_CONTAINMENT_BACKEND;
    else process.env.WORKFLOW_CONTAINMENT_BACKEND = previous;
    delete process.env.WORKFLOW_CONTAINER_BOUNDARY_FORCE;
  }
});

test("detectContainer honors the explicit force override and is otherwise best-effort", () => {
  const previous = process.env.WORKFLOW_CONTAINER_BOUNDARY_FORCE;
  try {
    process.env.WORKFLOW_CONTAINER_BOUNDARY_FORCE = "1";
    assert.equal(detectContainer(), true);
  } finally {
    if (previous === undefined) delete process.env.WORKFLOW_CONTAINER_BOUNDARY_FORCE;
    else process.env.WORKFLOW_CONTAINER_BOUNDARY_FORCE = previous;
  }
});
