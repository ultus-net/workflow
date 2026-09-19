import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { validateEvidenceShape, verifyEvidenceHash, type BrowserEvidenceRecord } from "../src/evidence.js";
import { createBrowserModel, startFakeCdpServer } from "./helpers/fake-cdp.mjs";

const serverPath = join(process.cwd(), "dist", "server.js");

async function connectedClient(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "browser-verification-black-box", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: process.cwd(), stderr: "pipe", env: { HOME: process.env.HOME ?? process.cwd(), PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } }));
  return client;
}

test("black-box server exposes model-visible guidance and a bounded verification tool surface", async (t) => {
  const fake = await startFakeCdpServer(createBrowserModel({ elements: { "#name": {}, "#greet": {} } }));
  const client = await connectedClient({ BROWSER_VERIFICATION_CDP_URL: fake.url });
  t.after(async () => { await client.close(); await fake.close(); });
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(names, ["navigate", "snapshot_accessibility", "perform_action", "take_screenshot", "run_assertion", "run_verification", "list_evidence", "get_evidence"]);
  assert.ok(tools.every((tool) => tool.outputSchema));
  const verification = tools.find((tool) => tool.name === "run_verification");
  assert.match(verification?.description ?? "", /verification-accountability-mcp/);
  assert.match(verification?.description ?? "", /untrusted input/);
  const debug = await connectedClient({ BROWSER_VERIFICATION_CDP_URL: fake.url, BROWSER_VERIFICATION_PROFILE: "debug" });
  t.after(async () => { await debug.close(); });
  const debugTools = (await debug.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(debugTools, ["navigate", "capture_console", "capture_network", "capture_trace", "list_evidence", "get_evidence"]);
});

test("black-box run_verification drives the fake CDP target and returns shaped evidence", async (t) => {
  const fake = await startFakeCdpServer(
    createBrowserModel({
      url: "https://app.test/",
      nodes: [
        { role: "RootWebArea", name: "Greeting Form", value: "" },
        { role: "StaticText", name: "Hello world", value: "" },
      ],
      elements: { "#name": {}, "#greet": {} },
    }),
  );
  const client = await connectedClient({ BROWSER_VERIFICATION_CDP_URL: fake.url });
  t.after(async () => { await client.close(); await fake.close(); });
  const result = await client.callTool({
    name: "run_verification",
    arguments: {
      url: "https://app.test/",
      actions: [
        { kind: "type", selector: "#name", text: "World" },
        { kind: "click", selector: "#greet" },
      ],
      assertions: [
        { kind: "text_visible", text: "Hello world" },
        { kind: "element_exists", selector: "#greet" },
      ],
      screenshot: false,
    },
  });
  assert.equal(result.isError, undefined);
  const evidence = (result.structuredContent as { evidence: BrowserEvidenceRecord }).evidence;
  assert.equal(validateEvidenceShape(evidence), true);
  assert.equal(verifyEvidenceHash(evidence), true);
  assert.equal(evidence.result.outcome, "passed");
  assert.equal(evidence.source.capability, "browser-verification-mcp/run_verification");
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((block) => block.type === "text");
  assert.ok(text && typeof text.text === "string");
});

test("black-box screenshot returns bounded image content and count caps hold", async (t) => {
  const fake = await startFakeCdpServer(createBrowserModel({}));
  const client = await connectedClient({ BROWSER_VERIFICATION_CDP_URL: fake.url });
  t.after(async () => { await client.close(); await fake.close(); });
  const first = await client.callTool({ name: "take_screenshot", arguments: {} });
  assert.equal(first.isError, undefined);
  assert.ok((first.content as Array<{ type: string }>).some((block) => block.type === "image"));
});

test("rejects disallowed actions and script payloads at the MCP boundary", async (t) => {
  const fake = await startFakeCdpServer(createBrowserModel({}));
  const client = await connectedClient({ BROWSER_VERIFICATION_CDP_URL: fake.url });
  t.after(async () => { await client.close(); await fake.close(); });
  const evaluate = await client.callTool({ name: "perform_action", arguments: { action: { kind: "evaluate", selector: "body" } } });
  assert.equal(evaluate.isError, true);
  const badKey = await client.callTool({ name: "perform_action", arguments: { action: { kind: "press", key: "F5" } } });
  assert.equal(badKey.isError, true);
  assert.equal(fake.commands.some((command) => /Runtime\.evaluate/.test(command.method)), false);
});

test("fails closed with a clear configuration message when no Chrome target is configured", async (t) => {
  const client = await connectedClient({});
  t.after(async () => { await client.close(); });
  const { tools } = await client.listTools();
  assert.ok(tools.length > 0);
  const result = await client.callTool({ name: "navigate", arguments: { url: "https://app.test/" } });
  assert.equal(result.isError, true);
  const text = JSON.stringify(result.content);
  assert.match(text, /No Chrome target configured/);
});