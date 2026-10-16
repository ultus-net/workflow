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
import { taskId } from "../src/kernel/contracts.js";
import type { AssistantGatewayConfig } from "../src/integrations/assistant-gateway.js";
import type { McpCapability } from "../src/adapters/mcp.js";
import type { GuardCheckInput, GuardDecision } from "../src/integrations/guard-policy/index.js";
import type { GuardStatus, WorkflowGuardProvider } from "../src/integrations/mcp-toolbox-guard.js";
import {
  ALL_TOOL_CAPABILITIES,
  assistantRunTaskId,
  createAssistantToolHost,
  type AssistantRunPort,
} from "../src/integrations/assistant-tool-host.js";
import { createWorkflowHubBridge } from "../src/integrations/hub-http.js";
import { createHubAssistantToolExecutor } from "../src/integrations/assistant-tool-hub-client.js";
import { PermissionBroker } from "../src/ui/permission-broker.js";
import type { RunOrigin } from "../src/integrations/run-registry.js";

/**
 * W205 S4 — the hub-hosted assistant tool-call route (`POST /assistant/tool-call`,
 * topology Q3b). Pins the wire contract the daemon's forwarding executor depends
 * on:
 *   - a composed capability answers the operator-token route with the host's
 *     observation and its own status (an unknown identity is the host's 403);
 *   - absent capability 404s; a malformed body 400s; the verifier credential is
 *     refused (the route is operator-token class);
 *   - the host begins the run with the recorded assistant origin;
 *   - a guard `ask` parks on the hub's broker and is answerable through
 *     `/api/permission` — an allow proceeds, a reject fails the call closed.
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

class FakeGuard {
  constructor(private readonly decide: (input: GuardCheckInput) => GuardDecision) {}
  async capabilities(): Promise<readonly McpCapability[]> {
    return [];
  }
  async invoke(): Promise<unknown> {
    return undefined;
  }
  async guardCheck(input: GuardCheckInput): Promise<GuardDecision> {
    return this.decide(input);
  }
  async guardStatus(): Promise<GuardStatus> {
    return { mode: "test", enforcement: "test", executesActions: false };
  }
  async close(): Promise<void> {}
}

const allowGuard = (): WorkflowGuardProvider => new FakeGuard(() => ({ decision: "allow", policy: "test", reason: "no policy matched" })) as unknown as WorkflowGuardProvider;

function fakeRunPort(): AssistantRunPort & { origins: RunOrigin[] } {
  const apps = new Map<string, WorkflowApplication>();
  const origins: RunOrigin[] = [];
  return {
    origins,
    resolve(_workspace?: string, runId?: string): WorkflowApplication {
      const application = runId === undefined ? undefined : apps.get(runId);
      if (application === undefined) throw new TypeError("unknown run");
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

const SEED = (): WorkflowApplication => {
  const id = taskId("seed");
  return new WorkflowApplication(
    new TaskGraph([{ id, title: "seed", state: "READY", dependencies: [], requiredEvidence: [] }]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );
};

interface Composed {
  bridge: Awaited<ReturnType<typeof createWorkflowHubBridge>>;
  port: AssistantRunPort & { origins: RunOrigin[] };
  broker: PermissionBroker;
}

async function compose(options: {
  readonly guard?: WorkflowGuardProvider;
  readonly withCapability?: boolean;
  readonly withBroker?: boolean;
} = {}): Promise<Composed> {
  const port = fakeRunPort();
  const broker = new PermissionBroker();
  const host = createAssistantToolHost({
    config: CONFIG,
    withheld: ["network", "file_write"],
    capabilities: { run_shell: { capability: "process", mutating: true }, file_write: { capability: "mutation", mutating: true } },
    runs: port,
    ...(options.guard === undefined ? {} : { guard: options.guard }),
    broker,
    dispatcherFor: ({ hold, toolName }) => toolName !== "run_shell" ? undefined : ({
      dispatch: async (call) => {
        // Prove the ask hold is threaded into the dispatcher's seat: a parked ask
        // would resolve here rather than at dispatch; the dispatcher itself just
        // returns the observation the loop appends.
        void hold;
        return { callId: call.id, content: "ran: " + call.name };
      },
    }),
  });
  const bridge = await createWorkflowHubBridge(SEED(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
    ...(options.withCapability === false ? {} : { assistantToolCall: host }),
    ...(options.withBroker === false ? {} : { permissionBroker: broker }),
  });
  return { bridge, port, broker };
}

const postToolCall = async (
  composed: Composed,
  body: unknown,
  token?: string,
): Promise<{ status: number; payload: unknown }> => {
  const response = await fetch(`${composed.bridge.url}/assistant/tool-call`, {
    method: "POST",
    headers: { authorization: `Bearer ${token ?? composed.bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
};

const validBody = {
  identity: "coding_user",
  workspace: "/tmp/assistant-workspace",
  call: { id: "call-1", name: "run_shell", arguments: JSON.stringify({ command: "echo hi" }) },
};

test("a composed capability answers the operator-token route with the host's observation", async () => {
  const composed = await compose();
  try {
    const answered = await postToolCall(composed, validBody);
    assert.equal(answered.status, 200);
    assert.deepEqual(answered.payload, { result: { callId: "call-1", content: "ran: run_shell" } });
    assert.deepEqual(composed.port.origins, [{ kind: "assistant", identity: "coding_user" }], "the run begins with the assistant origin");
  } finally {
    await composed.bridge.close();
  }
});

test("an unknown identity rides the host's 403 through verbatim", async () => {
  const composed = await compose();
  try {
    const denied = await postToolCall(composed, { ...validBody, identity: "stranger" });
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.payload, { error: "unknown assistant identity" });
  } finally {
    await composed.bridge.close();
  }
});

test("an absent capability 404s (capability withheld, fail closed)", async () => {
  const composed = await compose({ withCapability: false });
  try {
    const denied = await postToolCall(composed, validBody);
    assert.equal(denied.status, 404);
    assert.deepEqual(denied.payload, { error: "not found" });
  } finally {
    await composed.bridge.close();
  }
});

test("a malformed body 400s (identity, workspace, and call are required)", async () => {
  const composed = await compose();
  try {
    const bad = await postToolCall(composed, { identity: "coding_user", workspace: "/tmp/x" });
    assert.equal(bad.status, 400);
    assert.match(String((bad.payload as { error: string }).error), /invalid assistant tool call request/);
  } finally {
    await composed.bridge.close();
  }
});

test("a care route call to a withheld tool NAME is denied before any dispatch directive", async () => {
  const composed = await compose();
  try {
    const denied = await postToolCall(composed, {
      identity: "care_user",
      workspace: "/tmp/assistant-workspace",
      call: { id: "call-1", name: "file_write", arguments: JSON.stringify({ path: "/x", content: "hi" }) },
    });
    assert.equal(denied.status, 200);
    assert.deepEqual(denied.payload, {
      result: { callId: "call-1", content: "tool 'file_write' is withheld on the care route", isError: true },
    });
  } finally {
    await composed.bridge.close();
  }
});

test("the same withheld NAME is NOT denied on a coding route (it delegates, not denies)", async () => {
  const composed = await compose();
  try {
    const answered = await postToolCall(composed, {
      identity: "coding_user",
      workspace: "/tmp/assistant-workspace",
      call: { id: "call-1", name: "file_write", arguments: JSON.stringify({ path: "/x", content: "hi" }) },
    });
    assert.equal(answered.status, 200);
    const body = answered.payload as { dispatch?: { call: { name: string } } };
    assert.equal(body.dispatch?.call.name, "file_write", "the coding route authorizes and delegates the name");
  } finally {
    await composed.bridge.close();
  }
});


test("the route is operator-token class — the verifier credential is refused", async () => {
  const composed = await compose();
  try {
    const verifier = await postToolCall(composed, validBody, composed.bridge.verificationToken);
    assert.equal(verifier.status, 401);
  } finally {
    await composed.bridge.close();
  }
});

test("a guard ask parks on the hub broker and an operator allow proceeds to dispatch", async () => {
  const askGuard = (): WorkflowGuardProvider =>
    new FakeGuard(() => ({ decision: "ask", policy: "confirm-shell", reason: "confirm" })) as unknown as WorkflowGuardProvider;
  const composed = await compose({ guard: askGuard() });
  try {
    const inFlight = postToolCall(composed, validBody);

    // Poll the broker's transport until the ask is parked, then allow it on the
    // same route the operator UI uses.
    const park = async (): Promise<void> => {
      for (let i = 0; i < 2000; i += 1) {
        const poll = await fetch(`${composed.bridge.url}/api/permission`, {
          method: "POST",
          headers: { authorization: `Bearer ${composed.bridge.token}`, "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const json = (await poll.json()) as { pendingAsks: readonly { requestId: string }[] };
        if (json.pendingAsks.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error("the ask never parked");
    };
    await park();
    const pending = composed.broker.pendingAsks();
    assert.equal(pending.length, 1);
    assert.equal(composed.broker.answerAsk(pending[0]!.requestId, "allow"), true);

    const answered = await inFlight;
    assert.equal(answered.status, 200);
    assert.deepEqual(answered.payload, { result: { callId: "call-1", content: "ran: run_shell" } });
  } finally {
    composed.broker.cancelAsks();
    await composed.bridge.close();
  }
});

test("a guard ask the operator rejects fails the call closed and never dispatches", async () => {
  const askGuard = (): WorkflowGuardProvider =>
    new FakeGuard(() => ({ decision: "ask", policy: "confirm-shell", reason: "confirm" })) as unknown as WorkflowGuardProvider;
  const composed = await compose({ guard: askGuard() });
  try {
    const inFlight = postToolCall(composed, validBody);
    const park = async (): Promise<void> => {
      for (let i = 0; i < 2000; i += 1) {
        if (composed.broker.pendingAsks().length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error("the ask never parked");
    };
    await park();
    const pending = composed.broker.pendingAsks();
    assert.equal(composed.broker.answerAsk(pending[0]!.requestId, "reject"), true);

    const answered = await inFlight;
    assert.equal(answered.status, 200);
    const result = (answered.payload as { result: { content: string; isError?: boolean } }).result;
    assert.equal(result.isError, true);
    assert.match(result.content, /operator rejected guard ask/);
  } finally {
    composed.broker.cancelAsks();
    await composed.bridge.close();
  }
});

test("the allow guard dispatches normally", async () => {
  const composed = await compose({ guard: allowGuard() });
  try {
    const answered = await postToolCall(composed, validBody);
    assert.equal(answered.status, 200);
    assert.deepEqual(answered.payload, { result: { callId: "call-1", content: "ran: run_shell" } });
  } finally {
    await composed.bridge.close();
  }
});

// The daemon half of the same hop: the forwarding executor. A fake hub stands in
// for the hub process so the client's wire shape and fail-closed reads are pinned
// without a second real process. Discovery is written to a temp dir exactly as
// the hub publishes it (`<dir>/hub/discovery.json`).
type Server = import("node:http").Server;
function fakeHub(handler: (body: unknown) => { status: number; body: unknown }): Promise<{ url: string; seen: unknown[]; close: () => Promise<void> }> {
  const seen: unknown[] = [];
  return new Promise((resolveStarted) => {
    const server: Server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        seen.push(body);
        const reply = handler(body);
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolveStarted({
        url: "http://127.0.0.1:" + String(address.port),
        seen,
        close: () => new Promise((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))),
      });
    });
  });
}

/** Write a hub discovery record into a fresh temp dir, as the hub publishes it. */
function publishDiscovery(context: import("node:test").TestContext, url: string, token = "hub-token"): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-assistant-tool-hub-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "hub"), { recursive: true });
  writeFileSync(join(dir, "hub", "discovery.json"), JSON.stringify({ endpoint: url, token }), "utf8");
  return dir;
}

