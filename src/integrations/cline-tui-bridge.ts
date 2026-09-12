import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { ClineHostAdapter } from "../adapters/cline.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { LinuxBubblewrapContainment } from "../containment/linux-bwrap.js";
import { WorkflowContainedProcess } from "../containment/workflow-process.js";
import { createWorkflowClinePlugin, type ClineBeforeToolHookInput } from "./cline-plugin.js";
import { createWorkflowClineShellExecutor, type WorkflowClineShellExecutor } from "./cline-shell-executor.js";

export interface WorkflowClineTuiBridge {
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

export type WorkflowApplicationResolver = (workspace?: string) => WorkflowApplication;

export async function createWorkflowClineTuiBridge(
  application: WorkflowApplication,
  resolveApplication: WorkflowApplicationResolver = () => application,
): Promise<WorkflowClineTuiBridge> {
  const token = randomBytes(32).toString("hex");

  const server = createServer((request, response) => {
    void handleRequest(request, response, token, resolveApplication);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Workflow could not establish the Cline authorization bridge");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  resolveApplication: WorkflowApplicationResolver,
): Promise<void> {
  try {
    if (!authorized(request, token) || request.method !== "POST") return send(response, 401, { error: "unauthorized" });
    const body = await readJson(request);
    if (request.url === "/before-tool") {
      const { input, workspace } = requireBeforeToolInput(body);
      const plugin = pluginFor(resolveApplication(workspace));
      return send(response, 200, (await plugin.hooks.beforeTool(input)) ?? {});
    }
    if (request.url === "/bash") {
      if (!isRecord(body) || typeof body.cwd !== "string" || !(typeof body.command === "string" || isRecord(body.command))) {
        return send(response, 400, { error: "invalid bash request" });
      }
      const application = resolveApplication(
        typeof body.workspace === "string" ? body.workspace : body.cwd,
      );
      const shellExecutor = shellExecutorFor(application);
      return send(response, 200, { output: await shellExecutor(body.command as never, body.cwd, undefined) });
    }
    send(response, 404, { error: "not found" });
  } catch (error) {
    send(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function adapterFor(application: WorkflowApplication): ClineHostAdapter {
  return new ClineHostAdapter({
    sessionId: "workflow-tui",
    taskId: () => application.activeTaskId(),
    isMutatingTool: () => false,
    authoritativePreMutation: true,
  });
}

function pluginFor(application: WorkflowApplication) {
  return createWorkflowClinePlugin(application, adapterFor(application));
}

function shellExecutorFor(application: WorkflowApplication): WorkflowClineShellExecutor {
  return createWorkflowClineShellExecutor(
    new WorkflowContainedProcess(application, new LinuxBubblewrapContainment()),
    adapterFor(application),
    (exitCode, output) => Object.assign(new Error(output), { exitCode }),
  );
}

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const expected = Buffer.from(token);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1024 * 1024) throw new Error("Workflow Cline bridge request is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function requireBeforeToolInput(value: unknown): { input: ClineBeforeToolHookInput; workspace?: string } {
  if (!isRecord(value) || !isRecord(value.toolCall) || typeof value.toolCall.toolName !== "string") {
    throw new TypeError("invalid before-tool request");
  }
  return {
    input: {
      toolCall: {
        toolName: value.toolCall.toolName,
        ...(typeof value.toolCall.toolCallId === "string" ? { toolCallId: value.toolCall.toolCallId } : {}),
      },
      input: value.input,
    },
    ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
