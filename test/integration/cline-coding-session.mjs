import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ClineHostAdapter,
  ClineSessionDriver,
  LinuxBubblewrapContainment,
  TaskGraph,
  WorkflowApplication,
  WorkflowCodingSession,
  WorkflowContainedProcess,
  createWorkflowClinePlugin,
  createWorkflowClineShellExecutor,
  evidenceId,
  observationId,
  taskId,
} from "../../dist/index.js";

const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const coreUrl = pathToFileURL(join(npmRoot, "cline", "node_modules", "@cline", "core", "dist", "index.js"));
let core;
try {
  core = await import(coreUrl.href);
} catch (error) {
  throw new Error("test:cline-coding-session requires the Cline CLI with @cline/core installed globally", { cause: error });
}

const providerConfig = new core.ProviderSettingsManager().getLastUsedProviderConfig();
if (!providerConfig?.providerId || !providerConfig.modelId) {
  throw new Error("test:cline-coding-session requires a configured Cline model provider");
}

const directory = await mkdtemp(join(tmpdir(), "workflow-cline-coding-"));
const id = taskId("cline-coding-session");
const graph = new TaskGraph([{
  id,
  title: "Real Cline coding session",
  state: "BLOCKED",
  dependencies: [],
  requiredEvidence: [],
}]);
const adapter = new ClineHostAdapter({
  sessionId: "cline-coding-session",
  taskId: id,
  isMutatingTool: (toolName) => toolName === "run_commands",
  authoritativePreMutation: true,
});
const application = new WorkflowApplication(
  graph,
  adapter.capabilities,
  [],
  new Set(["read", "mutation", "process"]),
  directory,
);
assert.equal(application.transition(id, "IN_PROGRESS").kind, "accepted");
let sessionDriver;
const plugin = createWorkflowClinePlugin(application, adapter, (tool, reason, toolCallId) => sessionDriver?.recordToolDenial(tool, reason, toolCallId));
const toolCalls = [];
const hooks = {
  ...plugin.hooks,
  async beforeTool(input) {
    toolCalls.push(input.toolCall.toolName);
    return plugin.hooks.beforeTool(input);
  },
};
const containmentExecutions = [];
const containment = new LinuxBubblewrapContainment();
const shellExecutor = createWorkflowClineShellExecutor(
  new WorkflowContainedProcess(application, {
    async execute(request) {
      const result = await containment.execute(request);
      containmentExecutions.push({ request, result });
      return result;
    },
  }),
  adapter,
  (exitCode, output) => new core.CommandExitError(exitCode, output),
);

