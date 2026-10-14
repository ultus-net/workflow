# OpenCode Server Authority — Decision Record (W071 M0)

**Status:** M0 verdicts recorded — 2026-09-19
**Scope:** feasibility spikes for the standard-TUI background-authority plan
(`docs/superpowers/plans/2026-09-19-standard-tui-background-authority.md`).
**Posture:** evidence over assumption. Gaps are recorded, not smoothed. This is
an append-only dated record; later milestones add dated sections.

## 1. Question

Can the operator keep the **stock `opencode` TUI** while the Workflow hub owns
and authorizes the OpenCode server behind it, with the hub as the *sole*
pre-mutation permission answerer — structurally, not by race?

## 2. Method

- `test/opencode-server-gateway.test.ts` — always-run unit tests of the
  authority split and reply interception against a stub upstream.
- `test/opencode-server-attach-probe.test.ts` — gated live probe
  (`WORKFLOW_OPENCODE_SERVER_ATTACH=1`) against real `opencode serve` on
  loopback with a hub-style `XDG_CONFIG_HOME` config, driven through an inline
  minimal loopback gateway.

Environment: opencode **1.18.31** (ambient PATH, matches `.opencode-src`
`5a83358`), Node 22.22.3, headless (no TTY), **no model key** available.

## 3. Verdicts

| Spike | Verdict | Evidence |
|---|---|---|
| M0.1 `serve` loopback + auth + hub-written config | **PASS** | unauthenticated request rejected (401); `/global/health` `healthy:true` version `1.18.31`; `/config` reflects the hub-written `permission: { edit: ask, bash: ask, task: ask }` and the `workflow-metered` provider — the server reads `XDG_CONFIG_HOME` config and the ruleset is pinnable server-side. |
| M0.2 gateway passes the stock-client API surface | **PASS (with two fidelity requirements)** | through the gateway: `/global/health`, `POST /session`, `/config/providers` (metered provider visible), and an open `/global/event` SSE stream all succeed using only the gateway password. |
| M0.4 authority split | **PASS** | a client holding only the gateway password gets 401 from the upstream permission reply route directly; the same client's reply through the gateway is intercepted (403, never forwarded); the upstream reply route answers only to the hub-only credential. |
| M0.3 permission event wire type + reply route | **PARTIAL** | reply route shape `/api/session/:sessionId/permission/:requestId/reply` **source-verified and live-routed** (the upstream answered a hub-authenticated POST). The live `permission.asked` event emission is **not yet pinned**: emitting it needs a real model turn, and no model key is present here. Deferred to the M3/M5 PERMISSION probe. |

**Gateway feasibility: YES.** The load-bearing W071 decision (plan §3) is
confirmed: the auth split makes the hub the sole upstream client, so the
stock TUI cannot answer permissions upstream. The gateway is required; a
shared-password broker remains the `advisory` fallback only.

## 4. Gateway fidelity findings (feed M1)

The live spike caught two things the stub could not:

1. **Response compression must pass through.** Real `opencode serve` returns
   gzipped JSON. A gateway that forwards the body without the upstream
   `content-encoding` header produces `Unexpected token '\x1F'` at the client.
   The gateway must forward upstream response headers (at minimum
   `content-type` + `content-encoding`), or decompress; it must not silently
   relabel compressed bytes as plain JSON.
2. **Route matching must use the pathname.** Clients send the `directory`
   query parameter on every request; matching the reply route against the raw
   `request.url` misses `.../reply?directory=...`. Match on the URL pathname.

Both are now pinned by the passing tests. M1's production gateway must
preserve hop-by-hop header handling, the `directory` query / `x-opencode-directory`
header, and SSE streaming.

## 5. Honest gaps (not yet evidenced)

- **Literal interactive TUI attach.** The probe proves the exact HTTP+SSE
  client surface the stock TUI speaks (health, session create, providers,
  events), and `AttachCommand` source confirms it uses that surface. The
  actual `opencode attach` TUI process was **not** driven here (headless, no
  TTY). Operator smoke is the M1 gate.
- **Live permission event.** `permission.asked` type/emission awaits a real
  model turn; no model key here. Gated probes PERMISSION/BYPASS/RULE-CONFIG
  remain to be run (M3/M5).
- **Containment.** M0 ran a plain `opencode serve`; the Observe/contain
  composition (Bubblewrap, scratch HOME, proxy metering) is M1 and is not
  claimed here.
- **The `opencode serve` unknown-POST behavior.** A hub-authenticated POST to
  the (bogus) reply path returned a non-401/403 status rather than a clean
  rejection. Not load-bearing for the split, but the M3 broker must confirm
  the real reply semantics (including `reject`-fails-other-pending behavior)
  against the pinned version.

## 6. Consequence for M1

Proceed with the production gateway + contained server + launcher. Carry
forward: forward response headers (compression), match on pathname, keep the
upstream credential out of the client entirely, and do not claim `enforced`
until the PERMISSION + RULE-CONFIG probes run live with a model key.

---

## 7. M1 — runtime, gateway, daemon, launcher (2026-09-19)

**Status:** implemented on `feat/w071-standard-tui-background-authority`;
focused gates green (typecheck, lint, 19 unit tests, and the gated live probe
against real opencode 1.18.31). **Posture remains `advisory`** — no broker hook
is wired, so the gateway passes client replies through; nothing is labeled
`enforced` yet.

**Built:**

- `src/integrations/opencode-server-runtime.ts` — launches a contained
  `opencode serve` (loopback, pinned port) with the hub-written metered config
  (proxy, provider, `ask` ruleset, skills mount) and a workspace-keyed
  persistent state dir. Fails closed on a missing upstream key, a policy-only
  containment backend, or a server that never becomes healthy.
- `src/integrations/opencode-server-gateway.ts` — the production gateway:
  client/upstream credential split, pathname route matching, response
  `content-encoding` forwarding, broker hook (intercept) vs advisory
  pass-through, fail-closed 502 on broker error.
- `src/integrations/opencode-server-discovery.ts` — the launcher discovery
  (0600, pid, gateway URL + client password only; never the upstream password)
  and the gateway health probe.
- `src/cli/opencode-server.ts` — the background daemon owning runtime +
  gateway; `src/cli/opencode-attach.ts` — resolves/auto-starts the daemon and
  runs the **stock** `opencode attach`. Bins `workflow-opencode-server` /
  `workflow-opencode` and scripts `opencode:server` / `opencode:attach`.

**Sequencing refinement (recorded, not silent):** the plan's M1.2 said the
existing `workflow-hub` process owns the server. This landed as a dedicated
workspace-scoped `workflow-opencode-server` daemon instead, for two reasons:
the server is per-workspace while `workflow-hub` is a single global process,
and it avoids colliding with the concurrent control-plane work touching
`src/integrations/acp-runtime.ts` and `src/ui/web-agents.ts`. Promoting
ownership into the hub (or having the hub ensure/own the daemon) is deferred to
**M2**, where the broker genuinely needs `WorkflowApplication`/`workflow-hub`
authority; the discovery contract is already the seam that promotion will use.

