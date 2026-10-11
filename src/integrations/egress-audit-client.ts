import type { EgressObservation, EgressTokenClass } from "./model-usage-proxy.js";
import { defaultDataRoot, EgressAuditLedger, EGRESS_TOKEN_CLASSES } from "./egress-ledger.js";

/**
 * W181 (A5, NVIDIA adoption): the honest seam between the metering proxy's
 * egress observation stream and the egress-audit ledger.
 *
 * IN-PROCESS (2026-10-11, feat/mcp-to-integrations). This seam used to spawn the
 * vendored `egress-audit-mcp` server over stdio and map the proxy's
 * structurally-owned `EgressObservation` onto the ledger's append calls across a
 * package boundary. The ledger core now lives in
 * `src/integrations/egress-ledger.ts` (moved verbatim), so the same mapping
 * calls the ledger directly — no child process, no `StdioClientTransport`, no
 * package-boundary structural copy. The token-class set is imported from the
 * ledger rather than mirrored, so the two can no longer drift.
 *
 * The ledger stays ADVISORY / READ-ONLY EVIDENCE: the appender only ever calls
 * `append`/`appendReject`; it cannot query-and-block, cannot change proxy
 * behavior, and a ledger failure is swallowed (an audit sink that could fail a
 * model request would turn observability into enforcement).
 *
 * NO SECRETS, PLACEHOLDERS, OR QUERY STRINGS. The mapper forwards `domain`
 * (already a bare hostname on the observation), `functionClass` (path-derived
 * label), and `tokenClass` (a closed enum) only. The `source` label names the
 * emitting surface; nothing request-derived crosses.
 */

/** Structural copy of the ledger's `AppendReachInput`. */
export interface EgressReachInput {
  readonly domain: string;
  readonly functionClass: string;
  readonly tokenClass: EgressTokenClass;
  readonly source: string;
  readonly observedAt?: number;
}

/** Structural copy of the ledger's `AppendRejectInput` (W181 A5). */
export interface EgressRejectInput {
  readonly domain: string;
  readonly functionClass: string;
  readonly tokenClass: EgressTokenClass;
  readonly policy: string;
  readonly source: string;
  readonly observedAt?: number;
}

/**
 * The ledger's token-class set, re-exported from the single declaration in
 * `egress-ledger.ts`. Kept as an export because the W181 parity test names it;
 * it is now the ledger's own list (same module), not a redeclared mirror.
 */
export const EGRESS_LEDGER_TOKEN_CLASSES = EGRESS_TOKEN_CLASSES;

/** The emitting surface label recorded on every appended event. */
export const EGRESS_PROXY_SOURCE = "model-usage-proxy";

/**
 * Pure mapping from the proxy's observation to the ledger's append input.
 * A `reach` maps to an `EgressReachInput`; a `reject` maps to an
 * `EgressRejectInput` (the ledger keeps rejections separate from reaches — a
 * rejected request never reached a destination). No clock: `observedAt` is left
 * to the ledger's arrival time so the mapping stays pure and testable.
 */
export function egressReachInput(observation: EgressObservation, source: string = EGRESS_PROXY_SOURCE): EgressReachInput | undefined {
  if (observation.kind !== "reach") return undefined;
  return {
    domain: observation.destination,
    functionClass: observation.functionClass,
    tokenClass: observation.tokenClass,
    source,
  };
}

export function egressRejectInput(observation: EgressObservation, source: string = EGRESS_PROXY_SOURCE): EgressRejectInput | undefined {
  if (observation.kind !== "reject") return undefined;
  return {
    domain: observation.destination,
    functionClass: observation.functionClass,
    tokenClass: observation.tokenClass,
    policy: observation.anomalyContext.policy,
    source,
  };
}

/** The ledger calls the feed actually makes (one append per event). */
export interface EgressReachAppender {
  appendReach(input: EgressReachInput): Promise<void>;
  appendReject(input: EgressRejectInput): Promise<void>;
  close(): Promise<void>;
}

export interface EgressAuditAppenderOptions {
  /** Directory the ledger document is written to. Defaults to `defaultDataRoot`. */
  readonly dataDir?: string;
}

