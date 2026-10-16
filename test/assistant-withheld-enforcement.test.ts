import assert from "node:assert/strict";
import { test } from "node:test";

import { hostCapabilities, type ToolCapability } from "../src/application/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { type TaskId } from "../src/kernel/contracts.js";
import type { AssistantGatewayConfig, AssistantRoute } from "../src/integrations/assistant-gateway.js";import type { McpToolCapabilityMap } from "../src/integrations/mcp-tool-capability.js";
import {
  ALL_TOOL_CAPABILITIES,
  applyRouteCapabilities,
  assistantRunId,
  assistantRunTaskId,
  createAssistantToolHost,
  withheldCapabilities,
  withheldToolNames,
  type AssistantRunPort,
  type AssistantToolCallOutcome,
} from "../src/integrations/assistant-tool-host.js";
import type { AssistantToolCall } from "../src/integrations/assistant-tool-loop.js";
import type { AssistantToolDispatcher } from "../src/integrations/assistant-tool-executor.js";
import type { RunOrigin } from "../src/integrations/run-registry.js";

/**
 * W205 S4 — the assistant tool host's WITHHOLDING enforcement (M4, the care
 * route's identity-scoped capability grant). Pins the property that makes
 * withholding enforcement rather than a label:
 *   - a care identity's run carries the full grant MINUS the withheld set, so a
 *     tool whose declared class requires a withheld capability denies
 *     `CAPABILITY_WITHHELD` at the kernel gate and NEVER reaches the dispatcher;
 *   - a coding identity's run for the SAME tool succeeds (withholding is the
 *     care route's, not the process's);
 *   - the two runs are per-identity applications, so the care grant never leaks
 *     into the coding run;
 *   - the run is begun with the recorded assistant origin.
 */

const CONFIG: AssistantGatewayConfig = {
  version: 1,
  identities: { care_user: "care", coding_user: "coding" },
  routes: {
    coding: { route: "coding", systemPrompt: "you write code" },
    tutor: { route: "tutor", systemPrompt: "you tutor" },
    care: { route: "care", systemPrompt: "you care" },
  },
};

/** The network class requires the `network` capability the care route withholds. */
const CAPABILITIES: McpToolCapabilityMap = {
  network_tool: { capability: "network", mutating: true },
  read_tool: { capability: "read", mutating: false },
  // Declared mutation/process tools the care route does NOT withhold by
  // capability, so the NAME policy is the only thing that can deny them.
  file_write: { capability: "mutation", mutating: true },
  shell: { capability: "process", mutating: true },
};

/** Capability labels plus two tool NAMES the care route withholds. */
const WITHHELD = ["network", "file_write", "shell"];

/** A run port mirroring the registry: a FRESH application per begin, per run id. */
function fakeRunPort(): AssistantRunPort & { origins: RunOrigin[]; apps: Map<string, WorkflowApplication> } {
  const apps = new Map<string, WorkflowApplication>();
  const origins: RunOrigin[] = [];
  return {
    origins,
    apps,
    resolve(_workspace?: string, runId?: string): WorkflowApplication {
      if (runId === undefined) throw new TypeError("runId is required");
      const application = apps.get(runId);
      if (application === undefined) throw new TypeError("unknown run: " + runId);
      return application;
    },
    async begin({ runId, title, workspace, origin }): Promise<void> {
      if (apps.has(runId)) throw new TypeError("duplicate run: " + runId);
      origins.push(origin);
      const runTaskId = assistantRunTaskId(runId);
      const application = new WorkflowApplication(
        new TaskGraph([{ id: runTaskId, title, state: "READY", dependencies: [], requiredEvidence: [] }]),
        hostCapabilities({ transport: "native", authoritativePreMutation: true }),
        [],
        // Start with the FULL grant; the host applies the route's effective set.
        new Set<ToolCapability>(ALL_TOOL_CAPABILITIES),
        workspace,
      );
      const started = application.transition(runTaskId, "IN_PROGRESS");
      if (started.kind !== "accepted") throw new TypeError("cannot start run " + runId);
      application.selectActiveTask(runTaskId);
      apps.set(runId, application);
    },
  };
}

