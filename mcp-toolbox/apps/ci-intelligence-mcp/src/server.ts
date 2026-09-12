#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { GitHubActionsAdapter } from "./github-actions-adapter.js";

const repository = process.env.CI_GITHUB_REPOSITORY;
if (!repository) throw new Error("CI_GITHUB_REPOSITORY is required");
const adapter = new GitHubActionsAdapter({
  repository,
  ...(process.env.CI_GITHUB_TOKEN ? { token: process.env.CI_GITHUB_TOKEN } : {}),
  ...(process.env.CI_GITHUB_API_URL ? { apiUrl: process.env.CI_GITHUB_API_URL } : {}),
});
const server = new McpServer({ name: "ci-intelligence-mcp", version: "0.1.0" });
const conclusion = z.enum(["success", "failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "unknown"]);

server.registerTool(
  "list_ci_runs",
  {
    description: "Return bounded read-only GitHub Actions run evidence for the configured repository.",
    inputSchema: {
      branch: z.string().min(1).max(255).optional(),
      revision: z.string().regex(/^[0-9a-fA-F]{40}$/u, "revision must be a full commit SHA").optional(),
      limit: z.number().int().positive().max(100).default(20),
    },
    outputSchema: {
      runs: z.array(z.object({
        id: z.string(), workflowName: z.string(), revision: z.string(), branch: z.string().optional(),
        state: z.enum(["queued", "in_progress", "completed"]), conclusion: conclusion.optional(), providerConclusion: z.string().optional(),
        startedAt: z.string().optional(), updatedAt: z.string(), webUrl: z.string().optional(),
      })),
      truncated: z.boolean(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  async (input, extra) => {
    const result = await adapter.listRuns(input, extra.signal);
    const structuredContent = { runs: [...result.runs], truncated: result.truncated };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "list_ci_jobs",
  {
    description: "Return bounded read-only GitHub Actions job evidence for one run in the configured repository.",
    inputSchema: {
      runId: z.string().regex(/^github:[1-9]\d*$/u, "runId must be a provider-qualified GitHub run ID"),
      limit: z.number().int().positive().max(100).default(20),
    },
    outputSchema: {
      jobs: z.array(z.object({
        id: z.string(), runId: z.string(), name: z.string(), revision: z.string(),
        state: z.enum(["queued", "in_progress", "completed"]), conclusion: conclusion.optional(), providerConclusion: z.string().optional(),
        startedAt: z.string(), completedAt: z.string().optional(), webUrl: z.string().optional(),
      })),
      truncated: z.boolean(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  async (input, extra) => {
    const result = await adapter.listJobs(input.runId, input.limit, extra.signal);
    const structuredContent = { jobs: [...result.jobs], truncated: result.truncated };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

await server.connect(new StdioServerTransport());
