import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { hostCapabilities, type ToolCapability } from "../src/application/host.js";
import { WorkflowApplication } from "../src/application/workflow.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import type { AssistantGatewayConfig } from "../src/integrations/assistant-gateway.js";
import type { AssistantToolCall } from "../src/integrations/assistant-tool-loop.js";
import type { AssistantToolDispatcher } from "../src/integrations/assistant-tool-executor.js";
import {
  ALL_TOOL_CAPABILITIES,
  assistantRunTaskId,
  createAssistantToolHost,
  type AssistantRunPort,
} from "../src/integrations/assistant-tool-host.js";
import { createHubAssistantToolExecutor } from "../src/integrations/assistant-tool-hub-client.js";
import {
  createAssistantMcpDispatcher,
  parseAssistantMcpToolServerMap,
  resolveAssistantMcpServers,
  type AssistantMcpConnection,
} from "../src/integrations/assistant-mcp-dispatcher.js";
import type { WorkflowSettings } from "../src/integrations/workflow-settings.js";

/**
 * W205 S5 — the split authority/dispatch (topology Option B). Pins:
 *   - the hub answers a call it does NOT own the seat for with a DISPATCH
 *     DIRECTIVE, but only AFTER it has authorized (a denial stays terminal);
 *   - the daemon's forwarding executor fulfills a directive against its own
 *     dispatcher, and fails closed when no dispatcher is composed;
 *   - the daemon MCP dispatcher holds no authority: an undeclared tool fails
 *     closed before any connection, and a declared one runs the tool.
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

function fakeRunPort(): AssistantRunPort {
  const apps = new Map<string, WorkflowApplication>();
  return {
    resolve(_workspace?: string, runId?: string): WorkflowApplication {
      const application = runId === undefined ? undefined : apps.get(runId);
      if (application === undefined) throw new TypeError("unknown run");
      return application;
    },
    async begin({ runId, title, workspace }): Promise<void> {
      if (apps.has(runId)) throw new TypeError("duplicate run: " + runId);
      const runTaskId = assistantRunTaskId(runId);
      const application = new WorkflowApplication(
        new TaskGraph([{ id: runTaskId, title, state: "READY", dependencies: [], requiredEvidence: [] }]),
        hostCapabilities({ transport: "native", authoritativePreMutation: true }),
        [],
        new Set<ToolCapability>(ALL_TOOL_CAPABILITIES),
        workspace,
      );
      const started = application.transition(runTaskId, "IN_PROGRESS");
      if (started.kind !== "accepted") throw new TypeError("cannot start run");
      application.selectActiveTask(runTaskId);
      apps.set(runId, application);
    },
  };
}

/** A host whose only owned seat is `run_shell`; every other tool is delegated. */
function composeHost(options: { readonly dispatcher?: AssistantToolDispatcher } = {}): {
  host: ReturnType<typeof createAssistantToolHost>;
  delegated: AssistantToolCall[];
} {
  const delegated: AssistantToolCall[] = [];
  const host = createAssistantToolHost({
    config: CONFIG,
    withheld: ["network"],
    capabilities: {
      record_learning_evidence: { capability: "mutation", mutating: true },
      network_tool: { capability: "network", mutating: true },
    },
    runs: fakeRunPort(),
    dispatcherFor: ({ toolName }) =>
      toolName !== "run_shell"
        ? undefined
        : {
            dispatch: async (call) => {
              options.dispatcher?.dispatch(call, { identity: "x", route: "coding", iteration: 0 }, { capability: "process", mutating: true });
              return { callId: call.id, content: "ran: " + call.name };
            },
          },
  });
  return { host, delegated };
}

const toolCall = (identity: string, name: string): Parameters<ReturnType<typeof createAssistantToolHost>["toolCall"]>[0] => ({
  identity,
  workspace: "/tmp/assistant-workspace",
  call: { id: "call-1", name, arguments: "{}" },
});

interface ResultBody {
  readonly result: { readonly content: string; readonly isError?: boolean };
}
interface DispatchBody {
  readonly dispatch: { readonly call: AssistantToolCall; readonly capability: string; readonly mutating: boolean };
}

test("the hub answers a non-owned tool with a dispatch directive AFTER authorizing", async () => {
  const { host } = composeHost();
  const outcome = await host.toolCall(toolCall("coding_user", "record_learning_evidence"));
  assert.equal(outcome.status, 200);
  const body = outcome.body as DispatchBody;
  assert.ok(body.dispatch !== undefined, "the hub hands back a directive, not an observation");
  assert.equal(body.dispatch.call.name, "record_learning_evidence");
  assert.equal(body.dispatch.capability, "mutation");
  assert.equal(body.dispatch.mutating, true, "the directive carries the classified tool class");
});

