#!/usr/bin/env node
import { isAbsolute } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { TypeScriptLanguageService } from "./typescript-language-service.js";

const locationSchema = {
  file: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
};

const server = new McpServer({ name: "code-intelligence-mcp", version: "0.1.0" });
const languageService = new TypeScriptLanguageService();
const workspaceRootSchema = z.string().min(1).refine(isAbsolute, "workspaceRoot must be absolute");
const fileSchema = z.string().min(1).refine(
  (file) => !isAbsolute(file) && !file.split(/[\\/]/).includes(".."),
  "file must be a workspace-relative path without parent traversal",
);
const limitSchema = z.number().int().positive().max(500).default(100);
const symbolSchema = { name: z.string(), kind: z.string(), ...locationSchema };
const diagnosticSchema = {
  severity: z.enum(["error", "warning", "information", "hint"]),
  code: z.number().int(),
  message: z.string(),
  ...locationSchema,
};

server.registerTool(
  "diagnostics",
  {
    description: "Return bounded normalized syntactic and semantic diagnostics for a TypeScript document.",
    inputSchema: { workspaceRoot: workspaceRootSchema, file: fileSchema, limit: limitSchema },
    outputSchema: { diagnostics: z.array(z.object(diagnosticSchema)), truncated: z.boolean() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async (input, extra) => {
    const result = await languageService.diagnostics(input, extra.signal);
    const structuredContent = { diagnostics: [...result.diagnostics], truncated: result.truncated };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "document_symbols",
  {
    description: "List bounded semantic declarations in source order for a TypeScript document.",
    inputSchema: { workspaceRoot: workspaceRootSchema, file: fileSchema, limit: limitSchema },
    outputSchema: { symbols: z.array(z.object(symbolSchema)), truncated: z.boolean() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async (input, extra) => {
    const result = await languageService.documentSymbols(input, extra.signal);
    const structuredContent = { symbols: [...result.symbols], truncated: result.truncated };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "workspace_symbols",
  {
    description: "Search bounded semantic declarations across a TypeScript workspace.",
    inputSchema: {
      workspaceRoot: workspaceRootSchema,
      query: z.string().trim().min(1),
      limit: limitSchema,
    },
    outputSchema: { symbols: z.array(z.object(symbolSchema)), truncated: z.boolean() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async (input, extra) => {
    const result = await languageService.workspaceSymbols(input, extra.signal);
    const structuredContent = { symbols: [...result.symbols], truncated: result.truncated };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

server.registerTool(
  "find_definition",
  {
    description: "Find exact semantic definitions at a 1-based source position in a TypeScript project.",
    inputSchema: {
      workspaceRoot: workspaceRootSchema,
      file: fileSchema,
      line: z.number().int().positive(),
      column: z.number().int().positive(),
    },
    outputSchema: { locations: z.array(z.object(locationSchema)) },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async (input, extra) => {
    const locations = await languageService.findDefinition(input, extra.signal);
    const structuredContent = { locations: [...locations] };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  },
);

server.registerTool(
  "find_references",
  {
    description: "Find bounded semantic references at a 1-based source position in a TypeScript project.",
    inputSchema: {
      workspaceRoot: workspaceRootSchema,
      file: fileSchema,
      line: z.number().int().positive(),
      column: z.number().int().positive(),
      limit: limitSchema,
    },
    outputSchema: { locations: z.array(z.object(locationSchema)), truncated: z.boolean() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async (input, extra) => {
    const result = await languageService.findReferences(input, extra.signal);
    const structuredContent = { locations: [...result.locations], truncated: result.truncated };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  },
);

await server.connect(new StdioServerTransport());
