import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { transportPermissionView, type PermissionBroker, type PermissionDecisionChoice } from "./permission-broker.js";

/**
 * P6 (issue #285): the ONE pending/answer body classifier and the dedicated
 * loopback answer route that share the broker's transport.
 *
 * The hub's `/api/permission` route (`src/integrations/hub-http.ts`) and the
 * standalone contained-shell seat's own answer route both classify the exact
 * same two wire shapes here — an id-less body is the poll, an `id` + `decision`
 * body is the answer — so there is one implementation, not two drifting copies.
 * The hub mounts the classifier on its existing bridge; the standalone shell
 * (which composes no hub and must NOT expose the hub's `/bash` and run routes)
 * serves it on this minimal permission-only server instead. Both are
 * same-process over the broker; no cross-process plumbing is invented.
 */

export interface PermissionAnswerResult {
  readonly status: number;
  readonly body: unknown;
}

export interface PermissionAnswerServer {
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecision(value: unknown): value is PermissionDecisionChoice {
  return value === "allow_once" || value === "allow_always" || value === "reject_once" || value === "reject_always";
}

/**
 * The shared pending/answer classifier: an id-less record is the poll
 * (`available` / `mode` / `pending` / `pendingAsks` / `patterns`); an `id` +
 * `decision` record is the answer, resolved through the broker's SAME
 * `pendingRequest`/`answer`. A malformed answer is a 400, a stale/unknown id a
 * 404, and the P10 approvability refusal the structured 409 — identical to the
 * hub route's contract.
 */
export function permissionAnswerRoute(broker: PermissionBroker, body: unknown, sessionKey?: string): PermissionAnswerResult {
  if (!isRecord(body)) return { status: 400, body: { error: "invalid permission request" } };
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || body.id.length === 0 || !isDecision(body.decision)) {
      return { status: 400, body: { error: "invalid permission decision request" } };
    }
    const answered = broker.answer(body.id, body.decision, sessionKey);
    if (typeof answered === "object") {
      return { status: 409, body: { error: answered.refused, reason: answered.reason } };
    }
    if (!answered) return { status: 404, body: { error: "unknown or stale permission request" } };
  }
  return {
    status: 200,
    body: {
      available: true,
      mode: broker.mode(),
      pending: transportPermissionView(broker.pendingRequest(sessionKey) ?? null),
      pendingAsks: broker.pendingAsks(sessionKey),
      patterns: broker.patterns(),
    },
  };
}

/**
 * A minimal loopback server that serves ONLY the broker's pending/answer
 * transport, bound to an ephemeral port and gated by its own bearer token.
 * This is deliberately NOT the hub bridge: a standalone seat that composes no
 * run controller must not expose the hub's mutation/run routes. The server
 * lives and dies with the seat's process.
 */
export async function createPermissionAnswerServer(
  broker: PermissionBroker,
  options: { readonly maxBodyBytes?: number } = {},
): Promise<PermissionAnswerServer> {
  const token = randomBytes(32).toString("hex");
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const server = createServer((request, response) => {
    void handlePermissionRequest(request, response, broker, token, maxBodyBytes);
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
    throw new Error("Permission answer route could not bind loopback");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}

async function handlePermissionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  broker: PermissionBroker,
  token: string,
  maxBodyBytes: number,
): Promise<void> {
  try {
    if (request.method !== "POST" || request.url !== "/api/permission") return send(response, 404, { error: "not found" });
    if (!authorized(request, token)) return send(response, 401, { error: "unauthorized" });
    const body = await readJson(request, maxBodyBytes);
    const result = permissionAnswerRoute(broker, body);
    return send(response, result.status, result.body);
  } catch (error) {
    // A malformed/oversized body is a client fault (400); anything else is a
    // server fault. Same classification as the hub bridge.
    return send(response, error instanceof PermissionBodyError ? 400 : 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

class PermissionBodyError extends Error {}

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const expected = Buffer.from(token);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJson(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBodyBytes) throw new PermissionBodyError("permission answer request is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new PermissionBodyError("a JSON request body is required (send {} for the poll)");
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
