<!-- Ledger fragment: opened 2026-09-30 as the P6 second-seat ask-hold record — the in-process OpenCode plugin (TASKS.md is frozen; live tracking is the GitHub Project, issue #285). Write-once record — append dated supersession notes, never rewrite. -->

### P6 second seat - the in-process OpenCode plugin's ASK HOLD (throw-or-proceed) (2026-09-30)

**Source:** the P6 seats-design brief's §2.3 extension point and §6 step 2 (`docs/P6_SEATS_ASK_DESIGN_BRIEF.md`): the in-process OpenCode plugin collapsed `ask`→deny at `src/integrations/opencode-plugin.ts:35` (the host aborts the tool call); the brief prescribes a three-way guard branch whose `ask` case awaits an injected operator hold, then proceeds on approval and throws on reject/timeout. The hold is the landed `OperatorAskHold` primitive from the ACP seat round (`src/integrations/operator-ask-hold.ts`, §3 shared semantics). Issue #285. Dispatched as the P6 plugin-seat subtask of the 2026-09-30 wave, branch `feat/p6-plugin-seat`, based on `origin/main`.

**What landed (one seat per iteration, per W097):**

- **The plugin seat** — `src/integrations/opencode-plugin.ts`: the guard branch is now three-way. A guard `ask` with a hold attached awaits `hold.park({ requestId: input.callID, policy, reason, matched? })`, then returns normally on approval (the tool proceeds) and throws on reject/timeout (fail closed). A guard `deny` still throws immediately and is never held (W092 acceptance criterion 3). The approved ask does not short-circuit kernel authorization or skill handling — the plugin has no post-guard work here, so approve simply falls through to the function's natural end.
- **The operator-answer seam** — a new optional fourth composition argument `hold?: OperatorAskHold` on `createWorkflowOpenCodePlugin(application, adapter, guard?, hold?)`. Additive; existing callers that pass three arguments keep today's behavior. The request id is the host's `callID`, mirroring the daemon's per-request keying.
- **No-operator posture (the brief's Q3, fail-closed, exactly as before)** — when no `hold` is attached, an `ask` falls into the existing `decision !== "allow"` branch and throws the byte-identical existing message (`Workflow denied <tool>: guard policy '<policy>': <reason>`). No new no-operator message is introduced for this seat: the task's "fail closed exactly as before" is honored literally (unlike the ACP seat, which added ask provenance — both are fail-closed; this seat preserves the existing string).
- **`trustedRole` NOT supplied** — deliberately untouched per §5/the brief: supplying a role would fabricate a security fact until the operator answers Q5.

**Red-first (no fabricated red):** the three plugin ask-hold pins (park/approve, reject, timeout) were captured RED against the unmodified plugin (`src/integrations/opencode-plugin.ts` `guardDecision.decision !== "allow"` throw):

```
not ok 5 - OpenCode plugin parks a guard ask on the operator hold and the operator's allow proceeds
  error: "Workflow denied bash: guard policy 'promotion-gate': promotion requires operator approval"
not ok 6 - OpenCode plugin resolves an operator reject on a held ask as a thrown denial
  error: "Workflow denied bash: guard policy 'promotion-gate': promotion requires operator approval"
not ok 7 - OpenCode plugin fails a held ask closed when the operator hold times out
  error: |-
    The input did not match the regular expression /operator reject or hold timeout/. Input:
  error: "Workflow denied bash: guard policy 'promotion-gate': promotion requires operator approval"
# pass 5 # fail 3
```

The fourth pin ("fails a guard ask closed when no operator hold is attached") was **green before and after** — it is a regression fence for the preserved no-hold behavior, not a product red, and is not claimed as one. The `hold`/`createOperatorAskHold` primitive itself is new-code coverage already pinned by `test/operator-ask-hold.test.ts`; no product-red is claimed for it.

**Green:** `node --import tsx --test test/opencode-plugin.test.ts` 8/8 (5 pre-existing + 3 ask-hold reds now green + 1 regression fence). `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Honest reachability (LATENT, same posture as the first seat).** The seam exists and is behavior-pinned, but **no production composition root calls `createWorkflowOpenCodePlugin` anywhere in `src/`** (grep finds only the definition `src/integrations/opencode-plugin.ts:10`, the public re-export `src/index.ts:14`, the docs, and the test). The factory is a host-facing plugin entry point: an OpenCode host that imports it could attach a hold, but the in-repo composition attaches none, so a guard `ask` still fails closed in production. There is also no operator-answer route wired to any hold for this seat (Q4 is untouched). **Do not read this seat as a live operator ask channel.**

**Remaining open questions (unchanged by this iteration; the operator's call per the brief §7):**

- **Q1 scope** — two of four non-primary seats now have the three-way branch (ACP resolver, Plugin); the hub ACP fs server (`acp-session.ts:649`) and the containment process seat (`workflow-process.ts:17`) remain collapsed `ask`→deny.
- **Q2 ordering at the containment seat** — guard-after-authorize (recommended) vs intersection semantics; not touched.
- **Q3 no-operator behavior** — both landed seats fail closed; the other two seats' posture is unset.
- **Q4 plane-3′ surface** — neither seat's held ask is projected to an operator UI; `pending`/`pendingCount` exist on the primitive but no broker/SSE/terminal route consumes them for these seats.
- **Q5 `trustedRole`** — untouched; still unsupplied.
- **Q6 hold window/observability** — the primitive defaults to the daemon's 120s; whether a held ask's pending count is journaled/metered is undecided.

**Follow-up debt:** unify the daemon's inline hold and this primitive on the one module (`createOperatorAskHold`); project the seats' `pendingCount`/`pending` to a surface the operator can answer (Q4); optionally attach a hold at a real plugin composition root once an answer route exists.

**Evidence:** `src/integrations/opencode-plugin.ts` (the three-way guard branch + `hold?`); `test/opencode-plugin.test.ts` (3 new ask-hold pins + 1 regression fence, 8/8); the dated note appended to the P6 parked row (`docs/PARKED_AND_LIMITATIONS.md:35`). Branch `feat/p6-plugin-seat`.