**Test artifacts:** `test/opencode-server-gateway.test.ts` (7),
`test/opencode-server-runtime.test.ts` (4), `test/opencode-server-launcher.test.ts`
(8) — all always-run except the runtime launch test which skips without an
opencode binary; `test/opencode-server-attach-probe.test.ts` (gated
`WORKFLOW_OPENCODE_SERVER_ATTACH=1`) exercises the production runtime + gateway
live. The probe uses a boundary double that runs real `opencode serve` directly
so it needs no Bubblewrap/model key; a real contained launch with a key remains
the operator smoke for this milestone.

**Still pending (unchanged):** literal interactive TUI attach (no TTY here),
contained launch with a real key, and the M2 broker that makes interception
policy-driven rather than pass-through.

---

## 8. M2 — authority broker (2026-09-19)

**Status:** implemented on `feat/w071-standard-tui-background-authority`;
focused gates green (typecheck, lint, 27 unit tests, gated live probe).
**Posture remains `advisory`** — the policy path is real, but `enforced` still
awaits the live PERMISSION/RULE-CONFIG probes (which need a model key).

**Built:**

- `src/integrations/opencode-server-authority.ts` — the broker. Subscribes to
  the server SSE via the production `HttpRemoteEngine`; each `permission.asked`
  is mapped to a `ProposedToolAction` through `AcpHostAdapter` +
  `permissionToolCall` + an OpenCode-action capability classifier
  (`bash→process`, `webfetch→network`, `task→spawn`, read tools→read, edit→mutation),
  authorized through `WorkflowApplication` (+ optional guard), and answered
  upstream (`once`/`reject`). Unmappable/malformed requests, guard failures,
  and denied policy all reply `reject` (fail closed). SSE loss sets
  `authorityLost`. Every decision is journaled (observability only).
- Session↔task correlation: `ensureOpencodeSessionTask` creates a canonical
  `opencode-session:<id>` task in `IN_PROGRESS`, so mutating proposals
  correlate with eligible work; an ineligible task stays denied by `authorize`.
  Workspace confinement is the application's `workspaceRoot` (the runtime
  workspace).
- `src/cli/opencode-server.ts` — the daemon now composes the broker with a
  real `WorkflowApplication` (capabilities read/mutation/process; network and
  spawn withheld → fail closed) and wires the gateway's client-reply hook to
  the broker, so the stock TUI can never answer upstream.

**Why the capability classifier is explicit:** `AcpHostAdapter` classifies by
tool *kind* only (execute→process, read/search→read, else mutation). `task`
already reaches `spawn` through the adapter's `KNOWN_SPAWN_TOOLS`; the
classifier's real addition is `webfetch→network` (which the adapter would
classify as mutation) plus explicit entries for OpenCode-shaped action names.
The adapter takes the stricter of the two, so this is escalation-only.

**M2 scope boundary (recorded):** the broker auto-resolves from policy; an
operator reply that reaches the gateway is journaled as observation only
(`handleOperatorReply`), not yet reconciled against policy. Operator-intent
modes ("ask me") are M3. The live permission event itself is not exercised
here — no model key in this environment — so the end-to-end `permission.asked`
→ authorize → reply path against a running server is the M3/M5 probe.

**Tests:** `test/opencode-server-authority.test.ts` (8): allow/deny/withheld
capability/workspace escape/in-workspace mutation/unmappable fail-closed/
SSE-loss/correlation/operator-reply observation. The gated live probe now also
confirms the broker subscribes to the real server's SSE and stays live.

---

## 9. Five-axis review + fixes + main sync (2026-09-19)

**Independent review** (`secondary-reviewer/w071-m0-m1-m2`, verdict recorded):
**REQUEST_CHANGES, no P0, two P1**, all five axes covered. The credential split
and fail-closed posture were confirmed; the fixes below are applied on this
branch.

- **P1-1 (fixed)** — the advisory gateway branch returned without responding
  or forwarding (hang), and its test hit `/reply` instead of the reply route.
  The no-hook branch now forwards the reply upstream, and the advisory test
  posts the real `permission/:rid/reply` route and asserts the upstream answer.
- **P1-2 (fixed)** — reply-route matching is now normalization-safe: the
  pathname is decoded before matching, so `/…/%72eply` cannot dodge
  interception, and a reply-shaped path that still does not map cleanly fails
  closed with 400 instead of being forwarded under the hub credential. Pinned
  by regression tests.
- **P2-1 (fixed)** — `authorityLost` now fires `onAuthorityLost`; the daemon
  logs the loss and tears down (authority stop → gateway close → runtime
  dispose → discovery removal) instead of advertising a dead policy point.
- **P2-3 (fixed)** — the gateway handler has an error boundary (500, never a
  crash), and the daemon registers `unhandledRejection`/`uncaughtException`
  guards with best-effort teardown on an uncaught exception.
- **P2-2 (resolved)** — the branch is now **rebased onto origin/main**
  (post-W052/W057-W064/W070a/W070b main); the only conflict was the TASKS.md
  Phase numbering — W071 landed as **Phase 13** because main's Phase 12 is the
  promoted AI-landscape/open-source-pivot items. W070a's reworked
  `meteredOpencodeConfig` remained option-compatible; all gates re-run green
  after the rebase.
- **Selected P3s (fixed)** — reply delivery confirmation in the journal
  (`delivered` + reason), duplicate-task catch narrowed, `start()` doc, static
  `node:net` import, dead ternary removed, stale daemon header rewritten,
  decision log bounded to 160 chars, discovery gateway URL validated loopback,
  spawn lock against double-daemon launches, and the TUI password now rides
  the child env instead of argv. **Accepted residuals (recorded):** forwarded
  bodies have no size limit and upstream requests no explicit timeout (SSE
  requires none); the §8 wording about `KNOWN_SPAWN_TOOLS` duplication is
  slightly overstated (the classifier's real addition is `webfetch→network`).

**Post-fix verification:** typecheck, lint, **28 unit tests**, the gated live
probe, and `npm run build` all green.

---

## 10. M3 — operator-intent reconciliation + enforcement mode (2026-09-19)

**Status:** implemented; focused gates green (typecheck, lint, **36 unit
tests**, gated live probe, build). **Posture remains `advisory`** — the
enforcement *mechanism* is real, the `enforced` *claim* still awaits the live
PERMISSION/RULE-CONFIG probes (which need a model key).

**Operator intent (M3.1):** the broker gained `mode`:
- `auto-resolve` (default) answers from policy immediately; an operator reply
  is journaled as observation (M2 behavior preserved).
- `ask-me` holds policy-allowed asks for the operator's answer (the TUI prompt
  resolves via the gateway intercept), reconciled as
  `effectiveReply = policyDeny ? reject : operatorReply` — the operator can
  tighten, never loosen. Policy denials never wait for anyone. An unanswered
  hold times out to `reject` (fail closed, default 120s). Early operator
  replies that race ahead of the SSE event are buffered and applied when the
  ask arrives.

