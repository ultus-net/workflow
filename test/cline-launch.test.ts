import assert from "node:assert/strict";
import test from "node:test";

import { resolveClineLaunch } from "../src/integrations/cline-launch.js";

const globalCline = "/usr/local/bin/cline-real";
const identity = (path: string): string => path;

test("resolveClineLaunch executes the WORKFLOW_CLINE_BIN override directly", () => {
  const resolution = resolveClineLaunch({
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
        envBinOverride: "/opt/custom-cline",
        clineOnPath: globalCline,
        exists: () => false,
      }),
    /WORKFLOW_CLINE_BIN points at a missing binary/,
  );
});

test("resolveClineLaunch runs the ambient cline under Node", () => {
  const resolution = resolveClineLaunch({
    clineOnPath: globalCline,
    exists: () => false,
    realpath: identity,
  });
  assert.equal(resolution.executable, process.execPath);
  assert.equal(resolution.script, globalCline);
});

test("resolveClineLaunch fails closed with no override and no ambient cline", () => {
  assert.throws(
    () =>
      resolveClineLaunch({
        exists: () => false,
      }),
    /No Cline agent available/,
  );
});

test("resolveClineLaunch ignores a blank override and uses the ambient cline", () => {
  const resolution = resolveClineLaunch({
    envBinOverride: "   ",
    clineOnPath: globalCline,
    exists: () => false,
    realpath: identity,
  });
  assert.equal(resolution.executable, process.execPath);
  assert.equal(resolution.script, globalCline);
});
