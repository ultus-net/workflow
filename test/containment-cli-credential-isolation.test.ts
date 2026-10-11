import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildBubblewrapInvocation } from "../src/containment/bwrap-args.js";

// Ambient CLI-credential reach pin (W-custody, 2026-10-11): every contained
// agent lane launches through buildBubblewrapInvocation. The boundary must
// never grant the host's logged-in CLI credential stores to the child, or an
// agent could use `gh`/`az`/`aws`/`docker` credentials the operator never
// consented to hand it. The posture is: `--clearenv` (no ambient token vars)
// plus a scratch HOME, with only the system binds and the read-only user
// toolchain paths. This test pins that invariant so a future change cannot
// silently re-grant an ambient credential store.

/** The host CLI credential stores that must never appear in the boundary. */
const CLI_CREDENTIAL_PATH_SUFFIXES = [
  "/.config/gh", // gh auth token (hosts.yml)
  "/.azure", // az login token cache
  "/.aws", // aws shared credentials
  "/.config/gcloud", // gcloud application-default credentials
  "/.docker", // docker registry auth (config.json)
  "/.netrc", // curl/wget/git netrc credentials
  "/.ssh", // ssh keys + known agents
  "/.git-credentials", // git https credential store
  "/.config/hub", // legacy hub CLI
];

function withScratch(): { workspace: string; home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "wf-bwrap-cli-"));
  const workspace = join(root, "project");
  const home = join(root, "acp-home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(workspace, "README.md"), "x");
  return { workspace, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("contained launch: the boundary always clears the ambient environment", () => {
  const scratch = withScratch();
  try {
    const { mountArgs } = buildBubblewrapInvocation(
      { executable: process.execPath, args: [], writablePaths: [scratch.workspace, scratch.home] },
      "host",
    );
    assert.ok(mountArgs.includes("--clearenv"), "the child env is cleared, so ambient GH_TOKEN/AZURE_* cannot ride in");
  } finally {
    scratch.cleanup();
  }
});

test("contained launch: no host CLI credential store is ever bound by default", () => {
  const scratch = withScratch();
  try {
    const { mountArgs } = buildBubblewrapInvocation(
      { executable: process.execPath, args: [], writablePaths: [scratch.workspace, scratch.home] },
      "host",
    );
    for (const suffix of CLI_CREDENTIAL_PATH_SUFFIXES) {
      assert.ok(
        !mountArgs.some((arg) => arg.endsWith(suffix)),
        `the boundary must not bind a host credential store matching '${suffix}' (args: ${mountArgs.join(" ")})`,
      );
    }
  } finally {
    scratch.cleanup();
  }
});

test("contained launch: HOME is the scratch dir (empty of the operator's CLI login), not the operator's real HOME", () => {
  const scratch = withScratch();
  try {
    const { mountArgs, unshareNet } = buildBubblewrapInvocation(
      {
        executable: process.execPath, args: [],
        writablePaths: [scratch.workspace, scratch.home],
        environment: { HOME: scratch.home },
      },
      "host",
    );
    const homeIndex = mountArgs.indexOf("HOME");
    assert.ok(homeIndex >= 0, "HOME must be set via --setenv");
    assert.equal(mountArgs[homeIndex + 1], scratch.home, "HOME resolves to the hub-owned scratch dir");
    // host posture keeps host networking (the recorded residual, not a CLI leak).
    assert.equal(unshareNet, false);
  } finally {
    scratch.cleanup();
  }
});
