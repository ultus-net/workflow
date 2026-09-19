import assert from "node:assert/strict";
import test from "node:test";

import { LIMITS } from "../src/bounds.js";
import { validateEvidenceShape, verifyEvidenceHash } from "../src/evidence.js";
import { BrowserSession, type SessionConfig } from "../src/session.js";
import { startFixtureApp } from "./fixtures/fixture-app.js";

/**
 * Live end-to-end probe against a real Chrome over CDP. It is probe-gated,
 * never date-gated, and honestly skips when no browser target is configured —
 * the mock-CDP suites remain the always-on evidence for protocol handling.
 *
 * Gate: BROWSER_VERIFICATION_LIVE=1 plus either
 *   BROWSER_VERIFICATION_CDP_URL (a running Chrome) or
 *   BROWSER_VERIFICATION_CHROME_PATH (launch Chrome; no download).
 */

const live = process.env.BROWSER_VERIFICATION_LIVE === "1";
const cdpUrl = process.env.BROWSER_VERIFICATION_CDP_URL;
const chromePath = process.env.BROWSER_VERIFICATION_CHROME_PATH;
const configured = cdpUrl !== undefined || chromePath !== undefined;

function liveConfig(): SessionConfig {
  return {
    cdpUrl,
    chromePath,
    chromeArgs: [],
    allowedOrigins: [],
    profile: "verification",
    commandTimeoutMs: LIMITS.defaultCommandTimeoutMs,
    navigationTimeoutMs: LIMITS.defaultNavigationTimeoutMs,
    maxScreenshotBytes: LIMITS.maxScreenshotBytes,
    maxScreenshots: LIMITS.maxScreenshotsPerSession,
  };
}

test("live probe: drives the fixture app in a real Chrome and records evidence", { skip: !live || !configured }, async () => {
  const fixture = await startFixtureApp();
  const session = await BrowserSession.start(liveConfig());
  try {
    const result = await session.runVerification({
      url: `${fixture.url}/`,
      actions: [
        { kind: "type", selector: "#name", text: "World" },
        { kind: "click", selector: "#greet" },
      ],
      assertions: [
        { kind: "text_visible", text: "Hello, World" },
        { kind: "element_exists", selector: "#output" },
        { kind: "title_contains", text: "Browser Verification Fixture" },
      ],
      screenshot: true,
    });
    assert.equal(result.evidence.result.outcome, "passed");
    assert.equal(validateEvidenceShape(result.evidence), true);
    assert.equal(verifyEvidenceHash(result.evidence), true);
    assert.ok(result.screenshot !== undefined && result.screenshot.bytes > 0);
    assert.ok(result.screenshot.bytes <= LIMITS.maxScreenshotBytes);

    const hostile = await session.runVerification({
      url: `${fixture.url}/hostile`,
      actions: [],
      assertions: [{ kind: "element_exists", selector: "#hostile-marker" }],
      screenshot: false,
    });
    assert.equal(hostile.evidence.result.outcome, "passed");
    assert.equal(verifyEvidenceHash(hostile.evidence), true);
  } finally {
    await session.close();
    await fixture.close();
  }
});

test("live probe: the fixture app is reachable on loopback even without a browser", { skip: !live }, async () => {
  const fixture = await startFixtureApp();
  try {
    const response = await fetch(`${fixture.url}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Greeting Form/);
    assert.ok((fixture.hits.get("/") ?? 0) >= 1);
  } finally {
    await fixture.close();
  }
});