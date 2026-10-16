/**
 * W205 S4 (assistant tool host, M4): the hub-side composition of the assistant
 * tool lane.
 *
 * The M1 gateway runs in the `opencode-server` daemon; the operator
 * `PermissionBroker` and the run registry live in the `hub` process
 * (topology decision Q3b, 2026-10-16 — both in one container over loopback).
 * Rather than stand a second broker in the daemon, the daemon forwards each
 * tool call to a hub loopback route, and the hub composes the executor here:
 * identity → route policy, a fresh per-identity run, the withheld capability
 * set for the care route, and the S2 executor with the in-process guard and the
 * broker's ask hold.
 *
 * Authority ordering is S2's (`assistant-tool-executor.ts`): classify →
 * `application.authorize` (kernel gate, where a withheld capability denies) →
 * guard → park an `ask` on the broker → dispatch. This module owns the
 * identity/route/run/withholding composition and nothing else.
 *
 * PER-SESSION WITHHOLDING: the withheld set is applied to the RUN's OWN
 * application — the registry constructs a fresh `WorkflowApplication` per
 * `begin`, so `setCapability` here scopes to this run, never the process. A
 * coding route in the same process keeps its full set.
 *
 * (Template literals are deliberately absent: `+` concatenation keeps sources
 * patchable under the guard shell classifier.)
 */

import type { ToolCapability } from "../application/host.js";
import type { WorkflowApplication } from "../application/workflow.js";
import type { TaskId } from "../kernel/contracts.js";
import { classifyMcpTool, type McpToolCapabilityMap } from "./mcp-tool-capability.js";
import type { WorkflowGuardProvider } from "./mcp-toolbox-guard.js";
import type { PermissionBroker } from "../ui/permission-broker.js";
import type { AssistantGatewayConfig, AssistantRoute } from "./assistant-gateway.js";
import { createAssistantToolExecutor, type AssistantToolDispatcher } from "./assistant-tool-executor.js";
import type { AssistantToolCall, AssistantToolResult } from "./assistant-tool-loop.js";
import type { RunOrigin } from "./run-registry.js";

/** The six capability strings, as a runtime value (the full grantable set). */
export const ALL_TOOL_CAPABILITIES: readonly ToolCapability[] = [
  "read",
  "mutation",
  "process",
  "spawn",
  "credentials",
  "network",
];

/**
 * The run registry surface the host needs. Structural so the host does not
 * import the registry (and its kernel/evidence dependencies) — the hub passes
 * `runs.resolve` + `runs.controller.begin`.
 */
export interface AssistantRunPort {
  /** Resolve an ACTIVE run's application; throws for an unknown run (fail closed). */
  resolve(workspace?: string, runId?: string): WorkflowApplication;
  /** Begin a run with recorded origin attribution (the hub-side recorder). */
  begin(input: { readonly runId: string; readonly title: string; readonly workspace?: string; readonly origin: RunOrigin }): Promise<void>;
}

export interface AssistantToolCallRequest {
  readonly identity: string;
  /** The bound workspace root the call executes against (absolute). */
  readonly workspace: string;
  readonly call: AssistantToolCall;
  /** Reuse this run for the session; absent → the host mints one per identity. */
  readonly runId?: string;
}

export interface AssistantToolCallOutcome {
  readonly status: number;
  readonly body: unknown;
}

export interface AssistantToolHostOptions {
  readonly config: AssistantGatewayConfig;
  /**
   * The route's withheld labels (WORKFLOW_CARE_WITHHELD), applied to the care
   * route only. The set is split by vocabulary: an entry that names one of the
   * six capabilities is the CAPABILITY layer's (`withheldCapabilities`, the
   * kernel gate); every other entry is a TOOL NAME (`withheldToolNames`, the
   * M7 name policy). The two readings are disjoint, so a capability name is
   * never reinterpreted as a tool name nor the reverse.
   */
  readonly withheld: readonly string[];
  readonly capabilities: McpToolCapabilityMap;
  readonly runs: AssistantRunPort;
  readonly guard?: WorkflowGuardProvider;
  readonly broker?: PermissionBroker;
  /**
   * Build the dispatcher for a route bound to the run's application + the
   * broker's ask hold. The hub composes the contained-shell dispatcher here so
   * the shell seat shares the run's withholding. Returns `undefined` when this
   * process does NOT own the tool's execution seat: the host then answers the
   * call with a DISPATCH DIRECTIVE (topology Option B, W205 S5) and the daemon
   * fulfills it locally against its own MCP clients. A dispatch is only ever
   * reached AFTER the hub has authorized the call (kernel gate + guard +
   * ask-hold), so the directive carries an already-decided call.
   */
  readonly dispatcherFor: (input: {
    readonly route: AssistantRoute;
    readonly workspace: string;
    readonly application: WorkflowApplication;
    readonly hold: ReturnType<PermissionBroker["askHold"]> | undefined;
    /** The tool the call names; the composition decides seat ownership per call. */
    readonly toolName: string;
  }) => AssistantToolDispatcher | undefined;
}