**Enforcement posture (M3.2–M3.4):**
- `WORKFLOW_OPENCODE_ENFORCEMENT=enforced` makes the daemon verify the pinned
  ruleset at startup via `assertAskRuleset(engine.config())` — a permissive
  ruleset refuses to serve (fail closed; `edit`/`bash`/`task` must all be
  `ask`).
- The gateway gained an `enforced` flag whose construction fails closed
  without the broker hook — the structural guarantee that no client reply can
  reach upstream in enforced posture.
- The bypass alarm observes `message.part.updated` tool parts: a mutating
  tool activity with no prior Workflow decision (matched by callID when the
  request carries one, else by session+tool) is journaled as `(bypass)`, fires
  `onBypass`, and the daemon shuts the surface down rather than keep serving a
  ruleset that is not asking.
- Guard dispatch was already wired (M2); it stays fail-closed and composes
  with the daemon when a guard provider is supplied.

**Honest boundaries:** the bypass alarm's event-shape assumptions (tool part
with `callID`/`tool` on `message.part.updated`) are derived from the pinned
source and the projection helpers, not yet from a live mutating turn — the
M5 BYPASS probe pins the real shapes. The ruleset check covers the three
pinned classes; a ruleset that silently allows another mutating class is
exactly what the BYPASS alarm is for, and the probe must prove it fires.

**Tests (8 new, 36 total):** ask-me hold→once, operator tighten→reject,
policy-deny immediate reject, timeout→reject, bypass alarm fires / does not
fire when covered by a decision, `assertAskRuleset` fail-closed matrix, and
the enforced-gateway-requires-hook construction check.

**Still open:** the live `permission.asked` → authorize → reply probe and the
rest of the probe family (needs a model key), a real contained launch with a
key, the literal interactive TUI operator smoke, the `HOST_ADAPTERS.md` verdict
row, and the final five-axis review pass on the completed milestones.

---

## 11. M4 — evidence, metering, budget, skills on the server path (2026-09-19)

**Status:** implemented; focused gates green (typecheck, lint, **43 unit
tests**, gated live probe, build). **Posture remains `advisory`.**

**Evidence (M4.2):** the broker's tool-activity observer now closes the loop
with canonical state — a mutation is recorded (`application.recordMutation`)
only when it is *observed completed* on the server's SSE with a prior Workflow
decision, which is the epoch-advancing freshness signal; a decided-but-not-
completed mutation advances nothing. On the enforced path the same observer
runs the bypass alarm for undecided mutating activity (M3.3).

**Skills delivery (M4.4):** journaled on *observed delivery*, never on an
unanswered ask: a completed `read_skill`-shaped tool part extracts the skill
name from the tool input and journals `application.recordSkillRead(skill,
sessionTask)` — the server-path equivalent of the ACP driver's `onSkillRead`,
bound explicitly to the session task (the broker also moves the active-task
pointer to the event's session, W046 parity). To make the delivery
authorizable at all, `read_skill`/`skills-mcp__read_skill` entered the ACP
adapter's `KNOWN_READ_TOOLS` and the broker carries a `read` kind when its
classifier says read (the adapter's non-mutating verdict needs both; `toolKind`
would have called the unknown MCP tool "other", and an unsubjected mutation
must fail closed). This is a shared-file classification update in
`src/adapters/acp.ts` — flagged here because another stream is active nearby.

**Budget (M4.1):** `src/integrations/opencode-server-budget.ts` — the W045
caps (`WORKFLOW_SESSION_BUDGET_{INPUT,OUTPUT,TOTAL}_TOKENS`, `_COST_USD`)
adapted to the server path: the watcher polls metering-proxy usage, aborts
every active server turn on crossing (`engine.abort`), sets a sticky
violation, and the broker consults it before every mutating proposal
(`session budget violated: …` denials; reads stay allowed). The daemon logs
which mechanism is active (local watcher vs provider-side spend limits) and
prints final metering totals at shutdown.

**Honest boundary (M4.3):** the project verify-command run gate stays
hub-owned (`createRunTestRunner` + contained shell, already proven there) and
will be reused when the server surface is promoted to hub authority — a
daemon-side duplicate would be speculative until live sessions exercise the
completion flow. The budget watcher's abort path is exercised against the
fake engine; live abort semantics land with the operator's probe runs.

---

## 12. Final five-axis review + fixes (2026-09-19)

**Review** (`secondary-reviewer/w071-final`, verdict recorded): REQUEST_CHANGES
— no P0, **two P1**, three P2, seven P3. All claimed evidence was reproduced;
the advisory/probe-PENDING honesty posture was confirmed intact. **The live
PERMISSION/RULE-CONFIG/BYPASS probes are deferred by operator decision** (no
model key here); the M5 verdict row will be recorded when they run on the
operator's machine.

**P1 fixes:**
- **P1-1 (denied decisions seeded coverage).** `rememberAllowed` now runs only
  after a *delivered* `allow`; a denied, operator-rejected, timed-out, or
  undelivered ask never authorizes later activity. Regression test: a completed
  denied mutation neither advances the epoch nor suppresses the alarm.
- **P1-2 (session+tool coverage was permanent).** Coverage is now consumed on
  observation — one delivered allow covers exactly one observed tool activity;
  the callID map is preferred and the session+tool entry is the single-use
  fallback (the tool part may carry a callID the ask lacked). Regression test:
  a second unasked mutation of the same tool alarms.

**P2 fixes:**
- **P2-1** the observer accepts `part.sessionID` when `properties.sessionID` is
  absent (the pinned source prefers the part's id).
- **P2-2** the broker normalizes the pinned v2 wire shape
  (`properties.permission`→`action`, `properties.patterns`→`resources`) once
  per event, documented probe-pending.
- **P2-3** the launcher's spawn lock is now held for the entire readiness wait,
  so a second launcher cannot start a second daemon.

**P3 fixes:** the unreachable `/reply?` guard was dropped; `earlyReplies`
entries are purged on timeout (and cleared on stop); `read_skill` matching is
exact-name only; the budget watcher aborts sessions learned *after* the
crossing (not just those known at crossing); focused tests added for
`authorityModeFromEnv`/`enforcementFromEnv` and the reviewed P1 paths.
**Accepted residuals (recorded):** the SSE loop serializes ask-me holds, so a
long operator hold delays later events (P3-4 — revisit with the live probe);
forwarded bodies have no size cap and only the known reply-route shape is
intercepted (P3-7 — the AUTHORITY-SPLIT/BYPASS probes pin the real shapes).

**Process cleanup follow-up (2026-09-19):** W071's focused tests leave zero
`opencode serve`, W071 `tsx`, or `--import tsx --test` processes. The stock-TUI
launcher now starts `opencode attach` in its own POSIX process group and sends
SIGTERM to the group after the TUI exits (`terminateProcessGroup`), preventing
OpenCode's child TypeScript language servers from being orphaned. Existing
long-running `opencode` hosts created by other worktrees are intentionally not
killed by this change.

**Post-fix verification:** typecheck, lint, **50 unit tests**, the gated live
probe, and `npm run build` all green.

**Fix-verification follow-up (2026-09-19):** a fresh reviewer found two new
issues in the first fix attempt: consuming coverage on non-terminal tool-part
updates (the real stream emits pending → running → completed for one call), and
seeding coverage when the upstream reply failed. Both are fixed: coverage is
consumed only on the terminal completed observation, and only a delivered allow
seeds coverage. Regression tests pin both cases. The observer also honors the
part-level session id and exact read_skill names; the v2 permission normalizer,
readiness-held spawn lock, and post-violation budget abort behavior remain
covered. The final review's P3-4 (serial ask-me SSE holds) and P3-7 (forwarded
body cap/alternate reply routes) remain explicitly accepted residuals pending
live probe evidence.
## Addendum (2026-09-22, W092 — guard asks join the operator hold)

The M3 ask-me hold set now includes **guard asks**: when a guard provider is
wired, a guard `ask` verdict (e.g. the W091 `promotion-gate`) maps to a held
allow that the operator answers through the existing gateway-intercepted
reply path — approve delivers once, reject/timeout fail closed (tighten,
never loosen). In `auto-resolve` mode a guard ask fails closed to deny with
the ask provenance (no operator is attached to answer). Scope honesty: the
authority path is implemented and pinned, but the stock daemon constructor
(`src/cli/opencode-server.ts`) does not yet pass a guard provider — daemon
guard-wiring is the top queued item. Residual note: a held guard ask blocks
the SSE loop up to the hold window (the pre-existing serial-hold residual
widens — delayed alarms, not false ones).

## Addendum (2026-09-22, W094 — daemon guard-wiring landed; supersedes the
scope-honesty sentence above)

