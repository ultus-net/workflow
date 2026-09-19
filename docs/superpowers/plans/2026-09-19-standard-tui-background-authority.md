# Standard-TUI Background Authority — Implementation Plan

**Status:** Proposed — 2026-09-19. **M0 complete (2026-09-19):** verdicts in
`docs/OPENCODE_SERVER_AUTHORITY.md` — serve-on-loopback + hub-written config +
auth split all **PASSED** against real opencode 1.18.31 (`test/opencode-server-gateway.test.ts`
always-run; `test/opencode-server-attach-probe.test.ts` gated live, both green;
typecheck + lint clean). Gateway confirmed feasible; two fidelity requirements
carried to M1 (forward response compression headers, match routes on pathname).
M0.3 live event-wire pin and the literal `opencode attach` operator smoke are
recorded gaps; next is M1.

**M1 implemented (2026-09-19):** production runtime + gateway + discovery +
`workflow-opencode-server` daemon + `workflow-opencode` stock-TUI launcher.
Focused gates green (typecheck, lint, 19 unit tests, gated live probe on real
opencode 1.18.31). Posture stays `advisory` (no broker hook yet). **Sequencing
refinement:** the server is owned by a dedicated workspace-scoped daemon rather
than the global `workflow-hub`; hub promotion is deferred to M2 where the broker
needs hub authority. Full detail + rationale in
`docs/OPENCODE_SERVER_AUTHORITY.md` §7. Next is M2 (the authority broker).

**M2 implemented (2026-09-19):** `opencode-server-authority.ts` broker (SSE →
`ProposedToolAction` → `WorkflowApplication.authorize` + guard → upstream
`once`/`reject`), session↔task correlation, fail-closed malformed/guard/SSE
paths, decision journal, and daemon wiring (client replies intercepted). Focused
gates green (typecheck, lint, 27 unit tests, gated live probe including a broker
SSE subscription against real opencode). Posture stays `advisory`; the live
`permission.asked` path and operator-intent reconciliation are M3/M5. Detail in
`docs/OPENCODE_SERVER_AUTHORITY.md` §8.

**M3 implemented (2026-09-19):** operator-intent reconciliation (`auto-resolve`
vs `ask-me` with policy-vetoed operator replies, fail-closed timeout, early-reply
buffering) and enforcement-mode wiring (`WORKFLOW_OPENCODE_ENFORCEMENT=enforced`
→ startup `assertAskRuleset` verification, gateway enforced-flag construction
check, bypass alarm on undecided mutating tool activity → daemon teardown).
Focused gates green (typecheck, lint, 36 unit tests, gated live probe, build).
Posture stays `advisory` until the live PERMISSION/RULE-CONFIG probes run.
Detail in `docs/OPENCODE_SERVER_AUTHORITY.md` §10.

**Work item:** W071 (reserved).
**Operator decisions (2026-09-19, this planning session):**
1. **Topology:** the operator keeps the **stock `opencode` TUI** as the
   interface; Workflow owns and launches the OpenCode *server* it attaches to.
2. **Enforcement:** aim for **probe-proven `enforced`**, fail-closed, never
   claimed before the permission + rule-config probes are green.
3. **Containment:** the server is **OS-contained from day one** (Bubblewrap),
   loopback-only, no ambient credentials.
4. **Concurrency:** base on `main` in an isolated worktree; keep new files
   under `src/integrations/opencode-server-*` to avoid the concurrent
   control-plane work touching `src/integrations/acp-runtime.ts` and
   `src/ui/web-agents.ts`.
**Related of record:** `docs/HUB.md`, `docs/HOST_ADAPTERS.md`,
`docs/OPENCODE_REMOTE_ACP_SPEC.md`, `docs/SECURITY_ASSURANCE.md`,
`docs/RUNTIME_CONTAINMENT.md`, `docs/OPERATOR_UI.md`.

---

## 1. One-line truth

