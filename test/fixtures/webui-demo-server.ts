/**
 * Demo web server for the Workflow operator UI browser tests: the same server
 * stack as `npm run web` with a scripted fake agent, so browser e2e can drive
 * the real bundle over real HTTP without a real ACP agent process.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { WorkflowApplication } from "../../src/application/workflow.js";
import { WorkflowCodingSession } from "../../src/application/coding-session.js";
import type { CodingSessionDriver } from "../../src/application/coding-session.js";
import { hostCapabilities } from "../../src/adapters/host.js";
import { taskId, type WorkflowTask } from "../../src/kernel/contracts.js";
import { TaskGraph } from "../../src/kernel/task-graph.js";
import type { WorkflowAcpRuntime } from "../../src/integrations/acp-runtime.js";
import type { AcpSessionConfig } from "../../src/adapters/acp-subprocess.js";
import type { ModelUsageMetrics } from "../../src/integrations/model-usage-proxy.js";
import { PermissionBroker } from "../../src/ui/permission-broker.js";
import { WebSessionManager } from "../../src/ui/web-sessions.js";
import { createWorkflowWebServer } from "../../src/ui/web.js";
import { buildWebappBundle } from "../../src/ui/webapp/bundle.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const DEMO_TASKS: WorkflowTask[] = [
  { id: taskId("W001"), title: "Audit the operator transcript rendering", state: "READY", dependencies: [], requiredEvidence: [] },
  { id: taskId("W002"), title: "Exercise composer and queue affordances", state: "IN_PROGRESS", dependencies: [taskId("W001")], requiredEvidence: [] },
  { id: taskId("W003"), title: "Review permission prompt ergonomics", state: "BLOCKED", dependencies: [taskId("W002")], requiredEvidence: [] },
];

interface DemoConfigOption {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly type: "select" | "boolean";
  currentValue: string | boolean;
  readonly description?: string;
  readonly options?: ReadonlyArray<{ value: string; name: string; description?: string }>;
}

interface DemoConfigShape {
  configOptions: DemoConfigOption[];
}

const DEMO_CONFIG: DemoConfigShape = {
  configOptions: [
    {
      id: "model", name: "Model", category: "model", type: "select", currentValue: "anthropic/claude-sonnet-4.6",
      options: [
        { value: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", description: "Balanced default" },
        { value: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6", description: "Deep work" },
        { value: "openai/gpt-5.6", name: "GPT-5.6", description: "Fast thinking" },
      ],
    },
    {
      id: "thought_level", name: "Effort", category: "thought_level", type: "select", currentValue: "high",
      options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High", description: "Default" }],
    },
    {
      id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "code",
      options: [{ value: "ask", name: "Ask" }, { value: "plan", name: "Plan" }, { value: "code", name: "Act" }],
    },
    { id: "web_search", name: "Web search", type: "boolean", currentValue: true, description: "Let the agent search the web" },
  ],
};

const DEMO_USAGE: ModelUsageMetrics = {
  requests: 6,
  usageEvents: 9,
  promptTokens: 84_512,
  completionTokens: 6_231,
  totalTokens: 90_743,
  costUsd: 0.4182,
  latestPromptTokens: 32_940,
};

/** Scripted driver: streams a plan, tool cards, and an assistant reply, then
 * completes — or fails when the prompt contains "fail". */
function fakeDriver(): CodingSessionDriver & {
  config(): AcpSessionConfig | undefined;
  setConfigOption(id: string, value: string | boolean): Promise<AcpSessionConfig>;
  agentSessionId(): string | undefined;
  connect(): Promise<void>;
  subscribe(): () => void;
  contextWindowTokens(): number | undefined;
} {
  let connected = false;
  const asAcpConfig = DEMO_CONFIG as unknown as AcpSessionConfig;
  return {
    async start(prompt, emit) {
      const fail = prompt.toLowerCase().includes("fail");
      emit({ type: "thought", text: "Surveying the operator surface before answering.\n" });
      await sleep(120);
      emit({
        type: "plan",
        entries: [
          { id: "p1", content: "Read the current implementation", status: "completed" },
          { id: "p2", content: "Summarize affordances and gaps", status: "in_progress" },
        ],
      });
      await sleep(120);
      emit({ type: "tool", callId: "t1", title: "Read src/ui/webapp/app.tsx", toolKind: "read", status: "in_progress", subjects: ["src/ui/webapp/app.tsx"] });
      await sleep(120);
      emit({ type: "tool", callId: "t1", title: "Read src/ui/webapp/app.tsx", toolKind: "read", status: "completed", subjects: ["src/ui/webapp/app.tsx"], rawOutput: "export function App() {}" });
      await sleep(120);
      emit({ type: "assistant", text: "The composer exposes model/effort/mode pickers with a queue path for follow-ups while a turn runs.\n" });
      await sleep(120);
      if (fail) {
        emit({ type: "failed", reason: "provider 502: connection reset by peer while streaming" });
        return;
      }
      emit({ type: "completed", result: "Pickers sit composer-adjacent; queueing parks prompts until the turn settles." });
    },
    async cancel() {},
    agentSessionId: () => "demo-driver-session",
    async connect() { connected = true; },
    subscribe: () => () => {},
    contextWindowTokens: () => 200_000,
    config: () => (connected ? asAcpConfig : undefined),
    async setConfigOption(id: string, value: string | boolean) {
      const entry = DEMO_CONFIG.configOptions.find((option) => option.id === id);
      if (entry !== undefined) entry.currentValue = value;
      return asAcpConfig;
    },
  } as CodingSessionDriver & {
    config(): AcpSessionConfig | undefined;
    setConfigOption(id: string, value: string | boolean): Promise<AcpSessionConfig>;
    agentSessionId(): string | undefined;
    connect(): Promise<void>;
    subscribe(): () => void;
    contextWindowTokens(): number | undefined;
  };
}

export interface WebuiDemoServer {
  readonly server: Server;
  readonly url: string;
  readonly registryPath: string;
  close(): void;
}

/** Starts the fake-agent operator UI on an ephemeral loopback port. */
export async function startWebuiDemoServer(): Promise<WebuiDemoServer> {
  const application = new WorkflowApplication(
    new TaskGraph(DEMO_TASKS),
    hostCapabilities({ transport: "acp", authoritativePreMutation: false }),
    [],
    new Set(["read", "mutation"]),
    process.cwd(),
  );
  const broker = new PermissionBroker();
  const registryPath = join(mkdtempSync(join(tmpdir(), "workflow-webui-")), "web-sessions.json");
  const manager = new WebSessionManager({
    registryPath,
    permissionBroker: broker,
    factory: async () => {
      const driver = fakeDriver();
      return {
        driver: driver as unknown as WorkflowAcpRuntime["driver"],
        session: new WorkflowCodingSession(driver),
      budgetMechanism: "test: no local caps (fake runtime)",
        usage: () => DEMO_USAGE,
        async dispose() {},
      };
    },
  });
  const webapp = await buildWebappBundle();
  const server = createWorkflowWebServer(application, manager, webapp);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("demo server did not bind a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}`, registryPath, close: () => server.close() };
}