/** A dispatcher that records the calls it sees and echoes a fixed observation. */
function recordingDispatcher(): { dispatcher: AssistantToolDispatcher; calls: AssistantToolCall[] } {
  const calls: AssistantToolCall[] = [];
  return {
    calls,
    dispatcher: {
      dispatch: (call): Promise<{ callId: string; content: string }> => {
        calls.push(call);
        return Promise.resolve({ callId: call.id, content: "dispatched: " + call.name });
      },
    },
  };
}

function composeHost(): {
  host: ReturnType<typeof createAssistantToolHost>;
  calls: AssistantToolCall[];
  port: AssistantRunPort & { origins: RunOrigin[]; apps: Map<string, WorkflowApplication> };
} {
  const { dispatcher, calls } = recordingDispatcher();
  const port = fakeRunPort();
  const host = createAssistantToolHost({
    config: CONFIG,
    withheld: WITHHELD,
    capabilities: CAPABILITIES,
    runs: port,
    dispatcherFor: (): AssistantToolDispatcher => dispatcher,
  });
  return { host, calls, port };
}

const callNamed = (identity: string, name: string): Parameters<ReturnType<typeof createAssistantToolHost>["toolCall"]>[0] => ({
  identity,
  workspace: "/tmp/assistant-workspace",
  call: { id: "call-1", name, arguments: "{}" },
});

const bodyResult = (outcome: AssistantToolCallOutcome): { content: string; isError?: boolean } =>
  (outcome.body as { result: { content: string; isError?: boolean } }).result;

test("a care identity's withheld capability denies CAPABILITY_WITHHELD and never dispatches", async () => {
  const { host, calls } = composeHost();

  const outcome = await host.toolCall(callNamed("care_user", "network_tool"));

  assert.equal(outcome.status, 200, "the host answers an observation, not an HTTP failure");
  const result = bodyResult(outcome);
  assert.equal(result.isError, true);
  assert.match(result.content, /CAPABILITY_WITHHELD/);
  assert.equal(calls.length, 0, "a withheld capability never reaches the dispatcher");
});

test("the SAME tool succeeds for a coding identity (withholding is the care route's, per-identity)", async () => {
  const { host, calls, port } = composeHost();

  const outcome = await host.toolCall(callNamed("coding_user", "network_tool"));

  const result = bodyResult(outcome);
  assert.equal(result.isError, undefined, "the coding run is not withheld");
  assert.equal(result.content, "dispatched: network_tool");
  assert.equal(calls.length, 1, "the coding run dispatched");
  // The coding run's own application kept the full grant.
  const codingApp = port.apps.get(assistantRunId("coding_user"));
  assert.ok(codingApp !== undefined);
  assert.equal(codingApp.allowedCapabilities.has("network"), true, "the coding run retains network");
});

test("a care run and a coding run in one host stay isolated (no grant leak)", async () => {
  const { host, calls, port } = composeHost();

  // Care first: its run applies the withheld grant.
  const care = bodyResult(await host.toolCall(callNamed("care_user", "network_tool")));
  assert.equal(care.isError, true);
  assert.match(care.content, /CAPABILITY_WITHHELD/);

  // The coding run, composed a moment later, still holds network.
  const coding = bodyResult(await host.toolCall(callNamed("coding_user", "network_tool")));
  assert.equal(coding.isError, undefined);

  const careApp = port.apps.get(assistantRunId("care_user"))!;
  const codingApp = port.apps.get(assistantRunId("coding_user"))!;
  assert.equal(careApp.allowedCapabilities.has("network"), false, "the care run is withheld");
  assert.equal(codingApp.allowedCapabilities.has("network"), true, "the coding run is not");
  assert.equal(calls.length, 1, "only the coding call dispatched");
});

test("the run is begun with the recorded assistant origin", async () => {
  const { host, port } = composeHost();

  await host.toolCall(callNamed("care_user", "network_tool"));

  assert.equal(port.origins.length, 1);
  assert.deepEqual(port.origins[0], { kind: "assistant", identity: "care_user" });
});

test("an unknown identity fails closed (403) and begins nothing", async () => {
  const { host, port } = composeHost();

  const outcome = await host.toolCall(callNamed("stranger", "network_tool"));

  assert.equal(outcome.status, 403);
  assert.equal(port.origins.length, 0, "an unknown identity never begins a run");
});