The stock TUI stays the operator's interface; the **hub owns the OpenCode
server** behind it and is the sole answerer of the server's pre-mutation
permission events, so authorization, guard policy, metering, and evidence are
enforced in the background without Workflow owning the display.

This is the **inverse composition** of the current default: today `workflow`
launches the browser operator UI and drives a headless OpenCode agent
in-process (`WorkflowApplication` + `createConfiguredAcpRuntime`). W071 keeps
the standard client, and moves the authority to the background hub.

It is **not** the remote ACP bridge (`src/integrations/remote-acp/*`). That
bridge makes Workflow an ACP *client* of a server and requires a Workflow-owned
surface. W071 keeps the server as the agent runtime but lets a *stock* client
be the surface; the two share the same HTTP/SSE engine
(`src/integrations/remote-acp/engine.ts`) and the same truthfulness discipline
(`docs/OPENCODE_REMOTE_ACP_SPEC.md` §3).

---

## 2. Architecture

```
 operator
   │  runs the stock binary:
   │  `opencode attach <gateway-url> --password <tui-password> --dir <workspace>`
   ▼
 stock `opencode` TUI  ──HTTP + SSE──▶  Workflow OpenCode Gateway (loopback)
                                             │  forwards session/prompt/stream traffic
                                             │  intercepts permission replies → broker
                                             ▼
                                    Workflow Hub daemon (background authority)
                                      · AuthorityBroker: SSE subscribe → authorize → reply
                                      · WorkflowApplication + guard (policy)
                                      · metering proxy (upstream key custody)
                                      · canonical task/evidence state
                                             │  HTTP + SSE (upstream password, hub-only)
                                             ▼
                                    `opencode serve`  (Bubblewrap-contained,
                                      loopback-only, hub-written config:
                                      metered provider · pinned ask ruleset ·
                                      skills-mcp mount · scratch HOME)
                                             │
                                             ▼
                                    workspace + model API via the loopback proxy
```

### Components

| Component | Path (proposed) | Responsibility |
|---|---|---|
| Server runtime | `src/integrations/opencode-server-runtime.ts` | Launch contained `opencode serve`; write hub config; start metering proxy; set `OPENCODE_SERVER_PASSWORD`; resolve bound URL; dispose. Reuses `LinuxBubblewrapContainment.spawn`, `meteredOpencodeConfig`, `createModelUsageProxy`, `resolveSkillsMount`. |
| Authority broker | `src/integrations/opencode-server-authority.ts` | Subscribe `HttpRemoteEngine.events`; map `permission.asked` → `ProposedToolAction` → `WorkflowApplication.authorize` + guard → `replyPermission`; fail closed; record decisions/evidence; session↔task correlation. |
| Gateway | `src/integrations/opencode-server-gateway.ts` | Loopback HTTP+SSE reverse proxy in front of the upstream server. Forwards all client traffic; does **not** expose the upstream password; routes permission replies to the broker. This is what makes authority singular (see §3). |
| Hub ownership + discovery | `src/integrations/workflow-hub.ts`, `src/cli/hub.ts`, `src/cli/hub-client.ts` | Hub optionally owns the server runtime + broker + gateway; discovery extends with `opencodeServer: { gatewayUrl, tuiPassword, workspace }`. Upstream password never enters discovery. |
| TUI launcher | `src/cli/opencode-attach.ts` (or extend `src/cli/tui-args.ts`) | Resolve hub discovery; `exec` the **stock** `opencode attach` with the gateway URL, TUI password, and workspace. Supplies connection details only; owns no UI. |

---

## 3. Authority model — the load-bearing decision

OpenCode's permission engine is a genuine pre-mutation seam: `ask()` publishes
`Event.Asked` and awaits a `Deferred`; a `reject` fails it before the tool runs
(`docs/OPENCODE_REMOTE_ACP_SPEC.md` §2.3). But **any** client with the server
password can call the reply route. If the stock TUI and the broker share one
password, whichever replies first wins — a race that cannot be claimed as
enforcement.

**Decision: the gateway makes authority singular structurally, not by speed.**

