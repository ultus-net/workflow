/**
 * W183: resolves the egress policy the contained-agent launch gives the
 * parent-side forward proxy for the `network: "proxied"` posture.
 *
 * Until a settings/control-plane surface owns per-workspace policy, the policy
 * comes from an operator-provided JSON file (`WORKFLOW_EGRESS_POLICY_FILE`),
 * loaded once and validated with W178's `validateEgressPolicy`. An absent file
 * means no proxied policy exists, so the launcher keeps the pre-W183 `host`
 * posture — a launch is never failed merely because no policy file is present.
 * A present-but-invalid file fails closed (a malformed policy must not become
 * an allow-all proxy).
 *
 * The file shape is `{ "rules": [...] }` (an `EgressPolicy`). The loader is
 * deliberately small; the policy *decision* stays in `egress-policy.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  validateEgressPolicy,
  type EgressPolicy,
  type EgressRule,
} from "./egress-policy.js";

export class EgressPolicyFileError extends Error {}

function parseRules(value: unknown, source: string): EgressPolicy {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { rules?: unknown }).rules)) {
    throw new EgressPolicyFileError(`egress policy ${source} must be an object with a rules array`);
  }
  const rules = (value as { rules: unknown[] }).rules.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new EgressPolicyFileError(`egress policy ${source} rule #${index} must be an object`);
    }
    const rule = entry as Partial<EgressRule>;
    if (typeof rule.host !== "string" || (rule.mode !== "audit" && rule.mode !== "enforce")) {
      throw new EgressPolicyFileError(`egress policy ${source} rule #${index} needs a string host and an audit|enforce mode`);
    }
    return {
      ...(typeof rule.id === "string" ? { id: rule.id } : {}),
      host: rule.host,
      ...(typeof rule.port === "number" ? { port: rule.port } : {}),
      ...(Array.isArray(rule.methods) ? { methods: rule.methods.filter((method): method is string => typeof method === "string") } : {}),
      ...(Array.isArray(rule.paths) ? { paths: rule.paths.filter((path): path is string => typeof path === "string") } : {}),
      mode: rule.mode,
    } satisfies EgressRule;
  });
  return { rules };
}

/**
 * Loads and validates the operator egress policy. Returns `undefined` when no
 * path is configured or the file does not exist (no proxied policy → the
 * launcher keeps the host posture). Throws `EgressPolicyFileError` on a
 * configured-but-unreadable, unparseable, or invalid policy (fail closed).
 */
export function loadEgressPolicyFile(path: string | undefined = process.env.WORKFLOW_EGRESS_POLICY_FILE): EgressPolicy | undefined {
  if (path === undefined || path.trim().length === 0) return undefined;
  const trimmed = path.trim();
  if (!isAbsolute(trimmed)) throw new EgressPolicyFileError(`WORKFLOW_EGRESS_POLICY_FILE must be an absolute path (got ${JSON.stringify(trimmed)})`);
  if (!existsSync(trimmed)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(trimmed, "utf8"));
  } catch (error) {
    throw new EgressPolicyFileError(`egress policy ${trimmed} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const policy = parseRules(parsed, trimmed);
  const validation = validateEgressPolicy(policy);
  if (!validation.valid) {
    throw new EgressPolicyFileError(`egress policy ${trimmed} is invalid: ${validation.issues.map((issue) => issue.message).join("; ")}`);
  }
  return policy;
}