The stock daemon now **does** pass a guard provider:
`src/cli/opencode-server.ts` composes the vendored guard fail-closed
(`createOpencodeServerGuard(workspace)` — a guard startup failure rejects
`main`, so the daemon refuses to run guard-less, mirroring the hub's
"no hub, no mutations" posture), passes it to the authority, and reaps it
explicitly on every failure path (runtime creation, enforced-ruleset
refusal, gateway failure, uncaughtException) and at shutdown. The composed
guard is pinned through the REAL vendored server: `workflow install fleet`
asks `promotion-gate` (the W091 rule + W090 enrichment live in the daemon's
guard). Credential note: the daemon's guard is composed without the hub's
credential broker — inert today (the vendored guard consumes only HOME), and
if `mcp:workflow-guard` credentials are ever configured the daemon must
compose the broker like the hub does.

## Addendum (2026-10-09, C1 deploy plan task 3.1 — the ingress-transport probe)

The C1 Azure control plane moves this authority chain behind a public ACA
ingress (the gateway front door, `0.0.0.0:4096`) rather than loopback. The
route-class/permission matrix above is re-certified at the new transport by a
new gated instrument, `test/c1-plane-probe.test.ts` (gate
`WORKFLOW_AZURE_PLANE_PROBE=1`), mirroring this doc's M0/M1 probe discipline:
unauthenticated reads are rejected at ingress (401), an authenticated
`/api/info` succeeds, the client/upstream credential split holds, the broker
SSE subscribes without forwarding, the route-class matrix is probed, and the
discovery record reports `boundaryKind === "container-boundary"`. The 240s
ingress-idle survival arm is a separate gate
(`WORKFLOW_AZURE_PLANE_PROBE_IDLE=1`). Status: **PENDING (never run live)** —
the instrument landing does not upgrade any claim here. A green earns only C1
Partial (advisory); nothing in this probe is a pod-side `enforced` claim.

## Addendum (2026-10-10, C1 live plane — the deferred v2 wire-shape probe, RUN: the envelope bug)

**This is the M0.3 / §3 "live `permission.asked` wire shape" item — deferred
for two years behind "needs a real model key" — actually run.** The C1 plane
gave the topology a real Synthetic/OpenRouter lane and a real model turn, so
the probe executed against a live `opencode serve` v2.0.10 through the public
ingress. It surfaced a defect: **every mutating tool call hung forever.**

**Observed (live, healthy plane — the revision id is an instance value and is
withheld from this open repo):**

- A tool turn parked at `session.tool.called` with `executed: false` and
  `state.status: "running"`, forever. Read-only answers passed; any `write`,
  `shell`, or `edit` hung.
- The broker logged, one line per tool turn, verbatim:
  `[authority] deny unknown session=undefined delivered=false reason=unmappable
  permission request (fail closed): invalid ACP permission event (upstream reply
  failed: remote engine POST /api/session/undefined/permission/undefined/reply`
- A captured `/api/event` frame (17 event types swept) showed the v2 envelope:
  `{"id","type","location","data":{...},"durable":{...}}` — the payload rides
  **`data`**, never `properties`.

**Root cause (one bug, three consumers).** `parseEventPayload`
(`src/integrations/remote-acp/engine.ts`) read `payload` then `properties`,
never the v2 `data`. So `sessionID`/`id` landed `undefined`, every ask was
"unmappable", the broker failed closed (correctly), and the `reject` reply went
to `/api/session/undefined/permission/undefined/reply` — which also fails, so
the tool never unblocks. Two more consumers shared the bug: the tool-activity
observer (`opencode-server-authority.ts`) gated on `message.part.updated`, a
type v2.0.10 does not emit (it emits the `session.tool.*` family), leaving
`recordMutation` and the enforced-mode bypass alarm dead; and
`consumeOpenCodeV2EventStream` (`opencode-v2-event-log.ts`) read `properties`,
silently dropping every v2 event.

**Fix (branch `fix/opencode-v2-event-envelope`; the three envelope-focused files
total 64 tests green, the full focused sweep 202 pass / 8 gated skips):**

- `normalizeEventEnvelope` (`engine.ts`) maps v1 contract, v1 `payload` wrapper,
  and the v2 `data` envelope to the one contract shape every consumer reads.
- `isPermissionAsked` accepts both `permission.asked` (live v2) and
  `permission.v2.asked` (the sibling the migration spec §2.3 recorded).
- `permissionToolCallId` reads the v2 `source.id` (the same value the
  `session.tool.*` events carry as `data.id`) as well as the v1 `tool.callID`,
  so delivered-allow coverage correlates on v2.
- The observer (`opencode-server-authority.ts`) normalizes both generations: the
  v2 `session.tool.called`/`success` family (terminal = `success`) and the v1
  `message.part.updated` shape; a v2 success now consumes coverage and records
  the mutation, and an undecided v2 mutation alarms under `enforced`.
- `consumeOpenCodeV2EventStream` reads `data`.
- Live-wire-shaped fixtures: `test/remote-acp-engine.test.ts` (envelope),
  `test/opencode-server-authority.test.ts` (data-wrapped ask answered; v2
  success records; undecided v2 mutation alarms), `test/opencode-v2-event-log.test.ts`
  (data-envelope journal).

