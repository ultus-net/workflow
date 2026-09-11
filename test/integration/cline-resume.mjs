import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ClineHostAdapter,
  ClineSessionDriver,
  JsonWorkflowStore,
  TaskGraph,
  WorkflowApplication,
  evidenceId,
  observationId,
  taskId,
} from "../../dist/index.js";

const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const core = await import(pathToFileURL(join(npmRoot, "cline", "node_modules", "@cline", "core", "dist", "index.js")).href);
const providerConfig = new core.ProviderSettingsManager().getLastUsedProviderConfig();
if (!providerConfig?.providerId || !providerConfig.modelId) throw new Error("test:cline-resume requires a configured Cline model provider");

const directory = await mkdtemp(join(tmpdir(), "workflow-cline-resume-"));
const store = new JsonWorkflowStore(join(directory, "workflow.json"));
const prerequisite = taskId("resume-prerequisite");
const implementation = taskId("resume-implementation");
const host = { transport: "native", enforcementLevel: "authoritative" };
let cline;

function evidence(id, subject, epoch) {
  return {
    id: evidenceId(id), observationId: observationId(`${id}-observation`), authority: "environment",
    subject, result: "passed", freshness: "fresh", mutationEpoch: epoch, observedAt: new Date().toISOString(),
  };
}

function startInput(prompt, initialMessages) {
  return {
    prompt, initialMessages, interactive: false,
    config: {
      providerId: providerConfig.providerId, modelId: providerConfig.modelId, providerConfig,
      apiKey: providerConfig.apiKey, baseUrl: providerConfig.baseUrl,
      cwd: directory, workspaceRoot: directory,
      systemPrompt: core.getClineDefaultSystemPrompt({ rootPath: directory, cwd: directory, ide: "Terminal Shell", platform: platform(), mode: "act", providerId: providerConfig.providerId }),
      enableTools: false, enableSpawnAgent: false, enableAgentTeams: false,
    },
  };
}

try {
  await writeFile(join(directory, "observed.txt"), "restart observation\n");
  let application = new WorkflowApplication(new TaskGraph([
    { id: prerequisite, title: "Prerequisite", state: "BLOCKED", dependencies: [], requiredEvidence: [{ authority: "environment", subject: "prerequisite" }] },
    { id: implementation, title: "Implementation", state: "BLOCKED", dependencies: [prerequisite], requiredEvidence: [{ authority: "environment", subject: "implementation" }] },
  ]), host, [], new Set(["read", "mutation"]), directory);
  assert.equal(application.transition(prerequisite, "IN_PROGRESS").kind, "accepted");
  assert.equal(application.transition(prerequisite, "VERIFYING").kind, "accepted");
  application.recordEvidence(evidence("pre-restart", "prerequisite", application.snapshot().mutationEpoch));
  assert.equal(application.transition(prerequisite, "VERIFIED").kind, "accepted");
  assert.equal(application.transition(implementation, "IN_PROGRESS").kind, "accepted");
  application.selectActiveTask(implementation);

  cline = await core.ClineCore.create({ clientName: "workflow-w029-resume-before", backendMode: "local" });
  const beforeDriver = new ClineSessionDriver({
    core: cline,
    hostAdapter: new ClineHostAdapter({ sessionId: "resume", taskId: implementation, isMutatingTool: () => false, authoritativePreMutation: true }),
    startInput,
    onSessionId: (sessionId) => application.setCodingSessionCorrelation(sessionId),
  });
  await beforeDriver.start("Remember the exact marker WORKFLOW-RESUME-29 for the next turn. Reply briefly.", () => undefined);
  assert.ok(application.codingSessionCorrelation);
  await store.create(application);
  await cline.dispose();
  cline = undefined;

  ({ application } = await store.load(host));
  assert.equal(application.snapshot().tasks.find((task) => task.id === prerequisite)?.state, "VERIFIED");
  assert.equal(application.snapshot().tasks.find((task) => task.id === implementation)?.state, "FAILED");
  assert.equal(application.retryFailedTask(implementation).kind, "accepted");
  assert.equal(application.authorize({ sessionId: "resume", taskId: implementation, tool: "write_file", mutating: true, subjects: ["observed.txt"], input: {} }).kind, "deny");
  assert.equal(application.transition(implementation, "IN_PROGRESS").kind, "accepted");
  application.selectActiveTask(implementation);

  cline = await core.ClineCore.create({ clientName: "workflow-w029-resume-after", backendMode: "local" });
  let historyReads = 0;
  let restoredMessages;
  const resumedCore = {
    start: (input) => cline.start(input), subscribe: (listener) => cline.subscribe(listener), stop: (sessionId) => cline.stop(sessionId),
    async readMessages(sessionId) { historyReads += 1; restoredMessages = await cline.readMessages(sessionId); return restoredMessages; },
  };
  const resumedEvents = [];
  const resumeDriver = new ClineSessionDriver({
    core: resumedCore,
    resumeSessionId: application.codingSessionCorrelation,
    hostAdapter: new ClineHostAdapter({ sessionId: "resume", taskId: implementation, isMutatingTool: () => false, authoritativePreMutation: true }),
    startInput,
    onSessionId: (sessionId) => application.setCodingSessionCorrelation(sessionId),
  });
  await resumeDriver.start("State the marker I asked you to remember, then stop.", (event) => resumedEvents.push(event));
  assert.equal(historyReads, 1, "resume must obtain conversation state from the SDK-native history store");
  assert.match(JSON.stringify(restoredMessages), /WORKFLOW-RESUME-29/, "SDK-native history must contain the pre-restart marker");
  const completed = resumedEvents.find((event) => event.type === "completed");
  assert.ok(completed);
  assert.match(completed.result, /WORKFLOW-RESUME-29/,
    "resumed model turn must recover conversation content from SDK-native history");

  const postRestartObservation = (await readFile(join(directory, "observed.txt"), "utf8")).trim();
  assert.equal(postRestartObservation, "restart observation");
  assert.equal(application.transition(implementation, "VERIFYING").kind, "accepted");
  application.recordEvidence({
    ...evidence("post-restart", "implementation", application.snapshot().mutationEpoch),
    result: postRestartObservation === "restart observation" ? "passed" : "failed",
  });
  assert.equal(application.transition(implementation, "VERIFIED").kind, "accepted");
  assert.ok(application.snapshot().tasks.every((task) => task.state === "VERIFIED"));
} finally {
  await cline?.dispose();
  await rm(directory, { recursive: true, force: true });
}
