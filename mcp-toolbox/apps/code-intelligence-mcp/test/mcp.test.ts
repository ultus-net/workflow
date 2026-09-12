import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectCompiledStdioClient } from "../../../packages/test-support/mcp-client.ts";

let client: Client;

before(async () => {
  client = await connectCompiledStdioClient("code-intelligence-black-box-test");
});

after(async () => client.close());

test("discovers find_definition with a structured output schema", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["diagnostics", "document_symbols", "find_definition", "find_references", "workspace_symbols"]);
  assert.ok(tools.every((tool) => tool.outputSchema));
});

test("finds a definition through the compiled stdio MCP server", async () => {
  const result = await client.callTool({
    name: "find_definition",
    arguments: {
      workspaceRoot: resolve("test/fixtures/typescript-project"),
      file: "src/main.ts",
      line: 3,
      column: 23,
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    locations: [{ file: "src/math.ts", line: 1, column: 17, endLine: 1, endColumn: 23 }],
  });
});

test("returns bounded normalized diagnostics through the compiled stdio MCP server", async () => {
  const result = await client.callTool({
    name: "diagnostics",
    arguments: {
      workspaceRoot: resolve("test/fixtures/typescript-project"),
      file: "src/main.ts",
      limit: 1,
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    diagnostics: [{
      severity: "error",
      code: 2322,
      message: "Type 'number' is not assignable to type 'string'.",
      file: "src/main.ts",
      line: 5,
      column: 14,
      endLine: 5,
      endColumn: 21,
    }],
    truncated: true,
  });
});

test("applies the public diagnostic limit policy", async () => {
  const arguments_ = {
    workspaceRoot: resolve("test/fixtures/typescript-project"),
    file: "src/main.ts",
  };
  const defaulted = await client.callTool({ name: "diagnostics", arguments: arguments_ });
  const structured = defaulted.structuredContent as { diagnostics: unknown[]; truncated: boolean };
  assert.equal(structured.diagnostics.length, 2);
  assert.equal(structured.truncated, false);

  for (const limit of [0, -1, 501]) {
    const result = await client.callTool({ name: "diagnostics", arguments: { ...arguments_, limit } });
    assert.equal(result.isError, true);
  }
});

test("finds bounded references through the compiled stdio MCP server", async () => {
  const result = await client.callTool({
    name: "find_references",
    arguments: {
      workspaceRoot: resolve("test/fixtures/typescript-project"),
      file: "src/math.ts",
      line: 1,
      column: 17,
      limit: 2,
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    locations: [
      { file: "src/main.ts", line: 1, column: 10, endLine: 1, endColumn: 16 },
      { file: "src/main.ts", line: 3, column: 23, endLine: 3, endColumn: 29 },
    ],
    truncated: true,
  });
});

test("applies the public reference limit policy", async () => {
  const arguments_ = {
    workspaceRoot: resolve("test/fixtures/typescript-project"),
    file: "src/math.ts",
    line: 1,
    column: 17,
  };
  const defaulted = await client.callTool({ name: "find_references", arguments: arguments_ });
  assert.deepEqual(defaulted.structuredContent, {
    locations: [
      { file: "src/main.ts", line: 1, column: 10, endLine: 1, endColumn: 16 },
      { file: "src/main.ts", line: 3, column: 23, endLine: 3, endColumn: 29 },
      { file: "src/math.ts", line: 1, column: 17, endLine: 1, endColumn: 23 },
      { file: "src/math.ts", line: 12, column: 10, endLine: 12, endColumn: 16 },
    ],
    truncated: false,
  });

  for (const limit of [0, -1, 501]) {
    const result = await client.callTool({ name: "find_references", arguments: { ...arguments_, limit } });
    assert.equal(result.isError, true);
  }
});

test("returns bounded document symbols through MCP", async () => {
  const result = await client.callTool({
    name: "document_symbols",
    arguments: {
      workspaceRoot: resolve("test/fixtures/typescript-project"),
      file: "src/math.ts",
      limit: 2,
    },
  });

  assert.equal(result.isError, undefined);
  const structured = result.structuredContent as { symbols: unknown[]; truncated: boolean };
  assert.equal(structured.symbols.length, 2);
  assert.equal(structured.truncated, true);
});

test("searches bounded workspace symbols through MCP", async () => {
  const result = await client.callTool({
    name: "workspace_symbols",
    arguments: {
      workspaceRoot: resolve("test/fixtures/typescript-project"),
      query: "Calc",
      limit: 10,
    },
  });

  assert.equal(result.isError, undefined);
  const structured = result.structuredContent as { symbols: Array<{ name: string }>; truncated: boolean };
  assert.deepEqual(structured.symbols.map((symbol) => symbol.name), ["Calculator", "calculate"]);
  assert.equal(structured.truncated, false);
});

test("rejects invalid coordinates at the MCP boundary", async () => {
  const result = await client.callTool({
    name: "find_definition",
    arguments: { workspaceRoot: resolve("."), file: "src/main.ts", line: 0, column: 1 },
  });
  assert.equal(result.isError, true);
});

test("rejects path shapes that violate the public MCP contract", async () => {
  for (const arguments_ of [
    { workspaceRoot: ".", file: "src/main.ts", line: 1, column: 1 },
    { workspaceRoot: resolve("."), file: resolve("src/main.ts"), line: 1, column: 1 },
    { workspaceRoot: resolve("."), file: "../outside.ts", line: 1, column: 1 },
  ]) {
    const result = await client.callTool({ name: "find_definition", arguments: arguments_ });
    assert.equal(result.isError, true);
  }
});
