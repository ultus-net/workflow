import assert from "node:assert/strict";
import test from "node:test";

import { LIMITS } from "../src/bounds.js";
import { validateEvidenceShape, verifyEvidenceHash } from "../src/evidence.js";
import { BrowserSession, type SessionConfig } from "../src/session.js";
import { createBrowserModel, startFakeCdpServer, TINY_PNG_BASE64 } from "./helpers/fake-cdp.mjs";

function config(cdpUrl: string, overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    cdpUrl,
    chromePath: undefined,
    chromeArgs: [],
    allowedOrigins: [],
    profile: "verification",
    commandTimeoutMs: 5_000,
    navigationTimeoutMs: 5_000,
    maxScreenshotBytes: LIMITS.maxScreenshotBytes,
    maxScreenshots: LIMITS.maxScreenshotsPerSession,
    ...overrides,
  };
}

async function withSession(
  options: Parameters<typeof createBrowserModel>[0],
  run: (session: BrowserSession, server: Awaited<ReturnType<typeof startFakeCdpServer>>) => Promise<void>,
  overrides: Partial<SessionConfig> = {},
): Promise<void> {
  const model = createBrowserModel(options);
  const server = await startFakeCdpServer(model);
  const session = await BrowserSession.start(config(server.url, overrides));
  try {
    await run(session, server);
  } finally {
    await session.close();
    await server.close();
  }
}

test("drives navigate, typed action, and assertion end-to-end with hash-stamped evidence", async () => {
  await withSession(
    {
      elements: { "#name": { attributes: ["value", ""] }, "#greet": { attributes: [] } },
      nodes: [
        { role: "RootWebArea", name: "Greeting Form", value: "" },
        { role: "StaticText", name: "Hello world", value: "" },
      ],
    },
    async (session) => {
      const result = await session.runVerification({
        url: "https://app.test/",
        actions: [
          { kind: "type", selector: "#name", text: "World" },
          { kind: "click", selector: "#greet" },
        ],
        assertions: [
          { kind: "text_visible", text: "Hello world" },
          { kind: "element_exists", selector: "#greet" },
          { kind: "element_absent", selector: "#missing" },
          { kind: "url_contains", text: "app.test" },
        ],
        screenshot: false,
      });
      assert.equal(result.evidence.result.outcome, "passed");
      assert.deepEqual(result.evidence.result.assertions, { passed: 4, failed: 0 });
      assert.equal(validateEvidenceShape(result.evidence), true);
      assert.equal(verifyEvidenceHash(result.evidence), true);
      assert.equal(result.evidence.subject.kind, "browser_page");
      assert.match(result.evidence.subject.pageHash, /^[0-9a-f]{64}$/);
      const records = session.listEvidence(50).records;
      assert.ok(records.length >= 4);
      const chained = [...records].reverse();
      for (let index = 1; index < chained.length; index += 1) {
        assert.equal(chained[index]?.previousHash, chained[index - 1]?.hash);
      }
      assert.equal(session.getEvidence(result.evidence.id)?.id, result.evidence.id);
    },
  );
});

test("records failed assertions as failed evidence instead of success", async () => {
  await withSession({ nodes: [{ role: "StaticText", name: "Hello world", value: "" }] }, async (session) => {
    const result = await session.runVerification({
      url: "https://app.test/",
      actions: [],
      assertions: [{ kind: "text_visible", text: "Definitely absent" }],
      screenshot: false,
    });
    assert.equal(result.evidence.result.outcome, "failed");
    assert.deepEqual(result.evidence.result.assertions, { passed: 0, failed: 1 });
    assert.equal(verifyEvidenceHash(result.evidence), true);
  });
});

test("treats a flow with no assertions as inconclusive, never as passed", async () => {
  await withSession({}, async (session) => {
    const result = await session.runVerification({ url: "https://app.test/", actions: [], assertions: [], screenshot: false });
    assert.equal(result.evidence.result.outcome, "inconclusive");
  });
});

