import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { ClineHostAdapter } from "../adapters/cline.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { LinuxBubblewrapContainment } from "../containment/linux-bwrap.js";
import { WorkflowContainedProcess } from "../containment/workflow-process.js";
import { buildReviewRubric } from "../review/rubric.js";
import { createWorkflowClinePlugin, type ClineBeforeToolHookInput } from "./cline-plugin.js";
import { createWorkflowClineShellExecutor, type WorkflowClineShellExecutor } from "./cline-shell-executor.js";

export interface WorkflowClineTuiBridge {
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

export type WorkflowApplicationResolver = (workspace?: string, runId?: string) => WorkflowApplication;

export interface WorkflowRunController {
  begin(input: { runId: string; title: string; workspace?: string; requiresReview?: boolean }): Promise<void>;
  finish(input: { runId: string; outcome: "verified" | "failed" }): Promise<void>;
  review(input: { runId: string; reviewerRunId: string; verdict: "approved" | "changes_requested" | "rejected"; summary: string }): Promise<{ recorded: boolean }>;
}

export async function createWorkflowClineTuiBridge(
  application: WorkflowApplication,
  resolveApplication: WorkflowApplicationResolver = () => application,
  runController?: WorkflowRunController,
): Promise<WorkflowClineTuiBridge> {
  const token = randomBytes(32).toString("hex");

  const server = createServer((request, response) => {
    void handleRequest(request, response, token, resolveApplication, runController);
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
  runController?: WorkflowRunController,
): Promise<void> {
  try {
    if (!authorized(request, token) || request.method !== "POST") return send(response, 401, { error: "unauthorized" });
    if (request.url === "/health") return send(response, 200, { status: "ok" });
    const body = await readJson(request);
    if (request.url === "/review/rubric") {
      if (!isRecord(body) || typeof body.diffText !== "string") {
        return send(response, 400, { error: "invalid review rubric request" });
      }
      return send(response, 200, {
        rubric: buildReviewRubric({
          diffText: body.diffText,
          ...(typeof body.taskPrompt === "string" ? { taskPrompt: body.taskPrompt } : {}),
        }),
      });
    }
    if (request.url === "/run/begin") {
      if (runController === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body) || typeof body.runId !== "string" || typeof body.title !== "string") {
        return send(response, 400, { error: "invalid run begin request" });
      }
      await runController.begin({
        runId: body.runId,
        title: body.title,
        ...(typeof body.workspace === "string" ? { workspace: body.workspace } : {}),
        ...(body.requiresReview === true ? { requiresReview: true } : {}),
      });
      return send(response, 200, {});
    }
    if (request.url === "/run/review") {
      if (runController === undefined) return send(response, 404, { error: "not found" });
      if (
        !isRecord(body) || typeof body.runId !== "string" || typeof body.reviewerRunId !== "string" ||
        !(body.verdict === "approved" || body.verdict === "changes_requested" || body.verdict === "rejected") ||
        typeof body.summary !== "string"
      ) {
        return send(response, 400, { error: "invalid run review request" });
      }
      const result = await runController.review({
        runId: body.runId, reviewerRunId: body.reviewerRunId, verdict: body.verdict, summary: body.summary,
      });
      return send(response, 200, result);
    }
    if (request.url === "/run/finish") {
      if (runController === undefined) return send(response, 404, { error: "not found" });
      if (!isRecord(body) || typeof body.runId !== "string" || !(body.outcome === "verified" || body.outcome === "failed")) {
        return send(response, 400, { error: "invalid run finish request" });
      }
      await runController.finish({ runId: body.runId, outcome: body.outcome });
      return send(response, 200, {});
    }
    if (request.url === "/before-tool") {
      const { input, workspace, runId } = requireBeforeToolInput(body);
      const plugin = pluginFor(resolveApplication(workspace, runId));
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

function requireBeforeToolInput(value: unknown): { input: ClineBeforeToolHookInput; workspace?: string; runId?: string } {
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
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
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
