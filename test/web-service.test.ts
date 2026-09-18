import assert from "node:assert/strict";
import test from "node:test";

import { startWorkflowWeb } from "../src/cli/web-service.js";

test("startWorkflowWeb serves the browser UI on an ephemeral port and closes", { timeout: 60_000 }, async () => {
  const service = await startWorkflowWeb({ port: 0, workspace: process.cwd() });
  try {
    assert.match(service.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${service.url}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<!doctype html>/i);
  } finally {
    await service.close();
  }
});
