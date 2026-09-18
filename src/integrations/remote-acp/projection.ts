/**
 * Pure ACP ↔ remote-engine projection. No I/O, no authorization.
 *
 * These functions define the wire mapping the bridge uses; they are unit-tested
 * directly. Enforcement does not live here — a projection is presentation, and
 * the permission path is answered by Workflow through the ACP connection.
 */

import type { RemoteAgent, RemoteEngineEvent, RemoteEnginePermissionRequest, RemoteEngineReply, RemoteMessage, RemoteProvider } from "./engine.js";

/** ACP permission options the bridge offering mirrors the native mapping. */
export const REMOTE_PERMISSION_OPTIONS = [
  { optionId: "once", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
] as const;

/** Maps an ACP `RequestPermissionResponse` outcome to an engine reply. */
export function permissionReplyFromOutcome(outcome: unknown): RemoteEngineReply {
  if (typeof outcome !== "object" || outcome === null) return "reject";
  const selected = (outcome as { outcome?: unknown }).outcome;
  if (selected !== "selected") return "reject";
  const optionId = (outcome as { optionId?: unknown }).optionId;
  return optionId === "once" || optionId === "always" ? optionId : "reject";
}

/** Builds the ACP tool-call update carried by a permission request. */
export function permissionToolCall(request: RemoteEnginePermissionRequest): Record<string, unknown> {
  const metadata = request.metadata ?? {};
  const toolName = typeof metadata.toolName === "string" ? metadata.toolName : request.action;
  const title = permissionTitle(request.action, metadata);
  const locations = permissionLocations(metadata);
  return {
    toolCallId: request.tool?.callID ?? request.id,
    title,
    kind: toolKind(toolName),
    ...(locations.length > 0 ? { locations } : {}),
    rawInput: metadata,
    status: "pending",
  };
}

/** Projects an engine event into an ACP `session/update`, if it maps. */
export function projectSessionUpdate(
  event: RemoteEngineEvent,
): { readonly sessionId: string; readonly update: Record<string, unknown> } | undefined {
  if (event.type === "message.part.delta") {
    const properties = event.properties as {
      sessionID?: unknown;
      field?: unknown;
      delta?: unknown;
    };
    if (properties.field !== "text" || typeof properties.delta !== "string") return undefined;
    if (typeof properties.sessionID !== "string") return undefined;
    return {
      sessionId: properties.sessionID,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: properties.delta } },
    };
  }

  if (event.type !== "message.part.updated") return undefined;
  const properties = event.properties as {
    sessionID?: unknown;
    part?: {
      type?: unknown;
      id?: unknown;
      sessionID?: unknown;
      messageID?: unknown;
      text?: unknown;
      callID?: unknown;
      tool?: unknown;
      state?: { status?: unknown; input?: unknown; output?: unknown; title?: unknown };
    };
  };
  const part = properties.part;
  if (typeof part !== "object" || part === null) return undefined;
  const sessionId = typeof part.sessionID === "string" ? part.sessionID : properties.sessionID;
  if (typeof sessionId !== "string") return undefined;

  if (part.type === "text" && typeof part.text === "string") {
    return {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", messageId: part.messageID, content: { type: "text", text: part.text } },
    };
  }
  if (part.type === "reasoning" && typeof part.text === "string") {
    return {
      sessionId,
      update: { sessionUpdate: "agent_thought_chunk", messageId: part.id, content: { type: "text", text: part.text } },
    };
  }
  if (part.type === "tool" && typeof part.callID === "string") {
    const state = part.state ?? {};
    const sessionUpdate = state.status === "pending" ? "tool_call" : "tool_call_update";
    return {
      sessionId,
      update: {
        sessionUpdate,
        toolCallId: part.callID,
        title: typeof state.title === "string" ? state.title : (typeof part.tool === "string" ? part.tool : undefined),
        kind: toolKind(part.tool),
        status: toolStatus(state.status),
        rawInput: state.input,
        ...(typeof state.output === "string" ? { content: [{ type: "content", content: { type: "text", text: state.output } }] } : {}),
      },
    };
  }
  return undefined;
}

/** True when the event is the engine's idle status for the given session. */
export function isSessionIdle(event: RemoteEngineEvent, sessionId: string): boolean {
  if (event.type !== "session.status") return false;
  const properties = event.properties as { sessionID?: unknown; status?: { type?: unknown } };
  return properties.sessionID === sessionId && properties.status?.type === "idle";
}