- The **upstream server password is known only to the hub** (broker + gateway).
- The **TUI holds a distinct gateway password** and can only reach the upstream
  through the gateway.
- The gateway forwards session/prompt/stream traffic faithfully, but
  `POST /api/session/:id/permission/:rid/reply` is **not forwarded upstream**;
  it is handed to the broker as an operator input.

Broker decision rule (policy is the authority; the operator can only tighten):

```
effectiveReply = policyDeny ? "reject" : operatorReply        // operator reject always wins
```

Auto-resolve mode (the web-UI default) answers from policy without waiting for
the TUI; "ask me" mode waits for the operator reply but still enforces policy
vetoes. Both modes are policy-authoritative.

**M0 spike confirms the gateway is feasible** (SSE pass-through, auth split).
If it is not, the fallback is a broker-only answerer, and the surface stays
`advisory` because the TUI race remains — recorded, never papered over.

---

## 4. Enforcement truthfulness (adapted from the remote spec §3)

The server surface may claim **`enforced`** only when **all** hold, each bound
to a gated probe (§10):

1. The effective ruleset emits **`ask`** for every mutating tool class
   (`edit`/`write`/`patch`/`apply_patch`, `bash`, `webfetch`, `task`, …). The
   hub-written config pins `permission: { edit: "ask", bash: "ask", task: "ask" }`;
   the bridge **verifies** it via `GET /config` and treats an unasked mutation
   in enforced mode as a bypass failure.
2. A denial is **honored pre-mutation** (canary never written).
3. **Workflow controls launch and config** (contained, hub-written, hub-only
   upstream credential).
4. The operator's TUI reach the upstream **only** through the policy gateway
   (§3), so there is no second answerer.
5. Spawn scope is probe-resolved; subagent-internal activity is default-deny
   unless a per-version probe proves projection (`docs/HOST_ADAPTERS.md`).

Otherwise the row is **`advisory`**.

---

## 5. Containment boundary

- The server process runs under `LinuxBubblewrapContainment` via the existing
  `launchContainedAcpAgent` shape (`writablePaths: [workspace, scratchHome]`,
  `network: "host"` for model egress through the loopback proxy) — an
  unavailable or policy-only backend **fails closed**, never a passthrough.
- HOME is a Workflow scratch home; the real credential store is never bound.
  The model credential is the metering placeholder; the real upstream key stays
  proxy-side (parity with the ACP paths).
- **Deliberate trade-off:** server-side session history lives in the
  Workflow-managed home, not the operator's ambient `~/.local/share/opencode`.
  This is required by containment/key-custody and is recorded; an opt-in
  history-only bind can be evaluated later.
- **Residuals (recorded, not buried):**
  - The stock TUI client runs outside the boundary. It owns no model or tool
    authority; it is presentation only.
  - `network: "host"` gives the contained server general egress, not only the
    proxy (existing residual for host-network contained agents). Key custody
    still prevents model-spend abuse; recorded in `SECURITY_ASSURANCE.md`.
  - Subagent-internal tool activity is likely projection-invisible (the goose/
    OpenCode precedent); spawn stays default-deny until probed.

---

## 6. Reuse map (build on, don't reinvent)

| Need | Existing asset |
|---|---|
| HTTP/SSE client, event parse, permission reply | `src/integrations/remote-acp/engine.ts` (`HttpRemoteEngine`) |
| Hub-written metered config, skills mount, ask ruleset | `src/integrations/opencode-agent-config.ts` (`meteredOpencodeConfig`) |
| Contained launch | `src/adapters/acp-contained-agent.ts` + `src/containment/linux-bwrap.ts` |
| Metering + key custody | `src/integrations/model-usage-proxy.ts`, `upstream-key.ts` |
| Hub daemon, discovery, protocol | `src/integrations/workflow-hub.ts`, `src/integrations/hub-http.ts`, `src/cli/hub-client.ts` |
| Permission → proposal → authorize + guard | `src/adapters/opencode.ts`, `src/adapters/acp-workflow-resolver.ts`, `src/integrations/mcp-toolbox-guard.ts` |
| Task correlation | `activeTaskCorrelation` / `activeTaskId` precedent (`src/integrations/acp-session.ts`, W046) |
| Probe pattern + verdict recording | `test/acp-*-probe.test.ts`, `docs/HOST_ADAPTERS.md`, `test/security-assurance.test.ts` |

