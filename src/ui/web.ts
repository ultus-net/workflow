import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { WorkflowApplication } from "../application/workflow.js";
import type { WorkflowCodingSession } from "../application/coding-session.js";
import { taskId, type TaskState } from "../kernel/contracts.js";
import { appendOperatorItem, projectOperatorSessionEvent, type OperatorSessionItem } from "./operator-session.js";
import type { WebappBundle } from "./webapp/bundle.js";
import { PWA_MANIFEST, renderIconPng, serviceWorkerSource } from "./webapp/pwa.js";

const STATES: readonly TaskState[] = ["BLOCKED", "READY", "IN_PROGRESS", "VERIFYING", "VERIFIED", "FAILED"];

/**
 * Serves the React operator surface (PWA) plus the Workflow-owned session API.
 * The browser only talks to these endpoints; ACP authority stays server-side.
 */
export function createWorkflowWebServer(
  application: WorkflowApplication,
  session?: WorkflowCodingSession,
  webapp?: WebappBundle,
) {
  let sessionItems: OperatorSessionItem[] = [];
  let turnInFlight = false;
  const images = new ImageStore();
  session?.subscribe((event) => {
    const item = projectOperatorSessionEvent(event);
    if (item) sessionItems = appendOperatorItem(sessionItems, item);
  });
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
    if (request.method === "GET" && request.url === "/api/session") {
      return json(response, 200, { available: Boolean(session), state: session?.snapshot() ?? { state: "unavailable" }, items: sessionItems });
    }
    if (request.method === "GET" && request.url?.startsWith("/api/image/")) {
      const stored = images.get(decodeURIComponent(request.url.slice("/api/image/".length)));
      if (stored === undefined) return json(response, 404, { error: "not found" });
      response.writeHead(200, { "content-type": stored.mediaType, "cache-control": "private, immutable" });
      return response.end(Buffer.from(stored.data, "base64"));
    }
    if (request.method === "POST" && request.url === "/api/prompt") {
      if (!session) return json(response, 503, { error: "ACP session unavailable" });
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request, PROMPT_BODY_LIMIT);
        if (!isPromptRequest(body)) return json(response, 400, { error: "invalid prompt request" });
        if (turnInFlight) return json(response, 409, { error: "coding session is already running" });
        turnInFlight = true;
        const userImages = (body.images ?? []).map((image) => ({ id: images.store(image), mediaType: image.mediaType }));
        sessionItems = appendOperatorItem(sessionItems, { kind: "user", text: body.prompt, ...(userImages.length > 0 ? { images: userImages } : {}) });
        void session.submit(body.prompt, body.images ?? []).finally(() => { turnInFlight = false; });
        return json(response, 202, { accepted: true });
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "POST" && request.url === "/api/cancel") {
      if (!session) return json(response, 503, { error: "ACP session unavailable" });
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      await session.cancel();
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

function isTrustedMutation(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return request.headers["sec-fetch-site"] !== "cross-site";
  const host = request.headers.host;
  if (!host) return false;
  return origin === `http://${host}` || origin === `https://${host}`;
}

/** Four images at ≤ 5 MB base64 payload each, plus the prompt body margin. */
const PROMPT_BODY_LIMIT = 24 * 1024 * 1024;
const MAX_PROMPT_IMAGES = 4;
const MAX_IMAGE_DATA_CHARS = 7_000_000;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

interface PromptImage {
  readonly mediaType: string;
  readonly data: string;
}

/** Bounded FIFO store so images stay fetchable without bloating the polled transcript. */
class ImageStore {
  #entries = new Map<string, { readonly mediaType: string; readonly data: string }>();
  #nextId = 0;

  get(id: string): { readonly mediaType: string; readonly data: string } | undefined {
    return this.#entries.get(id);
  }

  store(image: PromptImage): string {
    this.#nextId += 1;
    const id = String(this.#nextId);
    this.#entries.set(id, image);
    while (this.#entries.size > 24) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return id;
  }
}

function isPromptRequest(value: unknown): value is { prompt: string; images?: PromptImage[] } {
  if (typeof value !== "object" || value === null) return false;
  const prompt = (value as Record<string, unknown>).prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > 100_000) return false;
  const images = (value as Record<string, unknown>).images;
  if (images === undefined) return true;
  if (!Array.isArray(images) || images.length > MAX_PROMPT_IMAGES) return false;
  return images.every((image) =>
    typeof image === "object" && image !== null &&
    ALLOWED_IMAGE_TYPES.has((image as PromptImage).mediaType) &&
    typeof (image as PromptImage).data === "string" &&
    (image as PromptImage).data.length > 0 &&
    (image as PromptImage).data.length <= MAX_IMAGE_DATA_CHARS &&
    BASE64_PATTERN.test((image as PromptImage).data),
  );
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