function permissionTitle(action: string, metadata: Record<string, unknown>): string | undefined {
  for (const key of ["filepath", "filePath", "path", "command", "url", "query", "pattern"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return action.length > 0 ? action : undefined;
}

function permissionLocations(metadata: Record<string, unknown>): readonly { path: string }[] {
  const direct = metadata.filepath ?? metadata.filePath ?? metadata.path;
  if (typeof direct === "string" && direct.length > 0) return [{ path: direct }];
  if (!Array.isArray(metadata.files)) return [];
  return metadata.files.flatMap((file) => {
    if (typeof file !== "object" || file === null) return [];
    const path = (file as Record<string, unknown>).filePath;
    return typeof path === "string" && path.length > 0 ? [{ path }] : [];
  });
}

/** Maps engine tool names to ACP tool kinds (conservative: unknown → other). */
export function toolKind(toolName: unknown): string {
  if (typeof toolName !== "string") return "other";
  switch (toolName) {
    case "read":
    case "read_file":
    case "read_files":
      return "read";
    case "edit":
    case "write":
      return "edit";
    case "delete":
      return "delete";
    case "move":
      return "move";
    case "grep":
    case "glob":
    case "search":
      return "search";
    case "bash":
    case "shell":
      return "execute";
    case "webfetch":
      return "fetch";
    case "task":
    case "agent":
      return "think";
    default:
      return "other";
  }
}

/** Maps engine tool status to ACP tool status. */
export function toolStatus(status: unknown): string {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "in_progress";
    case "completed":
      return "completed";
    case "error":
      return "failed";
    default:
      return "in_progress";
  }
}

/** ACP `SessionConfigOption` (select form) as Workflow's surfaces consume it. */
export interface RemoteSessionConfigOption {
  readonly id: string;
  readonly name: string;
  readonly type: "select";
  readonly currentValue: string;
  readonly options: readonly { readonly value: string; readonly name: string }[];
}

/** Replays a session's assistant messages as ACP `session/update` chunks. */
export function projectReplay(
  messages: readonly RemoteMessage[],
): { readonly sessionId: string; readonly update: Record<string, unknown> }[] {
  const updates: { sessionId: string; update: Record<string, unknown> }[] = [];
  for (const message of messages) {
    if (message.info?.role === "user") continue;
    for (const part of message.parts ?? []) {
      const projected = projectSessionUpdate({ type: "message.part.updated", properties: { part } });
      if (projected !== undefined) updates.push(projected);
    }
  }
  return updates;
}

/** Selectable modes from the remote agents (subagents and hidden agents excluded). */
export function availableModes(agents: readonly RemoteAgent[]): readonly { readonly id: string; readonly name: string; readonly description?: string }[] {
  return agents
    .filter((agent) => agent.mode !== "subagent" && agent.hidden !== true)
    .map((agent) => ({
      id: agent.id,
      name: agent.name ?? agent.id,
      ...(agent.description === undefined ? {} : { description: agent.description }),
    }));
}

/** Selectable models from the remote providers, keyed `provider/model`. */
export function availableModels(providers: readonly RemoteProvider[]): readonly { readonly modelId: string; readonly name: string }[] {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({
      modelId: `${provider.id}/${model.id}`,
      name: model.name === undefined ? `${provider.id}/${model.id}` : `${provider.name ?? provider.id}: ${model.name}`,
    })),
  );
}

/** Builds ACP config options for the mode and model selectors. */
export function sessionConfigOptions(input: {
  readonly modes: readonly { readonly id: string; readonly name: string }[];
  readonly models: readonly { readonly modelId: string; readonly name: string }[];
  readonly currentModeId?: string | undefined;
  readonly currentModelId?: string | undefined;
}): readonly RemoteSessionConfigOption[] {
  const options: RemoteSessionConfigOption[] = [];
  if (input.modes.length > 0) {
    options.push({
      id: "mode",
      name: "Mode",
      type: "select",
      currentValue: input.currentModeId ?? input.modes[0]!.id,
      options: input.modes.map((mode) => ({ value: mode.id, name: mode.name })),
    });
  }
  if (input.models.length > 0) {
    options.push({
      id: "model",
      name: "Model",
      type: "select",
      currentValue: input.currentModelId ?? input.models[0]!.modelId,
      options: input.models.map((model) => ({ value: model.modelId, name: model.name })),
    });
  }
  return options;
}
