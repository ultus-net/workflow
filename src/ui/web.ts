import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { WorkflowApplication } from "../application/workflow.js";
import type { WorkflowCodingSession } from "../application/coding-session.js";
import { createOpenRouterAnalytics, usageTimeRange, type OpenRouterAnalytics } from "../integrations/openrouter-analytics.js";
import { compactSession, fetchLiveMcp, fetchSessionStats } from "../integrations/opencode-live-state.js";
import { nextCronMatch, type ScheduleDefinition } from "../integrations/hub-scheduler.js";
import { defaultSettings, mergeSettings, normalizeSettings, readSettingsFile, settingsPaths, writeSettingsFile } from "../integrations/workflow-settings.js";
import { resolveToolboxCatalog } from "../integrations/toolbox-catalog.js";
import { stepId, taskId, type TaskState } from "../kernel/contracts.js";
import type { PendingPermissionRequest } from "./permission-broker.js";
import { SessionChannel, isPromptRequest, PROMPT_BODY_LIMIT } from "./web-session-channel.js";
import { WebSessionManager, parseSessionBudgetRaise, type SessionSwitchResult } from "./web-sessions.js";
import { isWebAgentId, listWebAgents } from "./web-agents.js";
import type { WebappBundle } from "./webapp/bundle.js";
import { PWA_MANIFEST, renderIconPng, serviceWorkerSource } from "./webapp/pwa.js";

const STATES: readonly TaskState[] = ["BLOCKED", "READY", "IN_PROGRESS", "VERIFYING", "VERIFIED", "FAILED"];
const execGit = promisify(execFile);

type GitChangeStatus = "added" | "deleted" | "modified" | "renamed" | "untracked";

interface GitChange {
  readonly path: string;
  readonly status: GitChangeStatus;
  readonly sourcePath?: string;
}

/**
 * Serves the React operator surface (PWA) plus the Workflow-owned session API.
 * The browser only talks to these endpoints; ACP authority stays server-side.
 * With a WebSessionManager the UI can list, create, and resume chat sessions.
 */
