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
  /**
   * Session-budget violation gate (M4): when this returns a reason, mutating
   * proposals are denied fail-closed before authorization.
   */
  readonly budgetViolation?: (() => string | undefined) | undefined;
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
  try {
    // Correlation parity with the interactive surfaces (W046): the active-task
    // pointer moves to the session the event belongs to, so application-side
    // projections (and any later operator surface) read the same target.
    application.selectActiveTask(id);
  } catch {
    // The pointer stays put when selection is not allowed; authorize() decides.
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
  /**
   * Subjects of ALLOWED mutations, for completion-observation recording (M4),
   * keyed by the permission's callID. Only delivered allows register here —
   * denied/rejected/timeout asks must never seed coverage (review P1-1), and
   * entries are consumed on observation so each allow covers exactly one
   * observed tool activity (review P1-2).
   */
  const allowedSubjectsByCallId = new Map<string, readonly string[]>();
  /**
   * Coverage for allowed mutations whose permission carries no callID, keyed
   * by session+tool — consumed on first observation (review P1-2).
   */
  const allowedSubjectsBySessionTool = new Map<string, readonly string[]>();

  const record = (decision: OpencodeAuthorityDecision): void => {
    journal.push(decision);
    options.onDecision?.(decision);
  };

  const decide = async (request: RemoteEnginePermissionRequest): Promise<OpencodeAuthorityDecision> => {
    const sessionId = request.sessionID;
    const base = { sessionId, requestId: request.id, observedAt: now() };
    let proposal: ProposedToolAction;
    let sessionTask: TaskId | undefined;
    try {
      sessionTask = ensureOpencodeSessionTask(options.application, sessionId);
      proposal = proposalFromPermission(adapter, request, sessionTask);
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
    // Session-budget gate (M4): a crossed cap denies every further mutation.
    if (proposal.mutating && options.budgetViolation !== undefined) {
      const violation = options.budgetViolation();
      if (violation !== undefined) {
        return {
          ...base,
          tool: proposal.tool,
          ...(proposal.capability === undefined ? {} : { capability: proposal.capability }),
          subjects: proposal.subjects,
          decision: "deny",
          reply: "reject",
          reason: `session budget violated: ${violation}`,
        };
      }
    }
    // Skill delivery journaling happens in the completion observer (M4): the
    // precondition is satisfied by delivery, never by an unanswered ask.
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

  const answer = async (rawRequest: RemoteEnginePermissionRequest): Promise<void> => {
    // Normalize the pinned v2 wire shape once (review P2-2); everything
    // downstream (classifier, callID matching, coverage keys) sees the
    // contract shape.
    const request = normalizePermissionRequest(rawRequest);
    const decision = await decide(request);
    if (mode === "ask-me" && decision.decision === "allow") {
      // Policy allows but the operator holds the pen (M3): their reply can
      // only tighten it. Timeout fails closed.
      const operatorReply = await holdForOperator(request);
      const held = { ...decision, reply: operatorReply };
      await deliver(held);
      if (held.decision === "allow" && held.reply === "once") rememberAllowed(request, held.subjects);
      return;
    }
    await deliver(decision);
    // Coverage seeds only from a DELIVERED allow (review P1-1): a denied,
    // operator-rejected, timed-out, or undelivered ask must never authorize
    // later tool activity.
    if (decision.decision === "allow" && decision.reply === "once") rememberAllowed(request, decision.subjects);
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
        earlyReplies.delete(request.id); // A stale early reply must not answer a later ask (review P3-2).
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

  function rememberAllowed(request: RemoteEnginePermissionRequest, subjects: readonly string[]): void {
    const callId = typeof request.tool?.callID === "string" ? request.tool.callID : undefined;
    if (callId !== undefined) {
      allowedSubjectsByCallId.set(callId, subjects);
      return;
    }
    allowedSubjectsBySessionTool.set(`${request.sessionID}\u0000${permissionToolName(request)}`, subjects);
  }

  /** Extracts the skill name from a read_skill-shaped tool input (M4). */
  function skillNameFrom(input: unknown): string | undefined {
    if (!isRecord(input)) return undefined;
    for (const key of ["skill", "name", "skillName", "skill_name", "pattern"]) {
      const value = input[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
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

  /**
   * Tool-activity observer (M4):
   *  - a completed read_skill delivery journals the skill against the session
   *    task (the server-path onSkillRead equivalent — the precondition is
   *    satisfied by delivery, never by narration);
   *  - a completed mutation with a prior decision advances canonical freshness
   *    (`recordMutation`); the journal already holds the decision;
   *  - in enforced posture, undecided mutating activity is a bypass alarm.
   */
  const observeToolPart = (event: RemoteEngineEvent): void => {
    if (event.type !== "message.part.updated") return;
    const properties: { readonly sessionID?: unknown; readonly part?: unknown } = event.properties;
    const part = isRecord(properties.part) ? properties.part : undefined;
    if (part === undefined || part.type !== "tool") return;
    const tool = typeof part.tool === "string" ? part.tool : undefined;
    if (tool === undefined) return;
    // The part may carry its own session id; the pinned source prefers it
    // (review P2-1: ignoring it silently no-ops the observer).
    const sessionId = (typeof properties.sessionID === "string" ? properties.sessionID : undefined)
      ?? (typeof part.sessionID === "string" ? part.sessionID : undefined);
    if (sessionId === undefined) return;
    const callId = typeof part.callID === "string" ? part.callID : undefined;
    const status = isRecord(part.state) && typeof part.state.status === "string" ? part.state.status : undefined;
    const sessionKey = `${sessionId}\u0000${tool}`;

    if (isReadSkillTool(tool)) {
      // Skill delivery (M4): journaled when the content actually arrived.
      if (status !== "completed") return;
      const skill = skillNameFrom(isRecord(part.state) ? part.state.input : undefined) ?? skillNameFrom(part.metadata);
      if (skill !== undefined) {
        try {
          options.application.recordSkillRead(skill, opencodeSessionTaskId(sessionId));
        } catch {
          // Nothing to journal against this task; authorization still applies.
        }
      }
      return;
    }

    const capability = opencodePermissionCapability(tool);
    if (capability === undefined || capability === "read") return;
    // Coverage is strict (review P1-2): prefer the callID match; when the ask
    // carried no callID (or the part's callID differs from the ask's), fall
    // back to the single session+tool entry and CONSUME it — one delivered
    // allow covers exactly one observed tool activity, so a second unasked
    // mutation of the same tool alarms again.
    let subjects: readonly string[] | undefined;
    if (callId !== undefined) {
      subjects = allowedSubjectsByCallId.get(callId);
      if (subjects !== undefined) allowedSubjectsByCallId.delete(callId);
    }
    if (subjects === undefined) {
      subjects = allowedSubjectsBySessionTool.get(sessionKey);
      if (subjects !== undefined) allowedSubjectsBySessionTool.delete(sessionKey);
    }
    if (subjects === undefined) {
      if (enforcement === "enforced") {
        alarm(sessionId, tool, callId, `mutating tool '${tool}' ran with no prior Workflow decision (bypass alarm, enforced posture)`);
      }
      return;
    }
    if (status !== "completed") return;
    try {
      options.application.recordMutation(subjects);
    } catch {
      // Recording a mutation must never break the session stream; the journal
      // still holds the decision, and freshness stays conservative.
    }
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
          observeToolPart(event);
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

/** Exact-name read_skill matching (review P3-3: a `evilread_skill` tool must not journal). */
function isReadSkillTool(tool: string): boolean {
  return tool === "read_skill" || tool === "skills-mcp__read_skill";
}

/**
 * Normalizes the pinned v2 permission wire shape (review P2-2, probe-pending):
 * the server's v2 event may carry `properties.permission` (action) and
 * `properties.patterns` (resources) where this broker's contract expects
 * `action`/`resources`. Reading both keeps the capability classifier and
 * callID matching alive against a real server; the M5 PERMISSION probe pins
 * the exact shape.
 */
function normalizePermissionRequest(raw: RemoteEnginePermissionRequest): RemoteEnginePermissionRequest {
  const record = raw as unknown as Record<string, unknown>;
  const action = typeof raw.action === "string" && raw.action.length > 0
    ? raw.action
    : (typeof record.permission === "string" && record.permission.length > 0 ? record.permission : "unknown");
  const resources = Array.isArray(raw.resources) && raw.resources.length > 0
    ? raw.resources
    : (Array.isArray(record.patterns) ? record.patterns.filter((entry): entry is string => typeof entry === "string") : []);
  return action === raw.action && resources === raw.resources ? raw : { ...raw, action, resources };
}

function proposalFromPermission(
  adapter: AcpHostAdapter,
  request: RemoteEnginePermissionRequest,
  taskId: TaskId,
): ProposedToolAction {
  const projected = permissionToolCall(request);
  const name = permissionToolName(request);
  // When the classifier says read (e.g. the skills-mcp delivery), carry a read
  // kind too: the adapter's non-mutating verdict needs BOTH a read kind and a
  // known-read name, and toolKind() would call this unknown MCP tool "other".
  const kind = opencodePermissionCapability(name) === "read"
    ? "read"
    : (typeof projected.kind === "string" ? projected.kind : undefined);
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
  if (isReadSkillTool(tool)) return "read";
  if (tool === "edit" || tool === "write" || tool === "patch" || tool === "apply_patch" || tool === "multiedit") return "mutation";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}