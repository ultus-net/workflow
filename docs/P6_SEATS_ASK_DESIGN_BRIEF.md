# P6 — The four-seat ask channel, the plane-3′ pending-ask surface, and the G2 `trustedRole` supply (DESIGN brief)

Status: **design-open** — a brief, not an implementation. No code changes in this
deliverable. Issue #285.
Author: P6 seats-design-brief subtask, 2026-09-30 wave.
Date: 2026-09-30.

This brief records the design for the P6 remainder so a future implementation
iteration can start red-first without re-deriving the extension points. Truth
lives in the cited files; where this brief and the tree disagree, the tree wins.

## 1. What is landed and what is open

The **primary seat already holds asks**. `src/integrations/opencode-server-authority.ts`
(W092/W094) is the benchmark: in `ask-me` mode a guard `ask` joins an operator
hold — parked, answered by the operator, `reject` on timeout — and the reply can
only *tighten*, never loosen, because the held request exists only after policy
allowed it (`answer()`/`holdForOperator`, lines 330-373; `handleOperatorReply`,
lines 527-553; `pendingOperatorReplies` getter, line 498).

Everything else collapses `ask` to deny. The four non-primary seats each flatten
`guardDecision.decision !== "allow"` into a denial, so a guard `ask` is
indistinguishable from a `deny` at those surfaces:

| Seat | Collapse site | Shape |
|---|---|---|
| ACP permission resolver | `src/adapters/acp-workflow-resolver.ts:72` | returns `{ kind: "deny" }` |
| hub-implemented ACP fs server | `src/integrations/acp-session.ts:649` | throws |
| in-process OpenCode plugin | `src/integrations/opencode-plugin.ts:35` | throws (host aborts the tool) |
| containment process seat | `src/containment/workflow-process.ts:17` | throws |

The assessment documents the collapse as a class
(`docs/AGENTS_RESEARCH_PORT_ASSESSMENT_2026-09-22.md:43-49`) and names the ask
channel as a retirement precondition (§1, §6). G2 part 2 (`trustedRole`) is the
same shape: the field exists and the vendored rule consumes it, but the seat
deliberately does not supply it
(`src/integrations/mcp-toolbox-guard.ts:253-254`).

## 2. Per-seat extension points

Each seat's guard branch becomes **three-way** (`allow` / `deny` / `ask`). The
`ask` branch awaits an injected operator hold, then returns the binary outcome
the seat's contract can carry. The ACP wire decision is binary
(`AcpPermissionDecision` is `allow | deny`), so an ACP-seat "hold" is a *latency
on the binary decision*: the resolver blocks on the operator, then answers
allow or deny. This is the same shape the daemon uses — a held ask is an allow
whose reply the operator supplies.

### 2.1 ACP permission resolver — `src/adapters/acp-workflow-resolver.ts:72`

- **Today:** `if (guardDecision.decision !== "allow") return { kind: "deny", reason }`.
- **Extension:** the guard branch gains an `ask` case that awaits
  `holdForOperator({ policy, reason, matched })`; approve → fall through to
  `{ kind: "allow" }`, reject/timeout → `{ kind: "deny", reason }`. Needs an
  operator-answer seam on `WorkflowAcpPermissionResolverOptions` (the resolver
  is already `async`, so the await is structurally free).
- **Note:** this resolver is the per-permission-request hook the ACP driver
  calls; a held ask blocks that one request, matching the daemon's documented
  "a held ask blocks the SSE loop up to the hold window" residual.

### 2.2 Hub-implemented ACP fs server — `src/integrations/acp-session.ts:649`

- **Today:** `if (guardDecision.decision !== "allow") throw new Error(...)`.
- **Extension:** an `ask` case awaits the hold *before* the `writeFile` at line
  658; approve proceeds to the write, reject/timeout throws the deny. The seat
  mutates in-process immediately after the guard check, so the hold must
  complete before the write — there is no queue to return to.
- **Note:** this seat's guard check runs *after* kernel authorization already
  (lines 633-653), matching the primary seat's "guard after kernel
  authorization" ordering, so no reorder is needed here.

### 2.3 In-process OpenCode plugin — `src/integrations/opencode-plugin.ts:35`

- **Today:** `if (guardDecision.decision !== "allow") throw new Error(...)` —
  the host aborts the tool call.
- **Extension:** an `ask` case awaits the hold; approve returns normally (the
  tool proceeds), reject/timeout throws. Needs the hold reachable from the
  plugin's composition — the plugin is constructed with `application` +
  `adapter` + `guard` (`createWorkflowOpenCodePlugin`), so the hold/answer seam
  is a fourth composition argument.
