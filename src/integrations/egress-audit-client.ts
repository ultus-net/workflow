import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { EgressObservation, EgressTokenClass } from "./model-usage-proxy.js";

/**
 * W181 (A5, NVIDIA adoption): the honest seam between the metering proxy's
 * egress observation stream and the `egress-audit-mcp` ledger.
 *
 * WHY A BRIDGE AND NOT AN IMPORT. The ledger lives in `mcp-toolbox/apps/`
 * (a separate pnpm package, `tsconfig` rootDir `src`); `src/` must not import
 * across that boundary. So the proxy emits the structurally-owned
 * `EgressObservation` (see `model-usage-proxy.ts`), and this module maps that
 * shape onto the ledger's `AppendReachInput` and delivers it over MCP — the
 * same client pattern `src/integrations/project-memory.ts` uses. The mapping
 * test pins the proxy's token-class vocabulary to the ledger's.
 *
 * The ledger stays ADVISORY / READ-ONLY EVIDENCE: the appender only ever calls
 * `append_egress_reach`; it cannot query-and-block, cannot change proxy
 * behavior, and a ledger failure is swallowed (an audit sink that could fail a
 * model request would turn observability into enforcement).
 *
 * NO SECRETS, PLACEHOLDERS, OR QUERY STRINGS. The mapper forwards `domain`
 * (already a bare hostname on the observation), `functionClass` (path-derived
 * label), and `tokenClass` (a closed enum) only. The `source` label names the
 * emitting surface; nothing request-derived crosses.
 */

/**
 * Structural copy of the ledger's `AppendReachInput`
 * (`mcp-toolbox/apps/egress-audit-mcp/src/egress-ledger.ts`). Redeclared, not
 * imported, for the package-boundary reason above; the mapping test asserts the
 * `EgressTokenClass` sets are identical.
 */
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

/** The ledger token-class set, mirrored for the boundary parity test. */
export const EGRESS_LEDGER_TOKEN_CLASSES = ["session-placeholder", "absent", "foreign", "unknown"] as const;

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

/** The MCP ledger calls the feed actually makes (one append per event). */
export interface EgressReachAppender {
  appendReach(input: EgressReachInput): Promise<void>;
  appendReject(input: EgressRejectInput): Promise<void>;
  close(): Promise<void>;
}

export interface EgressAuditAppenderOptions {
  readonly serverScript: string;
  readonly dataDir?: string;
}

/**
 * The Workflow-side client for `egress-audit-mcp`. Mirrors
 * `createProjectMemoryClient`: a stdio MCP client is established eagerly and
 * the returned appender issues one `append_egress_reach` per call. The server's
 * own append-only/bounded semantics decide acceptance; a full ledger refuses
 * the append (that rejection surfaces to the feed, which logs and drops).
 */
export function createEgressAuditAppender(options: EgressAuditAppenderOptions): Promise<EgressReachAppender> {
  const client = new Client({ name: "workflow-egress-bridge", version: "1.0.0" });
  const env: Record<string, string> = options.dataDir === undefined ? {} : { EGRESS_AUDIT_DATA_DIR: options.dataDir };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.serverScript],
    stderr: "pipe",
    ...(Object.keys(env).length === 0 ? {} : { env }),
  });

  const ready = client.connect(transport).then(() => ({
    async appendReach(input: EgressReachInput): Promise<void> {
      const result = await client.callTool({ name: "append_egress_reach", arguments: { ...input } });
      if (result.isError) throw new Error(`egress-audit append_egress_reach failed: ${JSON.stringify(result.content)}`);
    },
    async appendReject(input: EgressRejectInput): Promise<void> {
      const result = await client.callTool({ name: "append_egress_reject", arguments: { ...input } });
      if (result.isError) throw new Error(`egress-audit append_egress_reject failed: ${JSON.stringify(result.content)}`);
    },
    async close(): Promise<void> {
      await client.close();
    },
  } satisfies EgressReachAppender));

  return ready;
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

/** The vendored `egress-audit-mcp` stdio entrypoint under a package/checkout root. */
export function egressAuditServerScript(root: string): string {
  return resolve(root, "mcp-toolbox", "apps", "egress-audit-mcp", "dist", "server.js");
}

/** Package root: two levels up from this module (src|dist/integrations → root). */
export function egressAuditPackageRoot(importUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(importUrl)), "..", "..");
}

export interface EgressRuntimeFeed {
  readonly onEgressObservation: (observation: EgressObservation) => void;
  close(): Promise<void>;
}

/**
 * Production composition for the OpenCode runtime: when the vendored
 * `egress-audit-mcp` build is present, open the MCP appender and return the
 * proxy callback plus a closer. ABSENT build → `undefined`, so the runtime
 * composes exactly as before (no phantom sink). Env-gated OFF by default so the
 * behavior change is an explicit, reviewable operator choice; a build or
 * connect failure degrades to observation-off with a visible log rather than
 * failing the session.
 */
export async function createEgressRuntimeFeed(options: {
  readonly root: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly dataDir?: string;
}): Promise<EgressRuntimeFeed | undefined> {
  const env = options.env ?? process.env;
  if (env.WORKFLOW_EGRESS_AUDIT_FEED?.trim() !== "1") return undefined;
  const serverScript = egressAuditServerScript(options.root);
  if (!existsSync(serverScript)) return undefined;
  try {
    const appender = await createEgressAuditAppender({
      serverScript,
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    });
    return {
      onEgressObservation: createEgressAuditFeed({ appender }),
      close: () => appender.close(),
    };
  } catch (error) {
    console.error(`egress audit feed unavailable (continuing without it): ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