test("enforces the screenshot count cap and byte cap", async () => {
  await withSession({}, async (session) => {
    await session.takeScreenshot();
  }, { maxScreenshots: 1 });
  await withSession({}, async (session) => {
    await session.takeScreenshot();
    await assert.rejects(session.takeScreenshot(), /Screenshot cap reached/);
  }, { maxScreenshots: 1 });
  await withSession({ screenshotBase64: Buffer.alloc(2_000_000).toString("base64") }, async (session) => {
    await assert.rejects(session.takeScreenshot(), /exceeds the .*-byte cap/);
  }, { maxScreenshotBytes: 1_000 });
});

test("rejects disallowed origins and unsupported actions before issuing CDP commands", async () => {
  await withSession({}, async (session, server) => {
    await assert.rejects(session.navigate("https://evil.test/"), /not in the configured allowlist/);
    await assert.rejects(session.performAction({ kind: "evaluate", script: "1+1" } as never), /Unsupported action/);
    assert.equal(server.commands.some((command) => command.method === "Page.navigate"), false);
  }, { allowedOrigins: ["https://allowed.test"] });
});

test("reports a missing selector as an error and keeps evidence for prior steps", async () => {
  await withSession({ elements: {} }, async (session) => {
    await assert.rejects(session.performAction({ kind: "click", selector: "#missing" }), /matched no element/);
    assert.equal(session.listEvidence(10).records.length, 0);
  });
});

test("hostile-page network capture is bounded and never issues a fetch or script evaluation of its own", async () => {
  const flood = Array.from({ length: LIMITS.maxNetworkRequests + 123 }, (_, index) => ({ requestId: `r${index}`, url: `https://hostile.test/asset-${index}` }));
  await withSession({ networkRequests: flood }, async (session, server) => {
    const capture = await session.captureDebug("network", LIMITS.minDebugDurationMs);
    assert.ok(capture.entries.length <= LIMITS.maxNetworkRequests);
    assert.equal(capture.truncated, true);
    assert.equal(verifyEvidenceHash(capture.evidence), true);
    const forbidden = /Runtime\.(evaluate|callFunctionOn|compileScript)|Page\.addScriptToEvaluateOnNewDocument|Network\.loadNetworkResource|Fetch\./i;
    assert.equal(server.commands.some((command) => forbidden.test(command.method)), false);
    const navigated = server.commands.filter((command) => command.method === "Page.navigate");
    assert.ok(navigated.length <= 1);
  });
});

test("captures console, network, and trace summaries in debug profile within bounds", async () => {
  await withSession(
    {
      consoleMessages: Array.from({ length: LIMITS.maxConsoleMessages + 10 }, (_, index) => ({ type: "log", args: [{ value: `message-${index}` }] })),
      traceEvents: Array.from({ length: LIMITS.maxTraceEvents + 10 }, (_, index) => ({ name: `event-${index}` })),
    },
    async (session) => {
      const consoleCapture = await session.captureDebug("console", LIMITS.minDebugDurationMs);
      assert.ok(consoleCapture.entries.length <= LIMITS.maxConsoleMessages);
      assert.equal(consoleCapture.truncated, true);
      const traceCapture = await session.captureDebug("trace", LIMITS.minDebugDurationMs);
      assert.ok(traceCapture.entries.length <= LIMITS.maxTraceEvents);
      assert.equal(traceCapture.truncated, true);
    },
    { profile: "debug" },
  );
});

test("captures a screenshot whose hash covers the actual bytes", async () => {
  await withSession({}, async (session) => {
    const shot = await session.takeScreenshot();
    assert.equal(shot.mimeType, "image/png");
    assert.equal(shot.data, TINY_PNG_BASE64);
    assert.equal(shot.bytes, Buffer.from(TINY_PNG_BASE64, "base64").length);
    assert.equal(shot.evidence.action.kind, "screenshot");
    assert.equal((shot.evidence.action.detail as { hash?: unknown }).hash, shot.hash);
  });
});

test("enforces command and navigation timeouts instead of hanging", async () => {
  await withSession({ hangMethods: ["Page.navigate"] }, async (session) => {
    await assert.rejects(session.navigate("https://app.test/"), /timed out/i);
  }, { navigationTimeoutMs: 400, commandTimeoutMs: 400 });
  await withSession({ hangMethods: ["Page.captureScreenshot"] }, async (session) => {
    await assert.rejects(session.takeScreenshot(), /timed out/i);
  }, { commandTimeoutMs: 400 });
});