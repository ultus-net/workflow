import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId } from "../src/kernel/contracts.js";
import { createConfiguredAcpRuntime, resolveSkillsMount } from "../src/integrations/acp-runtime.js";

/**
 * Plan Task F1 delivery proof on the lead-agent runtime: the hub composes the
 * skills-mcp mount into the per-runtime config AND the containment binds the
 * server's runtime dependencies (dist siblings, node_modules, the skills
 * directory), so the contained agent's spawned server actually starts and
 * delivers. The uncontained MCP-mount probe already proved the config
 * surface is honored; this probe proves the fully composed production path —
 * it calls createConfiguredAcpRuntime, the same factory the hub uses.
 *
 * Gated: WORKFLOW_ACP_OPENCODE_SKILLS=1 plus the upstream key for the
 * metering proxy (CLINE_API_KEY env or ~/.config/workflow/cline-api-key) and
 * an operator skills directory (SKILLS_MCP_DIR, default ~/.agents/skills).
 * Skips with a clear precondition failure when no skills mount composes.
 */
const runProbe = process.env.WORKFLOW_ACP_OPENCODE_SKILLS === "1";

test(
  "OpenCode lead runtime delivers skills from the hub-owned mount under containment",
  { skip: !runProbe, timeout: 300_000 },
  async () => {
    const skillsMount = resolveSkillsMount();
    if (skillsMount === undefined) {
      throw new Error("no skills mount composed: build skills-mcp and provide a skills directory (SKILLS_MCP_DIR, default ~/.agents/skills)");
    }
    const workspace = await mkdtemp(path.join(tmpdir(), "wf-opencode-skills-ws-"));
    try {
      await writeFile(path.join(workspace, "README.md"), "# skills delivery probe\n", "utf8");
      const graph = new TaskGraph([{
        id: taskId("skills-delivery"),
        title: "Skills delivery probe",
        state: "READY",
        dependencies: [],
        requiredEvidence: [],
      }]);
      const application = new WorkflowApplication(
        graph,
        hostCapabilities({ transport: "native", authoritativePreMutation: true }),
        [],
        new Set(["read", "mutation", "process"]),
        workspace,
      );
      application.startInteractiveTask();
      const runtime = await createConfiguredAcpRuntime(application, workspace, taskId("skills-delivery"));
      const events: string[] = [];
      runtime.session.subscribe((event) => {
        if (event.type === "tool" || event.type === "status") events.push(JSON.stringify(event).slice(0, 240));
      });
      try {
        await runtime.session.submit(
          "Call the MCP tool list_skills and reply with exactly the number of skills it lists, as a bare integer. " +
          "If no such tool exists, reply exactly: NO_MCP_TOOLS",
        );
        const snapshot = runtime.session.snapshot();
        console.log(JSON.stringify({
          skillsDir: skillsMount.skillsDir,
          turn: snapshot,
          toolEvents: events,
        }, null, 2));
        assert.equal(snapshot.state, "completed", "the delivery turn must complete");
        assert.notEqual(snapshot.result, "NO_MCP_TOOLS", "the skills-mcp mount must be visible to the contained agent");
        const count = Number.parseInt((snapshot.result ?? "").replace(/[^\d]/g, ""), 10);
        assert.ok(Number.isInteger(count) && count > 0, `list_skills must report the real skills count (reply: ${JSON.stringify(snapshot.result)})`);
      } finally {
        await runtime.dispose();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
);