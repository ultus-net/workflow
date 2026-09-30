#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { hostCapabilities, type ProposedToolAction } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { selectContainment } from "../containment/platform.js";
import { WorkflowContainedProcess } from "../containment/workflow-process.js";
import { createDefaultToolboxGuardProvider } from "../integrations/mcp-toolbox-guard.js";
import { evidenceId, observationId, taskId } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { PermissionBroker } from "../ui/permission-broker.js";
import { createPermissionAnswerServer } from "../ui/permission-broker-route.js";

// W129: the help contract — resolve help and exit before the shell's tmp
// workspace or guard composition.
if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
  console.log("workflow-shell — the interactive contained-shell smoke (one command per prompt)");
  console.log("  stdin: commands until exit/quit; the workspace/network/credential boundaries are stated at boot");
  console.log("  a guard `ask` parks on this process's broker and is answered at the boot-stated loopback route");
  console.log("  --help  print this help");
  process.exit(0);
}

const workspace = await mkdtemp(join(tmpdir(), "workflow-interactive-"));
const guard = await createDefaultToolboxGuardProvider().catch((error) => {
  console.error(`Workflow guard unavailable (advisory): ${error instanceof Error ? error.message : error}`);
  return undefined;
});
const permissionBroker = new PermissionBroker();
const input = createInterface({ input: process.stdin, output: process.stdout });
let permissionAnswers: Awaited<ReturnType<typeof createPermissionAnswerServer>> | undefined;

try {
  // P6 (issue #285): the standalone seat composes a SAME-PROCESS broker and
  // serves its ONE pending/answer transport on a dedicated loopback route. A
  // guard `ask` raised by the containment seat below parks on
  // `permissionBroker.askHold()` and is answerable here — not the 120s
  // park-then-deny. This is deliberately NOT the hub bridge: the standalone
  // smoke exposes ONLY the permission path, never the hub's `/bash` or run
  // mutation routes. No cross-process plumbing is invented.
  permissionAnswers = await createPermissionAnswerServer(permissionBroker);
  const hold = permissionBroker.askHold();
  console.log(`Writable workspace: ${workspace}`);
  console.log("Network: isolated | Credentials: cleared");
  console.log(`Permission answers: POST ${permissionAnswers.url}/api/permission (Authorization: Bearer ${permissionAnswers.token})`);
  const containment = selectContainment();
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
    const capabilities = hostCapabilities({ transport: "native", authoritativePreMutation: true });
    const application = new WorkflowApplication(
      new TaskGraph([{
        id,
        title: `Interactive contained command ${commandNumber}`,
        state: "BLOCKED",
        dependencies: [],
        requiredEvidence: [{ authority: "environment", subject: "command" }],
      }]),
      capabilities,
      [],
      new Set(["read", "mutation", "process"]),
    );
    // W157: deliberately UNATTRIBUTED — this is the e2e verification runner's
    // scratch graph, not an operator- or agent-owned lane; absence is legal
    // by contract and the timeline renders the explicit unattributed state.
    application.transition(id, "IN_PROGRESS");
    const proposal: ProposedToolAction = {
      sessionId: "interactive-session",
      taskId: id,
      tool: "execute_command",
      capability: "process",
      requiredCapabilities: ["process"],
      mutating: true,
      subjects: [],
      input: { executable: "/bin/sh", args: ["-c", command] },
    };
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

    let execution: Awaited<ReturnType<WorkflowContainedProcess["execute"]>>;
    try {
      execution = await new WorkflowContainedProcess(application, containment, guard, hold)
        .execute(proposal, { executable, args, writablePaths: [workspace] });
    } catch (error) {
      // W132 (the compiled-bin sweep's finding): a failure INSIDE execute —
      // the guard seat's denial, the second authorization seat's denial, or
      // a containment failure — used to escape the unguarded per-command
      // loop and terminate the persistent session, violating W022's
      // recorded contract ("a denied command does not terminate the
      // persistent session"). The label is deliberately NEUTRAL
      // ("execution refused"): the round-3 review's P2 — the throw classes
      // are distinguishable by their message prefixes, and a bwrap-less
      // operator must not read a false seat attribution. The denial is
      // fail-closed (it fires BEFORE any spawn: nothing executed, nothing
      // mutated), so the honest report is the per-command FAILED the
      // nonzero lane already prints, and the session survives.
      console.log(`Task: FAILED (execution refused: ${error instanceof Error ? error.message : String(error)})`);
      application.transition(id, "FAILED");
      input.prompt();
      continue;
    }
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
  if (permissionAnswers !== undefined) await permissionAnswers.close();
  await rm(workspace, { recursive: true, force: true });
}