/** The withheld capability set for a route (empty for coding/tutor). */
export function withheldCapabilities(
  route: AssistantRoute,
  withheld: readonly string[],
  all: readonly ToolCapability[] = ALL_TOOL_CAPABILITIES,
): ReadonlySet<ToolCapability> {
  if (route !== "care") return new Set<ToolCapability>();
  const known = new Set(all);
  return new Set(withheld.filter((entry): entry is ToolCapability => known.has(entry as ToolCapability)));
}

/**
 * The withheld TOOL NAME set for a route (empty for coding/tutor). This is the
 * M7 name policy, distinct from the capability layer above: an entry that is NOT
 * one of the six capability names is read as a tool name. FAIL CLOSED: a name
 * that is neither a known capability nor a declared tool is still withheld as a
 * tool name for the care route, so an operator typo withholds rather than
 * grants. The two vocabularies are disjoint by construction, so a capability
 * name is never reinterpreted as a tool name (and vice versa).
 */
export function withheldToolNames(
  route: AssistantRoute,
  withheld: readonly string[],
  knownCapabilities: readonly ToolCapability[] = ALL_TOOL_CAPABILITIES,
): ReadonlySet<string> {
  if (route !== "care") return new Set<string>();
  const capabilities = new Set<string>(knownCapabilities);
  return new Set(withheld.filter((entry) => !capabilities.has(entry)));
}

/**
 * Apply a route's effective capability grant to the run's fresh application.
 * The grant is the full set minus the route's withheld set; every capability is
 * set explicitly so the result does not depend on the registry's default set.
 * Returns the effective set (for observability/tests).
 */
export function applyRouteCapabilities(
  application: WorkflowApplication,
  route: AssistantRoute,
  withheld: readonly string[],
  all: readonly ToolCapability[] = ALL_TOOL_CAPABILITIES,
): ReadonlySet<ToolCapability> {
  const withheldSet = withheldCapabilities(route, withheld, all);
  const effective = new Set(all.filter((capability) => !withheldSet.has(capability)));
  for (const capability of all) application.setCapability(capability, effective.has(capability));
  return effective;
}

/** A stable per-identity run id (reused across a session's tool calls). */
export function assistantRunId(identity: string): string {
  // Sanitize to a run-id-safe token (the identity is a header value, untrusted).
  const safe = identity.replace(/[^A-Za-z0-9_.-]/g, "_");
  return "assistant:" + safe;
}

export interface AssistantToolHost {
  /** Run ONE tool call through the composed lane. */
  toolCall(request: AssistantToolCallRequest): Promise<AssistantToolCallOutcome>;
  /** The route an identity is bound to, or undefined (the daemon's own check mirrors this). */
  routeFor(identity: string): AssistantRoute | undefined;
}

