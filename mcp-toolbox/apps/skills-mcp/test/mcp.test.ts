import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixtureSkillsDir } from "./fixtures.js";

// The compiled server reads SKILLS_MCP_DIR/SKILLS_MCP_LEVEL from the
// environment. The SDK's stdio transport forwards only a limited default
// env, so the fixture directory must be passed explicitly.
let client: Client;

before(async () => {
  client = new Client({ name: "skills-mcp-black-box-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: { ...process.env, SKILLS_MCP_DIR: fixtureSkillsDir },
  }));
});

after(async () => client.close());

test("exposes exactly list_skills and read_skill with honest output schemas", async () => {
  assert.deepEqual(client.getServerVersion(), { name: "skills-mcp", version: "0.1.0" });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["list_skills", "read_skill"]);
  assert.ok(tools.every((tool) => tool.outputSchema));
  assert.deepEqual(tools.find((tool) => tool.name === "list_skills")?.annotations, {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
});

test("list_skills returns metadata only with gating explicitly off", async () => {
  const result = await client.callTool({ name: "list_skills", arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    skills: [
      { name: "advanced-refactoring", description: "" },
      { name: "code-review", description: "Reviews changes across the five core review axes before merging." },
      { name: "test-driven-development", description: "Drives development with tests: write a failing test first, then make it pass." },
    ],
    gating: "off",
    level: null,
  });
  const text = JSON.stringify(result.content);
  assert.equal(text.includes("# Test-Driven Development"), false, "skill content never leaks through discovery");
});

test("read_skill is the only delivery path and rejects traversal-shaped names", async () => {
  const delivered = await client.callTool({ name: "read_skill", arguments: { name: "test-driven-development" } });
  assert.equal(delivered.isError, undefined);
  const content = (delivered.structuredContent as { content: string }).content;
  assert.match(content, /# Test-Driven Development/);
  assert.match(content, /Write a failing test before/);

  const denied = await client.callTool({ name: "read_skill", arguments: { name: "../fixtures/skills/test-driven-development" } });
  assert.equal(denied.isError, true);
});