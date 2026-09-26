<!-- Ledger fragment: extracted from TASKS.md at line 918 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W071 - Stock-TUI surface over a hub-owned OpenCode server

**Objective:** Let the operator keep the standard `opencode` TUI as the
interface while the Workflow hub owns, contains, and authorizes the OpenCode
server behind it — the inverse of the current browser-fronted composition and
the terminal counterpart to the remote ACP bridge. Plan:
`docs/superpowers/plans/2026-09-19-standard-tui-background-authority.md`.

**Depends on:** W035 (ACP conformance), W037 (ACP session driver), W046 (task
correlation), W050 (Cline retirement; hub-http seam), and the merged remote ACP
bridge (`src/integrations/remote-acp/*`, PR #43).

**Acceptance criteria:**
- [ ] The hub launches and owns a **contained** `opencode serve` (Bubblewrap,
      loopback-only, hub-written config: metered provider via the loopback
      proxy, pinned `ask` ruleset, skills-mcp mount, scratch HOME); an
      unavailable or policy-only containment backend fails closed.
- [ ] A loopback **gateway** fronts the server with an auth split — the
      upstream server credential is hub-only, the stock TUI holds a distinct
      password — and permission replies from the client are routed to the hub
      broker, so the hub is the **sole** upstream permission answerer.
- [ ] The `workflow-opencode` launcher `exec`s the stock `opencode attach`
      binary with connection details only; the operator's UI is unmodified and
      Workflow owns no display.
- [ ] The hub broker maps `permission.asked` → `ProposedToolAction` →
      `WorkflowApplication.authorize` + guard, replies fail-closed, correlates
      sessions to canonical tasks, and records decisions/evidence; malformed
      events, SSE loss, and reply errors all reject.
- [ ] The gated probe family runs live with per-probe verdicts recorded in
      `docs/HOST_ADAPTERS.md` (TUI-ATTACH, AUTHORITY-SPLIT, PERMISSION,
      RULE-CONFIG, BYPASS, SUBAGENT, SSE/TURN, AUTH/METERED, CONTAINMENT); the
      surface is reported `enforced` **only** on green PERMISSION +
      RULE-CONFIG, otherwise `advisory`.
- [ ] Residuals are recorded, not buried: host-network egress for the
      contained server, subagent-internal projection invisibility, and the
      Workflow-managed server home/history.
- [ ] Focused gates pass on the diff (`npm run lint`, `npm run typecheck`,
      focused tests) and an independent five-axis review is recorded.

**Verification:** the live attach + denial + bypass probe evidence, the
`HOST_ADAPTERS.md` verdict row, the updated `docs/HUB.md` / `docs/FEATURES.md` /
`SECURITY_ASSURANCE.md` claims, and an independent five-axis review before
merge.

**Status (2026-09-19, M0–M3 on branch `feat/w071-standard-tui-background-authority`):**
plan `docs/superpowers/plans/2026-09-19-standard-tui-background-authority.md`;
decision record `docs/OPENCODE_SERVER_AUTHORITY.md`. **M0 complete:** against
real opencode 1.18.31, the loopback server honors `OPENCODE_SERVER_PASSWORD`,
reads the hub-written `XDG_CONFIG_HOME` config, the `ask` ruleset is pinnable,
the gateway passes the stock-client surface, and the **authority split holds**
(TUI-only credential → 401 upstream; intercepted at the gateway). **M1
implemented:** `opencode-server-runtime.ts` (contained `opencode serve` +
metered config + proxy, fail-closed), `opencode-server-gateway.ts` (auth split,
compression/pathname fidelity, broker hook vs advisory pass-through),
`opencode-server-discovery.ts`, the `workflow-opencode-server` daemon, and the
`workflow-opencode` stock-TUI launcher (bins/scripts added). **Sequencing
refinement (recorded):** server ownership landed in a dedicated workspace-scoped
daemon, not the global `workflow-hub`; hub promotion stays available through the
discovery seam. **M2 implemented:** `opencode-server-authority.ts` —
subscribes to the server SSE via the production `HttpRemoteEngine`, maps each
`permission.asked` to a `ProposedToolAction` (`AcpHostAdapter` + an explicit
OpenCode capability classifier so `webfetch`→network and `task`→spawn), runs
`WorkflowApplication.authorize` (+ optional guard), and answers upstream
`once`/`reject`; unmappable/malformed/guard failures and policy denials all
`reject` (fail closed); SSE loss marks authority lost; sessions correlate to
canonical `opencode-session:<id>` IN_PROGRESS tasks; every decision is
journaled (observability only). **Review passed:** an independent five-axis
review returned REQUEST_CHANGES (2×P1) and all fixes landed (reply-route
normalization-safety, advisory forward path, authority-lost teardown, gateway
error boundary, launcher hardening); the branch was rebased onto main (W071 =
Phase 13). **M3 implemented:** operator-intent reconciliation —
`auto-resolve` answers from policy immediately (operator reply = observation);
`ask-me` holds policy-allowed asks and reconciles the operator's answer as
`policyDeny ? reject : operatorReply` with a fail-closed timeout, so the
operator can tighten but never loosen; enforcement mode
(`WORKFLOW_OPENCODE_ENFORCEMENT=enforced`) verifies the pinned `ask` ruleset at
startup (`assertAskRuleset`, fail closed), makes the gateway construction
refuse to exist without the broker hook, and arms the bypass alarm — a
mutating tool activity with no prior Workflow decision is journaled, fires
`onBypass`, and tears the surface down. **M4 implemented:** server-path
evidence/metering/budget/skills — `recordMutation` on observed completed
mutations (a decided-but-not-completed mutation advances nothing); skill
delivery journaled on observed completion (`recordSkillRead` bound to the
session task; `read_skill` entered the ACP adapter's `KNOWN_READ_TOOLS` and
the broker carries a read kind so the delivery is authorizable); the
session-budget watcher (`opencode-server-budget.ts`, W045 caps → abort active
turns + sticky violation → mutating asks denied fail-closed); the daemon logs
the active budget mechanism and final metering totals. Focused gates green:
typecheck, lint, 43 unit tests, gated live probe, build. The verify-command
run gate stays hub-owned (recorded boundary). **Still open:** the live
`permission.asked` → authorize → reply probe and the rest of the probe family
(RULE-CONFIG/BYPASS/SUBAGENT/AUTH/METERED/CONTAINMENT — need a model key), a
real contained launch with a key, the literal interactive TUI operator smoke,
the `HOST_ADAPTERS.md` verdict row, and the final five-axis review pass. The
surface remains **`advisory`** — no `enforced` claim until the probes run.

## Phase 14: Roadmap Compliance & Plugin-Retirement Parity (2026-09-19)
