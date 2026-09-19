import { AcpHostAdapter } from "../adapters/acp.js";
import type { ProposedToolAction, ToolCapability } from "../adapters/host.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { taskId, type TaskId } from "../kernel/contracts.js";
import { guardInputFromToolCall, type WorkflowGuardProvider } from "./mcp-toolbox-guard.js";
import { isPermissionAsked, type RemoteEngine, type RemoteEnginePermissionRequest } from "./remote-acp/engine.js";
import { permissionToolCall } from "./remote-acp/projection.js";

/**
 * W071 — the OpenCode server authority broker (M2).
 *
 * The hub-side policy decision point for a Workflow-owned OpenCode server.
 * It subscribes to the server's SSE stream; every `permission.asked` is mapped
 * to a kernel-neutral {@link ProposedToolAction}, authorized through
 * `WorkflowApplication` (+ guard), and answered upstream — denials honored
 * pre-mutation. Malformed events, unmappable actions, and guard failures all
 * fail closed (`reject`). The gateway intercepts client replies so the stock
 * TUI can never answer upstream in broker mode (plan §3).
 *
 * M2 posture: auto-resolve from policy. Operator-intent reconciliation
 * ("ask me") is M3. Nothing here claims `enforced` until the live
 * PERMISSION/RULE-CONFIG probes are green.
 */

export interface OpencodeAuthorityDecision {
  readonly sessionId: string;
  readonly requestId: string;
  readonly tool: string;
  readonly capability?: ToolCapability | undefined;
  readonly subjects: readonly string[];
  readonly decision: "allow" | "deny";
  readonly reply: "once" | "reject";
  readonly reason?: string | undefined;
  readonly observedAt: number;
  /** Whether the reply actually reached the upstream server (review P3d). */
  readonly delivered?: boolean | undefined;
}

export interface OpencodeServerAuthorityOptions {
  readonly engine: Pick<RemoteEngine, "events" | "replyPermission">;
  readonly application: WorkflowApplication;
  /** Workspace directory sent on the engine's routing query. */
  readonly workspace: string;
  readonly guard?: WorkflowGuardProvider | undefined;
  /** Observation hook: every decision is journaled (observability only). */
  readonly onDecision?: ((decision: OpencodeAuthorityDecision) => void) | undefined;
  /** Fired once when the event stream ends or fails (review P2-1). */
  readonly onAuthorityLost?: (() => void) | undefined;
  /** Injectable clock (tests). */
  readonly now?: (() => number) | undefined;
}

export interface OpencodeServerAuthority {
  /** Runs the SSE loop to completion; resolves when the stream ends or fails. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** True once the event stream has ended/failed — authority is lost. */
  readonly authorityLost: boolean;
  /** The stream error that ended the loop, when it failed (diagnostics). */
  readonly lastStreamError: string | undefined;
  /**
   * Client (operator) replies are intercepted by the gateway and land here;
   * they never reach the upstream server directly. M2 auto-resolves from
   * policy, so an operator reply is journaled as operator intent only.
   */
  handleOperatorReply(reply: { readonly sessionId: string; readonly requestId: string; readonly reply: "once" | "always" | "reject" }): void;
  decisions(): readonly OpencodeAuthorityDecision[];
}

/** Stable canonical task id for an attached OpenCode session. */
export function opencodeSessionTaskId(sessionId: string): TaskId {
  return taskId(`opencode-session:${sessionId}`);
}

/**
 * Ensures a canonical IN_PROGRESS task exists for the session, so mutating
 * proposals correlate with eligible work (W046 precedent). A task that cannot
 * reach IN_PROGRESS leaves mutations denied by `authorize`, which is the
 * intended fail-closed outcome.
 */
export function ensureOpencodeSessionTask(application: WorkflowApplication, sessionId: string): TaskId {
  const id = opencodeSessionTaskId(sessionId);
  try {
    application.addTask({ id, title: `OpenCode session ${sessionId}`, dependencies: [], requiredEvidence: [] });
  } catch (error) {
    // A duplicate is the normal reuse path. Anything else is surfaced by
    // authorize() as UNKNOWN_TASK (fail closed), never as an implicit allow.
    if (!(error instanceof Error) || !/exists|duplicate/i.test(error.message)) {
      throw error;
    }
  }
  try {
    application.transition(id, "IN_PROGRESS");
  } catch {
    // Already IN_PROGRESS or terminal; authorize() decides.
  }
  return id;
}

