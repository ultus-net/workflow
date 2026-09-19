import { AcpHostAdapter } from "../adapters/acp.js";
import type { ProposedToolAction, ToolCapability } from "../adapters/host.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { taskId, type TaskId } from "../kernel/contracts.js";
import { guardInputFromToolCall, type WorkflowGuardProvider } from "./mcp-toolbox-guard.js";
import { isPermissionAsked, type RemoteEngine, type RemoteEngineEvent, type RemoteEnginePermissionRequest } from "./remote-acp/engine.js";
import { permissionToolCall } from "./remote-acp/projection.js";

/**
 * W071 — the OpenCode server authority broker.
 *
 * The hub-side policy decision point for a Workflow-owned OpenCode server.
 * It subscribes to the server's SSE stream; every `permission.asked` is mapped
 * to a kernel-neutral {@link ProposedToolAction}, authorized through
 * `WorkflowApplication` (+ guard), and answered upstream — denials honored
 * pre-mutation. Malformed events, unmappable actions, and guard failures all
 * fail closed (`reject`). The gateway intercepts client replies so the stock
 * TUI can never answer upstream in broker mode (plan §3).
 *
 * Operator intent (M3): `auto-resolve` answers from policy immediately; the
 * operator reply is observation. `ask-me` holds policy-allowed asks for the
 * operator's reply (with a fail-closed timeout) and reconciles it as
 * `policyDeny ? reject : operatorReply` — the operator can tighten, never
 * loosen. Denials never wait for anyone.
 *
 * Enforcement posture (M3): in `enforced` mode the daemon verifies the pinned
 * `ask` ruleset at startup (fail closed), the bypass alarm observes mutating
 * tool activity that never produced a decision, and the gateway must have the
 * broker hook wired (no client reply can reach upstream). Nothing here claims
 * `enforced` until the live PERMISSION/RULE-CONFIG probes are green.
 */

export type OpencodeAuthorityMode = "auto-resolve" | "ask-me";
export type OpencodeAuthorityEnforcement = "advisory" | "enforced";

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
  /** `auto-resolve` (default) answers from policy; `ask-me` holds for the operator. */
  readonly mode?: OpencodeAuthorityMode | undefined;
  /** `enforced` enables the startup ruleset check contract and the bypass alarm. */
  readonly enforcement?: OpencodeAuthorityEnforcement | undefined;
  /** Ask-me hold window; on timeout the ask is rejected (fail closed). Default 120s. */
  readonly operatorReplyTimeoutMs?: number | undefined;
  /** Observation hook: every decision is journaled (observability only). */
  readonly onDecision?: ((decision: OpencodeAuthorityDecision) => void) | undefined;
  /** Fired once when the event stream ends or fails (review P2-1). */
  readonly onAuthorityLost?: (() => void) | undefined;
  /** Fired when a mutating tool activity is observed with no prior decision. */
  readonly onBypass?: ((input: { readonly sessionId: string; readonly tool: string; readonly callId?: string; readonly reason: string }) => void) | undefined;
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
  /** Number of permission requests currently held for operator intent (ask-me). */
  readonly pendingOperatorReplies: number;
  /**
   * Client (operator) replies are intercepted by the gateway and land here;
   * they never reach the upstream server directly. In ask-me mode this is the
   * operator's answer, reconciled against policy; in auto-resolve mode it is
   * observation only.
   */
  handleOperatorReply(reply: { readonly sessionId: string; readonly requestId: string; readonly reply: "once" | "always" | "reject" }): Promise<void>;
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

/**
 * Enforcement contract (plan M3.2): the effective ruleset must emit `ask` for
 * every pinned mutating class. A permissive ruleset bypasses interception, so
 * an enforced surface refuses to start rather than claim enforcement over a
 * permissive engine. Call with `engine.config()` output at daemon startup.
 */