**Source grounding** (docs first, source by exception): the v2 docs
(`GET /api/session/{sessionID}/permission/{requestID}` → `{ data: Request }`;
`POST …/reply` { `reply` } → 204; Permissions page: `action`/`resource`/`effect`,
`once`/`always`/`reject`) and `packages/core/src/permission.ts`
(`Event.Asked` payload = `Permission.Request`), `packages/schema/src/session-event.ts`
(`Tool.Called`/`Success`/`Failed`; deprecated `session.next.*` spellings)
and `packages/app/src/context/server-session-v2-reducer.ts` (`event.data.id` is
the tool callID) in the `anomalyco/opencode` fork the pinned binary is cut from.

**Posture:** the *mapping* defect is fixed and pinned by tests, but the plane
runs the old image; the live tool-turn verdict flips only after a rebuilt,
digest-repinned release. No `enforced` claim is upgraded by any of this.

**2026-10-10 — the sibling wire defect (reply body field), found on the live
plane after the envelope fix deployed (branch `fix/opencode-v2-permission-decision`,
cut from `main`@8ae5f9b1 which carries the envelope fix):** with the envelope
defect fixed, the broker arm got much further — `session=ses_…` and `id=per_…`
now resolve, the decision logs `allow shell` — but `delivered=false` with
`upstream reply failed: remote engine POST …/permission/…/reply failed (400)` and
the mutating tool stayed `running`. Root cause: the pinned v2 (2.0.10) reply body
field is **`decision`**, not `reply`.

Live proof (the running plane's own OpenAPI): `GET /openapi.json` advertises
`POST /api/session/{sessionID}/permission/{requestID}/reply` requestBody
`{ properties: { decision: Permission.Reply, message?: string }, required:
["decision"], additionalProperties: false }`. Sending `{ reply }` is a 400 with an
empty body — `additionalProperties:false` rejects the unknown key and `decision`
is required. The pinned binary agrees: the in-binary server endpoint is
`so("session.permission.reply","/api/session/:sessionID/permission/:requestID/reply",
{ …, payload: o({ decision: CS, message: … }) … })`, its handler maps
`reply: s.payload.decision`, and its client lib posts `body: { decision, message }`.
The route spelling in the spec table above is correct; only the body field name was
wrong.

**Fix (two consumers):**

- `HttpRemoteEngine.replyPermission` (`engine.ts`) posts `{ decision: input.reply }`.
  The in-process API name stays `reply`; only the wire field maps to `decision`.
- The gateway's inbound parser (`opencode-server-gateway.ts`
  `handlePermissionReply`) reads `body.decision ?? body.reply`, so a live v2 TUI
  reply is intercepted (and the legacy spelling tolerated); a body with neither is
  a 400, never forwarded.

**Tests:** `test/remote-acp-engine.test.ts` asserts the outbound body is
`{ decision }`; `test/opencode-server-gateway.test.ts` asserts a `{ decision }`
reply is intercepted, a legacy `{ reply }` reply is intercepted, and a body with
neither fails closed 400. Focused sweep green; no existing assertion weakened.

