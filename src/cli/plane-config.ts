import { isAbsolute } from "node:path";

/**
 * C1 plane configuration — the pure seam the `workflow-plane` supervisor
 * resolves from the environment before it starts anything.
 *
 * Fail-closed by construction: `WORKFLOW_PLANE=1` is mandatory (a loopback
 * launcher must never silently become a public one), the gateway bind must be
 * explicit, and the client password MUST be an injected stable value — a
 * fresh random password per start would strand the operator on every replica
 * roll (`src/cli/opencode-server.ts` mints `newTuiPassword()` today).
 */
export interface PlaneConfig {
  readonly workspace: string;
  readonly gatewayHost: string;
  readonly gatewayPort: number;
  /** Stable client-facing credential injected by the instance (Key Vault). */
  readonly clientPassword: string;
}

/** The default single front-door bind (the C0-qualified ingress port). */
export const PLANE_GATEWAY_HOST = "0.0.0.0";
export const PLANE_GATEWAY_PORT = 4096;

/**
 * Minimum length of the injected client password. A floor (not a strength
 * policy) guards against a truncated/empty secret while still allowing an
 * operator-chosen short credential: the password is a stable value the
 * operator configures their client with, not a machine-generated one, so a
 * longer floor would only reject valid operator choices.
 */
export const MIN_CLIENT_PASSWORD_LENGTH = 8;

/**
 * Resolves plane mode from the environment. Throws (fail closed) on any
 * missing or malformed required value — never degrades to a loopback default,
 * which would silently leave ingress with no listener on 4096.
 */
export function resolvePlaneConfig(env: NodeJS.ProcessEnv, fallbackWorkspace: string): PlaneConfig {
  if (env.WORKFLOW_PLANE !== "1") {
    throw new Error("workflow-plane requires WORKFLOW_PLANE=1 (plane mode is an explicit opt-in)");
  }
  const workspace = env.WORKFLOW_PLANE_WORKSPACE ?? fallbackWorkspace;
  if (!isAbsolute(workspace)) {
    throw new Error(`WORKFLOW_PLANE_WORKSPACE must be an absolute path (got ${JSON.stringify(workspace)})`);
  }
  const gatewayHost = env.WORKFLOW_PLANE_GATEWAY_HOST ?? PLANE_GATEWAY_HOST;
  const rawPort = env.WORKFLOW_PLANE_GATEWAY_PORT;
  const gatewayPort = rawPort === undefined ? PLANE_GATEWAY_PORT : Number(rawPort);
  if (!Number.isInteger(gatewayPort) || gatewayPort <= 0 || gatewayPort > 65535) {
    throw new Error(`WORKFLOW_PLANE_GATEWAY_PORT must be an integer in 1..65535 (got ${JSON.stringify(rawPort)})`);
  }
  const clientPassword = env.WORKFLOW_PLANE_CLIENT_PASSWORD;
  if (clientPassword === undefined || clientPassword.length < MIN_CLIENT_PASSWORD_LENGTH) {
    // A short/absent password is a misconfiguration, not a degrade-to-random:
    // the whole point is a value the operator's client can be configured with.
    throw new Error(`workflow-plane requires WORKFLOW_PLANE_CLIENT_PASSWORD (>= ${MIN_CLIENT_PASSWORD_LENGTH} chars) from the instance secret store`);
  }
  return { workspace, gatewayHost, gatewayPort, clientPassword };
}
