import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { validateEvidenceShape, verifyEvidenceHash, type BrowserEvidenceRecord } from "../src/evidence.js";
import { createBrowserModel, startFakeCdpServer } from "./helpers/fake-cdp.mjs";

test("packed npm artifact runs the browser-verification binary against a CDP endpoint", async () => {
  const temp = mkdtempSync(join(tmpdir(), "browser-verification-package-"));
  const fake = await startFakeCdpServer(createBrowserModel({ elements: { "#greet": {} } }));
  try {
    const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: process.cwd(), encoding: "utf8" })) as [{ filename: string }];
    const consumer = join(temp, "consumer");
    mkdirSync(consumer);
    execFileSync("npm", ["init", "--yes"], { cwd: consumer, stdio: "ignore" });
    execFileSync("npm", ["install", "--ignore-scripts", join(temp, filename)], { cwd: consumer, stdio: "ignore" });
    const installed = JSON.parse(readFileSync(join(consumer, "node_modules", "browser-verification-mcp", "package.json"), "utf8")) as { bin?: Record<string, string>; dependencies?: Record<string, string> };
    assert.deepEqual(installed.bin, { "browser-verification-mcp": "./dist/server.js" });
    assert.deepEqual(Object.keys(installed.dependencies ?? {}).sort(), ["@modelcontextprotocol/sdk", "zod"]);
    const binary = join(consumer, "node_modules", ".bin", "browser-verification-mcp");
    accessSync(binary, constants.X_OK);
    const client = new Client({ name: "browser-verification-package-consumer", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: binary, cwd: consumer, stderr: "pipe", env: { HOME: process.env.HOME ?? consumer, PATH: process.env.PATH ?? "/usr/bin:/bin", BROWSER_VERIFICATION_CDP_URL: fake.url } }));
    try {
      const result = await client.callTool({ name: "run_verification", arguments: { url: "https://app.test/", actions: [], assertions: [{ kind: "element_exists", selector: "#greet" }], screenshot: false } });
      assert.equal(result.isError, undefined);
      const evidence = (result.structuredContent as { evidence: BrowserEvidenceRecord }).evidence;
      assert.equal(validateEvidenceShape(evidence), true);
      assert.equal(verifyEvidenceHash(evidence), true);
      assert.equal(evidence.result.outcome, "passed");
    } finally {
      await client.close();
    }
  } finally {
    await fake.close();
    rmSync(temp, { recursive: true, force: true });
  }
});