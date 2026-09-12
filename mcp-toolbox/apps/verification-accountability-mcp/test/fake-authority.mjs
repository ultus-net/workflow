#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake-verification-authority", version: "1.0.0" });
server.registerTool("run_tests", {
  inputSchema: { workspaceRoot: z.string(), testIds: z.array(z.string()), timeoutMs: z.number().optional() },
}, async () => ({ content: [{ type: "text", text: "test evidence" }], structuredContent: { outcome: "completed", exitCode: 1, tests: [{ name: "passes", status: "passed" }, { name: "fails", status: "failed" }], testsTruncated: true, failures: [{ message: "failure" }], failuresTruncated: true, diagnosticsTruncated: true } }));
server.registerTool("list_ci_runs", {
  inputSchema: { revision: z.string().optional(), limit: z.number() },
}, async ({ revision }) => {
  if (process.env.CI_GITHUB_REPOSITORY !== "owner/repo") throw new Error("CI repository configuration was not forwarded");
  return { content: [{ type: "text", text: "ci evidence" }], structuredContent: { runs: [{ id: "github:42", revision: revision ?? "d".repeat(40), state: "completed", conclusion: "success" }], truncated: false } };
});
await server.connect(new StdioServerTransport());