let cline;
try {
  await writeFile(join(directory, "README.md"), "# Fixture\n\nCreate the requested artifact.\n");
  await writeFile(join(directory, "answer.txt"), "Replace me.\n");
  await writeFile(join(directory, "editor.txt"), "Edit me.\n");
  await writeFile(join(directory, "patch.txt"), "Patch me.\n");
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["add", "README.md", "answer.txt", "editor.txt", "patch.txt"], { cwd: directory });
  execFileSync("git", ["-c", "user.name=Workflow Test", "-c", "user.email=workflow@example.invalid", "commit", "-qm", "fixture"], { cwd: directory });

  cline = await core.ClineCore.create({
    clientName: "workflow-w024-runtime-test",
    backendMode: "local",
    capabilities: { toolExecutors: { bash: shellExecutor } },
  });
  const sdkEditTools = core.createDefaultTools({
    executors: {
      editor: core.createEditorExecutor({ restrictToCwd: true }),
    },
    cwd: directory,
    enableReadFiles: false,
    enableSearch: false,
    enableBash: false,
    enableWebFetch: false,
    enableApplyPatch: false,
    enableEditor: true,
    enableSkills: false,
    enableAskQuestion: false,
  });
  const editorTool = sdkEditTools.find(({ name }) => name === "editor");
  const [applyPatchTool] = core.createDefaultTools({
    executors: { applyPatch: core.createApplyPatchExecutor({ restrictToCwd: true }) },
    cwd: directory,
    enableReadFiles: false,
    enableSearch: false,
    enableBash: false,
    enableWebFetch: false,
    enableApplyPatch: true,
    enableEditor: false,
    enableSkills: false,
    enableAskQuestion: false,
  });
  assert.ok(editorTool, "Cline public tool factory must expose editor when its executor is supplied");
  assert.equal(applyPatchTool?.name, "apply_patch", "Cline public tool factory must expose apply_patch when selected independently from editor");
  const mcpCalls = [];
  const [mcpLookupTool] = await core.createMcpTools({
    serverName: "fixture",
    nameTransform: ({ serverName, toolName }) => `mcp_${serverName}_${toolName}`,
    provider: {
      async listTools() {
        return [{ name: "lookup", description: "Return deterministic fixture data", inputSchema: { type: "object", properties: { query: { type: "string" } } } }];
      },
      async callTool(request) {
        mcpCalls.push(request);
        return { content: [{ type: "text", text: `fixture:${request.arguments?.query ?? ""}` }] };
      },
    },
  });
  assert.equal(mcpLookupTool?.name, "mcp_fixture_lookup");
  const sessionEvents = [];
  sessionDriver = new ClineSessionDriver({
    core: cline,
    hostAdapter: adapter,
    startInput: (prompt) => ({
    prompt,
    interactive: false,
    config: {
      providerId: providerConfig.providerId,
      modelId: providerConfig.modelId,
      providerConfig,
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      cwd: directory,
      workspaceRoot: directory,
      systemPrompt: core.getClineDefaultSystemPrompt({
        rootPath: directory,
        cwd: directory,
        ide: "Terminal Shell",
        platform: platform(),
        mode: "act",
        providerId: providerConfig.providerId,
      }),
      enableTools: true,
      enableSpawnAgent: false,
      enableAgentTeams: false,
    },
    localRuntime: { hooks, extraTools: [applyPatchTool] },
  }),
  });
  const codingSession = new WorkflowCodingSession(sessionDriver);
  codingSession.subscribe((event) => sessionEvents.push(event));
  await codingSession.submit([
      "Inspect README.md using read_files, then complete this tiny coding task.",
      "Change answer.txt so it contains exactly: Workflow governed this change.",
      "For the mutation and verification, use only run_commands; do not use editor or apply_patch.",
      "Immediately before submitting, you MUST invoke run_commands with the exact standalone verification command: git diff --check",
      "Your shell is already in the repository; do not prepend cd or combine that verification with any other command.",
      "Do not substitute another Git command or rely on an earlier command's output for verification.",
    ].join(" "));

  const sdkContext = { agentId: "workflow-tool-matrix", iteration: 1 };
  const editorInput = { path: "editor.txt", old_text: "Edit me.\n", new_text: "Editor parity works.\n" };
  assert.equal((await plugin.hooks.beforeTool({ toolCall: { toolName: "editor" }, input: editorInput })), undefined);
  assert.equal((await editorTool.execute(editorInput, sdkContext)).success, true);
  const patchInput = { input: "*** Begin Patch\n*** Update File: patch.txt\n@@\n-Patch me.\n+Patch parity works.\n*** End Patch" };
  assert.equal((await plugin.hooks.beforeTool({ toolCall: { toolName: "apply_patch" }, input: patchInput })), undefined);
  assert.equal((await applyPatchTool.execute(patchInput, { ...sdkContext, iteration: 2 })).success, true);
  const mcpInput = { query: "parity" };
  assert.equal((await plugin.hooks.beforeTool({ toolCall: { toolName: "mcp_fixture_lookup" }, input: mcpInput })), undefined);
  await mcpLookupTool.execute(mcpInput, { ...sdkContext, iteration: 3 });
  assert.equal(mcpCalls.length, 1);
  assert.equal(mcpCalls[0].toolName, "lookup");

  const isStandaloneVerification = ({ executable, args }) =>
    (executable === "/bin/bash" && args.length === 2 && args[0] === "-c" && args[1].trim() === "git diff --check")
    || (executable === "git" && args.length === 2 && args[0] === "diff" && args[1] === "--check");
  const verification = containmentExecutions.find(({ request }) => isStandaloneVerification(request));
  const diff = spawnSync("git", ["diff", "--", "answer.txt"], { cwd: directory, encoding: "utf8" });
  execFileSync("git", ["diff", "--check"], { cwd: directory });

  const deniedId = taskId("cline-coding-session-denied");
  const deniedAdapter = new ClineHostAdapter({
    sessionId: "cline-coding-session-denied",
    taskId: deniedId,
    isMutatingTool: (toolName) => toolName === "run_commands",
    authoritativePreMutation: true,
  });
  const deniedApplication = new WorkflowApplication(
    new TaskGraph([{ id: deniedId, title: "Denied Cline command", state: "BLOCKED", dependencies: [], requiredEvidence: [] }]),
    deniedAdapter.capabilities,
    [],
    new Set(["read", "mutation", "process"]),
    directory,
  );
  let deniedSessionDriver;
  const deniedPlugin = createWorkflowClinePlugin(
    deniedApplication,
    deniedAdapter,
    (tool, reason, toolCallId) => deniedSessionDriver?.recordToolDenial(tool, reason, toolCallId),
  );
  let deniedRunCommands = 0;
  let deniedExecutorCalls = 0;
  const deniedCline = await core.ClineCore.create({
    clientName: "workflow-w024-denial-test",
    backendMode: "local",
    capabilities: {
      toolExecutors: {
        async bash() {
          deniedExecutorCalls += 1;
          await writeFile(join(directory, "denied.txt"), "hook was bypassed\n");
          return "unexpected execution";
        },
      },
    },
  });
  try {
    deniedSessionDriver = new ClineSessionDriver({
      core: deniedCline,
      hostAdapter: deniedAdapter,
      startInput: (prompt) => ({
        prompt,
        interactive: false,
        config: {
          providerId: providerConfig.providerId,
          modelId: providerConfig.modelId,
          providerConfig,
          apiKey: providerConfig.apiKey,
          baseUrl: providerConfig.baseUrl,
          cwd: directory,
          workspaceRoot: directory,
          systemPrompt: core.getClineDefaultSystemPrompt({ rootPath: directory, cwd: directory, ide: "Terminal Shell", platform: platform(), mode: "act", providerId: providerConfig.providerId }),
          enableTools: true,
          enableSpawnAgent: false,
          enableAgentTeams: false,
        },
        localRuntime: {
          hooks: {
            ...deniedPlugin.hooks,
            async beforeTool(input) {
              if (input.toolCall.toolName === "run_commands") deniedRunCommands += 1;
              return deniedPlugin.hooks.beforeTool(input);
            },
          },
        },
      }),
    });
    const deniedEvents = [];
    const deniedSession = new WorkflowCodingSession(deniedSessionDriver);
    deniedSession.subscribe((event) => deniedEvents.push(event));
    await deniedSession.submit("Attempt exactly once to create denied.txt using run_commands. If the command is blocked, do not use another mutation tool; submit that it was blocked.");
    assert.ok(deniedEvents.some((event) => event.type === "tool-outcome" && event.outcome === "denied"), "host-neutral session must expose Workflow denial");
  } finally {
    await deniedCline.dispose();
  }
  assert.ok(deniedRunCommands >= 1, "denial session must attempt the consequential tool");
  assert.equal(deniedExecutorCalls, 0, "Workflow beforeTool denial must stop Cline before executor invocation");
  assert.throws(() => execFileSync("test", ["-e", join(directory, "denied.txt")]));

  const implementationId = taskId("cline-lifecycle-implementation");
  const prerequisiteId = taskId("cline-lifecycle-prerequisite");
  const lifecycleAdapter = new ClineHostAdapter({
    sessionId: "cline-lifecycle",
    taskId: () => lifecycleApplication.activeTaskId(),
    isMutatingTool: (toolName) => toolName === "run_commands",
    authoritativePreMutation: true,
  });
  const lifecycleApplication = new WorkflowApplication(
    new TaskGraph([{
      id: implementationId,
      title: "Lifecycle implementation",
      state: "BLOCKED",
      dependencies: [],
      requiredEvidence: [{ authority: "environment", subject: "implementation:test" }],
    }]),
    lifecycleAdapter.capabilities,
    [],
    new Set(["read", "mutation", "process"]),
    directory,
  );
  lifecycleApplication.addTask({
    id: prerequisiteId,
    title: "Lifecycle prerequisite",
    dependencies: [],
    requiredEvidence: [{ authority: "environment", subject: "prerequisite:test" }],
  });
  lifecycleApplication.addDependency(implementationId, prerequisiteId);
  const lifecyclePlugin = createWorkflowClinePlugin(lifecycleApplication, lifecycleAdapter);
  const lifecycleExecutions = [];
  const lifecycleShellExecutor = createWorkflowClineShellExecutor(
    new WorkflowContainedProcess(lifecycleApplication, {
      async execute(request) {
        const result = await containment.execute(request);
        lifecycleExecutions.push({ taskId: lifecycleApplication.activeTaskId(), request, result });
        return result;
      },
    }),
    lifecycleAdapter,
    (exitCode, output) => new core.CommandExitError(exitCode, output),
  );
  const lifecycleCline = await core.ClineCore.create({
    clientName: "workflow-w026-lifecycle-test",
    backendMode: "local",
    capabilities: { toolExecutors: { bash: lifecycleShellExecutor } },
  });
  const runLifecycleStep = async (prompt) => lifecycleCline.start({
    prompt,
    interactive: false,
    config: {
      providerId: providerConfig.providerId, modelId: providerConfig.modelId, providerConfig,
      apiKey: providerConfig.apiKey, baseUrl: providerConfig.baseUrl,
      cwd: directory, workspaceRoot: directory,
      systemPrompt: core.getClineDefaultSystemPrompt({ rootPath: directory, cwd: directory, ide: "Terminal Shell", platform: platform(), mode: "act", providerId: providerConfig.providerId }),
      enableTools: true, enableSpawnAgent: false, enableAgentTeams: false,
    },
    localRuntime: { hooks: lifecyclePlugin.hooks },
  });
  assert.throws(() => lifecycleApplication.selectActiveTask(implementationId), /BLOCKED/);

  try {
    assert.equal(lifecycleApplication.transition(prerequisiteId, "IN_PROGRESS").kind, "accepted");
    lifecycleApplication.selectActiveTask(prerequisiteId);
    const beforePrerequisite = lifecycleExecutions.length;
    await runLifecycleStep("Use run_commands exactly once with the command: test -f README.md . Then submit the result; do not use another tool.");
    const prerequisiteExecution = lifecycleExecutions.slice(beforePrerequisite).at(-1);
    assert.equal(prerequisiteExecution?.taskId, prerequisiteId);
    assert.equal(prerequisiteExecution?.result.exitCode, 0);
    lifecycleApplication.recordMutation(["prerequisite:test"]);
    assert.equal(lifecycleApplication.transition(prerequisiteId, "VERIFYING").kind, "accepted");
    assert.equal(lifecycleApplication.transition(prerequisiteId, "VERIFIED").kind, "rejected", "tool success alone cannot verify prerequisite");
    lifecycleApplication.recordEvidence({
      id: evidenceId("cline-prerequisite-evidence"), observationId: observationId("cline-prerequisite-observation"),
      authority: "environment", subject: "prerequisite:test", result: prerequisiteExecution.result.exitCode === 0 ? "passed" : "failed", freshness: "fresh",
      mutationEpoch: lifecycleApplication.snapshot().mutationEpoch, observedAt: new Date().toISOString(),
    });
    assert.equal(lifecycleApplication.transition(prerequisiteId, "VERIFIED").kind, "accepted");
    assert.equal(lifecycleApplication.snapshot().tasks.find(({ id }) => id === implementationId)?.state, "READY");

    assert.equal(lifecycleApplication.transition(implementationId, "IN_PROGRESS").kind, "accepted");
    lifecycleApplication.selectActiveTask(implementationId);
    const beforeImplementation = lifecycleExecutions.length;
    await runLifecycleStep("Use run_commands exactly once with the command: git diff --check . Then submit the result; do not use another tool.");
    const implementationExecution = lifecycleExecutions.slice(beforeImplementation).at(-1);
    assert.equal(implementationExecution?.taskId, implementationId);
    assert.equal(implementationExecution?.result.exitCode, 0);
    lifecycleApplication.recordMutation(["implementation:test"]);
    assert.equal(lifecycleApplication.transition(implementationId, "VERIFYING").kind, "accepted");
    assert.equal(lifecycleApplication.transition(implementationId, "VERIFIED").kind, "rejected", "tool success alone cannot verify implementation");
    lifecycleApplication.recordEvidence({
      id: evidenceId("cline-implementation-evidence"), observationId: observationId("cline-implementation-observation"),
      authority: "environment", subject: "implementation:test", result: implementationExecution.result.exitCode === 0 ? "passed" : "failed", freshness: "fresh",
      mutationEpoch: lifecycleApplication.snapshot().mutationEpoch, observedAt: new Date().toISOString(),
    });
    assert.equal(lifecycleApplication.transition(implementationId, "VERIFIED").kind, "accepted");
    assert.ok(lifecycleApplication.snapshot().tasks.every(({ state }) => state === "VERIFIED"));
  } finally {
    await lifecycleCline.dispose();
  }

  assert.equal(codingSession.snapshot().state, "completed");
  assert.ok(sessionEvents.some((event) => event.type === "assistant"), "host-neutral session must receive assistant activity");
  assert.ok(sessionEvents.some((event) => event.type === "tool-proposal"), "host-neutral session must receive tool proposals");
  assert.ok(sessionEvents.some((event) => event.type === "tool-outcome"), "host-neutral session must receive tool outcomes");
  assert.ok(toolCalls.includes("read_files"), `expected repository inspection, saw: ${toolCalls.join(", ")}`);
  assert.ok(toolCalls.includes("run_commands"), `expected mutation and verification command activity, saw: ${toolCalls.join(", ")}`);
  assert.ok(containmentExecutions.length >= 1, "Cline commands must execute through Workflow containment");
  assert.ok(verification, `Cline must run its requested verification through Workflow containment: ${JSON.stringify(containmentExecutions.map(({ request }) => [request.executable, ...request.args]))}`);
  assert.equal(containmentExecutions.at(-1), verification, "standalone verification must be Cline's final contained command");
  assert.equal(verification.result.exitCode, 0, verification.result.stderr);
  assert.ok(containmentExecutions.every(({ request }) => request.cwd === directory));
  assert.match(await readFile(join(directory, "answer.txt"), "utf8"), /^Workflow governed this change\.\n?$/);
  assert.match(await readFile(join(directory, "editor.txt"), "utf8"), /^Editor parity works\.\n?$/);
  assert.match(await readFile(join(directory, "patch.txt"), "utf8"), /^Patch parity works\.\n?$/);
  assert.equal(diff.status, 0, diff.stderr);
  assert.match(diff.stdout, /Workflow governed this change\./);
} finally {
  await cline?.dispose();
  await rm(directory, { recursive: true, force: true });
}
