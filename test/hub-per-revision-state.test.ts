import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  hubDiscoveryDirectory,
  readHubWebEndpoint,
} from "../src/integrations/hub-discovery.js";
import {
  planeRevisionIdentity,
  opencodeServerStateHome,
  WORKFLOW_CONTAINER_APP_REVISION_ENV,
  WORKFLOW_PLANE_REVISION_ENV,
} from "../src/integrations/opencode-server-discovery.js";

/**
 * C1 per-revision hub state (the v0.1.8 rollout deadlock fix).
 *
 * The hub's instance lock, discovery, and every hub-owned state file live under
 * one state dir. Two Container App revisions sharing the Azure Files mount
 * contended on ONE lock, so the new revision could not boot while the old held
 * it (`Workflow hub is already running (pid 13)`; revision --0000015
 * ActivationFailed). The fix scopes the whole hub state dir to the revision
 * identity — the instance's WORKFLOW_PLANE_REVISION or the ACA-injected
 * CONTAINER_APP_REVISION.
 *
 * These pins cover the shared resolver and the reader that must resolve the
 * SAME directory the hub wrote.
 */

test("planeRevisionIdentity: explicit wins, then the ACA var, else undefined", () => {
  assert.equal(planeRevisionIdentity({}), undefined);
  assert.equal(planeRevisionIdentity({ [WORKFLOW_PLANE_REVISION_ENV]: "  " }), undefined);
  assert.equal(planeRevisionIdentity({ [WORKFLOW_CONTAINER_APP_REVISION_ENV]: "csh-dev-plane--0000015" }), "csh-dev-plane--0000015");
  // The explicit instance value has the last word over the ACA var.
  assert.equal(
    planeRevisionIdentity({
      [WORKFLOW_PLANE_REVISION_ENV]: "explicit",
      [WORKFLOW_CONTAINER_APP_REVISION_ENV]: "csh-dev-plane--0000015",
    }),
    "explicit",
  );
});

test("hubDiscoveryDirectory scopes to the revision identity (two revisions never share one lock dir)", () => {
  const base = "/mnt/plane-state/.workflow";
  const rev14 = hubDiscoveryDirectory(base, "csh-dev-plane--0000014");
  const rev15 = hubDiscoveryDirectory(base, "csh-dev-plane--0000015");
  assert.notEqual(rev14, rev15);
  assert.equal(rev14, join(base, "csh-dev-plane--0000014"));
  assert.equal(rev15, join(base, "csh-dev-plane--0000015"));
  // The hub's lock dir is a child of this directory, so distinct dirs mean
  // distinct locks (the deadlock cannot recur).
  assert.notEqual(join(rev14, "hub", "lock"), join(rev15, "hub", "lock"));
});

test("hubDiscoveryDirectory is byte-identical to the pre-revision root when no identity is set", () => {
  const base = "/home/node/.workflow";
  assert.equal(hubDiscoveryDirectory(base), base);
  assert.equal(hubDiscoveryDirectory(base), opencodeServerStateHome(base, undefined));
});

test("hubDiscoveryDirectory defaults the revision to the ambient identity without an explicit arg", () => {
  const base = "/mnt/plane-state/.workflow";
  const previous = process.env[WORKFLOW_CONTAINER_APP_REVISION_ENV];
  try {
    process.env[WORKFLOW_CONTAINER_APP_REVISION_ENV] = "csh-dev-plane--0000099";
    assert.equal(hubDiscoveryDirectory(base), join(base, "csh-dev-plane--0000099"));
    // An explicit revision still wins over the ambient one.
    assert.equal(hubDiscoveryDirectory(base, "override"), join(base, "override"));
  } finally {
    if (previous === undefined) delete process.env[WORKFLOW_CONTAINER_APP_REVISION_ENV];
    else process.env[WORKFLOW_CONTAINER_APP_REVISION_ENV] = previous;
  }
});

test("readHubWebEndpoint reads the revision-scoped web.json the hub actually wrote", () => {
  const base = mkdtempSync(join(tmpdir(), "wf-hub-rev-"));
  try {
    const revision = "csh-dev-plane--0000015";
    const webPath = join(opencodeServerStateHome(base, revision), "hub", "web.json");
    // Simulate the hub's publish (it writes beside its discovery.json).
    mkdirSync(join(opencodeServerStateHome(base, revision), "hub"), { recursive: true });
    writeFileSync(webPath, JSON.stringify({ protocol: 1, endpoint: "http://127.0.0.1:36569" }));
    assert.equal(readHubWebEndpoint(base, revision), "http://127.0.0.1:36569");
    // A different revision sees no web.json (its own, distinct directory).
    assert.equal(readHubWebEndpoint(base, "csh-dev-plane--0000016"), undefined);
    // Unscoped read (no identity) resolves the base, which holds nothing here.
    assert.equal(readHubWebEndpoint(base), undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
