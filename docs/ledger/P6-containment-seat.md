<!-- Ledger fragment: opened 2026-09-30 as the P6 containment-process-seat ask-hold record (TASKS.md is frozen; live tracking is the GitHub Project, issue #285). Write-once record — append dated supersession notes, never rewrite. -->

### P6 containment process seat — the guard ASK HOLD (throw-or-return) + the §2.4 ordering fix (2026-09-30)

**Source:** the P6 seats-design brief §2.4 and §6 steps 2–3 (`docs/P6_SEATS_ASK_DESIGN_BRIEF.md`): the containment process seat collapsed a guard `ask` into a deny at `src/containment/workflow-process.ts:17` (the seat threw `guard denied process execution`); the brief prescribes a three-way guard branch whose `ask` case awaits an injected hold before `this.containment.execute`, then proceeds on approval and throws on reject/timeout. The hold is the landed `OperatorAskHold` primitive (`src/integrations/operator-ask-hold.ts`, §3 shared semantics). Issue #285. Dispatched as the P6 containment-seat subtask of the 2026-09-30 wave, branch `feat/p6-contain-seat`, based on `origin/main` (no node_modules symlink needed).

**What landed (one seat per iteration, per W097):**

- **The containment seat** — `src/containment/workflow-process.ts`: the guard branch is now three-way. A guard `ask` with a hold attached awaits `hold.park({ requestId, policy, reason, matched? })` before `this.containment.execute`, then falls through to containment on approval and throws on reject/timeout (fail closed). A guard `deny` still throws immediately and is never held (W092 acceptance criterion 3). The approved ask does not short-circuit containment: approve falls through to `this.containment.execute(request)`.
- **The operator-answer seam** — a new optional fourth constructor argument `hold?: OperatorAskHold` on `WorkflowContainedProcess(application, containment, guard?, hold?)`. Additive; existing callers that pass three arguments keep today's behavior. The request id is a synthesized monotonic `contained-process-ask-<n>` (`#askSeq`), mirroring the fs seat's `acp-fs-ask-<n>` — the process request carries no per-call id, so the seat synthesizes one for the hold's `pending` projection.
- **Ordering fix (the brief's §2.4 wrinkle, and §6 step 3)** — the guard check **moved after `application.authorize`**. The seat now runs: the process-capability `TypeError` → `application.authorize` (deny throws `Workflow denied process execution`) → the guard (ask parks / deny throws / throw propagates) → `this.containment.execute`. This is option (a) from the brief ("one ordering story"): it matches the primary seat (`opencode-server-authority`) and the other three seats, so a held ask parks only after the kernel has ruled. Pinned by "kernel authorization runs before the guard" (a guard `deny` against a blocked task must surface the Workflow denial and never consult the guard).
- **No-operator posture (the brief's Q3, fail-closed, exactly as before)** — when no `hold` is attached, an `ask` falls into the existing `decision !== "allow"` branch and throws the byte-identical existing message (`guard denied process execution: '<policy>': <reason>`). No new no-operator message is introduced for this seat: the task's "fail closed" is honored literally, and the real vendored promotion-gate ask keeps the string that `test/e2e-hub-bash.test.ts:366` pins.
- **`trustedRole` NOT supplied** — deliberately untouched per §5/the brief: supplying a role would fabricate a security fact until the operator answers Q5. `guardInputFromToolCall` is unchanged and the seat's `guardCheck` still passes no `trustedRole`.

**Red-first (no fabricated red):** the five new containment-seat pins were captured RED against the **unmodified** `src/containment/workflow-process.ts` (guard branch first, `decision.decision !== "allow"` throw). Verbatim:

```
not ok 4 - P6 containment seat: a guard ask parks on the operator hold and the operator's allow proceeds to containment
  error: 'guard denied process execution: promotion-gate: promotion requires operator approval'
not ok 5 - P6 containment seat: the operator's reject refuses the process fail-closed
  error: 'guard denied process execution: promotion-gate: promotion requires operator approval'
not ok 6 - P6 containment seat: an unanswered hold times out and refuses the process fail-closed
  error: |-
    The input did not match the regular expression /operator reject or hold timeout/. Input:
    'Error: guard denied process execution: promotion-gate: promotion requires operator approval'
not ok 8 - P6 containment seat: kernel authorization runs before the guard (one ordering story)
  error: |-
    The input did not match the regular expression /Workflow denied process execution: TASK_NOT_IN_PROGRESS/. Input:
    'Error: guard denied process execution: shell.destructive.pattern: blocked'
# tests 8
# pass 4
# fail 4
```

Pins 4–6 are red for the right reason: the unmodified seat ignores the injected hold and collapses `ask` to the guard-deny throw, so the ask never parks (4), there is no pending request to answer (5), and the deny provenance never names the operator/timeout (6). Pin 8 is red because the unmodified seat guard-checks first: the guard's `deny` fires before `application.authorize`, so the blocked task's `TASK_NOT_IN_PROGRESS` denial never surfaces. The fifth pin ("a guard ask with no operator hold fails closed exactly as before") was **green before and after** — it is a regression fence for the preserved no-hold behavior, not a product red, and is not claimed as one.

**Green:** `node --import tsx --test test/guarded-process.test.ts` 8/8 (3 pre-existing + 4 ask-hold/ordering reds now green + 1 regression fence). The focused battery `test/guarded-process.test.ts test/containment.test.ts test/operator-ask-hold.test.ts test/opencode-plugin.test.ts test/acp-workflow-resolver.test.ts test/acp-session.test.ts` 95/95. `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Honest reachability (LATENT, same posture as the other three seats).** The seam exists and is behavior-pinned, but **no production composition attaches a hold**: `createOperatorAskHold` still has no non-test caller (grep `src/` finds only the definition at `operator-ask-hold.ts:64`), and both production constructions pass three arguments — `src/cli/contained-shell.ts:90` and `src/integrations/run-controller.ts:119`. So in production a guard `ask` still fails closed with the byte-identical guard-deny message (the same terminal outcome as before). Attaching a hold with no answer route would only add a 120s park-then-deny latency to every guard `ask`. The operator-answer surface (the brief's Q4) is the named follow-up. **Do not read this seat as a live operator ask channel.**

**Deviations / honest limits:**

- **Additive, not a primitive extraction** — the brief §6 step 1 sketches *extracting* the hold from the daemon; the primitive already landed in the first seat (`operator-ask-hold.ts`), so this iteration consumes it and leaves the daemon's inline hold byte-unchanged. One change per iteration (W097).
- **Guard-after-authorize consumes a mutation-budget unit on a guard-denied call** — with the guard moved after `application.authorize`, an authorized-then-guard-denied process now consumes one unit of the application's mutation budget (`workflow.ts:273`) where the old guard-first order did not. This is the same property the primary seat already has (it authorizes then guards), and it is the cost of the one-ordering-story choice; no test pins the old ordering's budget behavior.
- **No distinct no-operator ask provenance** — unlike the ACP resolver/fs seats, this seat keeps the byte-identical guard-deny message when no hold is attached, because `test/e2e-hub-bash.test.ts:366` pins the real promotion-gate ask to `guard denied process execution: promotion-gate: …`. The no-hold ask is therefore indistinguishable in the message from a guard `deny`; both are fail-closed.
- **`trustedRole` stays unsupplied** (Q5 open).

**Remaining open questions (unchanged; the operator's call per the brief §7):** Q1 (scope; all four non-primary seats now carry the three-way branch — ACP resolver, fs server, plugin, containment — leaving only the plane-3′ surface, `trustedRole`, and observability), Q3 (no-operator posture: all four fail closed), Q4 (plane-3′ pending-ask surface), Q5 (`trustedRole`), Q6 (hold window/observability).

**Evidence:** `src/containment/workflow-process.ts` (the three-way guard branch + `hold?` + `#askSeq` + guard-after-authorize reorder); `test/guarded-process.test.ts` (4 new ask-hold/ordering pins + 1 regression fence, 8/8); the P6 row's dated note (`docs/PARKED_AND_LIMITATIONS.md`, the P6 row). Branch `feat/p6-contain-seat`, issue #285.