test("the forwarding executor POSTs each call to the hub and returns its observation", async (context) => {
  const hub = await fakeHub(() => ({ status: 200, body: { result: { callId: "call-1", content: "ran: run_shell" } } }));
  try {
    const executor = createHubAssistantToolExecutor({
      workspace: "/tmp/assistant-workspace",
      hubDiscoveryDir: publishDiscovery(context, hub.url),
    });
    const result = await executor.execute(
      { id: "call-1", name: "run_shell", arguments: JSON.stringify({ command: "echo hi" }) },
      { identity: "coding_user", route: "coding", iteration: 0 },
    );
    assert.deepEqual(result, { callId: "call-1", content: "ran: run_shell" });
    assert.deepEqual(hub.seen[0], {
      identity: "coding_user",
      workspace: "/tmp/assistant-workspace",
      call: { id: "call-1", name: "run_shell", arguments: JSON.stringify({ command: "echo hi" }) },
    });
  } finally {
    await hub.close();
  }
});

test("the forwarding executor fails a call closed when no hub is discoverable", async () => {
  const executor = createHubAssistantToolExecutor({
    workspace: "/tmp/assistant-workspace",
    hubDiscoveryDir: "/tmp/no-such-hub-dir-" + String(process.pid),
  });
  const result = await executor.execute(
    { id: "call-1", name: "run_shell", arguments: "{}" },
    { identity: "coding_user", route: "coding", iteration: 0 },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /no workflow hub is reachable/);
});

test("the forwarding executor surfaces a non-2xx hub refusal as its own error observation", async (context) => {
  const hub = await fakeHub(() => ({ status: 403, body: { error: "unknown assistant identity" } }));
  try {
    const executor = createHubAssistantToolExecutor({
      workspace: "/tmp/assistant-workspace",
      hubDiscoveryDir: publishDiscovery(context, hub.url),
    });
    const result = await executor.execute(
      { id: "call-1", name: "run_shell", arguments: "{}" },
      { identity: "stranger", route: "coding", iteration: 0 },
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /refused by the hub \(403\)/);
    assert.match(result.content, /unknown assistant identity/);
  } finally {
    await hub.close();
  }
});