/**
 * The Workflow-side appender for the egress-audit ledger. Establishes the
 * in-process ledger eagerly and returns an appender issuing one append per
 * call. The ledger's own append-only/bounded semantics decide acceptance; a
 * full ledger refuses the append (that rejection surfaces to the feed, which
 * logs and drops).
 */
export function createEgressAuditAppender(options: EgressAuditAppenderOptions = {}): Promise<EgressReachAppender> {
  const ledger = new EgressAuditLedger(options.dataDir ?? defaultDataRoot());
  return Promise.resolve({
    async appendReach(input: EgressReachInput): Promise<void> {
      const { source, ...rest } = input;
      await ledger.append({ ...rest, source });
    },
    async appendReject(input: EgressRejectInput): Promise<void> {
      const { source, ...rest } = input;
      await ledger.appendReject({ ...rest, source });
    },
    async close(): Promise<void> {
      // No child process or handle to release (in-process ledger).
    },
  });
}

export interface EgressAuditFeedOptions {
  readonly appender: EgressReachAppender;
  /** Bounded in-flight queue depth; past it events drop rather than grow memory. */
  readonly maxPending?: number;
  /** Observability hook for a dropped/refused append; defaults to a stderr line. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

/**
 * The proxy's `onEgressObservation` callback wired to the ledger. Serialized:
 * one append is in flight at a time, preserving arrival order. BOUNDED: past
 * `maxPending` (default 32) a reach is dropped rather than queued, so a slow or
 * wedged ledger cannot grow the proxy's memory. Every failure is swallowed by
 * default — the audit sink is advisory evidence and must never fail a model
 * request.
 *
 * Returns the callback; callers pass it as `onEgressObservation` when composing
 * the proxy (and typically feed every proxy in a pool).
 */
export function createEgressAuditFeed(options: EgressAuditFeedOptions): (observation: EgressObservation) => void {
  const maxPending = options.maxPending ?? 32;
  const onError = options.onError ?? ((error: unknown) => console.error(`egress audit feed dropped an event: ${error instanceof Error ? error.message : String(error)}`));
  let pending = 0;
  let tail: Promise<void> = Promise.resolve();
  return (observation: EgressObservation): void => {
    if (pending >= maxPending) {
      onError(new Error(`egress audit feed is saturated at ${maxPending} pending appends; dropping an event`));
      return;
    }
    const append = observation.kind === "reach"
      ? (): Promise<void> => options.appender.appendReach({ domain: observation.destination, functionClass: observation.functionClass, tokenClass: observation.tokenClass, source: EGRESS_PROXY_SOURCE })
      : (): Promise<void> => options.appender.appendReject({ domain: observation.destination, functionClass: observation.functionClass, tokenClass: observation.tokenClass, policy: observation.anomalyContext.policy, source: EGRESS_PROXY_SOURCE });
    pending += 1;
    tail = tail
      .catch(() => undefined)
      .then(append)
      .catch((error: unknown) => onError(error))
      .finally(() => {
        pending -= 1;
      });
  };
}

export interface EgressRuntimeFeed {
  readonly onEgressObservation: (observation: EgressObservation) => void;
  close(): Promise<void>;
}

/**
 * Production composition for the OpenCode runtime: open the in-process ledger
 * appender and return the proxy callback plus a closer. Env-gated OFF by
 * default (`WORKFLOW_EGRESS_AUDIT_FEED=1`) so the behavior change is an explicit,
 * reviewable operator choice; a construction failure degrades to
 * observation-off with a visible log rather than failing the session. Because
 * the ledger is in-process there is no vendored build to probe, so the gate is
 * the only condition.
 */
export async function createEgressRuntimeFeed(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly dataDir?: string;
} = {}): Promise<EgressRuntimeFeed | undefined> {
  const env = options.env ?? process.env;
  if (env.WORKFLOW_EGRESS_AUDIT_FEED?.trim() !== "1") return undefined;
  try {
    const appender = await createEgressAuditAppender(options.dataDir === undefined ? {} : { dataDir: options.dataDir });
    return {
      onEgressObservation: createEgressAuditFeed({ appender }),
      close: () => appender.close(),
    };
  } catch (error) {
    console.error(`egress audit feed unavailable (continuing without it): ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
