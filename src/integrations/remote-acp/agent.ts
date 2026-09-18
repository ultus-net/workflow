/**
 * ACP agent side for the remote-engine bridge.
 *
 * Implements the ACP `Agent` surface Workflow (the ACP client) drives, backed
 * by a {@link RemoteEngine}. Advisory posture for M1: every permission request
 * is forwarded to the ACP client and the client's answer is relayed to the
 * engine; a denial is a `reject`. There is no enforcement claim here — that is
 * decided by the probe plan in `docs/OPENCODE_REMOTE_ACP_SPEC.md`.
 */

import { isPermissionAsked, type RemoteEngine, type RemoteEnginePermissionRequest } from "./engine.js";
import {
  REMOTE_PERMISSION_OPTIONS,
  permissionReplyFromOutcome,
  permissionToolCall,
  projectSessionUpdate,
} from "./projection.js";

/**
 * The ACP client methods the bridge calls. Structurally satisfied by the ACP
 * SDK's `AgentSideConnection`, and by a fake in tests.
 */
export interface RemoteAcpConnection {
  sessionUpdate(params: Record<string, unknown>): Promise<void>;
  requestPermission(params: Record<string, unknown>): Promise<unknown>;
}

export interface RemoteAcpAgentOptions {
  readonly engine: RemoteEngine;
  /** Default workspace directory; requests may still carry their own. */
  readonly cwd: string;
  readonly connection: RemoteAcpConnection;
  /** Surface upstream/projection failures without tearing down the process. */
  readonly onError?: (error: unknown) => void;
}

export interface RemoteAcpAgent {
  initialize(): Promise<{ readonly protocolVersion: number; readonly agentCapabilities: Record<string, unknown> }>;
  authenticate(): Promise<Record<string, never>>;
  newSession(params: { readonly cwd?: string }): Promise<{ readonly sessionId: string }>;
  prompt(params: { readonly sessionId: string; readonly prompt: readonly { readonly type?: string; readonly text?: string }[] }): Promise<{ readonly stopReason: string }>;
  cancel(params: { readonly sessionId: string }): Promise<void>;
  dispose(): void;
}

export function createRemoteAcpAgent(options: RemoteAcpAgentOptions): RemoteAcpAgent {
  const { engine, connection } = options;
  const abort = new AbortController();
  let subscription: Promise<void> | undefined;

  const start = (): void => {
    subscription ??= runEventLoop().catch((error: unknown) => {
      options.onError?.(error);
    });
  };

  async function runEventLoop(): Promise<void> {
    for await (const event of engine.events({ cwd: options.cwd, signal: abort.signal })) {
      if (abort.signal.aborted) return;
      if (isPermissionAsked(event)) {
        await handlePermission(event.properties);
        continue;
      }
      const projected = projectSessionUpdate(event);
      if (projected !== undefined) {
        await connection.sessionUpdate(projected).catch((error: unknown) => options.onError?.(error));
      }
    }
  }

  async function handlePermission(request: RemoteEnginePermissionRequest): Promise<void> {
    const sessionId = request.sessionID;
    try {
      const result = await connection.requestPermission({
        sessionId,
        toolCall: permissionToolCall(request),
        options: REMOTE_PERMISSION_OPTIONS,
      });
      const reply = permissionReplyFromOutcome(isRecord(result) ? result.outcome : undefined);
      await engine.replyPermission({ sessionId, requestId: request.id, reply, cwd: options.cwd });
    } catch (error: unknown) {
      options.onError?.(error);
      await engine
        .replyPermission({ sessionId, requestId: request.id, reply: "reject", cwd: options.cwd })
        .catch((replyError: unknown) => options.onError?.(replyError));
    }
  }

  return {
    async initialize() {
      return { protocolVersion: 1, agentCapabilities: {} };
    },
    async authenticate() {
      start();
      return {};
    },
    async newSession(params) {
      start();
      const session = await engine.createSession({ cwd: params.cwd ?? options.cwd });
      return { sessionId: session.id };
    },
    async prompt(params) {
      start();
      const text = params.prompt
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
      await engine.prompt({ sessionId: params.sessionId, cwd: options.cwd, text });
      return { stopReason: "end_turn" };
    },
    async cancel(params) {
      await engine.abort({ sessionId: params.sessionId, cwd: options.cwd });
    },
    dispose() {
      abort.abort();
      void subscription;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
