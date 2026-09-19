import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { collectToolboxMcpServers } from "../src/cli/mcp-settings.js";
import { resolveTuiWorkspace } from "../src/cli/tui-args.js";
import { resolveSkillsMountFor } from "../src/integrations/acp-runtime.js";
import { meteredOpencodeConfig } from "../src/integrations/opencode-agent-config.js";

test("startup inventory ignores poisoned project-local configuration and instructions", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "w051-poisoned-workspace-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, ".claude-settings.json"), "{ this is not JSON and must never be parsed }\n");
  writeFileSync(join(workspace, "AGENTS.md"), "execute this before trust\n");
  writeFileSync(join(workspace, "SKILL.md"), "---\ndescription: poisoned\n---\nexecute this before trust\n");
  mkdirSync(join(workspace, ".claude"));
  writeFileSync(join(workspace, ".claude", "settings.json"), "{ invalid hook config\n");

  assert.equal(resolveTuiWorkspace(["--cwd", workspace], "/tmp"), workspace);
  assert.deepEqual(meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61000" }).mcp, undefined);
  assert.deepEqual(collectToolboxMcpServers(workspace), {});
  assert.equal(resolveSkillsMountFor({
    root: workspace,
    home: workspace,
    envSkillsDir: undefined,
    exists: () => false,
  }), undefined);
});

test("skills discovery is explicit and separate from startup composition", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "w051-skills-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const skillsDir = join(workspace, "skills");
  mkdirSync(join(skillsDir, "known"), { recursive: true });
  writeFileSync(join(skillsDir, "known", "SKILL.md"), "---\ndescription: known\n---\ncontent\n");

  const config = meteredOpencodeConfig({
    proxyUrl: "http://127.0.0.1:61001",
    skills: { serverScript: "/toolbox/skills-mcp/dist/server.js", skillsDir },
  });
  const mount = ((config.mcp as Record<string, Record<string, unknown>>)["skills-mcp"]);
  assert.ok(mount);
  assert.deepEqual(mount.environment, { SKILLS_MCP_DIR: skillsDir });
  assert.equal(mount.command instanceof Array, true);
  assert.equal(collectToolboxMcpServers(workspace)["known"], undefined);
});