export function createOpencodeServerAuthority(options: OpencodeServerAuthorityOptions): OpencodeServerAuthority {
  const adapter = new AcpHostAdapter({ authoritativePermissions: true });
  const now = options.now ?? (() => Date.now());
  const journal: OpencodeAuthorityDecision[] = [];
  let lost = false;
  let streamError: string | undefined;
  const controller = new AbortController();

  const record = (decision: OpencodeAuthorityDecision): void => {
    journal.push(decision);
    options.onDecision?.(decision);
  };

  const decide = async (request: RemoteEnginePermissionRequest): Promise<OpencodeAuthorityDecision> => {
    const sessionId = request.sessionID;
    const base = { sessionId, requestId: request.id, observedAt: now() };
    let proposal: ProposedToolAction;
    try {
      const taskId = ensureOpencodeSessionTask(options.application, sessionId);
      proposal = proposalFromPermission(adapter, request, taskId);
    } catch (error) {
      // Malformed/unmappable safety metadata fails closed.
      return {
        ...base,
        tool: request.action,
        subjects: [],
        decision: "deny",
        reply: "reject",
        reason: `unmappable permission request (fail closed): ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const policy = options.application.authorize(proposal);
    if (policy.kind !== "allow") {
      return {
        ...base,
        tool: proposal.tool,
        ...(proposal.capability === undefined ? {} : { capability: proposal.capability }),
        subjects: proposal.subjects,
        decision: "deny",
        reply: "reject",
        reason: policy.reason,
      };
    }
    if (options.guard !== undefined) {
      const guardInput = guardInputFromToolCall(proposal.tool, proposal.input, options.workspace);
      if (guardInput !== undefined) {
        let guardDecision;
        try {
          guardDecision = await options.guard.guardCheck(guardInput);
        } catch (error) {
          return {
            ...base,
            tool: proposal.tool,
            ...(proposal.capability === undefined ? {} : { capability: proposal.capability }),
            subjects: proposal.subjects,
            decision: "deny",
            reply: "reject",
            reason: `guard unavailable (fail closed): ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        if (guardDecision.decision !== "allow") {
          return {
            ...base,
            tool: proposal.tool,
            ...(proposal.capability === undefined ? {} : { capability: proposal.capability }),
            subjects: proposal.subjects,
            decision: "deny",
            reply: "reject",
            reason: `guard policy '${guardDecision.policy}': ${guardDecision.reason}`,
          };
        }
      }
    }
    return {
      ...base,
      tool: proposal.tool,
      ...(proposal.capability === undefined ? {} : { capability: proposal.capability }),
      subjects: proposal.subjects,
      decision: "allow",
      reply: "once",
    };
  };

  const answer = async (request: RemoteEnginePermissionRequest): Promise<void> => {
    const decision = await decide(request);
    let delivered = true;
    let deliveryError: string | undefined;
    try {
      await options.engine.replyPermission({
        sessionId: decision.sessionId,
        requestId: decision.requestId,
        reply: decision.reply,
        cwd: options.workspace,
      });
    } catch (error) {
      // A reply failure means the engine may still be waiting; the decision is
      // recorded with delivery confirmation so the journal never reports an
      // allow that never reached the server.
      delivered = false;
      deliveryError = error instanceof Error ? error.message : String(error);
    }
    record({
      ...decision,
      delivered,
      ...(delivered ? {} : { reason: `${decision.reason ?? "policy allow"} (upstream reply failed: ${deliveryError})` }),
    });
  };

  const markLost = (): void => {
    if (lost) return;
    lost = true;
    options.onAuthorityLost?.();
  };

  return {
    get authorityLost() {
      return lost;
    },
    async start() {
      // Runs the event loop to completion; it resolves when the stream ends,
      // fails, or stop() aborts it — and `authorityLost` reports that outcome.
      try {
        for await (const event of options.engine.events({ cwd: options.workspace, signal: controller.signal })) {
          if (isPermissionAsked(event)) await answer(event.properties);
        }
        markLost();
      } catch (error) {
        markLost();
        streamError = error instanceof Error ? error.message : String(error);
      }
    },
    async stop() {
      controller.abort();
    },
    get lastStreamError() {
      return streamError;
    },
    handleOperatorReply(reply) {
      // M2: policy is authoritative and the broker auto-answers; an operator
      // reply is observation only. M3 reconciles operator intent.
      record({
        sessionId: reply.sessionId,
        requestId: reply.requestId,
        tool: "(operator reply)",
        subjects: [],
        decision: "deny",
        reply: reply.reply === "reject" ? "reject" : "once",
        reason: "operator reply observed in auto-resolve mode (M2); the upstream answer is policy-driven",
        observedAt: now(),
      });
    },
    decisions() {
      return journal;
    },
  };
}

function proposalFromPermission(
  adapter: AcpHostAdapter,
  request: RemoteEnginePermissionRequest,
  taskId: TaskId,
): ProposedToolAction {
  const projected = permissionToolCall(request);
  const metadata = request.metadata ?? {};
  const name = typeof metadata.toolName === "string" && metadata.toolName.length > 0 ? metadata.toolName : request.action;
  const kind = typeof projected.kind === "string" ? projected.kind : undefined;
  const capability = opencodePermissionCapability(name);
  const locations = Array.isArray(projected.locations)
    ? projected.locations.flatMap((location) => (isRecord(location) && typeof location.path === "string" ? [{ path: location.path }] : []))
    : undefined;
  return adapter.proposalFromBeforeTool({
    sessionId: request.sessionID,
    taskId,
    toolCall: {
      name,
      ...(kind === undefined ? {} : { kind }),
      ...(capability === undefined ? {} : { capability }),
      rawInput: projected.rawInput,
      ...(locations === undefined ? {} : { locations }),
    },
  });
}

/**
 * OpenCode tool-class capability. The ACP adapter classifies by kind only
 * (execute→process, read/search→read, else mutation) and would miss
 * `webfetch` (network) and `task` (spawn); this escalates the classification
 * (never relaxes it — the adapter takes the stricter of the two).
 */
export function opencodePermissionCapability(tool: string): ToolCapability | undefined {
  if (tool === "bash" || tool === "shell") return "process";
  if (tool === "webfetch" || tool === "fetch") return "network";
  if (tool === "task" || tool === "agent" || tool === "subagent") return "spawn";
  if (tool === "read" || tool === "glob" || tool === "grep" || tool === "list") return "read";
  if (tool === "edit" || tool === "write" || tool === "patch" || tool === "apply_patch" || tool === "multiedit") return "mutation";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}