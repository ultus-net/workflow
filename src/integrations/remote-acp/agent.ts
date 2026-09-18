/**
 * ACP agent side for the remote-engine bridge.
 *
 * Implements the ACP `Agent` surface Workflow (the ACP client) drives, backed
 * by a {@link RemoteEngine}. Advisory posture: every permission request is
 * forwarded to the ACP client and the client's answer is relayed to the engine;
 * a denial is a `reject`. There is no enforcement claim here — that is decided
 * by the probe plan in `docs/OPENCODE_REMOTE_ACP_SPEC.md`.
 */

import { isPermissionAsked, type RemoteEngine, type RemoteEnginePermissionRequest } from "./engine.js";
import {
  REMOTE_PERMISSION_OPTIONS,
  availableCommandsUpdate,
  availableModes,
  availableModels,
  currentModeUpdate,
  permissionReplyFromOutcome,
  permissionToolCall,
  projectReplay,
  projectSessionUpdate,
  sessionConfigOptions,
  type RemoteSessionConfigOption,
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

export interface RemoteAcpCatalog {
  readonly modes: readonly { readonly id: string; readonly name: string; readonly description?: string }[];
  readonly models: readonly { readonly modelId: string; readonly name: string }[];
}

interface SessionState {
  readonly cwd: string;
  modeId?: string;
  modelId?: string;
}

export interface RemoteAcpAgent {
  initialize(): Promise<{ readonly protocolVersion: number; readonly agentCapabilities: Record<string, unknown>; readonly agentInfo: { readonly name: string; readonly version: string } }>;
  authenticate(): Promise<Record<string, never>>;
  newSession(params: { readonly cwd?: string }): Promise<{
    readonly sessionId: string;
    readonly configOptions: readonly RemoteSessionConfigOption[];
    readonly availableModes: RemoteAcpCatalog["modes"];
    readonly availableModels: RemoteAcpCatalog["models"];
  }>;
  loadSession(params: { readonly sessionId: string; readonly cwd?: string }): Promise<{ readonly configOptions: readonly RemoteSessionConfigOption[] }>;
  resumeSession(params: { readonly sessionId: string; readonly cwd?: string }): Promise<{ readonly configOptions: readonly RemoteSessionConfigOption[] }>;
  listSessions(params: { readonly cwd?: string }): Promise<{ readonly sessions: readonly { readonly sessionId: string; readonly cwd: string; readonly title?: string; readonly updatedAt?: number }[] }>;
  closeSession(params: { readonly sessionId: string }): Promise<void>;
  setSessionMode(params: { readonly sessionId: string; readonly modeId: string }): Promise<void>;
  setSessionConfigOption(params: { readonly sessionId: string; readonly configId: string; readonly value: string | boolean }): Promise<{ readonly configOptions: readonly RemoteSessionConfigOption[] }>;
  prompt(params: { readonly sessionId: string; readonly prompt: readonly { readonly type?: string; readonly text?: string }[] }): Promise<{ readonly stopReason: string }>;
  cancel(params: { readonly sessionId: string }): Promise<void>;
  dispose(): void;
}

export function createRemoteAcpAgent(options: RemoteAcpAgentOptions): RemoteAcpAgent {
  const { engine, connection } = options;
  const abort = new AbortController();
  const sessions = new Map<string, SessionState>();
  const catalogs = new Map<string, Promise<RemoteAcpCatalog>>();
  let subscription: Promise<void> | undefined;

  const start = (): void => {
    subscription ??= runEventLoop().catch((error: unknown) => {
      options.onError?.(error);
    });
  };

  const catalogFor = (cwd: string): Promise<RemoteAcpCatalog> => {
    const existing = catalogs.get(cwd);
    if (existing !== undefined) return existing;
    const loaded = Promise.all([engine.agents({ cwd }), engine.providers({ cwd })])
      .then(([agents, providers]) => ({ modes: availableModes(agents), models: availableModels(providers) }));
    catalogs.set(cwd, loaded);
    return loaded;
  };

  const stateFor = (sessionId: string): SessionState => {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: SessionState = { cwd: options.cwd };
    sessions.set(sessionId, created);
    return created;
  };

  const configFor = (state: SessionState, catalog: RemoteAcpCatalog): readonly RemoteSessionConfigOption[] =>
    sessionConfigOptions({
      modes: catalog.modes,
      models: catalog.models,
      currentModeId: state.modeId,
      currentModelId: state.modelId,
    });

  const emitConfigUpdate = async (sessionId: string, configOptions: readonly RemoteSessionConfigOption[]): Promise<void> => {
    await connection
      .sessionUpdate({ sessionId, update: { sessionUpdate: "config_option_update", configOptions } })
      .catch((error: unknown) => options.onError?.(error));
  };

  const emitCommands = async (sessionId: string, cwd: string): Promise<void> => {
    const commands = await engine.commands({ cwd });
    if (commands.length === 0) return;
    await connection
      .sessionUpdate(availableCommandsUpdate(sessionId, commands))
      .catch((error: unknown) => options.onError?.(error));
  };

  const emitMode = async (sessionId: string, modeId: string): Promise<void> => {
    await connection
      .sessionUpdate(currentModeUpdate(sessionId, modeId))
      .catch((error: unknown) => options.onError?.(error));
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
      await engine.replyPermission({ sessionId, requestId: request.id, reply, cwd: stateFor(sessionId).cwd });
    } catch (error: unknown) {
      options.onError?.(error);
      await engine
        .replyPermission({ sessionId, requestId: request.id, reply: "reject", cwd: stateFor(sessionId).cwd })
        .catch((replyError: unknown) => options.onError?.(replyError));
    }
  }

  async function applyConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<readonly RemoteSessionConfigOption[]> {
    const state = stateFor(sessionId);
    const catalog = await catalogFor(state.cwd);
    if (typeof value !== "string") throw new TypeError(`config option ${configId} requires a string value`);
    if (configId === "mode") {
      if (!catalog.modes.some((mode) => mode.id === value)) throw new TypeError(`unknown mode: ${value}`);
      state.modeId = value;
      await emitMode(sessionId, value);
    } else if (configId === "model") {
      if (!catalog.models.some((model) => model.modelId === value)) throw new TypeError(`unknown model: ${value}`);
      state.modelId = value;
    } else {
      throw new TypeError(`unsupported config option: ${configId}`);
    }
    const configOptions = configFor(state, catalog);
    await emitConfigUpdate(sessionId, configOptions);
    return configOptions;
  }

  return {
    async initialize() {
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        },
        agentInfo: { name: "Workflow remote ACP bridge", version: "0.0.0" },
      };
    },
    async authenticate() {
      start();
      return {};
    },
    async newSession(params) {
      start();
      const cwd = params.cwd ?? options.cwd;
      const [session, catalog] = await Promise.all([engine.createSession({ cwd }), catalogFor(cwd)]);
      const state: SessionState = {
        cwd,
        ...(catalog.modes[0] === undefined ? {} : { modeId: catalog.modes[0].id }),
        ...(catalog.models[0] === undefined ? {} : { modelId: catalog.models[0].modelId }),
      };
      sessions.set(session.id, state);
      await emitCommands(session.id, cwd);
      return {
        sessionId: session.id,
        configOptions: configFor(state, catalog),
        availableModes: catalog.modes,
        availableModels: catalog.models,
      };
    },
    async loadSession(params) {
      start();
      const cwd = params.cwd ?? options.cwd;
      const catalog = await catalogFor(cwd);
      const messages = await engine.messages({ sessionId: params.sessionId, cwd });
      for (const update of projectReplay(messages)) {
        await connection.sessionUpdate(update).catch((error: unknown) => options.onError?.(error));
      }
      const state: SessionState = {
        cwd,
        ...(catalog.modes[0] === undefined ? {} : { modeId: catalog.modes[0].id }),
        ...(catalog.models[0] === undefined ? {} : { modelId: catalog.models[0].modelId }),
      };
      sessions.set(params.sessionId, state);
      await emitCommands(params.sessionId, cwd);
      return { configOptions: configFor(state, catalog) };
    },
    async resumeSession(params) {
      start();
      const cwd = params.cwd ?? options.cwd;
      const catalog = await catalogFor(cwd);
      const state: SessionState = {
        cwd,
        ...(catalog.modes[0] === undefined ? {} : { modeId: catalog.modes[0].id }),
        ...(catalog.models[0] === undefined ? {} : { modelId: catalog.models[0].modelId }),
      };
      sessions.set(params.sessionId, state);
      return { configOptions: configFor(state, catalog) };
    },
    async listSessions(params) {
      const cwd = params.cwd ?? options.cwd;
      const listed = await engine.listSessions({ cwd });
      return {
        sessions: listed.map((session) => ({
          sessionId: session.id,
          cwd,
          ...(session.title === undefined ? {} : { title: session.title }),
          ...(session.time?.updated === undefined ? {} : { updatedAt: session.time.updated }),
        })),
      };
    },
    async closeSession(params) {
      const state = stateFor(params.sessionId);
      await engine.deleteSession({ sessionId: params.sessionId, cwd: state.cwd });
      sessions.delete(params.sessionId);
    },
    async setSessionMode(params) {
      const state = stateFor(params.sessionId);
      const catalog = await catalogFor(state.cwd);
      if (!catalog.modes.some((mode) => mode.id === params.modeId)) throw new TypeError(`unknown mode: ${params.modeId}`);
      state.modeId = params.modeId;
      await emitMode(params.sessionId, params.modeId);
    },
    async setSessionConfigOption(params) {
      const configOptions = await applyConfigOption(params.sessionId, params.configId, params.value);
      return { configOptions };
    },
    async prompt(params) {
      start();
      const state = stateFor(params.sessionId);
      const text = params.prompt
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
      const model = parseModelId(state.modelId);
      await engine.prompt({
        sessionId: params.sessionId,
        cwd: state.cwd,
        text,
        ...(state.modeId === undefined ? {} : { agent: state.modeId }),
        ...(model === undefined ? {} : { model }),
      });
      return { stopReason: "end_turn" };
    },
    async cancel(params) {
      await engine.abort({ sessionId: params.sessionId, cwd: stateFor(params.sessionId).cwd });
    },
    dispose() {
      abort.abort();
      void subscription;
    },
  };
}

function parseModelId(modelId: string | undefined): { providerID: string; modelID: string } | undefined {
  if (modelId === undefined) return undefined;
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) return undefined;
  return { providerID: modelId.slice(0, slash), modelID: modelId.slice(slash + 1) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
