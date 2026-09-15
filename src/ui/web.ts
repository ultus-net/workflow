import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { WorkflowApplication } from "../application/workflow.js";
import type { WorkflowCodingSession } from "../application/coding-session.js";
import { taskId, type TaskState } from "../kernel/contracts.js";
import { SessionChannel, isPromptRequest, PROMPT_BODY_LIMIT } from "./web-session-channel.js";
import { WebSessionManager, type SessionSwitchResult } from "./web-sessions.js";
import type { WebappBundle } from "./webapp/bundle.js";
import { PWA_MANIFEST, renderIconPng, serviceWorkerSource } from "./webapp/pwa.js";

const STATES: readonly TaskState[] = ["BLOCKED", "READY", "IN_PROGRESS", "VERIFYING", "VERIFIED", "FAILED"];

/**
 * Serves the React operator surface (PWA) plus the Workflow-owned session API.
 * The browser only talks to these endpoints; ACP authority stays server-side.
 * With a WebSessionManager the UI can list, create, and resume chat sessions.
 */
export function createWorkflowWebServer(
  application: WorkflowApplication,
  session?: WorkflowCodingSession | WebSessionManager,
  webapp?: WebappBundle,
) {
  const manager = session instanceof WebSessionManager ? session : undefined;
  const single = session !== undefined && !(session instanceof WebSessionManager) ? session : undefined;
  const singleChannel = single === undefined ? undefined : new SessionChannel(single);

  async function channel(): Promise<SessionChannel | undefined> {
    try {
      if (manager !== undefined) return await manager.channel();
      return singleChannel;
    } catch {
      // A failed runtime factory must never reject the request listener:
      // every caller maps undefined to 503.
      return undefined;
    }
  }

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") return html(response, PAGE);
    if (request.method === "GET" && request.url === "/app.js") {
      if (webapp === undefined) return json(response, 503, { error: "webapp bundle not built" });
      return asset(response, "text/javascript; charset=utf-8", webapp.js);
    }
    if (request.method === "GET" && request.url === "/app.css") {
      if (webapp === undefined) return json(response, 503, { error: "webapp bundle not built" });
      return asset(response, "text/css; charset=utf-8", webapp.css);
    }
    if (request.method === "GET" && request.url === "/manifest.webmanifest") {
      return json(response, 200, PWA_MANIFEST);
    }
    if (request.method === "GET" && request.url === "/sw.js") {
      const version = webapp === undefined
        ? "unbuilt"
        : createHash("sha256").update(webapp.js).update(webapp.css).digest("hex").slice(0, 12);
      return asset(response, "text/javascript; charset=utf-8", serviceWorkerSource(version));
    }
    if (request.method === "GET" && request.url === "/icon-192.png") {
      return asset(response, "image/png", renderIconPng(192));
    }
    if (request.method === "GET" && request.url === "/icon-512.png") {
      return asset(response, "image/png", renderIconPng(512));
    }
    if (request.method === "GET" && request.url === "/api/snapshot") return json(response, 200, application.snapshot());
    if (request.method === "GET" && request.url === "/api/sessions") {
      if (manager === undefined) return json(response, 503, { error: "session management unavailable" });
      return json(response, 200, { sessions: manager.list() });
    }
    if (request.method === "POST" && request.url === "/api/sessions") {
      if (manager === undefined) return json(response, 503, { error: "session management unavailable" });
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      return switchResult(response, await manager.create(), 201);
    }
    if (request.method === "POST" && request.url === "/api/sessions/activate") {
      if (manager === undefined) return json(response, 503, { error: "session management unavailable" });
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        const id = typeof (body as { id?: unknown } | null)?.id === "string" ? (body as { id: string }).id : undefined;
        if (id === undefined) return json(response, 400, { error: "invalid activation request" });
        return switchResult(response, await manager.activate(id), 200);
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "POST" && request.url === "/api/sessions/dismiss") {
      if (manager === undefined) return json(response, 503, { error: "session management unavailable" });
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        const input = body as { id?: unknown; clearUnused?: unknown } | null;
        if (input?.clearUnused === true) return json(response, 200, { removed: await manager.clearUnused() });
        const id = typeof input?.id === "string" ? input.id : undefined;
        if (id === undefined) return json(response, 400, { error: "invalid dismiss request" });
        return switchResult(response, await manager.dismiss(id), 200);
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "GET" && request.url?.startsWith("/api/image/")) {
      const active = await channel();
      const stored = active?.image(decodeURIComponent(request.url.slice("/api/image/".length)));
      if (stored === undefined) return json(response, 404, { error: "not found" });
      response.writeHead(200, { "content-type": stored.mediaType, "cache-control": "private, immutable" });
      return response.end(Buffer.from(stored.data, "base64"));
    }
    if (request.method === "GET" && request.url === "/api/session") {
      const active = await channel();
      const meta = manager?.activeMeta();
      return json(response, 200, {
        available: active !== undefined,
        ...(meta === undefined ? {} : { id: meta.id, title: meta.title }),
        state: active?.state() ?? { state: "unavailable" },
        items: active?.items() ?? [],
      });
    }
    if (request.method === "POST" && request.url === "/api/prompt") {
      const active = await channel();
      if (active === undefined) return json(response, 503, { error: "ACP session unavailable" });
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request, PROMPT_BODY_LIMIT);
        if (!isPromptRequest(body)) return json(response, 400, { error: "invalid prompt request" });
        if (active.submit(body.prompt, body.images ?? []) === "busy") {
          return json(response, 409, { error: "coding session is already running" });
        }
        return json(response, 202, { accepted: true });
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "POST" && request.url === "/api/cancel") {
      const active = await channel();
      if (active === undefined) return json(response, 503, { error: "ACP session unavailable" });
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      await active.cancel();
      return json(response, 200, { cancelled: true });
    }
    if (request.method === "POST" && request.url === "/api/transition") {
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        if (!isTransitionRequest(body)) return json(response, 400, { error: "invalid transition request" });
        const result = application.transition(taskId(body.taskId), body.requested);
        return json(response, result.kind === "accepted" ? 200 : 409, result);
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    return json(response, 404, { error: "not found" });
  });
}

function switchResult(response: ServerResponse, result: SessionSwitchResult, okStatus: number) {
  switch (result.kind) {
    case "ok": return json(response, okStatus, result.meta);
    case "busy": return json(response, 409, { error: "a turn is still running" });
    case "unknown": return json(response, 404, { error: "unknown session" });
    case "failed": return json(response, 502, { error: result.error });
  }
}

function isTrustedMutation(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return request.headers["sec-fetch-site"] !== "cross-site";
  const host = request.headers.host;
  if (!host) return false;
  return origin === `http://${host}` || origin === `https://${host}`;
}

function isTransitionRequest(value: unknown): value is { taskId: string; requested: TaskState } {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  return typeof input.taskId === "string" && STATES.includes(input.requested as TaskState);
}

async function readJson(request: IncomingMessage, limit = 16_384): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new TypeError("request too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function asset(response: ServerResponse, contentType: string, body: string | Buffer): void {
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-cache",
  });
  response.end(body);
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "manifest-src 'self'",
      "worker-src 'self'",
    ].join("; "),
  });
  response.end(body);
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#14161a"><title>Workflow Control</title><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