export function assertAskRuleset(config: Record<string, unknown> | undefined): void {
  const permission = config !== undefined && isRecord(config.permission) ? config.permission : undefined;
  const unpinned = ["edit", "bash", "task"].filter((key) => permission?.[key] !== "ask");
  if (unpinned.length > 0) {
    throw new Error(`ruleset not pinned to ask for: ${unpinned.join(", ")} (enforced posture fails closed)`);
  }
}

export function createOpencodeServerAuthority(options: OpencodeServerAuthorityOptions): OpencodeServerAuthority {
  const adapter = new AcpHostAdapter({ authoritativePermissions: true });
  const mode = options.mode ?? "auto-resolve";
  const enforcement = options.enforcement ?? "advisory";
  const operatorReplyTimeoutMs = options.operatorReplyTimeoutMs ?? 120_000;
  const now = options.now ?? (() => Date.now());
  const journal: OpencodeAuthorityDecision[] = [];
  let lost = false;
  let streamError: string | undefined;
  const controller = new AbortController();

  /** Ask-me holds: requestId -> resolver. */
  const pending = new Map<string, { readonly resolveReply: (reply: "once" | "reject") => void; readonly timer: ReturnType<typeof setTimeout> }>();
  /** Operator replies that raced ahead of the SSE event. */
  const earlyReplies = new Map<string, "once" | "reject">();
  /** Mutating activity that has a prior decision, keyed by callID. */
  const answeredCallIds = new Set<string>();
  /** Mutating activity covered by a decision without a callID (session+tool). */
  const answeredTools = new Set<string>();

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

  const deliver = async (decision: OpencodeAuthorityDecision): Promise<void> => {
    let delivered = true;
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
      record({
        ...decision,
        delivered,
        reason: `${decision.reason ?? "policy allow"} (upstream reply failed: ${error instanceof Error ? error.message : String(error)})`,
      });
      return;
    }
    record({ ...decision, delivered });
  };

  const answer = async (request: RemoteEnginePermissionRequest): Promise<void> => {
    const decision = await decide(request);
    rememberAnswered(request);
    if (mode === "ask-me" && decision.decision === "allow") {
      // Policy allows but the operator holds the pen (M3): their reply can
      // only tighten it. Timeout fails closed.
      const operatorReply = await holdForOperator(request);
      await deliver({ ...decision, reply: operatorReply });
      return;
    }
    await deliver(decision);
  };

  const holdForOperator = (request: RemoteEnginePermissionRequest): Promise<"once" | "reject"> => {
    const early = earlyReplies.get(request.id);
    if (early !== undefined) {
      earlyReplies.delete(request.id);
      return Promise.resolve(early);
    }
    return new Promise<"once" | "reject">((resolveHold) => {
      const timer = setTimeout(() => {
        pending.delete(request.id);
        resolveHold("reject"); // Fail closed: an unanswered hold never mutates.
      }, operatorReplyTimeoutMs);
      pending.set(request.id, {
        resolveReply: (reply) => {
          clearTimeout(timer);
          pending.delete(request.id);
          resolveHold(reply);
        },
        timer,
      });
    });
  };

  function rememberAnswered(request: RemoteEnginePermissionRequest): void {
    const callId = typeof request.tool?.callID === "string" ? request.tool.callID : undefined;
    if (callId !== undefined) answeredCallIds.add(callId);
    answeredTools.add(`${request.sessionID}\u0000${permissionToolName(request)}`);
  }

  const alarm = (sessionId: string, tool: string, callId: string | undefined, reason: string): void => {
    record({
      sessionId,
      requestId: callId ?? "(bypass)",
      tool: "(bypass)",
      subjects: [],
      decision: "deny",
      reply: "reject",
      reason,
      observedAt: now(),
      delivered: false,
    });
    options.onBypass?.({ sessionId, tool, ...(callId === undefined ? {} : { callId }), reason });
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
    get lastStreamError() {
      return streamError;
    },
    get pendingOperatorReplies() {
      return pending.size;
    },
    async start() {
      // Runs the event loop to completion; it resolves when the stream ends,
      // fails, or stop() aborts it — and `authorityLost` reports that outcome.
      try {
        for await (const event of options.engine.events({ cwd: options.workspace, signal: controller.signal })) {
          if (isPermissionAsked(event)) {
            await answer(event.properties);
            continue;
          }
          if (enforcement === "enforced") checkBypass(event, alarm, answeredCallIds, answeredTools);
        }
        markLost();
      } catch (error) {
        markLost();
        streamError = error instanceof Error ? error.message : String(error);
      }
    },
    async stop() {
      controller.abort();
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.resolveReply("reject");
      }
      pending.clear();
    },
    async handleOperatorReply(reply) {
      const held = pending.get(reply.requestId);
      if (held !== undefined) {
        // M3 reconciliation: the operator can tighten, never loosen — the held
        // request only exists because policy allowed it, so a reject wins and
        // an allow proceeds under the already-checked policy.
        held.resolveReply(reply.reply === "reject" ? "reject" : "once");
        return;
      }
      const mode_ = mode;
      if (mode_ === "ask-me") {
        // The ask has not reached the broker yet (SSE latency race): remember
        // the operator's answer and apply it when the ask arrives.
        earlyReplies.set(reply.requestId, reply.reply === "reject" ? "reject" : "once");
        return;
      }
      record({
        sessionId: reply.sessionId,
        requestId: reply.requestId,
        tool: "(operator reply)",
        subjects: [],
        decision: "deny",
        reply: reply.reply === "reject" ? "reject" : "once",
        reason: "operator reply observed in auto-resolve mode; the upstream answer is policy-driven",
        observedAt: now(),
      });
    },
    decisions() {
      return journal;
    },
  };
}