---

## 7. Milestones

### M0 — Decision spikes (no production code)

| # | Task | Evidence |
|---|---|---|
| M0.1 | Confirm `opencode serve` network flags + `opencode attach` auth against the pinned/ambient version from `.opencode-src` (`ServeCommand` uses `withNetworkOptions`; `AttachCommand` takes `--password`). | gated probe + note in the decision record |
| M0.2 | **Gateway feasibility:** put a minimal loopback HTTP+SSE proxy in front of a running server; confirm the stock TUI attaches and streams, and that upstream auth can stay hub-only. | gated probe |
| M0.3 | Pin exact event wire types (`permission.asked` vs `permission.v2.asked`) and reply-route stability; confirm the server reads `XDG_CONFIG_HOME` config. | RULE-CONFIG probe input |
| M0.4 | Confirm the authority split: a TUI holding only the gateway password cannot reach the upstream reply route. | probe output |

**Files:** `test/opencode-server-attach-probe.test.ts` (gated),
`docs/OPENCODE_SERVER_AUTHORITY.md` (decision record; append-only).
**Gate:** gateway chosen or fallback recorded; all four spikes have a verdict.

### M1 — Contained server + discovery + stock-TUI launcher

| # | Task |
|---|---|
| M1.1 | `opencode-server-runtime.ts`: launch contained `opencode serve` (loopback, pinned port), write metered config + ask ruleset + skills mount, start proxy, set upstream password, resolve URL, dispose cleanly (proxy + config dir + server). |
| M1.2 | Hub owns the runtime: `workflow-hub.ts` / `cli/hub.ts` start it; discovery carries `{ gatewayUrl, tuiPassword, workspace }` (never the upstream password). |
| M1.3 | `opencode-server-gateway.ts`: loopback HTTP+SSE proxy with the auth split; intercept permission replies → broker hook (no-op in M1). |
| M1.4 | `src/cli/opencode-attach.ts`: resolve discovery, `exec` stock `opencode attach <gatewayUrl> --password <tuiPassword> --dir <workspace>`. |
| M1.5 | Fail-closed wiring: no hub → no server → the launcher refuses (never a bare unguarded server). |

**Files:** the three `src/integrations/opencode-server-*.ts`, `src/cli/opencode-attach.ts`,
`test/opencode-server-runtime.test.ts`, `test/opencode-server-gateway.test.ts`,
`test/opencode-attach.test.ts` (fake server fixtures).
**Gate:** operator runs the stock TUI against a contained hub-launched server;
ordinary editing/prompting works; no enforcement claim yet.

### M2 — Authority broker (observe, then decide)

| # | Task |
|---|---|
| M2.1 | `opencode-server-authority.ts`: SSE subscribe; `permission.asked` → proposal → `application.authorize` + guard → `replyPermission`; malformed event → reject; SSE loss → reject outstanding and surface "authority lost". |
| M2.2 | Session↔task correlation: create one interactive canonical task per attached session; authorize against the active task (W046 precedent); unknown task id fails closed. |
| M2.3 | Workspace resolution per session `directory` via the hub's `workspaceApplicationFor`; unbound directory fails closed. |
| M2.4 | Decision journal (observability): every decision, subject, and outcome recorded; no canonical advance from a decision alone. |

**Files:** `opencode-server-authority.ts`, `test/opencode-server-authority.test.ts`
(fake SSE + fake authorize), extension of `hub.ts` composition.
**Gate:** decisions and denials recorded on a real session; surface still
`advisory` in `HOST_ADAPTERS.md`.

### M3 — Enforcement on (singular authority)