export function createWorkflowWebServer(
  application: WorkflowApplication,
  session?: WorkflowCodingSession | WebSessionManager,
  webapp?: WebappBundle,
  options?: {
    /** The OpenRouter management-key analytics client factory; undefined (or
     * returning undefined) means the Usage page reports its setup state. */
    readonly analytics?: () => OpenRouterAnalytics | undefined;
    /** Workspace root for the per-workspace settings overlay. */
    readonly workspace?: string | undefined;
    /** Home root for the global settings file; defaults to the OS home. */
    readonly home?: string | undefined;
    /**
     * W074/W073 operator surfaces (main's scheduled-task manager + RSI loop):
     * the hub discovery directory so the browser can reach the hub's schedule
     * table and self-improvement loop registry through this service (the
     * browser itself never holds a hub token). The hub stays the single
     * writer; the web service is a proxy. Undefined (or a hub that is not
     * running) means the Schedules page reports unavailable.
     */
    readonly hubDiscoveryDir?: string;
  },
) {
  const manager = session instanceof WebSessionManager ? session : undefined;
  const single = session !== undefined && !(session instanceof WebSessionManager) ? session : undefined;
  const singleChannel = single === undefined ? undefined : new SessionChannel(single);
  const analyticsFactory = options?.analytics ?? ((): OpenRouterAnalytics | undefined => {
    const key = process.env.WORKFLOW_OPENROUTER_MANAGEMENT_KEY;
    return key === undefined || key.length === 0 ? undefined : createOpenRouterAnalytics({ key });
  });
  const settingsPathOptions = (): { home?: string; workspace?: string } => ({
    ...(options?.home === undefined ? {} : { home: options.home }),
    ...(options?.workspace === undefined ? {} : { workspace: options.workspace }),
  });

  /** The hub's operator credential, re-read per request so a hub restart is
   * picked up without restarting this service. */
  const hubCredentials = (): { url: string; token: string } | undefined => {
    const dir = options?.hubDiscoveryDir ?? process.env.WORKFLOW_HUB_DIR ?? resolve(homedir(), ".workflow");
    const path = join(dir, "hub", "discovery.json");
    if (!existsSync(path)) return undefined;
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        typeof value !== "object" || value === null ||
        typeof (value as Record<string, unknown>).endpoint !== "string" ||
        typeof (value as Record<string, unknown>).token !== "string"
      ) {
        return undefined;
      }
      const record = value as { endpoint: string; token: string };
      return { url: record.endpoint, token: record.token };
    } catch {
      return undefined;
    }
  };

  /** Proxy one POST to the hub's operator routes; 503 when the hub is not
   * reachable (the browser sees "hub unavailable", never a token). */
  const hubPost = async (path: string, body: unknown): Promise<{ status: number; payload: unknown }> => {
    const hub = hubCredentials();
    if (hub === undefined) return { status: 503, payload: { error: "hub unavailable" } };
    try {
      const response = await fetch(`${hub.url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(5_000),
      });
      return { status: response.status, payload: (await response.json()) as unknown };
    } catch {
      return { status: 503, payload: { error: "hub unavailable" } };
    }
  };

  /** W150: the ONE posture read route (the borrowings spec forbids a second
   * aggregation endpoint — this proxies the hub's /snapshot posture block).
   * Fail-closed: no hub, or a hub older than W150, answers posture: null with
   * the reason, and the strip renders its degraded state — never a fabricated
   * zero. The browser never sees a hub token. */
  const hubPosture = async (): Promise<{ posture: unknown; reason?: string }> => {
    const result = await hubPost("/snapshot", {});
    const payload = result.payload as { posture?: unknown; error?: string } | undefined;
    if (result.status === 200 && payload?.posture !== undefined) return { posture: payload.posture };
    return { posture: null, reason: payload?.error ?? "hub unavailable" };
  };

  /** Session-scoped channel: `?session=<id>` selects a parallel live session;
   * without the parameter the operator's focused session answers. */
  function sessionId(url: string | undefined): string | undefined {
    if (url === undefined) return undefined;
    return new URL(url, "http://workflow.local").searchParams.get("session") ?? undefined;
  }

  /** A session id that is present but unknown must 404, never silently
   * answer as the focused session (stale/dismissed ids). */
  function unknownSession(url: string | undefined): boolean {
    const id = sessionId(url);
    return id !== undefined && manager !== undefined && !manager.knowsSession(id);
  }

  /** Session-scoped channel: `?session=<id>` selects a parallel live session;
   * without the parameter the operator's focused session answers. Viewing
   * history must never spawn an agent, so only the focused session (or an
   * already-live one) gets a runtime here — every other id answers from the
   * registry's stored transcript via /api/session. */
  async function sessionChannel(url: string | undefined): Promise<SessionChannel | undefined> {
    try {
      if (manager !== undefined) {
        const id = sessionId(url);
        if (id !== undefined && !manager.isLive(id) && id !== manager.activeId()) return undefined;
        return await manager.channel(id);
      }
      return singleChannel;
    } catch {
      // A failed runtime factory must never reject the request listener:
      // every caller maps undefined to 503.
      return undefined;
    }
  }

  return createServer(async (request, response) => {
    // Static routes match on pathname so query strings (cache-busting,
    // iframe params) never turn the app shell into a 404.
    const pathname = request.url === undefined ? "/" : new URL(request.url, "http://workflow.local").pathname;
    if (request.method === "GET" && pathname === "/") return html(response, PAGE);
    if (request.method === "GET" && pathname === "/app.js") {
      if (webapp === undefined) return json(response, 503, { error: "webapp bundle not built" });
      return asset(response, "text/javascript; charset=utf-8", webapp.js);
    }
    if (request.method === "GET" && pathname === "/app.css") {
      if (webapp === undefined) return json(response, 503, { error: "webapp bundle not built" });
      return asset(response, "text/css; charset=utf-8", webapp.css);
    }
    if (request.method === "GET" && pathname === "/manifest.webmanifest") {
      return json(response, 200, PWA_MANIFEST);
    }
    if (request.method === "GET" && pathname === "/sw.js") {
      const version = webapp === undefined
        ? "unbuilt"
        : createHash("sha256").update(webapp.js).update(webapp.css).digest("hex").slice(0, 12);
      return asset(response, "text/javascript; charset=utf-8", serviceWorkerSource(version));
    }
    if (request.method === "GET" && pathname === "/icon-192.png") {
      return asset(response, "image/png", renderIconPng(192));
    }
    if (request.method === "GET" && pathname === "/icon-512.png") {
      return asset(response, "image/png", renderIconPng(512));
    }
    if (request.method === "GET" && pathname === "/api/snapshot") return json(response, 200, application.snapshot());
    if (request.method === "GET" && pathname === "/api/posture") return json(response, 200, await hubPosture());
    if (request.method === "GET" && pathname === "/api/git") {
      const workspace = application.workspaceRoot;
      if (workspace === undefined) return json(response, 503, { error: "workspace unavailable" });
      try {
        const status = await gitStatus(workspace);
        return json(response, 200, {
          branch: status.branch,
          changes: status.changes.map(({ path, status: changeStatus }) => ({ path, status: changeStatus })),
        });
      } catch {
        return json(response, 503, { error: "git repository unavailable" });
      }
    }
    if (request.method === "GET" && pathname === "/api/git/diff") {
      const workspace = application.workspaceRoot;
      if (workspace === undefined) return json(response, 503, { error: "workspace unavailable" });
      try {
        const path = new URL(request.url ?? "/", "http://workflow.local").searchParams.get("path");
        const status = await gitStatus(workspace);
        const change = status.changes.find((entry) => entry.path === path);
        if (change === undefined) return json(response, 404, { error: "changed path not found" });
        return json(response, 200, { path: change.path, diff: await gitDiff(workspace, change) });
      } catch {
        return json(response, 503, { error: "git diff unavailable" });
      }
    }
    if (request.method === "GET" && pathname === "/api/worktrees") {
      const workspace = application.workspaceRoot;
      if (workspace === undefined) return json(response, 503, { error: "workspace unavailable" });
      try {
        return json(response, 200, { worktrees: await gitWorktrees(workspace) });
      } catch {
        return json(response, 503, { error: "git worktrees unavailable" });
      }
    }
    if (request.method === "GET" && pathname === "/api/usage") {
      // W111 (amux C4): the Workflow-side facts — the backend-measured
      // headline, the per-session rollup, and the attribution disclosure —
      // are served regardless of the analytics key: they are this server's
      // own measurements, never client-derived. The headline states the
      // unmeasured axes explicitly (the run-registry precedent: recall and
      // time-to-response are "unmeasured" there for the same reason), and
      // the attribution note names the lanes the metering trail does NOT
      // cover (the amux attribution lesson: a rollup that counts only
      // recorded lanes accuses the unrecorded ones of working off-ledger).
      const snapshotTasks = application.snapshot().tasks;
      const rollup = manager?.usageRollup();
      const knownCosts = (rollup ?? []).map((entry) => entry.costUsd).filter((cost) => cost !== undefined);
      const sessionCostUsd = knownCosts.length > 0 ? knownCosts.reduce((sum, cost) => sum + cost, 0) : undefined;
      const verifiedTasks = snapshotTasks.filter((task) => task.state === "VERIFIED").length;
      const totalTasks = snapshotTasks.length;
      const headline = {
        verifiedTasks,
        totalTasks,
        ...(sessionCostUsd !== undefined ? { sessionCostUsd } : {}),
        ...(sessionCostUsd !== undefined && sessionCostUsd > 0 ? { verifiedTasksPerCostUsd: verifiedTasks / sessionCostUsd } : {}),
        attention: "unmeasured",
      };
      const attribution = {
        perTask: "not yet built — turn-boundary attribution (the active-task pointer at turn boundaries, paired with per-turn deltas) is queued",
        unrecordedLanes: [
          "hub reviewer-lane spend is recorded nowhere",
          "RSI proposal turns are recorded nowhere",
          "multi-turn runs record only their last turn",
          "the anthropic messages lane's usage extraction is shape-mismatched (zero-token events)",
        ],
        attention: "unmeasured",
      };
      const analytics = analyticsFactory();
      if (analytics === undefined) {
        return json(response, 200, {
          available: false,
          reason: "OpenRouter analytics need a Management key — set WORKFLOW_OPENROUTER_MANAGEMENT_KEY (server-side only; it never reaches the browser)",
          headline,
          ...(rollup !== undefined ? { sessionRollup: rollup } : {}),
          attribution,
        });
      }
      const requestedDays = new URL(request.url ?? "/", "http://workflow.local").searchParams.get("days");
      const days = requestedDays === "30" ? 30 : requestedDays === "1" ? 1 : 7;
      const { startIso, endIso } = usageTimeRange(days);
      try {
        const [byModel, byDay, credits] = await Promise.all([
          analytics.queryByModel(startIso, endIso),
          analytics.queryDaily(startIso, endIso),
          analytics.credits(),
        ]);
        // W107 (amux C1): response-honesty coverage — every fact here is
        // SERVER-computed (never client-derived), and unknown fields stay
        // absent rather than fabricated. The amux anti-pattern this closes:
        // an all-clear that silently coerced its window or truncated its
        // population ("0 5xx" covering 1.1% of traffic).
        return json(response, 200, {
          available: true,
          days,
          credits,
          byModel,
          byDay,
          coverage: {
            requestedDaysParam: requestedDays,
            days,
            ...(requestedDays !== null && days !== Number(requestedDays)
              ? { ignoredParams: [`days=${requestedDays}`] }
              : {}),
            window: { startIso, endIso },
            byModel: { rows: byModel.rows.length, truncated: byModel.truncated, limit: 100 },
            byDay: {
              rows: byDay.rows.length,
              truncated: byDay.truncated,
              limit: 120,
              ...(byDay.granularityAvailable !== undefined ? { granularityAvailable: byDay.granularityAvailable } : {}),
            },
            creditsAvailable: credits !== undefined,
          },
          headline,
          ...(rollup !== undefined ? { sessionRollup: rollup } : {}),
          attribution,
        });
      } catch (error) {
        return json(response, 503, { error: error instanceof Error ? error.message : "OpenRouter analytics unavailable" });
      }
    }
    if (request.method === "GET" && pathname === "/api/invariants") {
      // W107 (amux C2): kernel-evaluated invariant rows relayed verbatim —
      // the evaluation stays kernel-side; this surface only relays it.
      return json(response, 200, application.invariants());
    }
    if (request.method === "GET" && pathname === "/api/sessions") {
      if (manager === undefined) return json(response, 503, { error: "session management unavailable" });
      return json(response, 200, { sessions: manager.list() });
    }
    if (request.method === "GET" && pathname === "/api/agents") {
      // Annotate each agent with the live handshake facts (version, advertised
      // session capabilities) any live session's runtime reported — absent
      // (never fabricated) when unknown. Read paths only: this must never
      // spawn a runtime just to answer.
      const facts = manager?.liveAgentFacts() ?? new Map();
      return json(response, 200, {
        agents: listWebAgents().map((agent) => {
          const live = facts.get(agent.id);
          return live === undefined ? agent : {
            ...agent,
            ...(live.version !== undefined ? { version: live.version } : {}),
            ...(live.capabilities !== undefined ? { capabilities: live.capabilities } : {}),
          };
        }),
      });
    }
    // ── W074/W073 operator surfaces (hub proxy) ────────────────────────────
    // The hub is the single writer; this service only relays operator-token
    // routes. The verifier-gated actions (loop start, schedule run-now) are
    // deliberately NOT proxied — the browser must never hold that credential.
    if (request.method === "GET" && pathname === "/api/schedules") {
      const result = await hubPost("/schedule/list", {});
      if (result.status !== 200) return json(response, result.status, result.payload);
      const payload = result.payload as { schedules?: ScheduleDefinition[]; recentRuns?: unknown[] };
      const schedules = payload.schedules ?? [];
      return json(response, 200, {
        schedules: schedules.map((entry) => ({
          ...entry,
          nextRunAt: nextCronMatch(entry.cron, new Date())?.toISOString() ?? null,
        })),
        // W153: the hub-computed recent schedule-origin runs, relayed verbatim.
        ...(payload.recentRuns === undefined ? {} : { recentRuns: payload.recentRuns }),
      });
    }
    if (request.method === "POST" && pathname === "/api/schedules/save") {
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        if (
          typeof body !== "object" || body === null ||
          typeof (body as Record<string, unknown>).id !== "string" ||
          typeof (body as Record<string, unknown>).title !== "string" ||
          typeof (body as Record<string, unknown>).cron !== "string" ||
          typeof (body as Record<string, unknown>).prompt !== "string"
        ) {
          return json(response, 400, { error: "invalid schedule save request" });
        }
        // Forward only known schedule fields: the browser payload carries the
        // server-computed `nextRunAt` and may carry arbitrary extras, and the
        // hub persists whatever it is given. The proxy strips to the table
        // schema so nothing client-supplied beyond it is ever persisted.
        const source = body as Record<string, unknown>;
        const schedule: ScheduleDefinition = {
          id: source.id as string,
          title: source.title as string,
          cron: source.cron as string,
          prompt: source.prompt as string,
          ...(typeof source.workspace === "string" ? { workspace: source.workspace } : {}),
          ...(typeof source.requiresReview === "boolean" ? { requiresReview: source.requiresReview } : {}),
          ...(typeof source.enabled === "boolean" ? { enabled: source.enabled } : {}),
          ...(source.budget !== undefined && typeof source.budget === "object" && source.budget !== null
            ? { budget: source.budget as NonNullable<ScheduleDefinition["budget"]> }
            : {}),
          ...(typeof source.taskClass === "string" ? { taskClass: source.taskClass as NonNullable<ScheduleDefinition["taskClass"]> } : {}),
          ...(source.offPeak !== undefined && typeof source.offPeak === "string" ? { offPeak: source.offPeak as NonNullable<ScheduleDefinition["offPeak"]> } : {}),
          ...(typeof source.offPeakRequired === "boolean" ? { offPeakRequired: source.offPeakRequired } : {}),
        };
        const result = await hubPost("/schedule/save", schedule);
        return json(response, result.status, result.payload);
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "POST" && pathname === "/api/schedules/delete") {
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        const id = typeof (body as { id?: unknown } | null)?.id === "string" ? (body as { id: string }).id : undefined;
        if (id === undefined || id.length === 0) return json(response, 400, { error: "invalid schedule delete request" });
        const result = await hubPost("/schedule/delete", { id });
        return json(response, result.status, result.payload);
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "GET" && pathname === "/api/loops") {
      const result = await hubPost("/rsi/status", {});
      if (result.status !== 200) return json(response, result.status, result.payload);
      return json(response, 200, { loops: (result.payload as { loops?: unknown }).loops ?? [] });
    }
    if (request.method === "POST" && pathname === "/api/loops/cancel") {
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        const id = typeof (body as { id?: unknown } | null)?.id === "string" ? (body as { id: string }).id : undefined;
        if (id === undefined || id.length === 0) return json(response, 400, { error: "invalid loop cancel request" });
        const result = await hubPost("/rsi/cancel", { id });
        return json(response, result.status, result.payload);
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "POST" && pathname === "/api/sessions/agent") {
      if (manager === undefined) return json(response, 503, { error: "session management unavailable" });
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        const agent = (body as { agent?: unknown } | null)?.agent;
        if (!isWebAgentId(agent)) return json(response, 400, { error: "unknown agent" });
        // With a session id the agent switch targets that parallel session;
        // without it the operator's focused session re-launches.
        const target = typeof (body as { session?: unknown } | null)?.session === "string"
          ? (body as { session: string }).session
          : undefined;
        const info = listWebAgents().find((entry) => entry.id === agent);
        if (info !== undefined && !info.available) {
          return json(response, 409, { error: `agent unavailable: ${info.reason ?? "prerequisites not met"}` });
        }
        return switchResult(response, await manager.setActiveAgent(agent, target), 200);
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "POST" && pathname === "/api/sessions") {
      if (manager === undefined) return json(response, 503, { error: "session management unavailable" });
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      return switchResult(response, await manager.create(), 201);
    }
    if (request.method === "POST" && pathname === "/api/sessions/activate") {
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
    if (request.method === "POST" && pathname === "/api/sessions/dismiss") {
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
    if (request.method === "POST" && pathname === "/api/sessions/rename") {
      if (manager === undefined) return json(response, 503, { error: "session management unavailable" });
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        const input = body as { id?: unknown; title?: unknown } | null;
        const id = typeof input?.id === "string" && input.id.length > 0 ? input.id : undefined;
        const title = typeof input?.title === "string" ? input.title : undefined;
        if (id === undefined || title === undefined) return json(response, 400, { error: "invalid rename request" });
        return switchResult(response, manager.rename(id, title), 200);
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "POST" && pathname === "/api/sessions/budget-raise") {
      // W151: raise a paused session's caps and resume it. The manager is the
      // raise's authority; every denial carries its reason so the incident
      // card renders the refusal verbatim (fail-closed, never a success-
      // shaped 200). The browser never raises anything itself.
      if (manager === undefined) return json(response, 503, { error: "session management unavailable" });
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        const input = body as { id?: unknown; budget?: unknown } | null;
        const id = typeof input?.id === "string" && input.id.length > 0 ? input.id : undefined;
        const raise = parseSessionBudgetRaise(input?.budget);
        if (id === undefined || raise === undefined) return json(response, 400, { error: "invalid budget-raise request" });
        const result = await manager.raiseBudgetAndResume(id, raise);
        if (result.kind === "ok") return json(response, 200, { session: result.meta });
        if (result.kind === "unknown") return json(response, 404, { error: "unknown session" });
        if (result.kind === "denied") return json(response, 409, { error: result.reason });
        return json(response, 502, { error: result.error });
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "POST" && pathname === "/api/tasks/retry") {
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        const rawTaskId = (body as { taskId?: unknown } | null)?.taskId;
        if (typeof rawTaskId !== "string" || rawTaskId.trim().length === 0) {
          return json(response, 400, { error: "invalid retry request" });
        }
        const result = application.retryFailedTask(taskId(rawTaskId));
        return json(response, result.kind === "accepted" ? 200 : 409, result);
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "POST" && pathname === "/api/tasks") {
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        const input = body as { taskId?: unknown; title?: unknown; dependencies?: unknown; requiredEvidence?: unknown } | null;
        const rawTaskId = typeof input?.taskId === "string" ? input.taskId.trim() : "";
        const title = typeof input?.title === "string" ? input.title.trim() : "";
        if (rawTaskId.length === 0 || title.length === 0) {
          return json(response, 400, { error: "taskId and title are required" });
        }
        const dependencies = Array.isArray(input?.dependencies)
          ? input.dependencies.flatMap((entry) => (typeof entry === "string" && entry.length > 0 ? [taskId(entry)] : []))
          : [];
        const requiredEvidence = Array.isArray(input?.requiredEvidence)
          ? input.requiredEvidence.flatMap((entry) => {
            if (typeof entry !== "object" || entry === null) return [];
            const requirement = entry as { authority?: unknown; subject?: unknown };
            const validAuthorities = ["environment", "host", "mcp", "reviewer"];
            if (
              typeof requirement.authority === "string" && validAuthorities.includes(requirement.authority) &&
              typeof requirement.subject === "string" && requirement.subject.length > 0
            ) {
              return [{ authority: requirement.authority as "environment" | "host" | "mcp" | "reviewer", subject: requirement.subject }];
            }
            return [];
          })
          : [];
        application.addTask({ id: taskId(rawTaskId), title, dependencies, requiredEvidence });
        // Echo the post-add state: a dependency-free task recomputes to READY
        // immediately, so a hard-coded BLOCKED would misreport the graph.
        const state = application.snapshot().tasks.find((task) => task.id === rawTaskId)?.state ?? "BLOCKED";
        return json(response, 201, { taskId: rawTaskId, state });
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    // W083: the canonical step ledger (roadmap → tasks → steps) is the custom
    // web UI's tracking surface (stock OpenCode v2 removed native todos). Reads
    // compose the application's public API — never the raw TaskGraph — and the
    // kernel's structured rejections surface verbatim so the panel can never
    // self-certify a step.
    if (request.method === "GET" && pathname === "/api/steps") {
      const snapshot = application.snapshot();
      // The panel's "active task" is the ledger-relevant fact: exactly one
      // task IN_PROGRESS. (The application's activation pointer is the
      // interactive-authorization correlation, a different concern.) Zero or
      // several IN_PROGRESS tasks read as null and the panel simply gates the
      // per-row actions on each task's own state.
      const inProgress = snapshot.tasks.filter((task) => task.state === "IN_PROGRESS");
      const activeTaskId = inProgress.length === 1 ? inProgress[0]?.id ?? null : null;
      return json(response, 200, {
        activeTaskId,
        tasks: snapshot.tasks.map((task) => {
          const id = taskId(task.id);
          return {
            ...task,
            steps: application.taskSteps(id),
            activeStepId: application.activeStepId(id) ?? null,
          };
        }),
      });
    }
    if (
      request.method === "POST" &&
      (pathname === "/api/steps/start" || pathname === "/api/steps/complete" || pathname === "/api/steps/cancel")
    ) {
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        const rawStepId = (body as { id?: unknown } | null)?.id;
        if (typeof rawStepId !== "string" || rawStepId.trim().length === 0) {
          return json(response, 400, { error: "step id is required" });
        }
        const id = stepId(rawStepId);
        const result = pathname === "/api/steps/start"
          ? application.startTaskStep(id)
          : pathname === "/api/steps/complete"
            ? application.completeTaskStep(id)
            : application.cancelTaskStep(id);
        // Rejections are kernel decisions (illegal transition, missing fresh
        // evidence, task not in progress) — 409 with the structured code and
        // reason, never rewritten into a client-side success.
        return json(response, result.kind === "accepted" ? 200 : 409, result);
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "POST" && pathname === "/api/steps/define") {
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        const input = body as { taskId?: unknown; content?: unknown } | null;
        const rawTaskId = typeof input?.taskId === "string" ? input.taskId.trim() : "";
        const content = typeof input?.content === "string" ? input.content.trim() : "";
        if (rawTaskId.length === 0 || content.length === 0) {
          return json(response, 400, { error: "taskId and content are required" });
        }
        const id = taskId(rawTaskId);
        const known = application.snapshot().tasks.some((task) => task.id === rawTaskId);
        if (!known) return json(response, 404, { error: `unknown task ${rawTaskId}` });
        // Operator-gated decomposition: append one step to the task's ledger.
        // The appended step carries an explicit environment-evidence
        // requirement (subject `step:<content>`), the same contract the
        // native-todo bridge assigns — an empty requirement list would let the
        // step complete with zero evidence and hollow out I-3. Re-defining
        // carries the existing steps through unchanged; the kernel still
        // enforces I-2 (an active ledger cannot be silently cleared), and its
        // TypeError is surfaced verbatim.
        const existing = application.taskSteps(id).map((step) => ({
          id: step.id,
          content: step.content,
          requiredEvidence: [...step.requiredEvidence],
        }));
        try {
          const steps = application.defineTaskSteps(id, [
            ...existing,
            { content, requiredEvidence: [{ authority: "environment" as const, subject: `step:${content}` }] },
          ]);
          return json(response, 201, { steps });
        } catch (error) {
          return json(response, 409, { error: error instanceof Error ? error.message : String(error) });
        }
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "GET" && pathname === "/api/config-options") {
      if (unknownSession(request.url)) return json(response, 404, { error: "unknown session" });
      const active = await sessionChannel(request.url);
      if (active === undefined) return json(response, 503, { error: "ACP session unavailable" });
      return json(response, 200, { options: active.configOptions() });
    }
    if (request.method === "POST" && pathname === "/api/config-options") {
      if (unknownSession(request.url)) return json(response, 404, { error: "unknown session" });
      const active = await sessionChannel(request.url);
      if (active === undefined) return json(response, 503, { error: "ACP session unavailable" });
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        const input = body as { id?: unknown; value?: unknown } | null;
        const id = typeof input?.id === "string" && input.id.length > 0 ? input.id : undefined;
        const value = typeof input?.value === "string" || typeof input?.value === "boolean" ? input.value : undefined;
        if (id === undefined || value === undefined) return json(response, 400, { error: "invalid config option request" });
        if (!active.configOptions().some((option) => option.id === id)) {
          return json(response, 404, { error: "unknown config option" });
        }
        try {
          return json(response, 200, { options: await active.setConfigOption(id, value) });
        } catch (error) {
          return json(response, 502, { error: error instanceof Error ? error.message : "config update failed" });
        }
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "GET" && pathname === "/api/permission") {
      if (unknownSession(request.url)) return json(response, 404, { error: "unknown session" });
      const active = await sessionChannel(request.url);
      return json(response, 200, {
        available: active?.permissionAskingAvailable() ?? false,
        mode: active?.permissionMode() ?? "auto",
        pending: transportPermissionView(active?.pendingPermission() ?? null),
        patterns: active?.permissionPatterns() ?? { alwaysAllow: [], alwaysReject: [] },
      });
    }
    if (request.method === "POST" && pathname === "/api/permission") {
      if (unknownSession(request.url)) return json(response, 404, { error: "unknown session" });
      const active = await sessionChannel(request.url);
      if (active === undefined) return json(response, 503, { error: "ACP session unavailable" });
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        const input = body as { id?: unknown; decision?: unknown } | null;
        const id = typeof input?.id === "string" && input.id.length > 0 ? input.id : undefined;
        const decision = input?.decision;
        if (
          id === undefined ||
          (decision !== "allow_once" && decision !== "allow_always" && decision !== "reject_once" && decision !== "reject_always")
        ) {
          return json(response, 400, { error: "invalid permission decision request" });
        }
        if (!active.answerPermission(id, decision)) {
          return json(response, 404, { error: "unknown or stale permission request" });
        }
        return json(response, 200, {
          mode: active.permissionMode(),
          // W115 review round 1 P3: the answer response also carries
          // `pending` — null on every same-session path today (a concurrent
          // same-session park is PROMPT_BUSY-denied and the field is read
          // synchronously with the answer), but the legacy undefined-key
          // shape surfaces the oldest parked request overall. Whatever this
          // field carries rides the SAME transport view as the poll.
          pending: transportPermissionView(active.pendingPermission() ?? null),
          patterns: active.permissionPatterns(),
        });
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "POST" && pathname === "/api/permission-mode") {
      if (unknownSession(request.url)) return json(response, 404, { error: "unknown session" });
      const active = await sessionChannel(request.url);
      if (active === undefined) return json(response, 503, { error: "ACP session unavailable" });
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        const input = body as { mode?: unknown; reset?: unknown } | null;
        const mode = input?.mode;
        if (mode !== undefined && mode !== "auto" && mode !== "ask") {
          return json(response, 400, { error: "invalid permission mode" });
        }
        if (mode !== undefined) active.setPermissionMode(mode);
        if (input?.reset === true) active.resetPermissionPatterns();
        if (mode === undefined && input?.reset !== true) {
          return json(response, 400, { error: "nothing to update" });
        }
        return json(response, 200, {
          mode: active.permissionMode(),
          patterns: active.permissionPatterns(),
        });
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    if (request.method === "GET" && pathname === "/api/capabilities") {
      return json(response, 200, {
        capabilities: [...application.allowedCapabilities],
        // Process/network can only be enabled when workspace confinement is
        // active: the web CLI passes workspaceRoot before exposing toggles.
        workspaceConfinement: application.workspaceRoot !== undefined,
      });
    }
    if (request.method === "POST" && pathname === "/api/capabilities") {
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      try {
        const body = await readJson(request);
        const input = body as { capability?: unknown; enabled?: unknown } | null;
        const capability = typeof input?.capability === "string" ? input.capability : undefined;
        const enabled = input?.enabled;
        if (capability !== "process" && capability !== "network") {
          return json(response, 400, { error: "only process and network capabilities are toggleable" });
        }
        if (typeof enabled !== "boolean") return json(response, 400, { error: "enabled must be a boolean" });
        if (enabled && application.workspaceRoot === undefined) {
          return json(response, 409, { error: "capability requires workspace confinement, which is not active" });
        }
        application.setCapability(capability, enabled);
        return json(response, 200, { capability, enabled });
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    // The Workflow-owned MCP catalog: the control plane's canonical MCP server
    // list, projected into each agent's launch config on the next session. The
    // global file is the base; a workspace overlay (when the service has a
    // workspace) can be edited independently. Changes are launch-time by
    // nature — ACP fixes mcpServers at session creation — so the UI states
    // that they take effect on the next session.
    if (pathname === "/api/settings/mcp") {
      const paths = settingsPaths(settingsPathOptions());
      if (request.method === "GET") {
        const global = readSettingsFile(paths.global);
        const workspace = paths.workspace === undefined ? defaultSettings() : readSettingsFile(paths.workspace);
        return json(response, 200, {
          servers: mergeSettings(global, workspace).mcpServers,
          global: global.mcpServers,
          workspace: workspace.mcpServers,
          workspaceOverlay: paths.workspace !== undefined,
          // The vendored connector catalog: every toolbox MCP the operator can
          // enable with one toggle instead of hand-typed JSON.
          catalog: resolveToolboxCatalog(),
        });
      }
      if (request.method === "POST") {
        if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          return json(response, 415, { error: "content-type must be application/json" });
        }
        try {
          const body = await readJson(request);
          const input = body as { scope?: unknown; servers?: unknown } | null;
          const scope = input?.scope === "global" || input?.scope === "workspace"
            ? input.scope
            : paths.workspace === undefined ? "global" : "workspace";
          if (scope === "workspace" && paths.workspace === undefined) {
            return json(response, 409, { error: "workspace scope unavailable: the service has no workspace root" });
          }
          if (!Array.isArray(input?.servers)) return json(response, 400, { error: "servers must be an array" });
          const path = scope === "workspace" ? paths.workspace! : paths.global;
          const current = readSettingsFile(path);
          const normalized = normalizeSettings({ mcpServers: input.servers });
          writeSettingsFile(path, { ...current, mcpServers: normalized.mcpServers, updatedAt: new Date().toISOString() });
          return json(response, 200, { scope, servers: normalized.mcpServers });
        } catch {
          return json(response, 400, { error: "invalid request body" });
        }
      }
    }
    // Live MCP state (W074 follow-up, dual data lane): when the Workflow-owned
    // opencode server topology is running for this workspace, its enforced
    // gateway answers GET /api/mcp — the live server-side state ACP does not
    // expose. A read, not a mutation: no cross-origin gate needed, and the
    // honest "unavailable" states are values, never fabricated connections.
    if (request.method === "GET" && pathname === "/api/settings/mcp/live") {
      const stateHome = process.env.WORKFLOW_OPENCODE_SERVER_HOME ?? join(homedir(), ".workflow", "opencode-server");
      const live = await fetchLiveMcp({ workspace: options?.workspace ?? process.cwd(), stateHome });
      return json(response, 200, live);
    }
    // Live session statistics (W079, data lane read #2): the documented
    // aggregate through the enforced gateway, honest reasons when the
    // topology is not running. Read-only.
    if (request.method === "GET" && pathname === "/api/usage/sessions/live") {
      const stateHome = process.env.WORKFLOW_OPENCODE_SERVER_HOME ?? join(homedir(), ".workflow", "opencode-server");
      const live = await fetchSessionStats({ workspace: options?.workspace ?? process.cwd(), stateHome });
      return json(response, 200, live);
    }
    // W082: operator-triggered compaction over the documented v2 data lane —
    // POST /api/session/{agentSessionId}/compact through the enforced gateway
    // (classified forward in §2.5). The workflow session id selects the
    // record; the AGENT's v2 session id is what the route takes. The route
    // durably ADMITS a compaction request — it runs at the session's next
    // step boundary — so a 200 here means "queued", stated as such by the UI.
    if (request.method === "POST" && pathname === "/api/sessions/compact") {
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        return json(response, 415, { error: "content-type must be application/json" });
      }
      const manager = session instanceof WebSessionManager ? session : undefined;
      if (manager === undefined) {
        return json(response, 409, { error: "compaction needs the parallel session manager (single-session servers have no session registry)" });
      }
      try {
        const body = await readJson(request);
        const rawId = (body as { id?: unknown } | null)?.id;
        if (typeof rawId !== "string" || rawId.trim().length === 0) {
          return json(response, 400, { error: "session id is required" });
        }
        const agentSessionId = manager.agentSessionIdFor(rawId.trim());
        if (agentSessionId === undefined) {
          return json(response, 409, { error: "that session has no agent session yet — send a message first, then compact" });
        }
        const stateHome = process.env.WORKFLOW_OPENCODE_SERVER_HOME ?? join(homedir(), ".workflow", "opencode-server");
        const result = await compactSession({ workspace: options?.workspace ?? process.cwd(), stateHome, sessionId: agentSessionId });
        // A gateway-walk unavailability (no daemon, not loopback, did not
        // answer) maps to 503 like the sibling unavailable reads; every other
        // refusal stays a 409 with the verbatim reason.
        return json(response, result.compacted ? 200 : result.unavailable === true ? 503 : 409, result);
      } catch {
        return json(response, 400, { error: "invalid request body" });
      }
    }
    // The scheduler's operator surface lives on main's Schedules page (the hub
    // proxy above): a live registry with pause/resume/delete/run-now, which
    // supersedes this branch's read-only file-table read.
    // Persisted agent runtime preferences (model/mode/effort). These are the
    // launch defaults the control plane pushes into each agent's config on the
    // next session; live changes still ride ACP `setConfigOption`.
    if (pathname === "/api/settings/agents") {
      if (request.method === "GET") {
        const paths = settingsPaths(settingsPathOptions());
        const global = readSettingsFile(paths.global);
        const workspace = paths.workspace === undefined ? defaultSettings() : readSettingsFile(paths.workspace);
        return json(response, 200, {
          agents: mergeSettings(global, workspace).agents,
          // Routing facts the env currently dictates — presence booleans and
          // the upstream URL only, never secret values.
          facts: {
            upstream: process.env.WORKFLOW_ACP_UPSTREAM?.trim() || "https://openrouter.ai",
            envModelOpencode: (process.env.WORKFLOW_OPENCODE_MODEL ?? "").trim().length > 0,
            envModelGoose: [
              process.env.WORKFLOW_GOOSE_MODEL,
              process.env.GOOSE_MODEL,
              process.env.AZURE_FOUNDRY_MODEL,
            ].some((entry) => (entry ?? "").trim().length > 0),
            managementKey: (process.env.WORKFLOW_OPENROUTER_MANAGEMENT_KEY ?? "").trim().length > 0,
          },
        });
      }
      if (request.method === "POST") {
        if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          return json(response, 415, { error: "content-type must be application/json" });
        }
        try {
          const paths = settingsPaths(settingsPathOptions());
          const body = await readJson(request);
          const input = body as { agent?: unknown; preference?: unknown; scope?: unknown } | null;
          const agent = typeof input?.agent === "string" && input.agent.trim().length > 0 ? input.agent.trim() : undefined;
          if (agent === undefined) return json(response, 400, { error: "agent is required" });
          const normalized = normalizeSettings({ agents: { [agent]: input?.preference } });
          const preference = normalized.agents[agent];
          if (preference === undefined) return json(response, 400, { error: "preference must set at least one of model, mode, thoughtLevel, autoCompact" });
          const scope = input?.scope === "global" || input?.scope === "workspace"
            ? input.scope
            : paths.workspace === undefined ? "global" : "workspace";
          if (scope === "workspace" && paths.workspace === undefined) {
            return json(response, 409, { error: "workspace scope unavailable: the service has no workspace root" });
          }
          const path = scope === "workspace" ? paths.workspace! : paths.global;
          const current = readSettingsFile(path);
          writeSettingsFile(path, {
            ...current,
            agents: { ...current.agents, [agent]: { ...(current.agents[agent] ?? {}), ...preference } },
            updatedAt: new Date().toISOString(),
          });
          return json(response, 200, { scope, agent, preference });
        } catch {
          return json(response, 400, { error: "invalid request body" });
        }
      }
    }
    if (request.method === "GET" && pathname.startsWith("/api/image/")) {
      if (unknownSession(request.url)) return json(response, 404, { error: "unknown session" });
      const active = await sessionChannel(request.url);
      const stored = active?.image(decodeURIComponent(pathname.slice("/api/image/".length)));
      if (stored === undefined) return json(response, 404, { error: "not found" });
      response.writeHead(200, { "content-type": stored.mediaType, "cache-control": "private, immutable" });
      return response.end(Buffer.from(stored.data, "base64"));
    }
    if (request.method === "GET" && pathname === "/api/session") {
      if (unknownSession(request.url)) return json(response, 404, { error: "unknown session" });
      const active = await sessionChannel(request.url);
      const requested = sessionId(request.url);
      // History-first: a session with no live runtime serves its persisted
      // transcript and last-known usage straight from the registry — viewing
      // history never spawns an agent process.
      const candidate = active === undefined ? manager?.historyFor(requested) : undefined;
      const stored = candidate !== undefined && (candidate.items.length > 0 || candidate.usage !== undefined) ? candidate : undefined;
      const meta = active === undefined ? undefined : (requested === undefined
        ? manager?.activeMeta()
        : manager?.list().find((entry) => entry.id === requested));
      // The live handshake's version for the requested session, when known.
      const agentVersion = manager?.agentVersion(requested);
      const spawnError = active === undefined ? manager?.spawnError(requested) : undefined;
      return json(response, 200, {
        available: active !== undefined,
        ...(spawnError === undefined ? {} : { error: spawnError }),
        ...(active === undefined
          ? (candidate === undefined ? {} : { id: candidate.id, title: candidate.title, agent: candidate.agent })
          : {
            ...(meta === undefined ? {} : { id: meta.id, title: meta.title, agent: meta.agent }),
            ...(agentVersion === undefined ? {} : { agentVersion }),
          }),
        state: active?.state() ?? (stored === undefined ? { state: "unavailable" } : { state: "stored" }),
        items: active?.items() ?? stored?.items ?? [],
        // Slash commands the live agent advertised; absent (never fabricated)
        // when no runtime is connected.
        ...(active === undefined ? {} : { commands: active.availableCommands() }),
        ...((active?.usage() ?? stored?.usage) === undefined ? {} : { usage: active?.usage() ?? stored!.usage }),
        ...(active?.budgetMechanism() === undefined ? {} : {
          budgetMechanism: active.budgetMechanism(),
          ...(active?.budgetViolation() === undefined ? {} : { budgetViolation: active.budgetViolation() }),
        }),
      });
    }
    if (request.method === "POST" && pathname === "/api/prompt") {
      if (unknownSession(request.url)) return json(response, 404, { error: "unknown session" });
      const active = await sessionChannel(request.url);
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
    if (request.method === "POST" && pathname === "/api/cancel") {
      if (unknownSession(request.url)) return json(response, 404, { error: "unknown session" });
      const active = await sessionChannel(request.url);
      if (active === undefined) return json(response, 503, { error: "ACP session unavailable" });
      if (!isTrustedMutation(request)) return json(response, 403, { error: "cross-origin mutation denied" });
      await active.cancel();
      return json(response, 200, { cancelled: true });
    }
    if (request.method === "POST" && pathname === "/api/transition") {
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

/** W115: the 1s permission poll is a transport, not a bulk channel. An
 * oversized parked payload can never be approved (the card's 64 KiB
 * inspection cap renders it NOT-APPROVABLE-WITH-REASON), so shipping it to
 * the browser every poll is pure amplification. The transport view strips
 * `input` for flagged payloads and keeps the flag — the card stays
 * NOT-APPROVABLE-WITH-REASON without the payload, and the broker's parked
 * in-memory request is untouched for the answer path. */
function transportPermissionView(pending: PendingPermissionRequest | null) {
  if (pending === undefined || pending === null || pending.inputOverCap !== true) return pending;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the rest sibling IS the W115 strip: the payload is discarded by design
  const { input: _stripped, ...view } = pending;
  return { ...view, inputOverCap: true };
}

export interface GitWorktree {
  readonly path: string;
  readonly head?: string;
  /** Short branch name; null for bare/detached entries. */
  readonly branch: string | null;
  readonly bare: boolean;
  readonly detached: boolean;
  /** The worktree the web server's workspace lives in. */
  readonly current: boolean;
}

/** `git worktree list --porcelain`, parsed; the source for the collapsible
 * left-rail list. Read-only — switching worktrees stays an operator command. */
async function gitWorktrees(workspace: string): Promise<readonly GitWorktree[]> {
  const { stdout } = await execGit("git", ["worktree", "list", "--porcelain"], {
    cwd: workspace,
    maxBuffer: 1024 * 1024,
  });
  const worktrees: GitWorktree[] = [];
  let current: { path?: string; head?: string; branch?: string; bare?: boolean; detached?: boolean } = {};
  const flush = (): void => {
    if (current.path === undefined) return;
    worktrees.push({
      path: current.path,
      ...(current.head === undefined ? {} : { head: current.head }),
      branch: current.branch ?? null,
      bare: current.bare === true,
      detached: current.detached === true,
      current: current.path === workspace,
    });
    current = {};
  };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  flush();
  return worktrees;
}

async function gitStatus(workspace: string): Promise<{ branch: string; changes: GitChange[] }> {
  const { stdout } = await execGit("git", ["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"], {
    cwd: workspace,
    maxBuffer: 1024 * 1024,
  });
  const records = stdout.split("\0");
  const header = records.shift() ?? "";
  const branch = header.startsWith("## ") ? header.slice(3).split("...")[0] ?? "HEAD" : "HEAD";
  const changes: GitChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    let sourcePath: string | undefined;
    if (code.includes("R") || code.includes("C")) {
      // Porcelain -z reports the destination in this record, then the source.
      sourcePath = records[index + 1] || undefined;
      index += 1;
    }
    changes.push({ path, status: gitChangeStatus(code), ...(sourcePath === undefined ? {} : { sourcePath }) });
  }
  changes.sort((left, right) => left.path.localeCompare(right.path));
  return { branch, changes };
}

function gitChangeStatus(code: string): GitChangeStatus {
  if (code === "??") return "untracked";
  if (code.includes("R") || code.includes("C")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
}

async function gitDiff(workspace: string, change: GitChange): Promise<string> {
  if (change.status === "untracked") {
    try {
      const { stdout } = await execGit("git", ["diff", "--no-index", "--", "/dev/null", change.path], {
        cwd: workspace,
        maxBuffer: 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      if (typeof stdout === "string") return stdout;
      throw error;
    }
  }
  try {
    await execGit("git", ["rev-parse", "--verify", "HEAD"], { cwd: workspace });
    const paths = change.sourcePath === undefined ? [change.path] : [change.sourcePath, change.path];
    const { stdout } = await execGit("git", ["diff", "HEAD", "--", ...paths], { cwd: workspace, maxBuffer: 1024 * 1024 });
    return stdout;
  } catch {
    const [staged, unstaged] = await Promise.all([
      execGit("git", ["diff", "--cached", "--", change.path], { cwd: workspace, maxBuffer: 1024 * 1024 }),
      execGit("git", ["diff", "--", change.path], { cwd: workspace, maxBuffer: 1024 * 1024 }),
    ]);
    return `${staged.stdout}${unstaged.stdout}`;
  }
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

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#101216"><title>Workflow Control</title><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
