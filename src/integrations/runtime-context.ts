/**
 * W181 (A6, NVIDIA adoption): the runtime-context projection — agent-facing
 * guidance adapted from NemoClaw's `runtime-context.ts` pattern (see
 * `docs/NVIDIA_ADOPTION_PLAN.md` Wave A item A6).
 *
 * PRESENTATION ONLY. This module is a pure projection into the agent's
 * instruction surface; it is never imported by `src/kernel/` and it carries no
 * enforcement. Egress enforcement, where it exists, lives at the proxy/policy
 * boundary (`src/integrations/model-usage-proxy.ts`, eventually
 * `egress-policy.ts`).
 *
 * The load-bearing honesty rule (the same discipline the plan applies to
 * agent-facing text): the projection asserts *deny-by-default* only when an
 * enforcing posture actually exists. Today the metering proxy is pass-through
 * (the W052 token-binding reject plus, later, the W178/W180 policy tier); there
 * is no deny-by-default gate for arbitrary endpoints, so `egressPostureFromEnv`
 * returns `absent` and `egressRuntimeContext` returns `undefined`. A test pins
 * that no posture except `proxy-gated` emits any deny-by-default claim, so the
 * text can never run ahead of the boundary it describes.
 *
 * The three teaching points:
 *  - egress through the proxy is policy-gated, not a free socket;
 *  - *attempt* a restricted endpoint rather than refusing preemptively — a
 *    policy denial surfaces an operator decision (rides W182), it is not a
 *    dead end;
 *  - distinguish a policy denial (a structured proxy `403` with a policy tag)
 *    from DNS / connection-timeout / TLS failure classes, which are transport
 *    faults to diagnose rather than approval cases.
 */

/** The postures Workflow can actually be in. Extend as real boundary work lands. */
export const EGRESS_POSTURES = ["absent", "advisory", "proxy-gated"] as const;
export type EgressPosture = (typeof EGRESS_POSTURES)[number];

/**
 * The declaring env var for an enforcing posture. Today no code sets it: the
 * W178 policy engine and W180 proxy reject tier do not exist at this revision,
 * so production stays `absent`. When those land, the composition site derives
 * the posture from the real boundary (a policy in `enforce` mode) instead of an
 * operator flag — this reader is the honest placeholder until then.
 */
export const EGRESS_POSTURE_ENV = "WORKFLOW_EGRESS_POSTURE";

export function isEgressPosture(value: unknown): value is EgressPosture {
  return typeof value === "string" && (EGRESS_POSTURES as readonly string[]).includes(value);
}

/**
 * Reads the declared posture from the environment. Unset / unrecognized →
 * `absent` (never fabricate a gate). A declared `proxy-gated` is only honored
 * when `WORKFLOW_EGRESS_POLICY=1` also carries an enforcing policy; without a
 * policy the boundary is not actually deny-by-default, so the posture stays
 * `advisory`. This two-signal gate is deliberate: the text may not assert a
 * posture from one flag.
 */
export function egressPostureFromEnv(env: NodeJS.ProcessEnv = process.env): EgressPosture {
  const declared = env[EGRESS_POSTURE_ENV]?.trim();
  if (!isEgressPosture(declared) || declared === "absent") return "absent";
  if (declared === "proxy-gated" && env.WORKFLOW_EGRESS_POLICY?.trim() === "1") return "proxy-gated";
  return "advisory";
}

/**
 * The instruction body for an enforcing `proxy-gated` posture, or `undefined`
 * for every other posture. Returning `undefined` (rather than an "advisory"
 * hint) is intentional: an observability-only boundary has nothing to teach and
 * a partial claim risks reading as a gate.
 *
 * The text is bounded and static; the caller decides *where* it is delivered
 * (the hub-owned OpenCode config references it as an instruction file when the
 * posture is active).
 */
export function egressRuntimeContext(posture: EgressPosture): string | undefined {
  if (posture !== "proxy-gated") return undefined;
  return [
    "# Egress through the Workflow proxy",
    "",
    "Model and network egress from this session passes through the Workflow",
    "metering proxy and is policy-gated: destinations and functions outside the",
    "operator's allowlist are denied by default. Do not treat a restriction as",
    "permanent — and do not refuse a task preemptively because you expect a",
    "denial.",
    "",
    "- **Attempt the restricted endpoint.** A policy denial parks an operator",
    "  approval decision; it is a request for a human decision, not a dead end.",
    "- **A policy denial** is a structured proxy response carrying a `policy`",
    "  tag (for example `egress-credential` on a rejected credential). Report it",
    "  as an operator decision that is pending or refused — do not retry it",
    "  unchanged and do not work around it.",
    "- **A transport failure is not a policy denial.** DNS resolution failure,",
    "  connection timeouts, and TLS/certificate errors are network faults: they",
    "  mean the request never reached a policy boundary, so diagnose or retry",
    "  them rather than escalating for approval.",
    "",
  ].join("\n");
}