- **Note:** the plugin runs in the agent host process; the operator channel is
  whatever the launching surface exposes. If no operator is attached,
  `auto-resolve`-style fail-closed deny preserves today's behavior.

### 2.4 Containment process seat — `src/containment/workflow-process.ts:17`

- **Today:** `if (decision.decision !== "allow") throw new Error(...)`.
- **Extension:** an `ask` case awaits the hold before `this.containment.execute`
  (line 42); approve proceeds, reject/timeout throws.
- **Design wrinkle (call it out):** unlike the other three seats, this seat runs
  the **guard check before kernel authorization** (guard lines 14-20, then
  `application.authorize` at line 33). A held ask here would park *before* the
  kernel has ruled. The design should either (a) move the guard check after
  `authorize` to match the primary seat, or (b) define the ask as "guard asks,
  then the kernel still authorizes, and only the intersection passes" — and pin
  which one. Recommend (a) for one ordering story across seats.
- **Note:** this seat passes no `workspaceRoot` (the sandbox is the boundary;
  `mcp-toolbox-guard.ts:110-112`), so guard facts stay unenriched here — the
  hold must not depend on workspace facts.

## 3. Shared hold semantics (mirror the landed daemon hold)

One primitive, four (five, counting the daemon) consumers. Reuse the daemon's
contract verbatim; do not invent a second hold dialect:

- **Park.** On an `ask`, first consume an early operator reply if one arrived
  before the ask (the SSE-latency race — daemon `earlyReplies`, lines 353-357),
  else register a pending entry with a timeout timer (`holdForOperator`, lines
  358-372).
- **Answer.** `handleOperatorReply` reconciles **tighten-never-loosen**: an
  operator `reject` wins; anything else maps to the policy-allowed outcome
  (daemon lines 529-534). The held ask exists only because policy allowed it, so
  the operator can only deny.
- **Timeout.** An unanswered hold resolves to `reject` (fail closed) at the
  configured window (default 120s on the daemon, `operatorReplyTimeoutMs` line
  60-61). A stale early reply must not answer a later ask (line 361).
- **Cancel/stop.** Every pending hold resolves to deny on stop/mode-switch so no
  ask dangles (daemon `stop`, lines 518-526).
- **Counting / observability.** Expose a pending count (the daemon's
  `pendingOperatorReplies`) so the surface can project it.

The seat-level deny stays mode-independent: a guard `deny` is answered
immediately and never held (W092 acceptance criterion 3). Only `ask` parks.

## 4. Plane-3′ pending-ask surface — options

**What exists today.** The browser operator channel (plane 3′, the
uncredentialed loopback JSON channel — `docs/PROTOCOL_PLANES_2026-09-22.md:23`)
has exactly one park surface: `src/ui/web.ts:941-993` `/api/permission`
GET/POST projects **one** parked request via
`transportPermissionView(active?.pendingPermission())`, where `active` is the
in-process ACP session channel (`WebSessionChannel`, `src/ui/web-session-channel.ts:285`).
The park itself is the `PermissionBroker` (`src/ui/permission-broker.ts`), which
parks ACP-session permission requests in `ask` mode, keyed per session. The
daemon authority's hold is **not** projected: `src/cli/opencode-server.ts:293`
wires `onPermissionReply → authority.handleOperatorReply`, but no browser route
polls `pendingOperatorReplies`.

