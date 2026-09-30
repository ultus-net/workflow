<!-- Ledger fragment: opened 2026-09-30 as the P6 hub-implemented ACP fs-server seat's ask-hold record (TASKS.md is frozen; live tracking is the GitHub Project, issue #285). Write-once record — append dated supersession notes, never rewrite. -->

### P6 hub ACP fs-server seat — the guard ASK HOLD (the write waits for the operator) (2026-09-30)

**Source:** the P6 seats-design brief §2.2 and §6 step 2 (`docs/P6_SEATS_ASK_DESIGN_BRIEF.md`): the hub-implemented ACP fs server collapsed a guard `ask` into a deny at `src/integrations/acp-session.ts` (the write was refused); the brief prescribes a hold that parks the ask for the operator, then lets the write proceed on approval and refuses it on reject/timeout. Issue #285. Dispatched as the P6 fs-server-seat subtask of the 2026-09-30 wave, branch `feat/p6-fsseat`, based on `origin/main` (no node_modules symlink needed).

**What landed (one seat per iteration, per W097):**

- **The fs-server seat** — `src/integrations/acp-session.ts`, `#resolveFs`: the guard branch is now three-way. A guard `ask` on a delegated write awaits `this.#hold.park({ requestId, policy, reason, matched? })` **before** the `writeFile`, then falls through to perform the write on approval and throws on `reject`/timeout (fail closed, surfaced to the agent as a JSON-RPC error). The seat mutates in-process immediately after the guard check, so the hold completes *before* the write — matching the brief's §2.2 note ("there is no queue to return to").
- **The operator-answer seam** — a new optional `hold?: OperatorAskHold` on the `AcpSessionDriver` constructor options and on the `AcpSessionDriver.contained(...)` options (passed through by `{ ...options, child }`). The hold is the landed primitive `createOperatorAskHold` (`src/integrations/operator-ask-hold.ts`) — no second hold dialect.
- **No-operator posture (the brief's Q3, fail-closed)** — when no `hold` is attached, an `ask` is denied immediately with honest ask provenance (`ask requires operator approval; no operator hold attached, failing closed`) instead of the collapsed `guard policy` deny.
- **`trustedRole` NOT supplied** — deliberately untouched per the brief §5: supplying a role would fabricate a security fact until the operator answers Q5. `guardInputFromToolCall` is unchanged.

**Red-first (no fabricated red):** the four new fs-seat pins were captured RED against the **unmodified** `src/integrations/acp-session.ts` (the new test + fixture only; the source change stashed). Verbatim first run:

```
not ok 1 - P6 fs seat: a guard ask parks before the write and the operator's allow releases it
  error: a guard ask must park on the operator hold before the write
  0 !== 1
not ok 2 - P6 fs seat: the operator's reject refuses the write fail-closed
  error: "Cannot read properties of undefined (reading 'requestId')"
not ok 3 - P6 fs seat: an unanswered hold times out and refuses the write fail-closed
  error: 'an unanswered hold must fail closed'
  actual: `{"code":-32000,"message":"fs/write_text_file denied by guard policy 'promotion-gate': promotion requires operator approval"}`
not ok 4 - P6 fs seat: a guard ask fails closed when no operator hold is attached
  error: 'the no-operator posture must be an honest fail-closed deny'
  actual: `{"code":-32000,"message":"fs/write_text_file denied by guard policy 'promotion-gate': promotion requires operator approval"}`
# tests 4
# pass 0
# fail 4
```

Pins 1–4 are red for the right reason: the unmodified seat ignores the injected hold and collapses `ask` to the `guard policy` deny, so the ask never parks (1), there is no pending request to answer (2), and the deny provenance never names the operator/timeout (3) or the missing hold (4).

**Green:** `node --import tsx --test --test-name-pattern "P6 fs seat" test/acp-session.test.ts` 4/4; the focused battery `test/acp-session.test.ts test/operator-ask-hold.test.ts test/acp-workflow-resolver.test.ts test/acp-opencode-permission-shape.test.ts` 61/61; the acp-session consumer battery `test/error-surfacing.test.ts test/interactive-task-commands.test.ts test/acp-session.test.ts` 54/54. `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Honest reachability (do NOT read this seat as a live operator ask channel).** The seat seam and its behavior are pinned, but **no production composition attaches a hold**: `createOperatorAskHold` still has no non-test caller (grep `src/` finds only the definition), and the fs server is composed inside the `AcpSessionDriver` constructor (`src/integrations/acp-session.ts`), whose callers (`AcpSessionDriver.contained`, the surfaces) pass no `hold`. So in production a guard `ask` on a delegated write still fails closed with the new "no operator hold attached" provenance — the same terminal outcome as before, with honest provenance. The latent status mirrors the P6 first-seat resolver (`docs/ledger/P6-first-seat-ask-hold.md`): attaching a hold without an answer route would only add a 120s park-then-deny latency. The operator-answer surface (the brief's Q4) is the named follow-up.

**Deviations / honest limits:**

- **Additive, not a primitive extraction.** The brief §6 step 1 sketches *extracting* the hold from the daemon; the primitive already landed in the first seat (`operator-ask-hold.ts`), so this iteration consumes it and leaves the daemon's inline hold byte-unchanged. One change per iteration (W097).
- **Synthesized request id.** The ACP `fs/write_text_file` wire carries no request id (the handler signatures receive only `params`; the JSON-RPC `id` is not threaded to `#resolveFs`). The seat synthesizes a monotonic `acp-fs-ask-<n>` id so a surface answers from the hold's `pending` projection. Early-reply reconciliation (`answer` before `park`) is inherited from the primitive — pinned in `test/operator-ask-hold.test.ts` — but at this seat there is no pre-park id for an early answer to target, so the seat's own pins cover park/answer/timeout instead. The three required red-first pins (blocks / answer releases / timeout refuses) plus the no-operator pin are the fs-seat evidence.
- **`trustedRole` stays unsupplied** (Q5 open).
- **Resolver seat not wired here.** The driver's `#resolvePermission` still passes no `hold` to `createWorkflowAcpPermissionResolver`, so the resolver seat remains latent exactly as the first-seat record states. Wiring it is a separate seat iteration.

**Remaining open questions (unchanged; the operator's call per the brief §7):** Q1 (scope; the in-process OpenCode plugin `opencode-plugin.ts:35` and the containment process seat `workflow-process.ts:17` remain collapsed), Q2 (containment-seat ordering), Q3 (no-operator posture elsewhere), Q4 (plane-3′ pending-ask surface), Q5 (`trustedRole`), Q6 (hold window/observability).

**Evidence:** `src/integrations/acp-session.ts` (the three-way fs guard branch + `hold?` on the constructor and `contained` options + `#fsAskSeq`); `test/acp-session.test.ts` (4 new fs-seat pins); `test/fixtures/fake-acp-agent.mjs` (new `fs-absolute-write` mode); the P6 row's dated note (`docs/PARKED_AND_LIMITATIONS.md`, the P6 row). Branch `feat/p6-fsseat`, issue #285.
