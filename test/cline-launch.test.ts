import assert from "node:assert/strict";
import test from "node:test";

import { resolveClineLaunch } from "../src/integrations/cline-launch.js";

const root = "/repo";
const platformDir = `cli-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const compiledBinary = `${root}/.workflow-cline/cline/apps/cli/dist/${platformDir}/bin/${process.platform === "win32" ? "cline.exe" : "cline"}`;
const globalCline = "/usr/local/bin/cline-real";
const identity = (path: string): string => path;

test("resolveClineLaunch executes the WORKFLOW_CLINE_BIN override directly", () => {
  const resolution = resolveClineLaunch({
    workflowRoot: root,
    envBinOverride: "/opt/custom-cline",
    clineOnPath: globalCline,
    exists: (path) => path === "/opt/custom-cline",
    realpath: identity,
  });
  assert.equal(resolution.executable, "/opt/custom-cline");
  assert.equal(resolution.script, undefined);
});

test("resolveClineLaunch fails closed when the override binary is missing", () => {
  assert.throws(
    () =>
      resolveClineLaunch({
        workflowRoot: root,
        envBinOverride: "/opt/custom-cline",
        clineOnPath: globalCline,
        exists: () => false,
      }),
    /WORKFLOW_CLINE_BIN points at a missing binary/,
  );
});

test("resolveClineLaunch prefers the ambient cline over the deprecated vendored binary", () => {
  const resolution = resolveClineLaunch({
    workflowRoot: root,
    clineOnPath: globalCline,
    exists: (path) => path === compiledBinary,
    realpath: identity,
  });
  assert.equal(resolution.executable, process.execPath);
  assert.equal(resolution.script, globalCline);
});

test("resolveClineLaunch falls back to the deprecated vendored binary when no ambient cline", () => {
  const resolution = resolveClineLaunch({
    workflowRoot: root,
    exists: (path) => path === compiledBinary,
    realpath: identity,
  });
  assert.equal(resolution.executable, compiledBinary);
  assert.equal(resolution.script, undefined);
});

test("resolveClineLaunch falls back to Node + the global cline wrapper", () => {
  const resolution = resolveClineLaunch({
    workflowRoot: root,
    clineOnPath: globalCline,
    exists: () => false,
  });
  assert.equal(resolution.executable, process.execPath);
  assert.equal(resolution.script, globalCline);
});

test("resolveClineLaunch fails closed with no override, no ambient cline, and no vendored build", () => {
  assert.throws(
    () =>
      resolveClineLaunch({
        workflowRoot: root,
        exists: () => false,
      }),
    /No Cline agent available/,
  );
});

test("resolveClineLaunch ignores a blank override and uses the ambient cline", () => {
  const resolution = resolveClineLaunch({
    workflowRoot: root,
    envBinOverride: "   ",
    clineOnPath: globalCline,
    exists: (path) => path === compiledBinary,
    realpath: identity,
  });
  assert.equal(resolution.executable, process.execPath);
  assert.equal(resolution.script, globalCline);
});