| # | Task |
|---|---|
| M3.1 | Gateway routes TUI permission replies to the broker; `effectiveReply = policyDeny ? reject : operatorReply`; upstream reply route is unreachable to the TUI. |
| M3.2 | Ruleset verification: read `GET /config`, assert every mutating class maps to `ask`; mismatch fails closed at startup. |
| M3.3 | Bypass alarm: a mutation observed without a prior `ask`/decision in enforced mode stops the run and records a bypass failure (never "assume allowed"). |
| M3.4 | Guard dispatch on the broker path (identical policy to the ACP resolver), fail closed if the guard is unavailable. |

**Files:** `opencode-server-gateway.ts`, `opencode-server-authority.ts`,
`test/opencode-server-enforcement.test.ts`.
**Gate:** canary denial honored pre-mutation in a controlled run; bypass case
detected; no path from the stock TUI to an unasked mutation.

### M4 — Evidence, metering, budget, skills

| # | Task |
|---|---|
| M4.1 | Per-session metering: proxy metrics surfaced and journaled; budget guard equivalent to `composeSessionWithBudget` driven by proxy metrics + server `abort`. |
| M4.2 | Mutation evidence: authorized mutations recorded against the session task; tool success never self-verifies. |
| M4.3 | Verification evidence: the hub's contained shell runs the project verify command for the session task (reuse `shellExecutorFor`). |
| M4.4 | Skills delivery: `skills-mcp` mount in the server config; the broker observes `read_skill`-shaped calls and journals `recordSkillRead` (the `onSkillRead` equivalent). |

**Files:** `opencode-server-authority.ts`, `opencode-server-runtime.ts`,
focused tests per task.
**Gate:** a real session shows cost, evidence-gated completion, and a skills
read journaled.

### M5 — Probes, honest claims, docs

| # | Task |
|---|---|
| M5.1 | Run the gated probe family (§10); record per-version verdicts in `docs/HOST_ADAPTERS.md`. |
| M5.2 | Claim `enforced` only on green PERMISSION + RULE-CONFIG (+ gateway/authority-split). |
| M5.3 | Update `docs/FEATURES.md`, `docs/HUB.md` (hub now owns an OpenCode server surface), `docs/OPERATOR_UI.md` (terminal surface note), `AGENTS.md` (generated guide pointer), `SECURITY_ASSURANCE.md` (new residuals + checker pins). |
| M5.4 | Independent five-axis review before merging. |

**Gate:** honest labels; full focused gates green; review recorded.

### M6 — Operator dogfood and default switch (operator-owned)

Record a dogfood period on the standard TUI; only then consider making it the
default surface. No code dependency, an explicit operator gate.

---

## 8. Probe plan (gated, mirror `test/acp-*-probe.test.ts`; no date-gating)

| Probe | Env gate | Proves |
|---|---|---|
| TUI-ATTACH | `WORKFLOW_OPENCODE_SERVER_ATTACH=1` | stock TUI attaches to the gateway; prompt/stream/tool round-trips |
| RESPONDER-RACE / AUTHORITY-SPLIT | `WORKFLOW_OPENCODE_SERVER_GATEWAY=1` | TUI cannot reach the upstream reply route; gateway is sole upstream client |
| PERMISSION (pivotal) | `WORKFLOW_OPENCODE_SERVER_PERMISSION=1` | mutating call reaches an `ask`; broker denies; canary never written |
| RULE-CONFIG | `WORKFLOW_OPENCODE_SERVER_RULE_CONFIG=1` | effective ruleset maps every mutating class to `ask` |
| BYPASS | `WORKFLOW_OPENCODE_SERVER_BYPASS=1` | an unasked mutation is detected and never certified |
| SUBAGENT | `WORKFLOW_OPENCODE_SERVER_SUBAGENT=1` | `task` projects and is hub-gateable, or spawn default-deny |
| SSE/TURN | `WORKFLOW_OPENCODE_SERVER_SSE=1` | streaming + turn completion via idle; SSE loss fails closed |
| AUTH/METERED | `WORKFLOW_OPENCODE_SERVER_METERED=1` | placeholder-only credential in the boundary; proxy records usage |
| CONTAINMENT | `WORKFLOW_OPENCODE_SERVER_CONTAINMENT=1` | host-home canary invisible; workspace write only |

