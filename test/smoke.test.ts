import assert from "node:assert/strict";
import test from "node:test";

import { WORKFLOW_PROTOCOL_VERSION } from "../src/index.js";

test("Workflow project foundation loads as ESM", () => {
  assert.equal(WORKFLOW_PROTOCOL_VERSION, "0.0.0");
});
