# Hub Control Plane: stock OpenCode web UI behind the Workflow hub

Idea-refine output (2026-09-20). Continuation of the 2026-09-16 pivot recorded in
`AGENTS.md` — this does not replace that direction, it extends it.

## Problem Statement

How might we give a single operator one terminal command that brings up a governed
agent workspace — stock OpenCode web UI in front, one control plane in the middle
owning policy/settings/skills/model-routing/MCP publish, and the agent behind it —
so that every mutation, config change, and model call crosses an authority the
operator actually controls, from any of their devices?

## Recommended Direction

Extend the existing hub-resolved launcher rather than introduce a new topology.
The pivot already made `workflow` launch the browser operator UI over stock-ACP
OpenCode with the hub composing `WorkflowApplication` in-process. This idea adds
three things to that spine:

1. **Stock OpenCode web UI as a second served surface.** The stock v2 web UI is
   reached *through* the hub, not around it. Two session transports already exist
   (`--driver acp`, `--driver opencode`); the route-class gateway
   (`src/integrations/opencode-v2-route-class.ts`, landed on `feat/web-chat-reapply`)
   is the qualification layer for the opencode-server transport: enforced posture
   forwards only classified read-only/input routes, brokers permission replies,
   and fails closed on everything else. For stock-ACP sessions the hub needs an
   opencode-API facade translating UI calls onto ACP engines — scoped by the same
   matrix.
2. **Config authority at the hub.** Settings, skills gating, model routing
   (`model-usage-proxy.ts`), and the MCP toolbox are published by the controller:
   the hub renders the opencode config (model-proxy base URL, MCP registrations,
   plugin pin) and agents receive it. The route matrix already denies
   `mcp-config-mutation` to clients — agents cannot drift or self-configure;
   publish is the only writer.
3. **One journal of record.** Hub-managed sessions journal in the hub; the
   in-process guard plugin goes telemetry-only for those sessions (planned
   `hubHosted` mode) so mutation epochs and the circuit breaker never double-count.

Division of labor the operator chose: stock OpenCode UI for coding sessions;
Workflow PWA for oversight/governance across sessions (journal, decisions,
budgets). `workflow` command brings up controller + both surfaces.

## Key Assumptions to Validate

- [ ] Stock v2 web UI tolerates a fronting gateway (origin/basic-auth) — or the
      hub must serve its static assets same-origin. *Test: drive one session
      through the enforced gateway.*
- [ ] v2 config hot-reload exists (`POST /api/config`) — otherwise publish means
      a server restart, which kills running sessions. *Test: privileged POST from
      the hub path; watch for live reload.* Highest-value unknown.
- [ ] Guard plugin can run telemetry-only for hub-hosted sessions (single journal).
- [ ] Multi-device access needs Tailscale (or equivalent) before anything else —
      shared basic-auth over HTTP stays localhost-only until then.

## MVP Scope

`workflow` launcher (hub + opencode server + both UIs) → enforced route-class
gateway in front of the stock web UI → PWA oversight surface → config publish v1
covering model routing, MCP toolbox registration, plugin pin.

## Not Doing (and Why)

- **ACP facade for pi/goose/cline** — phase two per operator decision; the native
  and stock-ACP opencode surfaces prove the spine first.
- **Multi-operator identities** — one principal; basic-auth + Tailscale suffices.
- **Custom TLS** — Tailscale solves transport security better than hand-rolling.
- **Migrating integrations into the hub process** — they remain clients behind the
  control plane; the hub stays policy + journal + routing + UI surface.

## Open Questions

- Classification of `session.todo` / `session.abort` / `session.init` routes the
  stock UI probes (fail-closed today; review P3) — must land before an enforced
  UI surface ships.
- Review P2 on the same branch: `execute`/Code-Mode tools unmapped in
  `opencodePermissionCapability` — add to the §2.4 matrix with the above.
