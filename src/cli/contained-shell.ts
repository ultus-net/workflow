#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { ClineHostAdapter } from "../adapters/cline.js";
import { WorkflowApplication } from "../application/workflow.js";
import { LinuxBubblewrapContainment } from "../containment/linux-bwrap.js";
import { WorkflowContainedProcess } from "../containment/workflow-process.js";
import { createDefaultToolboxGuardProvider } from "../integrations/mcp-toolbox-guard.js";
import { evidenceId, observationId, taskId } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";

const workspace = await mkdtemp(join(tmpdir(), "workflow-interactive-"));
const guard = await createDefaultToolboxGuardProvider().catch((error) => {
  console.error(`Workflow guard unavailable (advisory): ${error instanceof Error ? error.message : error}`);
  return undefined;
});
const input = createInterface({ input: process.stdin, output: process.stdout });

try {
  console.log(`Writable workspace: ${workspace}`);
  console.log("Network: isolated | Credentials: cleared");
  const containment = new LinuxBubblewrapContainment();
  let commandNumber = 0;
  input.setPrompt("Workflow> ");
  input.prompt();
  for await (const command of input) {
    if (command.trim() === "exit" || command.trim() === "quit") break;
    if (command.trim().length === 0) {
      input.prompt();
      continue;
    }
    commandNumber += 1;
    const id = taskId(`interactive-contained-command-${commandNumber}`);
    const adapter = new ClineHostAdapter({
      sessionId: "interactive-session",
      taskId: id,
      isMutatingTool: () => true,
      authoritativePreMutation: true,
    });
    const application = new WorkflowApplication(
      new TaskGraph([{
        id,
        title: `Interactive contained command ${commandNumber}`,
        state: "BLOCKED",
        dependencies: [],
        requiredEvidence: [{ authority: "environment", subject: "command" }],
      }]),
      adapter.capabilities,
      [],
      new Set(["read", "mutation", "process"]),
    );
    application.transition(id, "IN_PROGRESS");
    const proposal = adapter.proposalFromBeforeTool({
      tool: { name: "execute_command" },
      input: { executable: "/bin/sh", args: ["-c", command] },
    });
    const decision = application.authorize(proposal);
    if (decision.kind === "deny") {
      console.log(`Policy: DENY (${decision.code}: ${decision.reason})`);
      application.transition(id, "FAILED");
      console.log("Task: FAILED");
      input.prompt();
      continue;
    }
    console.log("Policy: ALLOW");
    if (typeof proposal.input !== "object" || proposal.input === null) throw new TypeError("invalid process proposal input");
    const { executable, args } = proposal.input as Record<string, unknown>;
    if (typeof executable !== "string" || !Array.isArray(args) || !args.every((argument) => typeof argument === "string")) {
      throw new TypeError("invalid process proposal command");
    }

    const execution = await new WorkflowContainedProcess(application, containment, guard)
      .execute(proposal, { executable, args, writablePaths: [workspace] });
    console.log(`Containment: ${execution.enforcement.toUpperCase()}`);
    if (execution.stdout.length > 0) process.stdout.write(execution.stdout);
    if (execution.stderr.length > 0) process.stderr.write(execution.stderr);
    if (execution.exitCode !== 0) {
      application.recordMutation(["command"]);
      application.transition(id, "FAILED");
      console.log(`Task: FAILED (exit ${execution.exitCode ?? "unknown"})`);
      input.prompt();
      continue;
    }

    application.recordMutation(["command"]);
    application.transition(id, "VERIFYING");
    application.recordEvidence({
      id: evidenceId(`interactive-command-evidence-${commandNumber}`),
      observationId: observationId(`interactive-command-observation-${commandNumber}`),
      authority: "environment",
      subject: "command",
      result: "passed",
      freshness: "fresh",
      mutationEpoch: application.snapshot().mutationEpoch,
      observedAt: new Date().toISOString(),
    });
    const verified = application.transition(id, "VERIFIED");
    if (verified.kind !== "accepted") throw new Error(`verification failed: ${verified.reason}`);
    console.log("Task: VERIFIED");
    input.prompt();
  }
} finally {
  await guard?.close();
  input.close();
  await rm(workspace, { recursive: true, force: true });
}
