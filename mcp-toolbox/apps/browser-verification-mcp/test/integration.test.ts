import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { pageHash } from "../src/evidence.js";
import { createBrowserModel, startFakeCdpServer } from "./helpers/fake-cdp.mjs";

/**
 * Cross-product integration: verification-accountability-mcp invokes the real
 * browser-verification-mcp server as its configured browser authority (both
 * from source via tsx), which drives a mock CDP target. This proves the
 * evidence contract between the two products, not just a stubbed authority.
 */

const accountabilityServer = join(process.cwd(), "..", "verification-accountability-mcp", "src", "server.ts");

test("verification-accountability admits browser evidence produced by the real browser product", async (t) => {
  const fake = await startFakeCdpServer(createBrowserModel({ url: "https://app.test/", title: "Fixture" }));
  const dataRoot = await mkdtemp(join(tmpdir(), "browser-accountability-integration-"));
  const workspace = await mkdtemp(join(tmpdir(), "browser-accountability-workspace-"));
  const client = new Client({ name: "browser-accountability-integration", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", accountabilityServer],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      HOME: process.env.HOME ?? process.cwd(),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      VERIFICATION_ACCOUNTABILITY_DATA_DIR: dataRoot,
      VERIFICATION_ACCOUNTABILITY_BROWSER_COMMAND: process.execPath,
      VERIFICATION_ACCOUNTABILITY_BROWSER_ARGS: JSON.stringify(["--import", "tsx", join(process.cwd(), "src", "server.ts")]),
      BROWSER_VERIFICATION_CDP_URL: fake.url,
    },
  }));
  t.after(async () => {
    await client.close();
    await fake.close();
    await Promise.all([rm(dataRoot, { recursive: true, force: true }), rm(workspace, { recursive: true, force: true })]);
  });

  const recorded = await client.callTool({ name: "record_verification", arguments: { workspaceRoot: workspace, request: { kind: "browser_verification", url: "https://app.test/", assertions: [{ kind: "text_visible", text: "Hello world" }] } } });
  assert.equal(recorded.isError, undefined);
  const observation = (recorded.structuredContent as { observation: { source: { kind: string; capability: string; observedAt: number; evidenceHash: string }; subject: { kind: string; url: string; pageHash: string }; result: { outcome: string; passed: number; failed: number } } }).observation;
  assert.equal(observation.source.kind, "browser_verification");
  assert.equal(observation.source.capability, "browser-verification-mcp/run_verification");
  assert.match(observation.source.evidenceHash, /^[0-9a-f]{64}$/);
  assert.ok(observation.source.observedAt > 0);
  assert.equal(observation.subject.kind, "browser_page");
  assert.equal(observation.subject.url, "https://app.test/");
  assert.equal(observation.subject.pageHash, pageHash("https://app.test/", "Fixture"));
  assert.equal(observation.result.outcome, "passed");
  assert.equal(observation.result.passed, 1);
  assert.equal(observation.result.failed, 0);

  const fresh = await client.callTool({ name: "list_verifications", arguments: { workspaceRoot: workspace, currentSubject: { kind: "browser_page", url: "https://app.test/", pageHash: pageHash("https://app.test/", "Fixture") } } });
  assert.equal(((fresh.structuredContent as { observations: Array<{ freshness: string }> }).observations[0]?.freshness), "fresh");
  const stale = await client.callTool({ name: "list_verifications", arguments: { workspaceRoot: workspace, currentSubject: { kind: "browser_page", url: "https://app.test/", pageHash: "a".repeat(64) } } });
  assert.equal(((stale.structuredContent as { observations: Array<{ freshness: string }> }).observations[0]?.freshness), "stale");
});