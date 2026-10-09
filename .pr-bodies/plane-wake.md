## Summary

Task 2b of the C1 Azure control-plane deploy plan: **launcher
plane-awareness**. The remote plane is always-on by posture (`minReplicas=1`),
but can still be unreachable (revision restart, manual scale-in, network). The
launcher now probes gateway health before attaching and classifies the state
before acting, per spec
`docs/superpowers/specs/2026-09-25-azure-container-jobs-remote-sandbox-design.md`
§10:230-246.

- **`src/integrations/plane-wake.ts` (new)** — a fail-closed, injectable
  module:
  - `classifyPlaneState` — `ready` / `asleep` / `broken` / `no-az`. Reachability
    wins; the `az` session gates the wake; scale-to-zero is the one wakeable
    state and outranks the stopped `runningStatus` a zero-replica app reports.
  - `ensurePlaneReady` — probe → classify → wake a proven-asleep plane → bounded
    health poll. Every path resolves to an outcome; a transport fault or a
    `wake` throw is reported (`broken`), never thrown out.
  - `resolvePlaneWakeTarget` — fail-closed env resolution (both ACA vars or
    neither).
  - `createAzurePlaneWakeDeps` — the real `az` deps (`account show` session
    gate, `containerapp show --query`, `containerapp update --min-replicas 1`);
    argument array, no shell.
  - `ensureExplicitPlaneReady` — the lane the launcher calls.
- **`src/cli/opencode-attach.ts`** — the explicit-gateway C1 lane classifies via
  `ensureExplicitPlaneReady` and fails closed with the honest state line for any
  non-ready verdict (previously it attached unconditionally). Usage text
  documents the plane + wake env vars.
- **`test/plane-wake.test.ts` (new, 17 pins)** — the classification table, the
  scale-to-zero precedence, **no-az never polls (never hangs)**, a ready plane
  never touches `az`, the wake-then-attach path, a wake that never becomes
  healthy resolving `broken`, a throwing resource read as `broken` (never
  asleep), the fail-closed partial env pair, the `az` JSON parse, the honest
  lines, the `az` argv shape (an injected-`azExec` pin), and a `main()`
  source-artifact anti-drift pin.
- **Docs** — plan Appendix C entry + `docs/ledger/control-plane-c1-plane-wake.md`
  fragment, `docs/CI.md` suite count (52→53), and a dated `THREAT_MODEL.md`
  residual for the launcher's `az` wake authority (and the earlier
  explicit-gateway narrowing, plan §6 item 8).

**One-way rule kept:** the module names only env VARIABLE names
(`WORKFLOW_PLANE_ACA_RESOURCE_GROUP`, `WORKFLOW_PLANE_ACA_APP`); the instance
supplies the values.

## Verification

- `node --import tsx --test test/plane-wake.test.ts` → **17/17**.
- Wider focused set (`plane-wake` + `plane-supervisor` +
  `opencode-server-launcher` + `workflow-launcher` + `kernel-purity` +
  `text-hygiene`) → **66/66**.
- `npm run typecheck` → exit 0. `npm run lint` → exit 0.

## Review

Fresh-eyes 5-axis review (recorded `independent-reviewer-task2b`). Round 1
**ACCEPT** with one warning (the `az` argv shape was code-review-only, not
test-pinned) and one note (dead `ingressFqdn` field); both closed in the
follow-up commit; round 2 **ACCEPT** recorded (`independent-reviewer-task2b-round2`).

## Residuals (recorded, not claimed)

- **No live `az` verification.** The real `containerapp show`/`update` calls are
  not executed against Azure here; the argv shape and classification are pinned
  by injected-exec/executors. C1 live is task 3.1 (🛰,
  `WORKFLOW_AZURE_PLANE_PROBE=1`). No "the plane wakes in Azure" claim is made.
- The wake is `--min-replicas 1` only; `broken` states (revision error, ingress
  gone) are reported, not blindly re-driven.

## Task: 2b
