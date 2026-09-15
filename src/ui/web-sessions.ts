import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { WorkflowAcpRuntime } from "../integrations/acp-runtime.js";
import type { PermissionBroker } from "./permission-broker.js";
import { SessionChannel } from "./web-session-channel.js";

export interface WebSessionMeta {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly active: boolean;
}

interface SessionRecord {
  id: string;
  agentSessionId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

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

/** session/load gets this long to replay before the switch proceeds without it. */
const RESUME_LOAD_TIMEOUT_MS = 30_000;

/**
 * Owns the session registry (persisted metadata) and the single live ACP
 * runtime behind the browser UI. One agent process runs at a time: switching
 * or creating disposes the current runtime and spawns the next one, resuming
 * history through ACP session/load when the registry knows the agent id.
 */
export class WebSessionManager {
  readonly #factory: (resumeFrom?: string) => Promise<WorkflowAcpRuntime>;
  readonly #registryPath: string;
  readonly #permissionBroker: PermissionBroker | undefined;
  #sessions: SessionRecord[];
  #active: ActiveSession | undefined;
  #starting: Promise<ActiveSession> | undefined;
  #switchQueue: Promise<unknown> = Promise.resolve();

  /**
   * Serializes switches so concurrent create/activate calls can never spawn
   * two runtimes at once — without it the losing runtime (agent process and
   * metering proxy) would leak undisposed.
   */
  #enqueueSwitch(record: SessionRecord, resumeFrom: string | undefined): Promise<SessionSwitchResult> {
    const run = this.#switchQueue.then(() => this.#switchTo(record, resumeFrom));
    this.#switchQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  constructor(options: {
    readonly factory: (resumeFrom?: string) => Promise<WorkflowAcpRuntime>;
    readonly registryPath?: string;
    readonly permissionBroker?: PermissionBroker;
  }) {
    this.#factory = options.factory;
    this.#permissionBroker = options.permissionBroker;
    this.#registryPath = options.registryPath ?? join(homedir(), ".workflow", "web-sessions.json");
    this.#sessions = loadRegistry(this.#registryPath);
  }

  list(): WebSessionMeta[] {
    // The registry is stored most-recent-first; updatedAt is millisecond-precision
    // ISO, so co-created records tie — break ties toward the more recent entry.
    return [...this.#sessions.entries()]
      .sort(([indexA, a], [indexB, b]) => b.updatedAt.localeCompare(a.updatedAt) || indexA - indexB)
      .map(([, record]) => this.#meta(record));
  }

  /** Active channel, lazily creating the first session on demand. */
  async channel(): Promise<SessionChannel> {
    if (this.#starting !== undefined) await this.#starting.catch(() => undefined);
    return (await this.#ensureActive()).channel;
  }

  activeMeta(): WebSessionMeta | undefined {
    return this.#active === undefined ? undefined : this.#meta(this.#active.record);
  }

  async create(): Promise<SessionSwitchResult> {
    if (this.#starting !== undefined) await this.#starting.catch(() => undefined);
    const record: SessionRecord = {
      id: `web-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      title: "New session",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return this.#enqueueSwitch(record, undefined);
  }

  async activate(id: string): Promise<SessionSwitchResult> {
    if (this.#starting !== undefined) await this.#starting.catch(() => undefined);
    const record = this.#sessions.find((entry) => entry.id === id);
    if (record === undefined) return { kind: "unknown" };
    if (this.#active?.record.id === id) return { kind: "ok", meta: this.#meta(record) };
    return this.#enqueueSwitch(record, record.agentSessionId);
  }

  /**
   * Removes a session from the registry. Dismissing the active session moves
   * to the next most recent one (or creates a fresh one when none remain).
   * The agent's own session store is untouched; Workflow simply forgets the link.
   */
  async dismiss(id: string): Promise<SessionSwitchResult> {
    if (this.#starting !== undefined) await this.#starting.catch(() => undefined);
    if (this.#active?.record.id === id && this.#active.channel.busy()) return { kind: "busy" };
    const record = this.#sessions.find((entry) => entry.id === id);
    if (record === undefined) return { kind: "unknown" };
    const wasActive = this.#active?.record.id === id;
    this.#sessions = this.#sessions.filter((entry) => entry.id !== id);
    this.#persist();
    if (!wasActive) return { kind: "ok", meta: { ...this.#meta(record), active: false } };
    const next = this.#sessions[0];
    if (next === undefined) return this.create();
    return this.#enqueueSwitch(next, next.agentSessionId);
  }

  /** Removes every unused ("New session"-titled) non-active record; returns how many. */
  async clearUnused(): Promise<number> {
    if (this.#starting !== undefined) await this.#starting.catch(() => undefined);
    const before = this.#sessions.length;
    this.#sessions = this.#sessions.filter((entry) => entry.title !== "New session" || this.#active?.record.id === entry.id);
    if (this.#sessions.length !== before) this.#persist();
    return before - this.#sessions.length;
  }

  async dispose(): Promise<void> {
    this.#captureActive();
    this.#persist();
    const active = this.#active;
    this.#active = undefined;
    await active?.runtime.dispose();
  }

  async #switchTo(record: SessionRecord, resumeFrom: string | undefined): Promise<SessionSwitchResult> {
    // Busy-check and capture the outgoing session without spawning a runtime
    // when nothing is active yet.
    if (this.#active !== undefined) {
      if (this.#active.channel.busy()) return { kind: "busy" };
      this.#captureActive();
    }
    // Stamp the incoming record after the outgoing capture so the activated
    // session is never older than the one it replaces — the capture above can
    // otherwise land on a later millisecond and flip the recency sort.
    record.updatedAt = new Date().toISOString();
    this.#sessions = [record, ...this.#sessions.filter((entry) => entry.id !== record.id)];
    const previous = this.#active;
    this.#active = undefined;
    // A parked permission prompt belongs to the outgoing runtime's turn;
    // switching away must answer it (denied) instead of leaving the old
    // agent process waiting on a response it will never receive.
    this.#permissionBroker?.cancelPending("session switched away");
    await previous?.runtime.dispose();
    try {
      const runtime = await this.#factory(resumeFrom);
      const channel = new SessionChannel(
        runtime.session,
        runtime.driver,
        runtime.usage?.bind(runtime),
        this.#permissionBroker,
      );
      // Eagerly load the resumed session so its replayed history reaches the
      // channel before the UI polls — otherwise the transcript looks empty
      // until the first prompt. The subscription lasts only for the load.
      if (resumeFrom !== undefined) {
        const unsubscribe = runtime.driver.subscribe((event) => channel.ingest(event));
        let timer: NodeJS.Timeout | undefined;
        try {
          // Bounded wait: a hung session/load must not pend the switch queue
          // forever. The session stays usable; the replay simply never arrived.
          // The timer is always cleared so it never outlives the load itself.
          const loading = runtime.driver.connect();
          await Promise.race([
            loading,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, RESUME_LOAD_TIMEOUT_MS);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          unsubscribe();
        }
      }
      this.#active = { record, runtime, channel };
      this.#persist();
      return { kind: "ok", meta: this.#meta(record) };
    } catch (error) {
      this.#persist();
      return { kind: "failed", error: error instanceof Error ? error.message : "session start failed" };
    }
  }

  async #ensureActive(): Promise<ActiveSession> {
    if (this.#active !== undefined) {
      this.#touchActive();
      return this.#active;
    }
    this.#starting ??= (async () => {
      // Restart continuity: resume the most recent session instead of
      // accumulating an empty "New session" record on every service start.
      const existing = this.#sessions[0];
      if (existing !== undefined) {
        const resumed = await this.#switchTo(existing, existing.agentSessionId);
        if (resumed.kind === "ok" && this.#active !== undefined) return this.#active;
      }
      const created = await this.#switchTo({
        id: `web-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
        title: "New session",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, undefined);
      if (created.kind !== "ok" || this.#active === undefined) {
        throw new Error(created.kind === "failed" ? created.error : "session start failed");
      }
      return this.#active;
    })();
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  /** Copies volatile facts (agent session id, agent/derived title) into the record. */
  #captureActive(): void {
    if (this.#active === undefined) return;
    const agentId = this.#active.runtime.driver.agentSessionId();
    if (agentId !== undefined) this.#active.record.agentSessionId = agentId;
    // An agent-provided title (session_info_update) is the most accurate
    // label and outranks both the placeholder and the derived-from-prompt title.
    const agentTitle = this.#active.channel.agentTitle();
    if (agentTitle !== undefined) {
      this.#active.record.title = agentTitle.length > 60 ? `${agentTitle.slice(0, 60)}…` : agentTitle;
    } else if (this.#active.record.title === "New session") {
      const firstUser = this.#active.channel.items().find((item) => item.kind === "user");
      if (firstUser !== undefined && firstUser.kind === "user") {
        this.#active.record.title = firstUser.text.length > 60 ? `${firstUser.text.slice(0, 60)}…` : firstUser.text;
      }
    }
    this.#active.record.updatedAt = new Date().toISOString();
  }

  #touchActive(): void {
    this.#captureActive();
    this.#persist();
  }

  #meta(record: SessionRecord): WebSessionMeta {
    return {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      active: this.#active?.record.id === record.id,
    };
  }

  #persist(): void {
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
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}