test("the hub still denies (terminal observation) a delegated tool the route withholds", async () => {
  const { host } = composeHost();
  // `network` is withheld on the care route; `deep_research` classifies strictest
  // (`process` + mutating), so a care identity is denied at the kernel gate.
  const outcome = await host.toolCall(toolCall("care_user", "network_tool"));
  const body = outcome.body as ResultBody;
  assert.ok(body.result !== undefined, "a denial is an observation, never a directive");
  assert.equal(body.result.isError, true);
  assert.match(body.result.content, /CAPABILITY_WITHHELD/);
});

test("the hub dispatches its OWN seat (the shell tool) rather than delegating", async () => {
  const { host } = composeHost();
  const outcome = await host.toolCall(toolCall("coding_user", "run_shell"));
  const body = outcome.body as ResultBody;
  assert.ok(body.result !== undefined, "the owned seat returns an observation");
  assert.equal(body.result.content, "ran: run_shell");
  assert.equal((outcome.body as DispatchBody).dispatch, undefined);
});

// The daemon half: the forwarding executor fulfills a directive locally.
type Server = import("node:http").Server;
function fakeHub(handler: (body: unknown) => { status: number; body: unknown }): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveStarted) => {
    const server: Server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const reply = handler(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolveStarted({
        url: "http://127.0.0.1:" + String(address.port),
        close: () => new Promise((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))),
      });
    });
  });
}

function publishDiscovery(context: import("node:test").TestContext, url: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-assistant-mcp-dispatch-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "hub"), { recursive: true });
  writeFileSync(join(dir, "hub", "discovery.json"), JSON.stringify({ endpoint: url, token: "hub-token" }), "utf8");
  return dir;
}

