/**
 * W082 — the hub-side session-compaction monitor (the data-lane backstop).
 *
 * The config-side trigger composes `compaction: { auto: true }` into the
 * hub-written config (the runtime compacts itself); this monitor is the
 * hub-owned backstop for sessions driven through the server topology: a
 * deterministic `tick` reads every session's context usage from the
 * documented API (each `GET /api/session` entry carries the same
 * `tokens` shape the runtime's own overflow check uses — live-verified on
 * stock v2.0.10) and, when a session's usage crosses the operator-set
 * threshold, fires the documented `POST /api/session/{id}/compact` route
 * (classified `forward`, operator-controlled maintenance).
 *
 * Determinism: `tick` uses an injected clock and fetch; `start`/`stop` wrap
 * an interval (unref'd) for the daemon. Honesty: every outcome — fire,
 * veto, unavailable, error — is recorded in the tick result and never
 * fabricated as a success. Hysteresis: a session is not re-attempted until
 * its usage drops below the threshold (compaction actually freed context)
 * or its failure cooldown expires (with doubling backoff — an
 * uncompactable session is retried on a slowing schedule, never hammered).
 * Budget-aware: a sticky session-budget violation vetoes firing — a
 * compaction turn spends money, and the budget is the operator's stop.
 */

export interface CompactionMonitorOptions {
  /** Loopback upstream base URL (the daemon's runtime). */
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  /** The operator-set threshold in tokens; the monitor never invents one. */
  readonly thresholdTokens: number;
  /** Sticky session-budget veto: a truthy reason stops all firing. */
  readonly veto?: () => string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: () => Date;
  /** Cooldown base between fire attempts per session (ms). */
  readonly cooldownMs?: number;
  /** Poll interval for `start` (ms). */
  readonly intervalMs?: number;
}

export interface CompactionTickResult {
  readonly evaluated: number;
  readonly fired: readonly string[];
  readonly skipped: readonly { readonly sessionId: string; readonly reason: string }[];
  readonly errors: readonly string[];
}

export interface SessionCompactionMonitor {
  /** Evaluate every session once (deterministic; tests call this directly). */
  tick(): Promise<CompactionTickResult>;
  /** Start the wall-clock loop (unref'd). */
  start(): void;
  stop(): void;
}

function usageOf(session: Record<string, unknown>): number {
  const tokens = typeof session.tokens === "object" && session.tokens !== null
    ? (session.tokens as Record<string, unknown>)
    : undefined;
  const cache = typeof tokens?.cache === "object" && tokens.cache !== null
    ? (tokens.cache as Record<string, unknown>)
    : undefined;
  const total = typeof tokens?.total === "number" && Number.isFinite(tokens.total) ? tokens.total : undefined;
  if (total !== undefined) return total;
  const part = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return (
    part(tokens?.input) + part(tokens?.output) + part(tokens?.reasoning) +
    part(cache?.read) + part(cache?.write)
  );
}

export function createSessionCompactionMonitor(options: CompactionMonitorOptions): SessionCompactionMonitor {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? ((): Date => new Date());
  const cooldownBase = options.cooldownMs ?? 10 * 60_000;
  const auth = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
  const headers = { authorization: auth };
  /** Re-arm state: sessions currently above threshold that were fired (or are
   * cooling down) — cleared when usage drops below the threshold. */
  const armed = new Map<string, { at: number; failures: number }>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = async (): Promise<CompactionTickResult> => {
    const fired: string[] = [];
    const skipped: { sessionId: string; reason: string }[] = [];
    const errors: string[] = [];
    const stamp = now().getTime();

    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl}/api/session`, { headers, signal: AbortSignal.timeout(4_000) });
    } catch (error) {
      return { evaluated: 0, fired, skipped, errors: [`the session read failed: ${error instanceof Error ? error.message : String(error)}`] };
    }
    if (!response.ok) {
      return { evaluated: 0, fired, skipped, errors: [`the session read returned ${response.status}`] };
    }
    const body = await response.json().catch(() => undefined) as { data?: unknown } | undefined;
    if (body === undefined || !Array.isArray(body.data)) {
      return { evaluated: 0, fired, skipped, errors: ["the session read returned an unexpected shape"] };
    }

    const vetoReason = options.veto?.();
    let evaluated = 0;
    for (const entry of body.data) {
      if (typeof entry !== "object" || entry === null) continue;
      const session = entry as Record<string, unknown>;
      const id = typeof session.id === "string" ? session.id : undefined;
      if (id === undefined) continue;
      evaluated += 1;
      const usage = usageOf(session);

      // Re-arm: usage below threshold (compaction freed context) resets the
      // failure backoff and forgets the session.
      if (usage < options.thresholdTokens) {
        armed.delete(id);
        continue;
      }
      const state = armed.get(id);
      if (state !== undefined) {
        // Hysteresis with doubling backoff: while usage stays above the
        // threshold, retry only after the cooldown (failures double it).
        const wait = state.failures === 0
          ? cooldownBase
          : Math.min(cooldownBase * 2 ** (state.failures - 1), 60 * 60_000);
        if (stamp - state.at < wait) {
          skipped.push({ sessionId: id, reason: "cooling down since the last attempt" });
          continue;
        }
      }
      const vetoed = vetoReason === undefined ? undefined : vetoReason;
      if (vetoed !== undefined) {
        skipped.push({ sessionId: id, reason: `session-budget veto: ${vetoed}` });
        continue;
      }
      let compactResponse: Response;
      try {
        compactResponse = await fetchImpl(`${options.baseUrl}/api/session/${encodeURIComponent(id)}/compact`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        armed.set(id, { at: stamp, failures: (state?.failures ?? 0) + 1 });
        errors.push(`${id}: the compaction request failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!compactResponse.ok) {
        const payload = await compactResponse.json().catch(() => undefined) as { data?: { message?: unknown } | undefined; message?: unknown } | undefined;
        const message = typeof payload?.data?.message === "string" ? payload.data.message : undefined;
        armed.set(id, { at: stamp, failures: (state?.failures ?? 0) + 1 });
        errors.push(`${id}: the gateway refused the compaction request (${compactResponse.status})${message === undefined ? "" : `: ${message}`}`);
        continue;
      }
      // The documented 200 IS the durable admission; anything else is an
      // error counted above, never a fabricated success.
      armed.set(id, { at: stamp, failures: 0 });
      fired.push(id);
    }
    return { evaluated, fired, skipped, errors };
  };

  return {
    tick,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void tick().then((result) => {
          if (result.fired.length > 0) console.log(`session-compaction monitor fired compaction for ${result.fired.join(", ")}`);
          for (const error of result.errors) console.error(`session-compaction monitor: ${error}`);
        }).catch(() => undefined);
      }, options.intervalMs ?? 60_000);
      timer.unref();
    },
    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}