**Residual (off the plane's broker path):** the engine's non-broker REST helpers
and `opencode-session.ts` still carry v1 spellings (recorded above). The
`docs/OPENCODE_REMOTE_ACP_SPEC.md` table line for `…/reply` still shows the v2
*docs* `{ reply }` shape, which the pinned binary contradicts; that table is left
as the captured doc citation and this section records the measured binary/OpenAPI
contract.

## Addendum (2026-10-11, C1 live plane — the systemic-denial fault, diagnosed)

A live agent session inside the deployed plane reported the broker "began
denying every tool call — including benign read-only `ls`/`grep` inside the
authorized workspace — and finally denying even read/grep/glob", surfaced in the
UI as "The user declined this tool call". Ground truth from the container console
log (`az containerapp logs show … --container plane`), one line per decision:

```text
[auth] deny shell reason=session ses_ed75ecb8fffeTgcPcBxOLlwtNI and its descendants exhausted the mutation budget
```

**Not the circuit breaker, not a guard ask.** No `POLICY_CIRCUIT_BREAKER` line
appeared, and no `guard ask …` line appeared. The reason is
`MUTATION_BUDGET_EXHAUSTED` (`src/application/workflow.ts:290`,
`src/application/mutation-budget.ts`).

**Root cause.** `MutationBudget` (default cap 100) is parent-owned and consumed
by every ALLOWED mutation. OpenCode classifies `bash`/`shell` as the `process`
capability, so **any shell command is a mutation** — including benign `ls`/`grep`
run through the shell. After ~100 allowed shell actions the root session's
counter hits its cap and every later MUTATION is denied for the life of the
session. The denials were not sticky onto `read`/`glob`/`grep` (those are
`read`-capability and never reach the budget gate), but two confusions made the
session read as fully dead:

1. A cloud of 200+ `[auth] deny (operator reply)` lines — these are the client's
   own replies noted in auto-resolve mode (policy already answered upstream),
   journaled as `deny`. They are cosmetic, not policy denials.
2. The UI rendered every one of those as "the user declined this tool call".

**Fix (branch `fix/c1-authority-denial-and-live-test-hardening`):**

- The deny reason now carries `consumed/max` and names the reset seam
  (`WorkflowApplication.resetMutationBudget`, new; the `MutationBudget` already
  had `clear`). The budget is and stays a bounded, fail-closed policy: it refills
  only via an explicit operator/session reset or a new root session, never
  implicitly.
- The noted operator reply is journaled as `observe`, a new non-answer value in
  `OpencodeAuthorityDecision`, so no surface renders it as a decline.
- **New observability route** `GET /api/workflow/authority`: the gateway answers
  it from the broker journal (recent decisions + the gateway's OWN route-matrix
  posture), never forwards it upstream. An agent/operator can read a systemic
  denial over the wire without `az containerapp logs`. `OpenCodeV2RouteClass`
  gains `workflow-inspection` with disposition `workflow` (GET) / `deny` (other
  verbs).

**Tests.** `test/application-policy-failure-tracker.test.ts` — the bound is named
and reversible, and a denied mutation does NOT deny a subsequent unrelated read
(where the reported fault said it did). `test/opencode-server-authority.test.ts`
— a noted reply is `observe`, not `deny`. `test/opencode-v2-route-class.test.ts`
+ `test/opencode-server-gateway.test.ts` — the inspection route class, the served
payload (posture + reasons), the never-forward guarantee, and the 403/401 paths.

**Residual.** On the plane the delivered image must carry this branch before the
route exists. The read route returns the last 200 decisions and the gateway
posture only; it is not a durable audit log (the process-local journal resets on
daemon restart).

## Addendum (2026-10-11, follow-up — talking to the agent, the configurable cap, and the Key Vault key source)

The fault fix above made the exhaustion OBSERVABLE (log, journal, read route) and
reversible (reset seam). This addendum lands the three follow-ups the fault
exposed. All are on `fix/c1-authority-denial-and-live-test-hardening`.

**1. In-band feedback — tell the agent, do not just log.** The decisive gap: had
the exhaustion been communicated to the model, it could have adapted. The live v2
reply route's body is `{ decision, message? }`, and on `reject` a present
`message` becomes a `CorrectedError({ feedback })` the model sees ("The user
rejected permission ... with the following feedback: …"). So the broker's
`deliver` now attaches `rejectionFeedback(decision)` as `message` on every
`reject` that carries a reason (`src/integrations/opencode-server-authority.ts`);
a rejection reads `Workflow denied 'edit': session <id> ... exhausted the
mutation budget (100/100 consumed); an operator/session reset (resetMutationBudget)
is required ...`. Allows stay `{ decision: "once" }` (no message). An operator or
timeout reject with no reason carries no message. Bounded to 200 chars like the
log/journal. Source-anchored on the pinned v2 (`packages/core/src/permission.ts`
reply → `CorrectedError`; `packages/schema/src/v1/permission.ts ReplyBody`).

**2. The mutation cap is operator-configurable.** `WORKFLOW_MUTATION_BUDGET`
parses through `mutationBudgetFromEnv` (fail-closed: a non-positive-integer value
throws rather than degrading to an arbitrary cap; unset keeps the honest default
100). `WorkflowApplication` takes it as a trailing ctor arg (the daemon wires it;
tests pin small caps). The daemon logs the effective cap at startup. This is the
lever the operator pulls when a legitimate long session needs more than the
default; it is not an auto-refill.

**3. The upstream key can come from the secret store (F2 durable).** The prior
F2 fix only flagged the uid-shared env in `workflow doctor`. Now
`loadUpstreamApiKeyFromSecretStore` (with `WORKFLOW_UPSTREAM_KEY_FROM=azure-kv`)
resolves the key from the W156 `SecretStore` (Key Vault via managed identity)
instead of a container env. The seam is AUTHORITATIVE, not a fallback: when
`WORKFLOW_UPSTREAM_KEY_FROM` is set the store is the only source, so a lingering
uid-shared env/file key does NOT win (that would silently defeat the fix). A
named-but-absent vault secret THROWS fail-closed (never a silent fallback to a
uid-shared env); an unknown backend throws at parse. `FROM` also selects the
store backend (the daemon overrides `WORKFLOW_SECRET_STORE` for the resolution).
The daemon wires it before
`createOpencodeServerRuntime`; absent the seam the path is byte-identical.
The doctor gained `checkDaemonUpstreamKeyExposure`: it reads the DAEMON's own
`/proc/<pid>/environ` (via the discovery pid) and reports presence only — the
durable check, replacing the previous proxy that inspected the doctor's own env.

**Tests.** `test/remote-acp-engine.test.ts` — `message` rides a reject and is
absent on an allow. `test/opencode-server-authority.test.ts` — every
reason-bearing reject carries in-band feedback. `test/opencode-server-budget-
enforcement.test.ts` — the crossed-budget reject tells the agent why while the
read passes. `test/mutation-budget.test.ts` — the env cap parses, defaults, and
fails closed. `test/application-policy-failure-tracker.test.ts` — an explicit
cap binds exactly. `test/upstream-key.test.ts` — the secret-store source, the
absent-secret fail-closed, and the unknown-backend fail-closed.
`test/doctor.test.ts` — the environ parse is value-blind and the bogus-pid read
is an honest "cannot measure".

**Residual (dated).** (a) The in-band `message` is source-anchored but not
live-probe-verified on a real model turn — the v2 PERMISSION probe that emits a
real `permission.asked` still needs a model key; until then the feedback is
advisory, not proven surfaced. (b) `checkDaemonUpstreamKeyExposure` reads
`/proc/<pid>/environ`, which a same-uid process can read but a *different* uid
cannot — an unreadable environ is reported as "cannot measure" (pass), never a
false fail; the check is a diagnostic aid, not an authorization gate. (c) The
configurable cap and the secret-store source are operator/deploy actions: the
plane must set `WORKFLOW_UPSTREAM_KEY_FROM=azure-kv` (and store the secret) and
stop riding `WORKFLOW_UPSTREAM_KEY` as a container env, or the exposure persists.

## Addendum (2026-10-13, round-2 live plane — the v2 `resources` subject gap and the reject cascade)

A round-2 in-plane test on the `clean1` revision (v0.1.11) surfaced: benign
reads allowed (`allow shell … reason=policy allow`, ×27) while an
`external_directory` tool turn and an `edit` were denied as
`unmappable permission request (fail closed): invalid ACP tool subject` — with
the paired `delivered=false … upstream reply failed: … /permission/…/reply`
(404). Ground truth is the plane console (`[authority]` lines), not the inner
OpenCode log.

**Root cause (one defect, two symptoms).** The pinned v2 `Permission.Request`
carries the subject in **`resources`** (`{ id, sessionID, action, resources[],
save?, metadata?, source? }`, `packages/schema/src/permission.ts`); `metadata`
is freeform and, on the live wire, held no path. `permissionToolCall`
(`src/integrations/remote-acp/projection.ts`) built ACP locations from
`metadata.filepath/filePath/path` ONLY, so a v2 `edit`/`external_directory` ask
yielded no subject; the adapter's fail-closed guard (`src/adapters/acp.ts`,
"mutating + mutation + no subject ⇒ invalid ACP tool subject") threw, and the
broker recorded the unmappable deny. The path genuinely lay outside
`/workspace`, so confinement was correct — the subject simply never reached the
confinement gate (`workflow.ts:248-255` `WORKSPACE_PATH_DENIED`).

**Second symptom — the reject cascade.** opencode's `PermissionV2.reply("reject")`
fails EVERY pending request in the session with a bare `DeclinedError` (message
-less ⇒ `catchTag`→`die`) for the siblings (`packages/core/src/permission.ts`).
So one broker reject resolves a sibling ask, and the broker's follow-on reply for
that sibling answers **404** (`pending.get(id)` misses ⇒ `NotFoundError`). A
message-less decline is what the surface renders as "The user declined this tool
call" → "Step interrupted".

**Fix (two consumers).**

- `permissionToolCall` derives locations from `request.resources` for
  PATH-subject actions (`edit`/`write`/`patch`/`read`/`list`/
  `external_directory`/…), keeping `metadata` as the higher-priority v1 signal,
  and prefers the resource path as the title when metadata offered none.
  `shell`/`webfetch`/`task` resources (a command, URL, or agent name) AND
  `glob`/`grep`/`search` resources (a glob/regex pattern, not a path) are
  deliberately NOT mapped, so they cannot fake a confinement subject. The
  out-of-workspace path now returns the legible `WORKSPACE_PATH_DENIED`.
- `deliver` (`opencode-server-authority.ts`) journals a reply failure carrying
  `404`/`409` as `already resolved upstream (the v2 reject cascade drains
  sibling asks)`, not the alarming `upstream reply failed` framing. The boolean
  still gates coverage seeding, so an undelivered allow never authorizes later
  activity (unchanged).

**Skills (same run).** `WORKFLOW_PLANE_FULL_TOOLBOX` was unset, so the plane
took `resolveSkillsMount()` (mount-only-if-present) and never created or
provisioned the hub-owned `~/.agents/skills` store, leaving the fleet `skill`
kind (e.g. `code-cheatsheet`, `/explain`) unreachable. A new runtime option
`ensureSkillsStore` (independent of the O-4 `mountFullToolbox` switch) is wired
`true` on the plane lane so the store is created and provisioned every launch;
`skill: "deny"` is untouched (delivery is the journaled `read_skill`). A side
effect is that once the store resolves, the block also composes the narrow
declared-floor connector mounts (`workflow-guard-mcp`, and `skills-mcp` from the
delivery mount) into `config.mcp` — the documented plane floor, restored rather
than newly widened (the full catalog still needs the O-4 opt-in).

**Tests.** `test/remote-acp-projection.test.ts` — a v2 `edit`/`external_directory`
takes its subject from `resources`; a `shell` command's resources are NOT treated
as a path. `test/opencode-server-authority.test.ts` — an out-of-workspace
`external_directory` ask whose path rides `resources` denies by
`WORKSPACE_PATH_DENIED` (not unmappable); an in-workspace `edit` is allowed; a
404 reply is journaled as already-resolved. `test/opencode-server-launcher.test.ts`
pins the plane wiring; `test/acp-runtime-agent.test.ts` pins `ensureSkillsMount`
creating the store and degrading to no-mount when the build is absent.

**Posture.** Source-verified with focused tests; live-probe PENDING — the plane
runs the old image, so every affected claim stays **Partial** until a rebuilt,
digest-repinned release loads a real `edit`/`external_directory` turn and a
`/explain`.


## Addendum (2026-10-13, round-3 live plane — the turn-abort class, the falsified in-band feedback, and the native deny)

A round-3 in-plane test on the v0.1.12 revision (the round-2 fixes deployed)
surfaced a WORSE class than round 2: the agent's tool calls failed AND the
session froze. The round-3 console showed the legible deny the round-2 fix
produced, paired with the reject cascade, and then the breaker:

```text
[authority] deny external_directory … reason=path /app/src/cli/* is outside authorized workspace /workspace
[authority] deny external_directory … reason=path /app/src/integrations/* is outside authorized workspace /workspace (already resolved upstream: the v2 reject cascade drains sibling asks)
[authority] deny shell … reason=session ses_… has repeated policy failures; operator intervention is required
```

**Root cause (one abort path, two amplifiers; grounded in the pinned source).**

1. **A reject kills the turn; the round-2 in-band feedback never reached the
   model.** `PermissionV2.assert` (`packages/core/src/permission.ts:197-218`)
   awaits the ask deferred and does `catchTag("PermissionV2.DeclinedError", die)`.
   `isUserDeclined` (`packages/core/src/session/runner/llm.ts:145-150`) matches
   that die and `Effect.interrupt`s the step (`:304-308`). A reject WITH a
   `message` becomes `CorrectedError` (non-fatal), but the SIBLING cascade
   (`permission.ts:237-246`) fails every other pending ask with a bare
   `DeclinedError` — always fatal. Worse, the tool wrappers
   (`tool/{bash,read,write}.ts`) `Effect.mapError(() => new ToolFailure(…))`
   with NO error argument, so even the primary `CorrectedError.feedback` is
   discarded: the model saw a generic `Unable to …`. **The round-1 claim that
   the in-band message reaches the model is FALSIFIED** (see the 2026-10-11
   addendum §1 and THREAT_MODEL.md's "advisory until that probe runs"); the
   message is masked by the tool wrapper on the pinned version.
2. **The breaker counted the boundary.** `authorize` (`workflow.ts`) listed
   `WORKSPACE_PATH_DENIED` among the breaker classes, so two path denials opened
   the breaker (threshold 2) and every later mutation was denied
   `POLICY_CIRCUIT_BREAKER` for the session. The server lane also never reset the
   breaker (only the ACP lane wired `recordToolOutcome`).

**Fix — the boundary is engine-native, and the guidance is stated up front.**

1. **A native `deny` effect, not an ask answered with `reject`.** The composed
   config now carries `permission.external_directory = "deny"` (the other pins
   unchanged). Measured against the pinned v2.0.10 binary: it honors this v1
   shape and migrates it to `permissions:[{action:"external_directory",
   resource:"*",effect:"deny"}]` (`/api/config`). A config `deny` returns a
   non-fatal `BlockedError` (`permission.ts:201-205`) — the tool reports it and
   the step continues — and it never routes an `ask`, so there is no reject, no
   cascade, and no turn abort. In-workspace paths never assert
   `external_directory`, so this denies exactly the out-of-workspace access the
   plane already refuses. The `WORKSPACE_PATH_DENIED` broker path remains as
   defense in depth for any ask it still sees.
2. **`WORKSPACE_PATH_DENIED` leaves the breaker classes** (`workflow.ts`): the
   boundary is not a destructive-policy retry and must never ratchet toward a
   freeze. The server lane now resets the breaker on a completed, policy-allowed
   mutation (`opencode-server-authority.ts` `observeToolPart` →
   `recordToolOutcome(…, "succeeded")`), matching the ACP lane.
3. **The rule is told to the agent.** The runtime install folds a code-owned
   workspace-boundary block into the installed global `AGENTS.md`
   (`fleet-agent-install.ts` `WORKSPACE_BOUNDARY_GUIDANCE`, via
   `loadAmbientFoldDocs`), ahead of the vendored `STANDARDS.md` and style floor.
   The vendored sources stay byte-identical (the guidance is code-owned). This
   is the "make it easier for the agent not to break it" channel: the agent says
   what the boundary is before it probes.

**Tests.** `test/opencode-v2-metered-config.test.ts` pins the composed
`external_directory: "deny"` for both config shapes. `test/fleet-agent-install.test.ts`
pins the boundary fold ordering and that the vendored `AGENTS.md` source is
untouched. `test/application-policy-failure-tracker.test.ts` pins that repeated
`WORKSPACE_PATH_DENIED` never opens the breaker and leaves the session live.

**Posture.** Source-verified with focused tests AND the config migration
verified live against the pinned v2.0.10 binary (`/api/config`); the
turn-continuation behavior is source-grounded but live-probe PENDING on a real
model turn — every affected claim stays **Partial** until a rebuilt,
digest-repinned release runs a real out-of-workspace probe and the session
continues.


## Addendum (2026-10-13, round-4 live plane — the turn-abort fix HELD; two narrower defects recorded)

A round-4 in-plane test on the **v0.1.13** revision (`csh-dev-plane--0000020`,
image `sha256:744c38d9…19cc0`) ran the probe round 3 left pending: a rebuilt,
digest-repinned release executing a real out-of-workspace tool call on a live
model turn. **The headline round-3 defect is FIXED.** The boundary denial is now
non-fatal and the session never freezes.

**Held (upgrades the round-3 claim from source-grounded to live-verified).**

- **The boundary denial is non-fatal and the turn continues.** `read
  /app/src/integrations/contained-shell-executor.ts` returned
  `{"error":{"type":"permission.rejected","message":"Permission denied:
  external_directory"},"content":[]}` — an engine-native `BlockedError` — and the
  SAME turn then created `/workspace/probe1-inworkspace.txt` successfully
  (`[authority] allow edit … delivered=true reason=policy allow`). The path never
  reached the broker (journal `external_directory`/`WORKSPACE_PATH_DENIED`
  entries = 0). No turn abort, no `Effect.interrupt`, no "The user declined this
  tool call".
- **Repeated boundary probes never freeze.** 8+ out-of-workspace probes
  (read + edit against `/etc`, `/root`, `/app/src/containment`, `/srv`, …),
  interleaved with in-workspace edits, all returned the same non-fatal
  `external_directory` denial; a later in-workspace edit was ALLOWED and the
  journal shows **0** `POLICY_CIRCUIT_BREAKER` / "repeated policy failures"
  entries. The breaker-class removal and the server-lane reset hold live.
- **No reject-cascade churn for boundary paths.** Broker `reject` decisions = 12,
  **0** for `external_directory`; `upstream reply failed` = 0. The boundary no
  longer routes an `ask`, so there is no reject and no sibling cascade.
- **The boundary block is installed and precedes the ambient docs.**
  `$XDG_CONFIG_HOME/opencode/AGENTS.md` line 53 =
  `# --- fleet:workspace-boundary.md (folded into AGENTS.md at install) ---`,
  ahead of the `fleet:STANDARDS.md` banner. (Behavioral attribution to the fold
  vs the model's own reasoning is not cleanly separable — the deny message itself
  names `external_directory`; recorded as PARTIAL.)
- **Skills reach the model.** `read_skill name: code-cheatsheet len: 4230`;
  `/home/node/.agents/skills/code-cheatsheet/SKILL.md` exists; `/explain` drove a
  real session end to end; native `skill:"deny"` unchanged.
- **Fleet + config parity.** `/api/agent` lists the six fleet agents; composed
  config `permission {edit:ask, bash:ask, task:ask, skill:deny,
  external_directory:deny}`.

**New defect 1 — per-agent tier pins do NOT resolve on the v2 runtime
(FALSIFIES the round-2 tier claim).** Running each agent via
`POST /api/session {"agent":"…"}` records `model = {id:"openrouter/auto",
providerID:"openrouter"}` for **executor, reviewer, and screener alike** — the
session default, not the per-agent `openrouter/syn:small:text` /
`syn:large:text` pin the runtime transform writes. Grounded in the pinned
source: the v2 runner resolves the model from `session.model` only
(`packages/core/src/session/runner/model.ts:188-206`), never `agent.model`; the
v2 `CreateInput` carries `agent` and `model` as separate fields
(`packages/core/src/session.ts:79-82`) and does not derive the model from the
selected agent. The v1 path DOES fall back to `agent.model`
(`packages/opencode/src/session/prompt.ts:469` — `input.model ?? agent.model ??
…`), which is why the mechanism was assumed to carry over. It does not. The
catalog and proxy resolve both tiers correctly; only the session's default-model
selection ignores the agent pin. The round-2/round-3 FEATURES claim that "the pin
resolves" is therefore **FALSIFIED for the v2 plane lane** (tracked as a work
item; the fix is a plane-side session-create that seeds `model` from the selected
agent, or a runtime mechanism that maps the v2 agent model into `session.model`).

**New defect 2 — a broker `reject` still aborts siblings (narrower than round
3).** The engine-native boundary is clean, but the broker path for a
NON-boundary deny (e.g. the `subagent` tool denied `capability spawn is not
available to this workflow`, answered with `reject`) still produces the v2
sibling cascade: `[authority] deny subagent …`, then a sibling edit surfaces as
`{"error":{"type":"aborted","message":"The user declined this tool call"}}`, and
the allow is journaled `already resolved upstream`. Isolated probes: denied
**read** + edit sibling → edit **succeeds**; denied **subagent** + edit sibling →
edit **declined**. So the cascade is specific to the broker `reject` reply
(fatal for a mutating sibling), NOT to the engine-native boundary. Turn
continuation and the session survive; the blast radius is one batch's siblings.
Tracked as a follow-up.

#### Update (2026-10-14, W186): the single-deny batch is now drained

The cascade is structural in the host: `PermissionV2.reply("reject")` fails the
target ask and then **every other pending ask in the same session** with a bare
`DeclinedError` (`packages/core/src/permission.ts:231-247`), and the runner's
`isUserDeclined` interrupts the turn (`packages/core/src/session/runner/llm.ts`).
There is no non-cascading deny reply (`Permission.Reply` is `once | always |
reject`, `packages/schema/src/permission.ts:40`).

The broker now **drains allowed siblings before delivering a reject**
(`drainAllowedSiblings`, `src/integrations/opencode-server-authority.ts`): when a
deny is decided in `auto-resolve` mode, it lists the session's host-pending asks
(`GET /api/session/:id/permission`, `packages/protocol/src/groups/permission.ts`)
and resolves every one that policy ALLOWS with `once` — which does NOT cascade —
so the reject finds no allowed sibling pending. The reported case (one deny plus
a concurrently-allowed edit) no longer loses the edit, independent of SSE event
arrival order — the drain reads the host's pending-ask registration, so a sibling
is caught whether or not its own event has streamed yet. A drained ask is
remembered so its still-queued SSE event is not answered a second time.

**Residual (stated, not fixed): a batch with TWO OR MORE concurrent denies still
aborts.** A denied sibling cannot be resolved without delivering its own reject,
which cascades onto the others; no reply value or ordering avoids this host-side.
Fix requires an upstream non-cascading deny reply. `ask-me` mode is deliberately
exempt from the drain (an allowed sibling must stay held for the operator, never
auto-approved). The drain is best-effort and fail-open: an absent listing route, a
listing failure, or a drain that exceeds the bound (`siblingDrainTimeoutMs`,
default 2000ms — the drain sits on the deny path, so the listing round trip AND
the sibling decide/resolve loop must not stall the reject) leaves the pre-W186
reject path unchanged. A sibling id is remembered as drained only when its reply
actually reached the host, so a failed delivery can never leave an ask silently
unanswered.

**Residual — skill write target is outside the workspace.** `/explain`'s own
write target (`~/.local/share/cheatsheets`) is outside `/workspace`, so a
boundary-confined session cannot persist a sheet. A real skill/workspace-policy
tension, recorded not fixed.

**Also observed (not a regression):** `shell` (capability `process`) reads
outside `/workspace` are not blocked — the external-directory deny is enforced
on the `read`/`edit`/file-tool surface, not on arbitrary bash reads. This is the
recorded boundary surface; note it plainly (the shell capability auto-allows, and
the OS/confinement still permits reads).

**Posture.** The turn-abort / session-freeze claim moves from **Partial** to
**live-verified** on v0.1.13 (`csh-dev-plane--0000020`). The per-agent tier
claim is marked **FALSIFIED for the v2 plane lane** and the broker-reject sibling
cascade is a **partially-drained follow-up** (W186: the single-deny batch is
drained host-side; a 2+-deny batch remains a stated residual) — none blocks the
boundary fix.



