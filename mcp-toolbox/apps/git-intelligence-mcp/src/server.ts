#!/usr/bin/env node
import { isAbsolute } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { GitStatusAdapter } from "./git-status-adapter.js";
import { GitDiffAdapter } from "./git-diff-adapter.js";
import { GitHistoryAdapter } from "./git-history-adapter.js";

const server = new McpServer({ name: "git-intelligence-mcp", version: "0.1.0" });
const adapter = new GitStatusAdapter();
const diffAdapter = new GitDiffAdapter();
const historyAdapter = new GitHistoryAdapter();
const changeState = z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed", "unmerged", "untracked", "none"]);

server.registerTool(
  "working_tree_status",
  {
    description: "Return bounded structured local Git working-tree status.",
    inputSchema: {
      workspaceRoot: z.string().min(1).refine(isAbsolute, "workspaceRoot must be absolute"),
      limit: z.number().int().positive().max(500).default(100),
    },
    outputSchema: {
      entries: z.array(z.object({
        path: z.string(), originalPath: z.string().optional(), staged: changeState, unstaged: changeState,
        conflict: z.enum(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]).optional(),
      })),
      truncated: z.boolean(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (input, extra) => {
    const result = await adapter.workingTreeStatus(input, extra.signal);
    const structuredContent = { entries: [...result.entries], truncated: result.truncated };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "local_diff",
  {
    description: "Return bounded structured local Git changes for either the index or working tree.",
    inputSchema: {
      workspaceRoot: z.string().min(1).refine(isAbsolute, "workspaceRoot must be absolute"),
      scope: z.enum(["staged", "unstaged"]),
      limit: z.number().int().positive().max(500).default(100),
    },
    outputSchema: {
      files: z.array(z.object({
        path: z.string(), originalPath: z.string().optional(), change: z.enum(["added", "modified", "deleted", "renamed", "copied", "type_changed", "unmerged"]),
        binary: z.boolean(), additions: z.number().int().optional(), deletions: z.number().int().optional(), patch: z.string().optional(), patchTruncated: z.boolean(),
      })),
      truncated: z.boolean(), evidenceTruncated: z.boolean(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (input, extra) => {
    const result = await diffAdapter.diff(input, extra.signal);
    const structuredContent = { files: [...result.files], truncated: result.truncated, evidenceTruncated: result.evidenceTruncated };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "file_history",
  {
    description: "Return bounded local commit history for one confined workspace-relative file.",
    inputSchema: {
      workspaceRoot: z.string().min(1).refine(isAbsolute, "workspaceRoot must be absolute"),
      path: z.string().min(1),
      limit: z.number().int().positive().max(200).default(50),
    },
    outputSchema: {
      commits: z.array(z.object({
        commit: z.string(), authorName: z.string(), authorEmail: z.string(), authorTime: z.string(), path: z.string(), originalPath: z.string().optional(),
        subject: z.string(), body: z.string(), messageTruncated: z.boolean(),
      })),
      truncated: z.boolean(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (input, extra) => {
    const result = await historyAdapter.fileHistory(input, extra.signal);
    const structuredContent = { commits: [...result.commits], truncated: result.truncated };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "file_blame",
  {
    description: "Return bounded committed HEAD line provenance for one confined workspace-relative file.",
    inputSchema: {
      workspaceRoot: z.string().min(1).refine(isAbsolute, "workspaceRoot must be absolute"),
      path: z.string().min(1),
      limit: z.number().int().positive().max(1000).default(200),
    },
    outputSchema: {
      lines: z.array(z.object({
        commit: z.string(), authorName: z.string(), authorEmail: z.string(), authorTime: z.string(), path: z.string(),
        originalLine: z.number().int().positive(), finalLine: z.number().int().positive(),
      })),
      truncated: z.boolean(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (input, extra) => {
    const result = await historyAdapter.fileBlame(input, extra.signal);
    const structuredContent = { lines: [...result.lines], truncated: result.truncated };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

await server.connect(new StdioServerTransport());