Without PERMISSION + RULE-CONFIG green the row is `advisory`.

---

## 9. Fail-closed table

| Condition | Behavior |
|---|---|
| Hub not running | launcher refuses; no unguarded server |
| Containment policy-only/unavailable | refuse to start the server |
| Ruleset not pinned to `ask` | refuse to start (enforced mode) |
| Permission event malformed/unmappable | reply `reject`; never auto-allow |
| SSE stream drops mid-turn | reject outstanding; "authority lost"; stop certifying |
| Upstream 401/unreachable | fail closed |
| Mutation without a prior `ask`/decision (enforced) | bypass alarm; stop; do not certify |
| Gateway down | TUI cannot connect (fail closed), not a path around policy |
| Unknown server version | start `advisory` only |

---

## 10. Step-by-step execution checklist

1. `git worktree add /var/home/hunter/worktrees/w071-standard-tui -b feat/w071-standard-tui-background-authority origin/main` (done); symlink `node_modules`.
2. Land this plan + the W071 ledger item (this change).
3. M0: run the four spikes; write `docs/OPENCODE_SERVER_AUTHORITY.md`; confirm the gateway.
4. M1: implement runtime + discovery + gateway + launcher; fake-server tests; live TUI attach smoke.
5. M2: broker observe/decide; fake SSE tests; live decision journal.
6. M3: gateway reply routing + ruleset verify + bypass alarm + guard; canary denial test.
7. M4: metering/budget/evidence/skills tasks with focused tests.
8. M5: run the probe family live; record verdicts; update docs; five-axis review.
9. Open a PR to `main` with a `## Summary`; never push without operator direction.

Verification per milestone: `npm run lint`, `npm run typecheck`, and focused
tests only (`node --import tsx --test test/<file>.test.ts`) — never `npm test`
except at explicit release gates.

---

## 11. Definition of done

- The operator's daily interface is the stock `opencode` TUI attached to a
  hub-owned, contained server; the hub is the sole permission authority.
- Denials are honored pre-mutation (probe-proven); an unasked mutation is a
  detected bypass, never certified.
- `HOST_ADAPTERS.md` carries a per-version row; the label is `enforced` only on
  green evidence, `advisory` otherwise; residuals are recorded.
- Cost, evidence, and skills delivery work on a real session; completion is
  evidence-gated.
- Five-axis review recorded; full gates green.

---

## 12. Open questions

- Does `opencode serve` read `XDG_CONFIG_HOME` global config, or only project
  `opencode.json`? (M0.3)
- Exact SSE event type for permission requests and the v2 reply route's
  stability on the ambient version. (M0.3)
- Can the stock TUI's own global TUI plugins be kept off cleanly so the
  operator's ambient surface stays presentational only? (M1.4)
- Is a history-only bind of the operator's `~/.local/share/opencode` possible
  without exposing the credential store? (M1)
- Does the gateway need to translate any protocol the stock client expects
  beyond pass-through (e.g. websocket, mdns)? (M0.2)

## 13. Risks and residuals

- **False enforcement** if a mutating class is not pinned to `ask` — mitigated
  by the RULE-CONFIG probe and the bypass alarm.
- **Gateway complexity** as a new man-in-the-middle surface — bounded,
  loopback-only, covered by the AUTHORITY-SPLIT probe; fail-closed table above.
- **Containment trade-off**: server home/history is Workflow-managed;
  `network: "host"` egress residual; subagent invisibility — all recorded.
- **Version drift**: the server API is versioned/experimental v2 — re-probe on
  every bump.
- **Double authority** if the upstream also enforces; the auth split keeps the
  hub sole upstream client.
- **Operator friction**: the launcher must be a thin `exec` over the stock
  binary so the interface is genuinely standard.