**Options (the choice is the operator's — see §6):**

- **A. Unify on the broker (in-process seats).** Route every seat whose ask
  parks in the same process as the operator UI (the ACP resolver, the ACP fs
  server, the OpenCode plugin when in-process, the containment seat) through the
  single `PermissionBroker`, so the existing `/api/permission` transport and the
  webapp's permission card render it for free. Strongest structural fit; the
  existing approvability/ownership checks (W141, P10) come along. Requires the
  hold seam to accept a broker-backed park instead of a bespoke timer.
- **B. A daemon status/SSE projection (out-of-process daemon lane).** The
  daemon authority owns its hold in the daemon process; add a status field (or
  an SSE event) carrying the held ask's `requestId`/tool/policy/reason, and a
  webapp card that posts the operator answer back through the existing
  `onPermissionReply` route. Needed because the daemon is a separate process
  from the web channel.
- **C. A hub/CLI surface only.** Minimum viable: render the pending ask in the
  terminal surface and answer there; defer the browser card. Honest but leaves
  the operator UI blind.
- **D. Do nothing (status quo).** The ask stays a deny everywhere but the
  daemon; this is the current state and is not a design.

**Recommendation:** A for in-process seats, B for the daemon lane, with A and B
sharing the §3 primitive so the two surfaces are one contract. C is the
fallback if the operator wants the smallest first step. Record the decision as
an operator question (Q4).

## 5. G2 part 2 — the `trustedRole` supply decision (the operator's)

`GuardCheckInput.trustedRole?` exists (`src/integrations/mcp-toolbox-guard.ts:38`)
and the vendored guard consumes it. The seat deliberately does not supply it
(`mcp-toolbox-guard.ts:253-254`: "seat-level role semantics are a separate
design decision (queued)"). **Guessing a role would fabricate a security fact**,
so this brief does not decide it.

**What the field does.** `isReadOnlyRole`
(`mcp-toolbox/apps/workflow-guard-mcp/src/policy.ts:54-58`) matches the role
case-insensitively against `reviewer, planner, advisor, critic, explorer, scout,
evaluator` (substring match). When matched, the guard **denies**:

- git mutations (`policy.ts:141-143`),
- shell file/git mutations (`policy.ts:144-147`),
- file writes (`policy.ts:194`).

**What supplying it would authorize.** Strictly nothing new — it is a
*constraint* input. Supplying a read-only role can only turn today's
allow/deny/ask into a deny. The security-relevant fact is **identity**: which
session/seat is a read-only role, and who attests it.

**The two failure directions of guessing:**

- **False read-only:** a legitimate mutating session is supplied a read-only
  role and its writes are denied — availability, not security.
- **False non-read-only (the dangerous one):** a session that *should* be
  read-only supplies no role and remains mutation-capable at the guard. Today
  every seat is in this state, so read-only intent is unenforced at the guard
  (the kernel may still gate mutations by capability).

**The decision to put to the operator** (Q5): where does the role fact come
from — session config, task metadata, the launching surface — is it host-supplied
(trusted) or agent-influenced (untrusted), and which seats should carry it? Do
not implement until this is answered; a red-first pin could then assert the
configured role reaches `guardCheck` and that a read-only role's `file_write` is
denied.

## 6. Implementation sketch and red-first pin plan

1. **Extract the hold primitive.** Factor `holdForOperator`/`earlyReplies`/
   `pending` from `opencode-server-authority.ts` into a reusable
   `createOperatorAskHold({ timeoutMs, now })` returning
   `{ park, answer, pendingCount, cancelAll }`. The daemon keeps its behavior;
   its existing tests (`test/opencode-server-authority.test.ts:539-596`,
   `test/opencode-server-ask-e2e.test.ts`) are the regression fence.
2. **Per seat, one change at a time (W097 "one change per iteration").** Make
   the guard branch three-way; `ask` awaits the hold.
   - **Red-first:** with a stub guard returning `ask`, assert `park`ed
     (`pendingCount === 1`), approve → allow/`once`, reject → deny, timeout →
     deny. Today the seat denies immediately, so every assertion is red before
     the change and green after. Do not fabricate a red in `src/`.
3. **Ordering fix for the containment seat** (§2.4): move the guard check after
   `application.authorize`, or pin the chosen ordering.
4. **Surface** per §4 (the operator's option) — the hold's pending count and
   payload rendered where the operator answers.
5. **`trustedRole`** only after Q5; a red-first pin as described in §5.

**Verification discipline:** focused tests only, never `npm test`. Red-first
capture verbatim; then `node --import tsx --test <files>` green; `npm run lint`
and `npm run typecheck` for any code iteration (this brief itself is docs-only —
see §8).

## 7. Open operator questions (separated)

- **Q1 — Scope of the first iteration.** All four seats at once, or the
  highest-value seat first (recommend the ACP permission resolver, §2.1, since
  ACP is the default surface)? W097 says one change per iteration.
- **Q2 — Ordering at the containment seat** (§2.4): guard-after-authorize
  (recommended) or intersection semantics? Which is canonical?
- **Q3 — No-operator behavior outside the daemon.** When a seat has no operator
  attached, should `ask` fail closed to deny (today's behavior, matching the
  daemon's `auto-resolve`) or block? Recommend fail-closed deny.
- **Q4 — Plane-3′ surface shape** (§4): broker unification (A), a daemon
  status/SSE projection (B), terminal-only (C), or nothing (D)?
- **Q5 — `trustedRole` source and trust** (§5): where does the role fact come
  from, who attests it, and which seats carry it? No implementation before this.
- **Q6 — Hold window and observability.** Is the daemon's 120s default the
  shared default? Should a held ask's pending count be journaled/metered?

## 8. What this brief is and is not

This is a **docs-only design record**. No code changed, so `npm run lint`,
`npm run typecheck`, and `npm run build` are **not applicable** and are not
claimed. The daemon hold (§3) is landed and verified elsewhere
(`docs/ledger/W092-*.md`, `docs/ledger/W094-*.md`, and the P6 daemon e2e pin in
`docs/ledger/P6-ask-channel-remaining.md`); this brief does not re-verify it.
