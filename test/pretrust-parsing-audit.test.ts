import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * W051 pre-trust parsing audit — ordering regression tests.
 *
 * Read detection: each poisoned project-local fixture is created as a
 * *directory* where a file is expected. `existsSync` on it is true, but any
 * attempt to open-and-read it (`readFileSync`, `readSync`) throws EISDIR, so a
 * helper that reintroduces a pre-trust read fails the test loudly instead of
 * passing silently. `assertCanary` proves a trap is armed before the helpers
 * run.
 *
 * Honest scope: this catches reads performed by the covered helpers. A read
 * swallowed by try/catch, an ACP tool-call read (post-trust by construction),
 * or startup work inside a spawned agent subprocess is not detectable this
 * way; `docs/PRETRUST_PARSING_AUDIT.md` lists the uncovered inventory rows and
 * records acceptance criterion 3 as PARTIAL.
 */

function assertCanary(path: string): void {
  assert.throws(() => readFileSync(path, "utf8"), { code: "EISDIR" }, `canary ${path} is not armed`);
}

test("startup inventory reads no poisoned project-local configuration or instructions", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "w051-poisoned-workspace-"));
  const toolboxRoot = mkdtempSync(join(tmpdir(), "w051-toolbox-root-"));
  const skillsRoot = mkdtempSync(join(tmpdir(), "w051-skills-root-"));
  const operatorRoot = mkdtempSync(join(tmpdir(), "w051-operator-root-"));
  t.after(() => {
    for (const dir of [workspace, toolboxRoot, skillsRoot, operatorRoot]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Poisoned project-local fixtures, each a directory canary (see above).
  const poison = [
    join(workspace, ".claude-settings.json"),
    join(workspace, "AGENTS.md"),
    join(workspace, "SKILL.md"),
    join(workspace, ".claude", "settings.json"),
    join(workspace, "skills", "SKILL.md"),
    join(workspace, "skills", "levels.json"),
  ];
  for (const path of poison) mkdirSync(path, { recursive: true });
  for (const path of poison) assertCanary(path);

  // A real toolbox root so discovery enumeration actually runs; it must stay
  // inside the configured toolbox root and never wander into the workspace.
  mkdirSync(join(toolboxRoot, "apps", "known-mcp", "dist"), { recursive: true });
  writeFileSync(join(toolboxRoot, "apps", "known-mcp", "dist", "server.js"), "// built\n");
  // A built skills server so mount resolution checks existence only (no content).
  mkdirSync(join(skillsRoot, "mcp-toolbox", "apps", "skills-mcp", "dist"), { recursive: true });
  writeFileSync(join(skillsRoot, "mcp-toolbox", "apps", "skills-mcp", "dist", "server.js"), "// built\n");
  // The operator-owned MCP settings file lives outside the workspace.
  const operatorSettings = join(operatorRoot, "mcp.json");
  writeFileSync(operatorSettings, JSON.stringify({ mcpServers: { custom: { type: "stdio", command: "x", args: [] } } }));

  const { resolveTuiWorkspace } = await import("../src/cli/tui-args.js");
  const { resolveDriverName, parseUniversalArgs } = await import("../src/cli/driver-registry.js");
  const { meteredOpencodeConfig } = await import("../src/integrations/opencode-agent-config.js");
  const { collectToolboxMcpServers, readUserMcpSettings } = await import("../src/cli/mcp-settings.js");
  const { resolveSkillsMountFor } = await import("../src/integrations/acp-runtime.js");

  assert.equal(resolveTuiWorkspace(["--cwd", workspace], "/tmp"), workspace);
  assert.equal(resolveDriverName("acp"), "acp");
  assert.deepEqual(parseUniversalArgs(["--driver", "acp", "--opencode-url", "http://127.0.0.1:4096"]), {
    driver: "acp",
    opencodeUrl: "http://127.0.0.1:4096",
  });
  assert.deepEqual(meteredOpencodeConfig({ proxyUrl: "http://127.0.0.1:61000" }).mcp, undefined);
  assert.deepEqual(Object.keys(collectToolboxMcpServers(toolboxRoot)), ["known"]);
  assert.deepEqual(readUserMcpSettings(operatorSettings), {
    mcpServers: { custom: { type: "stdio", command: "x", args: [] } },
  });
  assert.equal(
    resolveSkillsMountFor({ root: skillsRoot, home: workspace, envSkillsDir: join(workspace, "skills") })?.skillsDir,
    join(workspace, "skills"),
  );
});

test("startup levels.json is parsed only through the explicit gating resolver, fail-closed", async (t) => {
  const skillsDir = mkdtempSync(join(tmpdir(), "w051-levels-"));
  t.after(() => rmSync(skillsDir, { recursive: true, force: true }));
  const { resolveSkillsLevelMap } = await import("../src/pedagogy/skill-gating.js");
  const levelsPath = join(skillsDir, "levels.json");

  writeFileSync(levelsPath, JSON.stringify({ "learn-to-code": { unlocked: ["a"], required: ["a"] } }));
  assert.deepEqual(resolveSkillsLevelMap(skillsDir, skillsDir), {
    "learn-to-code": { unlocked: ["a"], required: ["a"] },
  });

  rmSync(levelsPath);
  assert.equal(resolveSkillsLevelMap(skillsDir, skillsDir), undefined);

  writeFileSync(levelsPath, "{ not JSON\n");
  assert.throws(() => resolveSkillsLevelMap(skillsDir, skillsDir), /invalid levels\.json/);
});

test("composing the skills mount does not read skill content", async (t) => {
  const skillsDir = mkdtempSync(join(tmpdir(), "w051-skill-content-"));
  t.after(() => rmSync(skillsDir, { recursive: true, force: true }));
  mkdirSync(join(skillsDir, "known"), { recursive: true });
  const skillFile = join(skillsDir, "known", "SKILL.md");
  mkdirSync(skillFile);
  assertCanary(skillFile);

  const { meteredOpencodeConfig } = await import("../src/integrations/opencode-agent-config.js");

  const config = meteredOpencodeConfig({
    proxyUrl: "http://127.0.0.1:61001",
    skills: { serverScript: "/toolbox/skills-mcp/dist/server.js", skillsDir },
  });
  const mount = (config.mcp as Record<string, Record<string, unknown>>)["skills-mcp"];
  assert.ok(mount);
  assert.deepEqual(mount.environment, { SKILLS_MCP_DIR: skillsDir });
});