function permissionToolName(request: RemoteEnginePermissionRequest): string {
  const metadata = request.metadata ?? {};
  return typeof metadata.toolName === "string" && metadata.toolName.length > 0 ? metadata.toolName : request.action;
}

/**
 * Bypass alarm (plan M3.3, enforced posture): a mutating tool activity that
 * never produced a decision is a bypass — the ruleset was supposed to ask.
 * Matched by callID when present, otherwise by (session, tool).
 */
function checkBypass(
  event: RemoteEngineEvent,
  alarm: (sessionId: string, tool: string, callId: string | undefined, reason: string) => void,
  answeredCallIds: ReadonlySet<string>,
  answeredTools: ReadonlySet<string>,
): void {
  if (event.type !== "message.part.updated") return;
  const part = isRecord(event.properties) && isRecord(event.properties.part) ? event.properties.part : undefined;
  if (part === undefined) return;
  if (part.type !== "tool") return;
  const tool = typeof part.tool === "string" ? part.tool : undefined;
  if (tool === undefined) return;
  const capability = opencodePermissionCapability(tool);
  if (capability === undefined || capability === "read") return;
  const sessionId = typeof event.properties.sessionID === "string" ? event.properties.sessionID : undefined;
  if (sessionId === undefined) return;
  const callId = typeof part.callID === "string" ? part.callID : undefined;
  const sessionKey = `${sessionId}\u0000${tool}`;
  if ((callId !== undefined && answeredCallIds.has(callId)) || answeredTools.has(sessionKey)) return;
  alarm(
    sessionId,
    tool,
    callId,
    `mutating tool '${tool}' ran with no prior Workflow decision (bypass alarm, enforced posture)`,
  );
}

function proposalFromPermission(
  adapter: AcpHostAdapter,
  request: RemoteEnginePermissionRequest,
  taskId: TaskId,
): ProposedToolAction {
  const projected = permissionToolCall(request);
  const name = permissionToolName(request);
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
 * (execute→process, read/search→read, else mutation); this escalates the
 * classification (never relaxes it — the adapter takes the stricter of the two).
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