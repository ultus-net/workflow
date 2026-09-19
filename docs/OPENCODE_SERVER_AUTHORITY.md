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