export function createAssistantToolHost(options: AssistantToolHostOptions): AssistantToolHost {
  const routeFor = (identity: string): AssistantRoute | undefined => options.config.identities[identity];

  return {
    routeFor,
    async toolCall(request): Promise<AssistantToolCallOutcome> {
      const route = routeFor(request.identity);
      if (route === undefined) {
        return { status: 403, body: { error: "unknown assistant identity" } };
      }
      const boundRoute: AssistantRoute = route;
      const workspace = request.workspace;
      if (typeof workspace !== "string" || workspace.length === 0) {
        return { status: 400, body: { error: "assistant tool call requires a workspace" } };
      }
      if (typeof request.call?.id !== "string" || typeof request.call?.name !== "string") {
        return { status: 400, body: { error: "assistant tool call requires a call id and name" } };
      }

      // Care-route TOOL-NAME policy (M7), checked BEFORE any run or dispatch:
      // a care identity whose call names a withheld tool is denied terminally,
      // so the call never reaches the kernel gate, the guard, or a dispatch
      // directive. A withheld name that is neither a capability nor a declared
      // tool still denies (fail closed). Coding/tutor routes withhold no names,
      // so the same call is unaffected there.
      if (withheldToolNames(boundRoute, options.withheld).has(request.call.name)) {
        return {
          status: 200,
          body: {
            result: {
              callId: request.call.id,
              content: "tool '" + request.call.name + "' is withheld on the care route",
              isError: true,
            },
          },
        };
      }

      // Resolve or begin the run. A run id the caller supplied (a reused session
      // run) is resolved when active; otherwise a run is begun with the recorded
      // assistant origin. A duplicate active run (a concurrent begin) is resolved
      // rather than re-begun; a run that cannot be resolved either way fails the
      // call closed.
      const runId = typeof request.runId === "string" && request.runId.length > 0 ? request.runId : assistantRunId(request.identity);
      let application: WorkflowApplication | undefined;
      try {
        application = options.runs.resolve(workspace, runId);
      } catch {
        application = undefined;
      }
      if (application === undefined) {
        try {
          await options.runs.begin({
            runId,
            title: "assistant tool call",
            workspace,
            origin: { kind: "assistant", identity: request.identity },
          });
        } catch (error) {
          // A concurrent begin may have won the race; resolve the now-active run.
          try {
            application = options.runs.resolve(workspace, runId);
          } catch {
            return {
              status: 502,
              body: { error: "assistant run could not be begun: " + (error instanceof Error ? error.message : String(error)) },
            };
          }
        }
        if (application === undefined) application = options.runs.resolve(workspace, runId);
      }

      // Per-run withholding: the run's OWN application carries the route's
      // effective grant, so a care session's withheld capabilities deny at the
      // kernel gate while a coding session in the same process is unaffected.
      applyRouteCapabilities(application, boundRoute, options.withheld);

      const sessionId = "assistant:" + request.identity + ":session";
      const hold = options.broker?.askHold(sessionId);
      const dispatcher = options.dispatcherFor({ route: boundRoute, workspace, application, hold, toolName: request.call.name });
      const executor = createAssistantToolExecutor({
        application,
        capabilities: options.capabilities,
        dispatcher: dispatcher ?? NEVER_DISPATCH,
        sessionId,
        taskId: assistantRunTaskId(runId),
        ...(options.guard === undefined ? {} : { guard: options.guard }),
        ...(hold === undefined ? {} : { hold }),
        workspace,
      });
      const context = {
        identity: request.identity,
        route: boundRoute,
        iteration: 0,
      };
      // Topology Option B (W205 S5): this process authorizes every call, but it
      // only dispatches the tools whose execution seat it owns (the coding
      // route's contained shell). For any other tool the authority half still
      // runs here (kernel gate, guard, broker ask-hold), and an ALLOW becomes a
      // dispatch directive the daemon fulfills locally. A DENY is the final
      // observation either way; the daemon never sees an undecided call.
      if (dispatcher === undefined) {
        const authorized = await executor.authorize(request.call);
        if (authorized.decision === "deny") {
          return { status: 200, body: { result: authorized.result } };
        }
        return {
          status: 200,
          body: {
            dispatch: {
              call: request.call,
              capability: authorized.toolClass.capability,
              mutating: authorized.toolClass.mutating,
            },
          },
        };
      }
      const result: AssistantToolResult = await executor.execute(request.call, context);
      return { status: 200, body: { result } };
    },
  };
}

/**
 * The run's canonical task id (`run:<runId>`), matching the run registry's own
 * construction (`run-registry.ts`). Duplicated rather than imported so the host
 * does not pull the registry module into the daemon's import graph.
 */
export function assistantRunTaskId(runId: string): TaskId {
  return ("run:" + runId) as TaskId;
}

/** Re-export the classifier for callers that compose a map (parity with S1). */
export { classifyMcpTool };

/**
 * Placeholder dispatcher for the authority-only branch. It is never called:
 * when `dispatcherFor` returns `undefined` the host runs `authorize` alone and
 * answers with a directive, so an allow never reaches `execute`. Should the
 * composition ever change such that it does, this fails the call closed rather
 * than fabricating a success.
 */
const NEVER_DISPATCH: AssistantToolDispatcher = {
  async dispatch(call) {
    return {
      callId: call.id,
      content: "assistant tool dispatch is misconfigured: the authority-only branch reached a dispatcher",
      isError: true,
    };
  },
};
