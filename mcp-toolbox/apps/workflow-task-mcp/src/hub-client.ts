/**
 * The hub client for `workflow-task-mcp` (W072 Stage 3).
 *
 * WHY HTTP AND NOT AN IMPORT. The canonical step ledger lives behind the hub's
 * ordinary-token `/steps/*` routes (`src/integrations/hub-http.ts`). This app is
 * a separate pnpm package whose `tsconfig` rootDir is `src`, so it cannot import
 * `src/integrations/hub-discovery.ts`; the discovery read and the request shapes
 * are MIRRORED STRUCTURALLY here and pinned by `test/hub-client.test.ts`.
 *
 * NO SECRET ON ARGV. The ordinary token is read from the hub's published
 * `discovery.json` (0600, `~/.workflow/hub/`), re-read on every call so a hub
 * restart is picked up; it is never passed as a command-line argument. The
 * `WORKFLOW_HUB_URL`/`WORKFLOW_HUB_TOKEN` overrides exist for tests and for a
 * caller that already holds the credentials.
 *
 * FAIL CLOSED. A missing/malformed discovery file, an unreachable hub, or a
 * non-2xx response raises a clear error; this client NEVER fabricates an
 * accepted transition from a failed call.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The hub's loopback endpoint + ordinary token. */
export interface HubCredentials {
  readonly url: string;
  readonly token: string;
}

/** The discovery directory (the parent of the `hub/` subdirectory). */
export function hubDiscoveryDirectory(override?: string): string {
  return override ?? process.env.WORKFLOW_HUB_DIR ?? resolve(homedir(), ".workflow");
}

/**
 * Read the hub's loopback endpoint + ordinary token, re-read on every call so
 * a hub restart is picked up without restarting this server. Returns `undefined`
 * when no hub is running or the file is malformed — the same fail-closed read
 * `src/integrations/hub-discovery.ts` performs.
 */
export function readHubCredentials(override?: string): HubCredentials | undefined {
  const path = join(hubDiscoveryDirectory(override), "hub", "discovery.json");
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
}

/**
 * Env overrides win over the discovery read (tests set them; a caller that
 * already holds the credentials may too). A partial override falls back to the
 * discovery file for the missing half.
 */
export function resolveHubCredentials(override?: string): HubCredentials | undefined {
  const discovered = readHubCredentials(override);
  const url = process.env.WORKFLOW_HUB_URL ?? discovered?.url;
  const token = process.env.WORKFLOW_HUB_TOKEN ?? discovered?.token;
  if (url === undefined || token === undefined) return undefined;
  return { url, token };
}

/** The `/steps/*` routes this app drives. */
export type StepRoute = "list" | "define" | "start" | "complete" | "cancel";

export const STEP_ROUTES: readonly StepRoute[] = ["list", "define", "start", "complete", "cancel"];

/**
 * A hub refusal. A route answers 4xx with `{ error: string }` (a boundary
 * client fault) or, for `/steps/start|complete|cancel`, a kernel
 * `StepTransitionResult` on 409. Both are surfaced to the caller verbatim as a
 * tool error — never rewritten to a client-side success.
 */
export class HubStepError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(route: StepRoute, status: number, detail: unknown) {
    const message =
      typeof detail === "object" && detail !== null && typeof (detail as Record<string, unknown>).error === "string"
        ? (detail as { error: string }).error
        : typeof detail === "object" && detail !== null && typeof (detail as Record<string, unknown>).reason === "string"
          ? typeof (detail as Record<string, unknown>).code === "string"
            ? `${(detail as { code: string }).code}: ${(detail as { reason: string }).reason}`
            : (detail as { reason: string }).reason
          : `hub /steps/${route} answered ${status}`;
    super(message);
    this.name = "HubStepError";
    this.status = status;
    this.detail = detail;
  }
}

export interface StepCallResult {
  /** The parsed JSON body the hub returned (already a success shape). */
  readonly body: unknown;
}

/**
 * POST one `/steps/<route>` request with the ordinary token. `signal` aborts
 * the request when the MCP caller cancels. Resolves with the parsed body on a
 * 2xx; throws `HubStepError` on any non-2xx. Throws a plain `Error` when the
 * hub is not configured or unreachable (both are "cannot proceed" conditions,
 * not silent no-ops).
 */
export async function callStepRoute(
  route: StepRoute,
  payload: Readonly<Record<string, unknown>>,
  options: { readonly signal?: AbortSignal; readonly credentials?: HubCredentials } = {},
): Promise<StepCallResult> {
  const credentials = options.credentials ?? resolveHubCredentials();
  if (credentials === undefined) {
    throw new Error(
      "Workflow hub is not configured: no discovery file under WORKFLOW_HUB_DIR (or ~/.workflow) and no WORKFLOW_HUB_URL/WORKFLOW_HUB_TOKEN. Start the hub or set the overrides.",
    );
  }
  const base = credentials.url.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${base}/steps/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${credentials.token}` },
      body: JSON.stringify(payload),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    throw new Error(`Workflow hub is unreachable at ${base}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) throw new HubStepError(route, response.status, body);
  return { body };
}
