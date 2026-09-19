import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { WorkflowAcpRuntime } from "../integrations/acp-runtime.js";
import type { OperatorSessionItem } from "./operator-session.js";
import type { PermissionBroker } from "./permission-broker.js";
import { DEFAULT_WEB_AGENT, isWebAgentId, type WebAgentId } from "./web-agents.js";
import { SessionChannel, driverPermissionKey, type SessionUsageReadout } from "./web-session-channel.js";

export interface WebSessionMeta {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The session the operator UI is currently viewing (the focused one). */
  readonly active: boolean;
  /** The agent this session runs on (defaults to the server's lead agent). */
  readonly agent: WebAgentId;
  /** A live ACP runtime is spawned for this session right now. */
  readonly live: boolean;
  /** The live runtime's turn is in flight (parallel sessions run their own). */
  readonly busy: boolean;
}

interface SessionRecord {
  id: string;
  agentSessionId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  agent?: WebAgentId;
  /** Persisted transcript snapshot (bounded) — history is data, not control:
   * it stays viewable with no live runtime and no agent process. */
  items?: OperatorSessionItem[];
  /** Persisted usage readout; the channel merges it as a restart baseline. */
  usage?: SessionUsageReadout;
}

/** Transcript snapshot bound kept in the registry: enough to review a session,
 * small enough that the throttled persist never writes megabytes. */
const PERSISTED_ITEM_LIMIT = 100;

/** Failed-spawn backoff: the browser polls session state every ~1s, and a
 * spawn failure (stale resume, missing binary, crash-looping agent) must
 * never turn that poll into a re-spawn loop. 5s base, doubling to a 60s cap,
 * per record; a successful spawn resets it. */
const SPAWN_COOLDOWN_BASE_MS = 5_000;
const SPAWN_COOLDOWN_MAX_MS = 60_000;

interface ActiveSession {
  record: SessionRecord;
  runtime: WorkflowAcpRuntime;
  channel: SessionChannel;
}

export type SessionSwitchResult =
  | { readonly kind: "ok"; readonly meta: WebSessionMeta }
  | { readonly kind: "busy" }
  | { readonly kind: "unknown" }
  | { readonly kind: "failed"; readonly error: string };

/** session/load gets this long to replay before the session proceeds without it. */
const RESUME_LOAD_TIMEOUT_MS = 30_000;

/**
 * Bound on simultaneously live agent runtimes. Beyond it, the least recently
 * focused idle (non-busy, unfocused) runtime is disposed first; a refusal is
 * the honest fallback when every live session is busy or focused.
 */
const MAX_LIVE_RUNTIMES = 6;

/**
 * Owns the session registry (persisted metadata) and the parallel live ACP
 * runtimes behind the browser UI. Multiple agent processes may run at once —
 * one per live session, each with its own turn serialization and parked
 * permission prompts. Focusing a session never disposes another; runtimes are
 * disposed on dismiss, agent switch, and live-cap eviction. History resumes
 * through ACP session/load when the registry knows the agent id.
 */
export class WebSessionManager {
  readonly #factory: (agent: WebAgentId, resumeFrom?: string) => Promise<WorkflowAcpRuntime>;
  readonly #registryPath: string;
  readonly #permissionBroker: PermissionBroker | undefined;
  #sessions: SessionRecord[];
  /** Live runtimes by record id — parallel sessions, not one global. */
  readonly #live = new Map<string, ActiveSession>();
  /** Per-record in-flight spawns so concurrent callers share one runtime. */
  readonly #spawning = new Map<string, Promise<ActiveSession>>();
  /** The session the operator UI is viewing. */
  #focusId: string | undefined;
  /** Boot: the initial spawn (resume most recent, or create the first). */
  #boot: Promise<ActiveSession> | undefined;
  #lastTouchPersist = 0;
  /** Per-record spawn failures for the poll-storm backoff (see constants). */
  readonly #spawnFailures = new Map<string, { at: number; count: number; error: string }>();
  /** Cooldown base, overridable in tests so the doubling schedule is provable
   * without waiting real seconds. */
  readonly #spawnCooldownBaseMs: number;

