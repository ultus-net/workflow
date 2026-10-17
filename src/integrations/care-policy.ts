import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * W213 / Q28: the care reality-orientation policy SEAM (deferred value).
 *
 * Q28 (`docs/decision-brief-seam-stores.md` lines 204-223, 235-238) asks how
 * the system responds when the USER asserts something false: gentle
 * orientation, validation without endorsement, or redirect. That value is
 * DEFERRED — the brief is explicit that it is set later by the operator with
 * clinical input, and the decision brief recommends ONLY the store shape
 * (Option C) and the read rule (curated core only), not this value.
 *
 * This module is the SEAM and nothing more: it reads `policy.yaml` from the
 * care directory (the same dir `care-facts.ts` reads) and reports the value
 * honestly. A missing dir or missing file reports `"unset"` — an honest
 * named absence, never a fabricated default behavior. The value is NOT wired
 * to any behavior in this slice; wiring it is the care loop's job (W214+),
 * gated on the operator actually setting it.
 *
 * Two distinct behaviors must not be conflated (the brief's Q28 resolution):
 * dropping an ungrounded LLM claim is STRUCTURAL (fail-closed, handled by
 * `care-facts.ts`'s gate, needs no policy value); responding to a false USER
 * assertion is this value, and it has no structural default — which is why it
 * stays unset until the operator decides.
 */

export const CareRealityOrientationSchema = z
  .enum(["unset", "orient_gently", "validate_without_endorsement", "redirect"])
  .default("unset");

/** The Q28 reality-orientation value. `"unset"` is the honest seam default. */
export type CareRealityOrientation = z.infer<typeof CareRealityOrientationSchema>;

const carePolicySchema = z.object({
  realityOrientation: CareRealityOrientationSchema,
});

export interface CarePolicy {
  readonly realityOrientation: CareRealityOrientation;
}

const POLICY_FILENAME = "policy.yaml";

/**
 * Read the care policy from `policy.yaml` under `dir`. A MISSING dir or file
 * is the honest `{ realityOrientation: "unset" }` (the seam is present, the
 * value is not). A present-but-malformed file THROWS — the seam never
 * fabricates a policy value and never silently reads a broken file as unset.
 */
export function readCarePolicy(dir: string): CarePolicy {
  let raw: string;
  try {
    raw = readFileSync(join(dir, POLICY_FILENAME), "utf8");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { realityOrientation: "unset" }; // honest absence: Q28 is deferred
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new TypeError("invalid care policy (" + join(dir, POLICY_FILENAME) + "): not parseable YAML (" + (error instanceof Error ? error.message : String(error)) + ")", { cause: error });
  }
  const result = carePolicySchema.safeParse(parsed ?? {});
  if (!result.success) {
    throw new TypeError("invalid care policy (" + join(dir, POLICY_FILENAME) + "): " + result.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join("; "));
  }
  return result.data;
}
