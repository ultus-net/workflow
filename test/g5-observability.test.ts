import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../src/kernel/contracts.js";
import { createRunRegistry } from "../src/integrations/run-registry.js";
import { advisoryGuidanceFromEnv, buildAdvisoryGuidance, buildOrientation, hubPromptGuidanceFromEnv } from "../src/integrations/prompt-guidance.js";

/**
 * Plan Task G5: completion-claims journal (observability-only port of the
 * plugin's Policy 24) and advisory prompt guidance (the honest replacement
 * for tool.definition/system.transform steering).
 */

const tasks: WorkflowTask[] = [{ id: taskId("W1"), title: "interactive", state: "READY", dependencies: [], requiredEvidence: [] }];

function registry() {
  const graph = new TaskGraph(tasks.map((task) => ({ ...task })));
  const application = new WorkflowApplication(
    graph,
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set(["read", "mutation", "process"]),
    process.cwd(),
  );
  return { application, registry: createRunRegistry(application, graph) };
}

test("completion claims journal the claim with kernel verification state, observability-only", async () => {
  const { application, registry: runs } = registry();
  await runs.controller.begin({ runId: "claim-1", title: "Author run" });

  runs.recordCompletionClaim({ runId: "claim-1", claim: "All tests pass and the feature is complete." });
  const beforeVerify = runs.completionClaims().get("claim-1");
  assert.equal(beforeVerify?.verifiedAtClaim, false, "the claim arrived before verification — mismatch journaled, not blocked");
  const runTask = application.snapshot().tasks.find((task) => task.title === "Author run");
  assert.equal(runTask?.state, "IN_PROGRESS", "journaling a claim never advances or blocks the task");

  await runs.controller.finish({ runId: "claim-1", outcome: "verified" });
  runs.recordCompletionClaim({ runId: "claim-1", claim: "Verified." });
  assert.equal(runs.completionClaims().get("claim-1")?.verifiedAtClaim, true, "the last journal entry reflects the verified state");

  // Unknown runs journal with verifiedAtClaim=false rather than throwing:
  // the journal is observability, not authorization.
  runs.recordCompletionClaim({ runId: "ghost-run", claim: "claims about a run that never was" });
  assert.equal(runs.completionClaims().get("ghost-run")?.verifiedAtClaim, false);

  // A claim is never evidence.
  assert.equal(application.snapshot().evidence.some((evidence) => evidence.subject.includes("claim")), false);
});

test("buildAdvisoryGuidance composes optional advisory blocks and stays silent when empty", () => {
  assert.equal(buildAdvisoryGuidance({}), undefined);
  assert.equal(buildAdvisoryGuidance({ styleNote: "   " }), undefined);
  const guidance = buildAdvisoryGuidance({
    styleNote: "terse caveman",
    workflowNotes: ["keep the task list current", "prefer tests"],
  })!;
  assert.match(guidance, /Response style \(advisory\): terse caveman/);
  assert.match(guidance, /advisory — the Workflow hub enforces its rules independently of this text/);
  assert.match(guidance, /- keep the task list current/);
  assert.ok(guidance.endsWith("\n\n"), "guidance is a preamble — it ends with separation for the real prompt");
});

test("advisoryGuidanceFromEnv composes operator guidance and stays silent when unset or blank", () => {
  assert.equal(advisoryGuidanceFromEnv({}), undefined, "no env means no guidance");
  assert.equal(advisoryGuidanceFromEnv({ WORKFLOW_ADVISORY_STYLE: "   " }), undefined, "blank style is silence, not an empty block");
  assert.equal(advisoryGuidanceFromEnv({ WORKFLOW_ADVISORY_NOTES: " \n \n" }), undefined, "blank note lines are dropped rather than turned into guidance");

  const styled = advisoryGuidanceFromEnv({ WORKFLOW_ADVISORY_STYLE: "terse caveman" })!;
  assert.match(styled, /Response style \(advisory\): terse caveman/);
  assert.ok(!/Operating notes/.test(styled), "no notes env means no notes block");

  const noted = advisoryGuidanceFromEnv({ WORKFLOW_ADVISORY_NOTES: "keep the task list current\n\nprefer tests" })!;
  assert.match(noted, /- keep the task list current/);
  assert.match(noted, /- prefer tests/, "blank lines between notes are dropped, real notes survive");
  assert.ok(!/Response style/.test(noted));

  const both = advisoryGuidanceFromEnv({
    WORKFLOW_ADVISORY_STYLE: "terse",
    WORKFLOW_ADVISORY_NOTES: "prefer tests",
  })!;
  assert.match(both, /Response style \(advisory\): terse/);
  assert.match(both, /Operating notes \(advisory/);
  assert.ok(both.endsWith("\n\n"), "env guidance composes to the same preamble shape");
});

test("W075: the hub orientation is static, versioned, and interpolates nothing", () => {
  // Frozen-shape pins: the block is a constant template — the version is
  // embedded (the run registry's prompt digest binds exactly what the agent
  // saw), and no task/repo/env value can ever enter it because there is no
  // input path for one.
  const block = buildOrientation();
  assert.match(block, /<hub-orientation source="workflow-hub" version="1">/);
  assert.match(block, /guard_next_tasks before planning/);
  assert.match(block, /workflow-toolbox skill/);
  assert.match(block, /advisory and never a security boundary/);
  assert.ok(block.endsWith("\n"), "the orientation is a preamble — it ends with separation");
  assert.ok(!/\$\{/.test(block), "no template placeholders: static by construction");
  assert.equal(buildOrientation(), block, "two compositions are byte-identical");
  assert.equal(buildOrientation({ skillName: "custom-tools" }).includes("custom-tools skill"), true, "the only input is the static skill name");
});

test("W075: hub prompt guidance composes orientation first, advisory second, honors the opt-out", () => {
  // Default: orientation present.
  const def = hubPromptGuidanceFromEnv({});
  assert.match(def!, /<hub-orientation source="workflow-hub" version="1">/);
  assert.ok(!/Response style/.test(def!), "no advisory env means no advisory block");

  // Opt-out: WORKFLOW_HUB_ORIENTATION=0 removes the block entirely.
  assert.equal(hubPromptGuidanceFromEnv({ WORKFLOW_HUB_ORIENTATION: "0" }), undefined, "opted out with no advisory env = silence");

  // Orientation first, operator advisory after — one preamble, stable order.
  const both = hubPromptGuidanceFromEnv({ WORKFLOW_ADVISORY_STYLE: "terse" })!;
  const orientationEnd = both.indexOf("</hub-orientation>");
  const advisoryStart = both.indexOf("Response style (advisory)");
  assert.ok(orientationEnd !== -1 && advisoryStart !== -1 && orientationEnd < advisoryStart, "orientation leads, advisory follows");

  // Opt-out with advisory env keeps the advisory behavior unchanged.
  const opted = hubPromptGuidanceFromEnv({ WORKFLOW_HUB_ORIENTATION: "0", WORKFLOW_ADVISORY_STYLE: "terse" })!;
  assert.match(opted, /Response style \(advisory\): terse/);
  assert.ok(!/hub-orientation/.test(opted), "the opt-out removes the orientation, not the advisory text");
});