  constructor(options: {
    readonly factory: (agent: WebAgentId, resumeFrom?: string) => Promise<WorkflowAcpRuntime>;
    readonly registryPath?: string;
    readonly permissionBroker?: PermissionBroker;
    readonly spawnCooldownBaseMs?: number;
  }) {
    this.#factory = options.factory;
    this.#permissionBroker = options.permissionBroker;
    this.#spawnCooldownBaseMs = options.spawnCooldownBaseMs ?? SPAWN_COOLDOWN_BASE_MS;
    this.#registryPath = options.registryPath ?? join(homedir(), ".workflow", "web-sessions.json");
    this.#sessions = loadRegistry(this.#registryPath);
    // Focus continuity across restarts: the most recent record is the one the
    // operator was viewing when the service stopped.
    this.#focusId = this.#sessions[0]?.id;
  }

  list(): WebSessionMeta[] {
    // The registry is stored most-recent-first; updatedAt is millisecond-precision
    // ISO, so co-created records tie — break ties toward the more recent entry.
    return [...this.#sessions.entries()]
      .sort(([indexA, a], [indexB, b]) => b.updatedAt.localeCompare(a.updatedAt) || indexA - indexB)
      .map(([, record]) => this.#meta(record));
  }

  /** Focused channel, lazily creating the first session on demand. With an id,
   * that session's live channel (spawned on demand — parallel sessions). */
  async channel(id?: string): Promise<SessionChannel> {
    if (this.#boot !== undefined) await this.#boot.catch(() => undefined);
    const target = await this.#ensureSession(id);
    return target.channel;
  }

  /** Whether the registry knows this session id (routes 404 on stale ids). */
  knowsSession(id: string): boolean {
    return this.#sessions.some((entry) => entry.id === id);
  }

  activeMeta(): WebSessionMeta | undefined {
    const focused = this.#focusId === undefined ? undefined : this.#sessions.find((entry) => entry.id === this.#focusId);
    return focused === undefined ? undefined : this.#meta(focused);
  }

  /** The session the operator UI is viewing (undefined when none is known). */
  activeId(): string | undefined {
    return this.#focusId;
  }

  /** Whether a live runtime exists for this session right now (no spawning). */
  isLive(id: string): boolean {
    return this.#live.has(id);
  }

  /** The recorded spawn failure for a session, if it is backing off — the
   * surface reports WHY the session is unavailable instead of a bare 503. */
  spawnError(id?: string): string | undefined {
    const record = (id === undefined ? undefined : this.#sessions.find((entry) => entry.id === id))
      ?? this.#sessions.find((entry) => entry.id === this.#focusId)
      ?? this.#sessions[0];
    return record === undefined ? undefined : this.#spawnFailures.get(record.id)?.error;
  }

  /** Stored history for a session (focused by default): pure registry data —
   * transcript snapshot plus last-known usage — served without ever spawning
   * a runtime. Viewing history is independent of controlling live sessions. */
  historyFor(id?: string): {
    readonly id: string;
    readonly title: string;
    readonly agent: WebAgentId;
    readonly live: boolean;
    readonly items: readonly OperatorSessionItem[];
    readonly usage?: SessionUsageReadout;
  } | undefined {
    const record = (id === undefined ? undefined : this.#sessions.find((entry) => entry.id === id))
      ?? this.#sessions.find((entry) => entry.id === this.#focusId)
      ?? this.#sessions[0];
    if (record === undefined) return undefined;
    return {
      id: record.id,
      title: record.title,
      agent: record.agent ?? DEFAULT_WEB_AGENT,
      live: this.#live.has(record.id),
      items: record.items ?? [],
      ...(record.usage === undefined ? {} : { usage: record.usage }),
    };
  }

  /** Handshake version of one session's live runtime (or the focused one).
   * undefined is honest: not connected, or the agent did not report a version. */
  agentVersion(id?: string): string | undefined {
    const record = (id === undefined ? undefined : this.#sessions.find((entry) => entry.id === id))
      ?? this.#focusedSession()?.record
      ?? this.#sessions[0];
    if (record === undefined) return undefined;
    return this.#live.get(record.id)?.channel.agentInfo()?.version;
  }

  /** Handshake facts by agent id, from every live runtime that reported one:
   * version and/or the agent's advertised session capabilities. Read paths
   * only — the /api/agents annotation must never spawn a runtime. */
  liveAgentFacts(): ReadonlyMap<WebAgentId, { readonly version?: string; readonly capabilities?: { readonly close: boolean; readonly fork: boolean; readonly list: boolean; readonly resume: boolean } }> {
    const facts = new Map<WebAgentId, { readonly version?: string; readonly capabilities?: { readonly close: boolean; readonly fork: boolean; readonly list: boolean; readonly resume: boolean } }>();
    for (const active of this.#live.values()) {
      const version = active.channel.agentInfo()?.version;
      const capabilities = active.channel.sessionCapabilities();
      if (version === undefined && capabilities === undefined) continue;
      facts.set(active.record.agent ?? DEFAULT_WEB_AGENT, {
        ...(version !== undefined ? { version } : {}),
        ...(capabilities !== undefined ? { capabilities } : {}),
      });
    }
    return facts;
  }

  async create(): Promise<SessionSwitchResult> {
    if (this.#boot !== undefined) await this.#boot.catch(() => undefined);
    const focused = this.#focusedSession();
    const record: SessionRecord = {
      id: `web-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      title: "New session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // New sessions continue on the operator's current agent so switching
      // agents and opening a fresh session compose without a surprise reset.
      ...(focused?.record.agent !== undefined ? { agent: focused.record.agent } : {}),
    };
    this.#sessions = [record, ...this.#sessions];
    this.#captureFocused();
    this.#focusId = record.id;
    this.#persist();
    try {
      await this.#ensure(record);
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error.message : "session start failed" };
    }
    return { kind: "ok", meta: this.#meta(record) };
  }

  /**
   * Switches a session's agent: the record keeps its identity, its live
   * runtime (if any) is disposed, and a fresh runtime spawns for the new
   * agent. A different agent owns a different session store, so the old agent
   * session id cannot carry over — the relaunch starts a fresh agent session.
   */
  async setActiveAgent(agent: WebAgentId, id?: string): Promise<SessionSwitchResult> {
    if (this.#boot !== undefined) await this.#boot.catch(() => undefined);
    const target = id === undefined ? this.#focusedSession()?.record : this.#sessions.find((entry) => entry.id === id);
    if (target === undefined) return { kind: "failed", error: "no active session" };
    const previousAgent = target.agent ?? DEFAULT_WEB_AGENT;
    if (previousAgent === agent) return { kind: "ok", meta: this.#meta(target) };
    const previousSessionId = target.agentSessionId;
    target.agent = agent;
    delete target.agentSessionId;
    // A different agent is a different launch: any prior spawn backoff no
    // longer describes it.
    this.#spawnFailures.delete(target.id);
    try {
      await this.#relaunch(target);
    } catch (error) {
      // A failed launch must not strand the record on the new agent: restore
      // the old agent and its resume link so the session recovers where it was.
      target.agent = previousAgent;
      if (previousSessionId !== undefined) target.agentSessionId = previousSessionId;
      this.#persist();
      return { kind: "failed", error: error instanceof Error ? error.message : "session relaunch failed" };
    }
    return { kind: "ok", meta: this.#meta(target) };
  }

  /** Focuses a session (and makes sure its runtime is live). Focusing never
   * disposes or interrupts any other session — parallel sessions keep running. */
  async activate(id: string): Promise<SessionSwitchResult> {
    if (this.#boot !== undefined) await this.#boot.catch(() => undefined);
    const record = this.#sessions.find((entry) => entry.id === id);
    if (record === undefined) return { kind: "unknown" };
    if (this.#focusId === id && this.#live.has(id)) return { kind: "ok", meta: this.#meta(record) };
    this.#captureFocused();
    this.#focusId = id;
    record.updatedAt = new Date().toISOString();
    this.#sessions = [record, ...this.#sessions.filter((entry) => entry.id !== record.id)];
    this.#persist();
    try {
      await this.#ensure(record);
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error.message : "session start failed" };
    }
    return { kind: "ok", meta: this.#meta(record) };
  }

  /**
   * Removes a session from the registry. Its live runtime is disposed and its
   * parked permission prompts denied — the agent process is going away.
   * Dismissing the focused session moves focus to the next most recent one.
   */
  async dismiss(id: string): Promise<SessionSwitchResult> {
    if (this.#boot !== undefined) await this.#boot.catch(() => undefined);
    const live = this.#live.get(id);
    if (live !== undefined && live.channel.busy()) return { kind: "busy" };
    const record = this.#sessions.find((entry) => entry.id === id);
    if (record === undefined) return { kind: "unknown" };
    this.#sessions = this.#sessions.filter((entry) => entry.id !== id);
    this.#spawnFailures.delete(id);
    this.#persist();
    await this.#disposeLive(id, live, "session dismissed");
    if (this.#focusId !== id) return { kind: "ok", meta: { ...this.#meta(record), active: false, live: false, busy: false } };
    const next = this.#sessions[0];
    if (next === undefined) return this.create();
    this.#focusId = next.id;
    this.#persist();
    return { kind: "ok", meta: this.#meta(record) };
  }

  /** Removes every unused ("New session"-titled, unfocused, idle) record;
   * returns how many. A record with a turn in flight keeps its runtime and its
   * registry entry — the derived title can still read "New session" mid-turn. */
  async clearUnused(): Promise<number> {
    if (this.#boot !== undefined) await this.#boot.catch(() => undefined);
    const before = this.#sessions.length;
    const isBusy = (id: string): boolean => this.#live.get(id)?.channel.busy() === true;
    const keep = this.#sessions.filter((entry) =>
      entry.title !== "New session" || entry.id === this.#focusId || isBusy(entry.id)
    );
    const removed = this.#sessions.filter((entry) => !keep.includes(entry));
    this.#sessions = keep;
    for (const record of removed) {
      await this.#disposeLive(record.id, this.#live.get(record.id), "unused session cleared");
    }
    if (removed.length > 0) this.#persist();
    return before - this.#sessions.length;
  }

  /** Operator rename; persists immediately and never touches runtimes. */
  rename(id: string, title: string): SessionSwitchResult {
    const record = this.#sessions.find((entry) => entry.id === id);
    if (record === undefined) return { kind: "unknown" };
    const trimmed = title.trim();
    if (trimmed.length === 0) return { kind: "failed", error: "title must not be empty" };
    record.title = trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
    this.#persist();
    return { kind: "ok", meta: this.#meta(record) };
  }

  async dispose(): Promise<void> {
    this.#captureAll();
    this.#persist();
    const live = [...this.#live.values()];
    this.#live.clear();
    this.#spawning.clear();
    this.#focusId = undefined;
    // Deny every parked prompt: every agent process is going away.
    this.#permissionBroker?.cancelPending("service shutting down");
    await Promise.all(live.map((active) => active.runtime.dispose()));
  }

  /** The live (or about-to-be) channel for a record id, focused by default.
   * Spawns the runtime on demand — parallel sessions run side by side. */
  async #ensureSession(id?: string): Promise<ActiveSession> {
    const record = (id === undefined ? undefined : this.#sessions.find((entry) => entry.id === id))
      ?? this.#focusedSession()?.record
      ?? this.#sessions[0];
    if (record === undefined) return await this.#bootFirst();
    return await this.#ensure(record);
  }

  /** One shared spawn per record; concurrent callers await the same promise. */
  /** One shared spawn per record; concurrent callers await the same promise.
   * Failures latch a cooldown so the 1s UI poll cannot re-spawn a dead agent
   * launch over and over. The failure count survives cooldown expiry so the
   * schedule escalates (5s → 10s → … capped at 60s); only a successful spawn
   * clears it. */
  async #ensure(record: SessionRecord): Promise<ActiveSession> {
    const existing = this.#live.get(record.id);
    if (existing !== undefined) {
      this.#touch(record);
      return existing;
    }
    const failure = this.#spawnFailures.get(record.id);
    if (failure !== undefined) {
      const cooldown = Math.min(this.#spawnCooldownBaseMs * 2 ** (failure.count - 1), SPAWN_COOLDOWN_MAX_MS);
      if (Date.now() - failure.at < cooldown) {
        throw new Error(`agent start backing off (${failure.count} failed attempt(s)): ${failure.error}`);
      }
      // Cooldown elapsed: one retry is allowed. The entry deliberately stays —
      // if this retry fails too, the count escalates instead of resetting.
    }
    const inFlight = this.#spawning.get(record.id);
    if (inFlight !== undefined) return inFlight;
    const spawned = this.#spawn(record);
    this.#spawning.set(record.id, spawned);
    try {
      const active = await spawned;
      this.#spawnFailures.delete(record.id);
      return active;
    } catch (error) {
      const previous = this.#spawnFailures.get(record.id);
      const count = (previous?.count ?? 0) + 1;
      const message = error instanceof Error ? error.message : String(error);
      this.#spawnFailures.set(record.id, { at: Date.now(), count, error: message });
      console.error(`web session ${record.id}: agent start failed (attempt ${count}, backing off): ${message}`);
      throw error;
    } finally {
      this.#spawning.delete(record.id);
    }
  }

  async #spawn(record: SessionRecord): Promise<ActiveSession> {
    await this.#enforceLiveCap(record.id);
    try {
      return await this.#attemptSpawn(record, record.agentSessionId);
    } catch (error) {
      if (record.agentSessionId === undefined) throw error;
      // A stale resume link must not brick the session: the agent's session
      // store lives in the per-runtime scratch HOME, which dispose deletes,
      // so a stored id cannot survive restarts or runtime eviction. Drop it
      // and try once as a fresh agent session — history stays readable from
      // the persisted transcript; control starts a new agent-side store.
      console.error(`web session ${record.id}: resume of ${record.agentSessionId} failed (${error instanceof Error ? error.message : String(error)}); restarting as a fresh agent session`);
      delete record.agentSessionId;
      this.#persist();
      return await this.#attemptSpawn(record, undefined);
    }
  }

  async #attemptSpawn(record: SessionRecord, resumeFrom: string | undefined): Promise<ActiveSession> {
    const runtime = await this.#factory(record.agent ?? DEFAULT_WEB_AGENT, resumeFrom);
    const channel = new SessionChannel(
      runtime.session,
      runtime.driver,
      runtime.usage?.bind(runtime),
      this.#permissionBroker,
      // Parked prompts key on the workflow permission-correlation id the
      // resolver puts on ProposedToolAction.sessionId — never the ACP id.
      () => driverPermissionKey(runtime.driver),
      // W045: the hub records the active budget mechanism (and the sticky
      // violation once crossed) per runtime, served on /api/session.
      {
        mechanism: () => runtime.budgetMechanism,
        ...(runtime.budgetViolation === undefined ? {} : { violation: () => runtime.budgetViolation?.() }),
      },
      // Restart continuity: the record's persisted readout becomes the
      // channel's baseline, so the meter never blanks between processes.
      record.usage,
    );
    // Eagerly establish the ACP session on every spawn, not only on resume:
    // a fresh session's connect() captures the agent's advertised config
    // (model/effort/mode options) so the pickers are populated before the
    // first prompt. On resume the same connect replays history into the
    // channel through the load subscription. The subscription lasts only
    // for the connect.
    const unsubscribe = runtime.driver.subscribe((event) => channel.ingest(event));
    let timer: NodeJS.Timeout | undefined;
    try {
      // Bounded wait: a hung session/new or session/load must not pend the
      // spawn forever. The session stays usable; the config/replay simply
      // never arrived. The timer is always cleared.
      const loading = runtime.driver.connect();
      await Promise.race([
        loading,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RESUME_LOAD_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      // A failed connect must not leak the just-spawned process tree.
      await runtime.dispose().catch(() => undefined);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
    }
    const active: ActiveSession = { record, runtime, channel };
    this.#live.set(record.id, active);
    this.#persist();
    return active;
  }

  /** Disposes a session's runtime and re-spawns it for the record's (new)
   * agent. The session's parked prompts resolve as denials — its agent is
   * going away. Busy sessions refuse up front (their turn is in flight). */
  async #relaunch(record: SessionRecord): Promise<void> {
    const live = this.#live.get(record.id);
    if (live !== undefined && live.channel.busy()) throw new Error("turn in flight");
    this.#capture(record, live);
    this.#persist();
    this.#live.delete(record.id);
    if (live !== undefined) {
      const permissionKey = driverPermissionKey(live.runtime.driver);
      this.#permissionBroker?.cancelPending("session agent switched", permissionKey);
      await live.runtime.dispose();
    }
    await this.#ensure(record);
  }

  /** Keeps the live-runtime bound honest: dispose the least recently focused
   * idle runtime when over the cap. Focused and busy sessions never evict. */
  async #enforceLiveCap(incomingId: string): Promise<void> {
    if (this.#live.size < MAX_LIVE_RUNTIMES) return;
    const evictable = [...this.#live.keys()]
      .filter((id) => id !== incomingId && id !== this.#focusId && !this.#live.get(id)?.channel.busy())
      .sort((a, b) => (this.#live.get(a)?.record.updatedAt ?? "").localeCompare(this.#live.get(b)?.record.updatedAt ?? ""));
    const victim = evictable[0];
    if (victim === undefined) {
      throw new Error(`live runtime limit (${MAX_LIVE_RUNTIMES}) reached: all sessions busy or focused`);
    }
    const active = this.#live.get(victim);
    if (active === undefined) return;
    this.#capture(active.record, active);
    this.#persist();
    this.#live.delete(victim);
    const permissionKey = driverPermissionKey(active.runtime.driver);
    this.#permissionBroker?.cancelPending("runtime evicted", permissionKey);
    await active.runtime.dispose();
  }

  #bootFirst(): Promise<ActiveSession> {
    this.#boot ??= (async () => {
      // Restart continuity: resume the most recent session instead of
      // accumulating an empty "New session" record on every service start.
      const existing = this.#sessions[0];
      if (existing !== undefined) {
        try {
          return await this.#ensure(existing);
        } catch { /* fall through to a fresh record */ }
      }
      const record: SessionRecord = {
        id: `web-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
        title: "New session",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.#sessions = [record, ...this.#sessions];
      this.#focusId = record.id;
      this.#persist();
      return this.#ensure(record);
    })();
    return this.#boot.finally(() => {
      this.#boot = undefined;
    });
  }

  #focusedSession(): ActiveSession | undefined {
    return this.#focusId === undefined ? undefined : this.#live.get(this.#focusId);
  }

  /** Copies volatile facts (agent session id, agent/derived title) plus the
   * history snapshot (bounded transcript, last-known usage) into a record.
   * The snapshot is what makes history independent of runtimes: after the
   * agent process dies — restart, eviction, crash — the transcript stays
   * readable and the meter shows its last-known numbers. */
  #capture(record: SessionRecord, active: ActiveSession | undefined): void {
    if (active === undefined) return;
    const agentId = active.runtime.driver.agentSessionId();
    if (agentId !== undefined) record.agentSessionId = agentId;
    // An agent-provided title (session_info_update) is the most accurate
    // label and outranks both the placeholder and the derived-from-prompt title.
    const agentTitle = active.channel.agentTitle();
    if (agentTitle !== undefined) {
      record.title = agentTitle.length > 60 ? `${agentTitle.slice(0, 60)}…` : agentTitle;
    } else if (record.title === "New session") {
      const firstUser = active.channel.items().find((item) => item.kind === "user");
      if (firstUser !== undefined && firstUser.kind === "user") {
        record.title = firstUser.text.length > 60 ? `${firstUser.text.slice(0, 60)}…` : firstUser.text;
      }
    }
    const items = active.channel.items();
    record.items = items.length > PERSISTED_ITEM_LIMIT ? items.slice(-PERSISTED_ITEM_LIMIT) : [...items];
    // The readout already includes the persisted baseline (the channel merges),
    // so what lands here carries history from earlier processes too.
    const usage = active.channel.usage();
    if (usage !== undefined) record.usage = usage;
    record.updatedAt = new Date().toISOString();
  }

  #captureFocused(): void {
    const focused = this.#focusedSession();
    if (focused === undefined) return;
    this.#capture(focused.record, focused);
    this.#persist();
  }

  #captureAll(): void {
    for (const active of this.#live.values()) this.#capture(active.record, active);
  }

  /** Polls touch a session; persistence is throttled so the 1s poll does not
   * rewrite the registry file every second. */
  #touch(record: SessionRecord): void {
    const active = this.#live.get(record.id);
    if (active === undefined) return;
    this.#capture(record, active);
    const now = Date.now();
    if (now - this.#lastTouchPersist < 5_000) return;
    this.#lastTouchPersist = now;
    this.#persist();
  }

  async #disposeLive(id: string, live: ActiveSession | undefined, reason: string): Promise<void> {
    if (live === undefined) return;
    this.#live.delete(id);
    const permissionKey = driverPermissionKey(live.runtime.driver);
    this.#permissionBroker?.cancelPending(reason, permissionKey);
    await live.runtime.dispose();
  }

  #meta(record: SessionRecord): WebSessionMeta {
    const live = this.#live.get(record.id);
    return {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      active: this.#focusId === record.id,
      agent: record.agent ?? DEFAULT_WEB_AGENT,
      live: live !== undefined,
      busy: live?.channel.busy() ?? false,
    };
  }

  #persist(): void {
    this.#captureAll();
    mkdirSync(dirname(this.#registryPath), { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({ version: 1, sessions: this.#sessions }, null, 2);
    const temporary = `${this.#registryPath}.tmp`;
    writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.#registryPath);
  }
}

function loadRegistry(path: string): SessionRecord[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { sessions?: SessionRecord[] };
    const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    // A corrupt agent value must not dispatch silently to the wrong runtime;
    // drop it so the session falls back to the documented default.
    return sessions.map((session) => {
      if (isWebAgentId(session.agent)) return session;
      const clone = { ...session };
      delete clone.agent;
      return clone;
    });
  } catch {
    return [];
  }
}