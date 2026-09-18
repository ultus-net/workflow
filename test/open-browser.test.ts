import assert from "node:assert/strict";
import test from "node:test";

import { browserCommand, openBrowser } from "../src/cli/open-browser.js";

const URL = "http://127.0.0.1:4173";

test("browserCommand selects the platform opener", () => {
  assert.deepEqual(browserCommand(URL, "linux"), { command: "xdg-open", args: [URL] });
  assert.deepEqual(browserCommand(URL, "darwin"), { command: "open", args: [URL] });
  const windows = browserCommand(URL, "win32");
  assert.equal(windows?.command, "cmd");
  assert.deepEqual(windows?.args, ["/c", "start", "", URL]);
  assert.equal(browserCommand(URL, "aix" as NodeJS.Platform), undefined);
});

test("openBrowser is suppressed by WORKFLOW_NO_BROWSER and unknown platforms", async () => {
  assert.equal(await openBrowser(URL, { env: { WORKFLOW_NO_BROWSER: "1" }, platform: "linux" }), false);
  assert.equal(await openBrowser(URL, { env: {}, platform: "aix" as NodeJS.Platform }), false);
});