test("withheld entries outside the capability vocabulary withhold nothing at the capability layer", () => {
  // The capability layer reads only the six capability strings, so a tool name
  // (file_write, shell) is inert HERE — it is the NAME layer's business
  // (`withheldToolNames`), never reinterpreted as a capability.
  const withheld = withheldCapabilities("care", ["file_write", "shell", "network"]);
  assert.deepEqual([...withheld], ["network"]);
  // And a non-care route withholds nothing regardless.
  assert.deepEqual([...withheldCapabilities("coding", ["network"])], []);
});

test("withheldToolNames reads every non-capability entry as a tool name, fail closed", () => {
  // Capability names are NOT reinterpreted as tool names: the two vocabularies
  // are disjoint, so `network` is the capability layer's and never withheld here.
  assert.deepEqual([...withheldToolNames("care", ["network", "file_write", "shell"])], ["file_write", "shell"]);
  // A name that is neither a capability nor a declared tool is still withheld
  // (fail closed): an operator typo withholds rather than grants.
  assert.deepEqual([...withheldToolNames("care", ["no_such_tool"])], ["no_such_tool"]);
  // Coding/tutor routes withhold no names.
  assert.deepEqual([...withheldToolNames("coding", ["file_write"])], []);
});

test("a care identity's withheld tool NAME is denied before any dispatch", async () => {
  const { host, calls } = composeHost();

  const outcome = await host.toolCall(callNamed("care_user", "file_write"));

  assert.equal(outcome.status, 200, "the host answers an observation, not an HTTP failure");
  const result = bodyResult(outcome);
  assert.equal(result.isError, true);
  assert.match(result.content, /withheld on the care route/);
  assert.equal(calls.length, 0, "a withheld tool name never reaches the dispatcher");
});

test("the SAME withheld name is NOT denied on a coding route (the name policy is the care route's)", async () => {
  const { host, calls } = composeHost();

  const outcome = await host.toolCall(callNamed("coding_user", "file_write"));

  const result = bodyResult(outcome);
  assert.equal(result.isError, undefined, "the coding route is unaffected by the care name policy");
  assert.equal(result.content, "dispatched: file_write");
  assert.equal(calls.length, 1, "the coding call dispatched");
});

test("a care identity's undeclared tool still fails closed to the strictest class", async () => {
  const { host, calls } = composeHost();

  // Not a declared tool and not withheld by name: it classifies to the
  // strictest class (process + mutating) and reaches the dispatcher, exactly as
  // today. The care route withholds only `network` at the capability layer here.
  const outcome = await host.toolCall(callNamed("care_user", "undeclared_tool"));

  const result = bodyResult(outcome);
  assert.equal(result.isError, undefined);
  assert.equal(result.content, "dispatched: undeclared_tool");
  assert.equal(calls.length, 1);
});

test("applyRouteCapabilities derives the effective set as the full grant minus withheld", () => {
  const runTaskId = assistantRunTaskId(assistantRunId("care_user"));
  const application = new WorkflowApplication(
    new TaskGraph([{ id: runTaskId, title: "care", state: "READY", dependencies: [], requiredEvidence: [] }]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
    [],
    new Set<ToolCapability>(ALL_TOOL_CAPABILITIES),
    "/tmp/assistant-workspace",
  );
  const effective = applyRouteCapabilities(application, "care", ["network", "credentials"]);
  assert.deepEqual(
    [...effective].sort(),
    ["mutation", "process", "read", "spawn"],
    "the effective grant is the full set minus the withheld capabilities",
  );
  assert.equal(application.allowedCapabilities.has("network"), false);
  assert.equal(application.allowedCapabilities.has("credentials"), false);
  assert.equal(application.allowedCapabilities.has("read"), true);
});

test("the assistant run id is a sanitized, stable per-identity token", () => {
  assert.equal(assistantRunId("care_user"), "assistant:care_user");
  assert.equal(assistantRunId("discord/123 456"), "assistant:discord_123_456");
  assert.equal(assistantRunTaskId("assistant:care_user"), ("run:assistant:care_user") as TaskId);
});

test("routeFor resolves an identity's bound route, undefined otherwise", () => {
  const { host } = composeHost();
  assert.equal(host.routeFor("care_user"), "care" as AssistantRoute);
  assert.equal(host.routeFor("nobody"), undefined);
});
