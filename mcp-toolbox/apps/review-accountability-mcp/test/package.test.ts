import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("packed npm artifact independently records and retrieves review accountability", async () => {
  const temp = mkdtempSync(join(tmpdir(), "review-accountability-package-"));
  try {
    const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: process.cwd(), encoding: "utf8" })) as [{ filename: string }];
    const consumer = join(temp, "consumer");
    const workspace = join(temp, "workspace");
    const dataRoot = join(temp, "data");
    mkdirSync(consumer); mkdirSync(workspace);
    execFileSync("npm", ["init", "--yes"], { cwd: consumer, stdio: "ignore" });
    execFileSync("npm", ["install", "--ignore-scripts", join(temp, filename)], { cwd: consumer, stdio: "ignore" });
    const installed = JSON.parse(readFileSync(join(consumer, "node_modules", "review-accountability-mcp", "package.json"), "utf8")) as { bin?: Record<string, string>; dependencies?: Record<string, string> };
    assert.deepEqual(installed.bin, { "review-accountability-mcp": "./dist/server.js" });
    assert.deepEqual(Object.keys(installed.dependencies ?? {}).sort(), ["@modelcontextprotocol/sdk", "zod"]);
    const binary = join(consumer, "node_modules", ".bin", "review-accountability-mcp");
    accessSync(binary, constants.X_OK);
    const client = new Client({ name: "review-package-producer", version: "1.0.0" });
    try {
      await client.connect(new StdioClientTransport({ command: binary, cwd: consumer, stderr: "pipe", env: { REVIEW_ACCOUNTABILITY_DATA_DIR: dataRoot } }));
      const subject = { kind: "fingerprint", algorithm: "sha256", version: "1", scope: "review-diff", value: "d".repeat(64) };
      await client.callTool({ name: "record_review", arguments: { workspaceRoot: workspace, reviewer: "packed-reviewer", verdict: "approved", subject, blockingSeverities: ["P0", "P1"], findings: [] } });
    } finally { await client.close(); }
    const consumerClient = new Client({ name: "review-package-consumer", version: "1.0.0" });
    try {
      await consumerClient.connect(new StdioClientTransport({ command: binary, cwd: consumer, stderr: "pipe", env: { REVIEW_ACCOUNTABILITY_DATA_DIR: dataRoot } }));
      const subject = { kind: "fingerprint", algorithm: "sha256", version: "1", scope: "review-diff", value: "d".repeat(64) };
      const result = await consumerClient.callTool({ name: "list_reviews", arguments: { workspaceRoot: workspace, currentSubject: subject } });
      assert.equal((result.structuredContent as { reviews: Array<{ reviewer: string; freshness: string }> }).reviews[0]?.reviewer, "packed-reviewer");
      assert.equal((result.structuredContent as { reviews: Array<{ freshness: string }> }).reviews[0]?.freshness, "fresh");
    } finally { await consumerClient.close(); }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
