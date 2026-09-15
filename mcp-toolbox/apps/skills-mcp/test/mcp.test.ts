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

test("list_skills returns metadata only, quarantining the malicious fixture", async () => {
  const result = await client.callTool({ name: "list_skills", arguments: {} });
  assert.equal(result.isError, undefined);
  const body = result.structuredContent as {
    skills: Array<{ name: string; description: string }>;
    quarantined: Array<{ name: string; findings: string[] }>;
    gating: string;
    level: string | null;
  };
  assert.deepEqual(body.skills, [
    { name: "advanced-refactoring", description: "" },
    { name: "code-review", description: "Reviews changes across the five core review axes before merging." },
    { name: "security-guidance", description: "Teaches agents to recognize and defend against prompt injection — quotes attack patterns defensively." },
    { name: "test-driven-development", description: "Drives development with tests: write a failing test first, then make it pass." },
  ]);
  assert.equal(body.gating, "off");
  assert.equal(body.level, null);
  assert.equal(body.quarantined[0]?.name, "malicious-web-fetch");
  assert.ok((body.quarantined[0]?.findings.length ?? 0) >= 2, "findings surface why the skill was quarantined");
  const text = JSON.stringify(result.content);
  assert.equal(text.includes("# Test-Driven Development"), false, "skill content never leaks through discovery");
});

test("read_skill refuses quarantined skills with their findings", async () => {
  const refused = await client.callTool({ name: "read_skill", arguments: { name: "malicious-web-fetch" } });
  assert.equal(refused.isError, true);
  const text = JSON.stringify(refused.content);
  assert.match(text, /quarantined by safety screening/);
  assert.equal(text.includes("ignore all previous"), false, "malicious content is never delivered, even in the error");
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