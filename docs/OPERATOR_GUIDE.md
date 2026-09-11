# Operator Guide

Workflow is a deterministic in-process authority for task transitions, dependency readiness, evidence requirements, host-tool policy, and persisted workflow recovery. It is useful only for actions that actually pass through its application boundary.

Before treating a host as enforced, confirm that its concrete SDK adapter authoritatively intercepts every relevant mutation before execution. If it cannot, run it as advisory. Do not infer enforcement from transport names, prompts, model compliance, or the presence of a permission event.

`WorkflowApplication` allows `read` and `mutation` capabilities by default. `process`, `credentials`, and `network` are withheld unless explicitly granted when constructing the application. Granting them is application permission only. On supported Linux systems, `WorkflowContainedProcess` can pair that permission with the Bubblewrap backend described in `RUNTIME_CONTAINMENT.md`; an application `allow` alone is never containment evidence.

Evidence is subject-bound. Workflow accepts evidence only at the current mutation epoch and later stales it when a mutation affects the evidence subject. Unrelated mutations do not invalidate otherwise fresh evidence. MCP observations remain untrusted after normalization: normalization establishes shape, not truthfulness.

Local persistence uses version checks, an exclusive writer lock, randomized exclusive temporary files, file sync, and rename publication. A stale writer is rejected. A leftover lock fails closed. On restart an orphaned `IN_PROGRESS` task becomes `FAILED`; `VERIFYING` remains available for repeat verification. This is a local-store recovery mechanism, not distributed consensus, high availability, protection from a hostile local administrator, or a guarantee against every storage-device/power-loss failure.

For routine verification use:

```sh
npm test
npm run typecheck
npm run build
npm audit --audit-level=high
```

The browser demo binds to loopback by default and is not an authenticated remote control plane. Do not expose it through a public listener or reverse proxy as a production operator interface without adding an explicit authentication/authorization design.

When adding integrations, use `docs/HOST_ADAPTERS.md`, `docs/MCP_INTEGRATION.md`, and `docs/UI_INTEGRATION.md`. `THREAT_MODEL.md` is authoritative for security boundaries and residual risks.