test("the forwarding executor fulfills a hub dispatch directive against its own dispatcher", async (context) => {
  const hub = await fakeHub(() => ({
    status: 200,
    body: {
      dispatch: {
        call: { id: "call-1", name: "record_learning_evidence", arguments: '{"outcome":"ok"}' },
        capability: "mutation",
        mutating: true,
      },
    },
  }));
  const seen: AssistantToolCall[] = [];
  try {
    const executor = createHubAssistantToolExecutor({
      workspace: "/tmp/assistant-workspace",
      hubDiscoveryDir: publishDiscovery(context, hub.url),
      dispatch: {
        async dispatch(call) {
          seen.push(call);
          return { callId: call.id, content: "locally ran: " + call.name };
        },
      },
    });
    const result = await executor.execute(
      { id: "call-1", name: "record_learning_evidence", arguments: '{"outcome":"ok"}' },
      { identity: "coding_user", route: "coding", iteration: 0 },
    );
    assert.deepEqual(result, { callId: "call-1", content: "locally ran: record_learning_evidence" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.arguments, '{"outcome":"ok"}', "the directive's arguments are carried through");
  } finally {
    await hub.close();
  }
});

test("the forwarding executor fails a directive closed when no local dispatcher is composed", async (context) => {
  const hub = await fakeHub(() => ({
    status: 200,
    body: { dispatch: { call: { id: "call-1", name: "record_learning_evidence", arguments: "{}" }, capability: "mutation", mutating: true } },
  }));
  try {
    const executor = createHubAssistantToolExecutor({
      workspace: "/tmp/assistant-workspace",
      hubDiscoveryDir: publishDiscovery(context, hub.url),
    });
    const result = await executor.execute(
      { id: "call-1", name: "record_learning_evidence", arguments: "{}" },
      { identity: "coding_user", route: "coding", iteration: 0 },
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /no assistant MCP dispatcher is configured/);
  } finally {
    await hub.close();
  }
});

// The daemon MCP dispatcher module: an e2e-injectable connection keeps the tests
// free of a spawned child, while still exercising the whole dispatch path.
function fakeConnection(behavior: {
  readonly content: string;
  readonly isError?: boolean;
}): { factory: () => Promise<AssistantMcpConnection>; closes: () => number } {
  let closes = 0;
  return {
    closes: () => closes,
    factory: async () => ({
      async callTool() {
        return { content: behavior.content, isError: behavior.isError === true };
      },
      async close() {
        closes += 1;
      },
    }),
  };
}

test("the MCP dispatcher fails an UNDECLARED tool closed before any connection is made", async () => {
  let connects = 0;
  const dispatcher = createAssistantMcpDispatcher({
    tools: {},
    servers: { "learning-mcp": { command: "node", args: ["/srv/server.js"] } },
    connect: async () => {
      connects += 1;
      return { async callTool() { return { content: "", isError: false }; }, async close() {} };
    },
  });
  const result = await dispatcher.dispatch(
    { id: "call-1", name: "record_learning_evidence", arguments: "{}" },
    { identity: "coding_user", route: "coding", iteration: 0 },
    { capability: "mutation", mutating: true },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /no assistant MCP server is declared for tool 'record_learning_evidence'/);
  assert.equal(connects, 0, "an undeclared tool never opens a connection");
});

test("the MCP dispatcher runs a DECLARED tool on its server and closes the connection", async () => {
  const connection = fakeConnection({ content: "evidence recorded" });
  let seenArgs: Record<string, unknown> | undefined;
  let seenName: string | undefined;
  const dispatcher = createAssistantMcpDispatcher({
    tools: { record_learning_evidence: "learning-mcp" },
    servers: { "learning-mcp": { command: "node", args: ["/srv/server.js"] } },
    connect: async () => ({
      async callTool(name, args) {
        seenName = name;
        seenArgs = args;
        return { content: "evidence recorded", isError: false };
      },
      close: () => connection.factory().then((c) => c.close()),
    }),
  });
  const result = await dispatcher.dispatch(
    { id: "call-1", name: "record_learning_evidence", arguments: '{"outcome":"ok"}' },
    { identity: "coding_user", route: "coding", iteration: 0 },
    { capability: "mutation", mutating: true },
  );
  assert.deepEqual(result, { callId: "call-1", content: "evidence recorded" });
  assert.equal(seenName, "record_learning_evidence");
  assert.deepEqual(seenArgs, { outcome: "ok" });
  assert.equal(connection.closes(), 1, "the connection is closed after the call");
});

test("the MCP dispatcher surfaces a server tool error and malformed arguments fail closed", async () => {
  const failing = fakeConnection({ content: "server refused the write", isError: true });
  const dispatcher = createAssistantMcpDispatcher({
    tools: { record_learning_evidence: "learning-mcp" },
    servers: { "learning-mcp": { command: "node", args: ["/srv/server.js"] } },
    connect: () => failing.factory(),
  });
  const failed = await dispatcher.dispatch(
    { id: "call-1", name: "record_learning_evidence", arguments: "{}" },
    { identity: "coding_user", route: "coding", iteration: 0 },
    { capability: "mutation", mutating: true },
  );
  assert.equal(failed.isError, true);
  assert.equal(failed.content, "server refused the write");

  const malformed = await dispatcher.dispatch(
    { id: "call-2", name: "record_learning_evidence", arguments: "{not json" },
    { identity: "coding_user", route: "coding", iteration: 0 },
    { capability: "mutation", mutating: true },
  );
  assert.equal(malformed.isError, true);
  assert.match(malformed.content, /not valid JSON/);
});

test("the MCP dispatcher fails a tool whose server has no launch closed", async () => {
  const dispatcher = createAssistantMcpDispatcher({
    tools: { record_learning_evidence: "learning-mcp" },
    servers: {},
  });
  const result = await dispatcher.dispatch(
    { id: "call-1", name: "record_learning_evidence", arguments: "{}" },
    { identity: "coding_user", route: "coding", iteration: 0 },
    { capability: "mutation", mutating: true },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /has no launch configured/);
});

test("parseAssistantMcpToolServerMap fails closed on a non-object or a non-string server", () => {
  assert.throws(() => parseAssistantMcpToolServerMap([]), /must be an object/);
  assert.throws(() => parseAssistantMcpToolServerMap({ tool: "" }), /non-empty server name/);
  assert.deepEqual(parseAssistantMcpToolServerMap({ " record_learning_evidence ": " learning-mcp " }), {
    record_learning_evidence: "learning-mcp",
  });
});

test("resolveAssistantMcpServers keeps an operator server and fills a built catalog server", () => {
  const settings: WorkflowSettings = {
    version: 1,
    mcpServers: [
      { name: "learning-mcp", enabled: true, transport: "stdio", command: "/opt/node", args: ["/opt/learning.js"] },
      { name: "disabled-mcp", enabled: false, transport: "stdio", command: "/opt/x", args: [] },
    ],
    agents: {},
  };
  const servers = resolveAssistantMcpServers({
    settings,
    nodePath: "/usr/bin/node",
    toolboxRoot: "/nonexistent-toolbox-root",
    exists: (path) => path.includes("dist/server.js"),
  });
  // Operator declaration wins (explicit command preserved).
  assert.deepEqual(servers["learning-mcp"], { command: "/opt/node", args: ["/opt/learning.js"] });
  // A disabled server is never launched.
  assert.equal(servers["disabled-mcp"], undefined);
  // A built catalog server with no operator declaration is filled from the catalog.
  assert.deepEqual(servers["workflow-guard-mcp"]?.command, "/usr/bin/node");
  assert.match(String(servers["workflow-guard-mcp"]?.args[0]), /workflow-guard-mcp/);
});
