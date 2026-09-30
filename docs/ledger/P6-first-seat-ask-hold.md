<!-- Ledger fragment: opened 2026-09-30 as the P6 first-seat ACP-resolver ask-hold record (TASKS.md is frozen; live tracking is the GitHub Project, issue #285). Write-once record — append dated supersession notes, never rewrite. -->

### P6 first seat - the ACP permission resolver's ASK HOLD (the binary-decision latency) (2026-09-30)

**Source:** the P6 seats-design brief's §2.1 extension point and §6 step 2 (`docs/P6_SEATS_ASK_DESIGN_BRIEF.md`): the ACP permission resolver collapsed `ask`→deny at `src/adapters/acp-workflow-resolver.ts:72`; the brief prescribes a hold that parks the ask for the operator (mirroring the landed daemon hold in `src/integrations/opencode-server-authority.ts`), then returns the seat's binary ACP permission decision — the ACP decision is binary by contract (`AcpPermissionDecision` is `allow | deny`), so the hold is a latency on that binary outcome. Issue #285. Dispatched as the P6 first-seat subtask of the 2026-09-30 wave, branch `feat/p6-first-seat`, based on `origin/main`.

**What landed (one seat per iteration, per W097):**

- **The hold primitive** — new `src/integrations/operator-ask-hold.ts`, `createOperatorAskHold({ timeoutMs? })` returning `{ park, answer, pendingCount, pending, cancelAll }`. Mirrors the daemon's contract verbatim (§3 of the brief): park with a timeout timer (default 120s), an early operator reply that raced ahead of the ask is consumed first (and a stale reply is cleared so it cannot answer a later ask), `answer` reconciles **tighten-never-loosen** (`reject` wins; any other reply maps to the policy-allowed `once`), an unanswered hold resolves `reject` (fail closed), and `cancelAll` resolves every pending hold to `reject`.
- **The resolver seat** — `src/adapters/acp-workflow-resolver.ts`: the guard branch is now three-way. A guard `ask` awaits `options.hold.park({ requestId: toolCallId, policy, reason, matched? })`, then falls through to `{ kind: "allow" }` on approval and returns `{ kind: "deny", reason }` on reject/timeout. The allow path still runs skill journaling (the approved ask falls through, not early-returns). A new optional `hold?: OperatorAskHold` on `WorkflowAcpPermissionResolverOptions` is the operator-answer seam.
- **No-operator posture (the brief's Q3, fail-closed)** — when no `hold` is attached there is no operator channel to answer, so an `ask` is denied immediately with the ask provenance (`no operator hold attached, failing closed`). Existing callers that pass no `hold` (e.g. `src/integrations/acp-session.ts:569`) keep the current behavior shape, now with honest ask provenance instead of the collapsed `guard policy` deny.
- **`trustedRole` NOT supplied** — deliberately untouched per §5/the brief: supplying a role would fabricate a security fact until the operator answers Q5.

**Additive, not a daemon refactor (honest deviation from §6 step 1):** the brief sketches *extracting* the primitive from the daemon and having the daemon consume it. This iteration introduces the primitive and consumes it only in the resolver, leaving the daemon's inline hold (`holdForOperator`/`earlyReplies`/`pending`) byte-unchanged — "additive" per the task, and one change per iteration per W097. The daemon unification (one module, two consumers) remains a named follow-up below; the primitive's semantics are pinned against the daemon's contract so the follow-up is behavior-neutral.

**Red-first (no fabricated red):** the four resolver ask-hold pins were captured RED against the unmodified resolver (the new hold module present, the resolver untouched):

```
not ok 16 - ACP resolver parks a guard ask on the operator hold and the operator's allow resolves allow
  error: an ask must park on the operator hold  0 !== 1
not ok 17 - ACP resolver resolves an operator reject on a held ask as a denial
  error: The input did not match the regular expression /operator reject or hold timeout/.
         Input: "guard policy 'promotion-gate': promotion requires operator approval"
not ok 18 - ACP resolver fails a held ask closed when the operator hold times out
  error: The input did not match the regular expression /operator reject or hold timeout/.
not ok 19 - ACP resolver fails a guard ask closed when no operator hold is attached
  error: The input did not match the regular expression /no operator hold attached/.
# pass 21 # fail 4
```

The prior capture (before the new module existed) was an `ERR_MODULE_NOT_FOUND` for `operator-ask-hold.js` — the tests are red-first by construction. The six `operator-ask-hold` unit pins are new-code coverage (there was no hold to make red); no product-red is claimed for them.

**Green:** `node --import tsx --test test/operator-ask-hold.test.ts test/acp-workflow-resolver.test.ts` 25/25; the focused battery of every resolver consumer `test/operator-ask-hold.test.ts test/acp-workflow-resolver.test.ts test/acp-opencode-permission-shape.test.ts test/acp-cline-tool-matrix.test.ts test/acp-cline-metadata.test.ts test/acp-session.test.ts` 72/72. `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Remaining open questions (unchanged by this iteration; the operator's call per the brief §7):**

- **Q1 scope** — the other three seats (hub ACP fs server `acp-session.ts:649`, in-process OpenCode plugin `opencode-plugin.ts:35`, containment process seat `workflow-process.ts:17`) remain collapsed `ask`→deny. This iteration took the highest-value seat first.
- **Q2 ordering at the containment seat** — guard-after-authorize (recommended) vs intersection semantics; not touched.
- **Q3 no-operator behavior** — the brief's recommended fail-closed deny is what this seat implements; the other seats' posture is unset.
- **Q4 plane-3′ surface** — the resolver's held ask is not yet projected to the operator UI; `pending`/`pendingCount` are exposed on the primitive, but no broker/SSE/terminal route consumes them for this seat.
- **Q5 `trustedRole`** — untouched; still unsupplied.
- **Q6 hold window/observability** — the primitive defaults to the daemon's 120s; whether a held ask's pending count is journaled/metered is undecided.

**Follow-up debt:** unify the daemon's inline hold and this primitive on the one module (`createOperatorAskHold`), and project the resolver's `pendingCount`/`pending` to a surface the operator can answer (Q4).

**Evidence:** `src/integrations/operator-ask-hold.ts` (new); `src/adapters/acp-workflow-resolver.ts` (the three-way guard branch + `hold?`); `test/operator-ask-hold.test.ts` (new, 6 pins); `test/acp-workflow-resolver.test.ts` (4 new ask-hold pins, 25/25 with the hold suite); the dated note appended to the P6 parked row (`docs/PARKED_AND_LIMITATIONS.md:35`). Branch `feat/p6-first-seat`.

### Review repair (2026-09-30, same branch) — honest reachability wording + the stale-reply pin

**P2 honesty (reachability).** The record above overstates production reachability: it says "a guard `ask` parks on the shared `createOperatorAskHold` primitive". The primitive and the resolver's `hold?` seam landed, but **no production composition attaches a hold** — `createOperatorAskHold` has no non-test caller (grep `src/` finds only the definition), and the one production resolver construction (`src/integrations/acp-session.ts:569-589`) passes no `hold`, so the resolver's own no-operator branch returns `{ kind: "deny", reason: "…no operator hold attached, failing closed…" }`. The seat is therefore **latent**: the operator-answer seam exists and is unit/behavior-pinned, but a guard `ask` still fails closed in production. Attaching the hold at the browser composition point was considered and rejected as not-small **and wrong**: the production operator-answer path is the `PermissionBroker` (`src/ui/permission-broker.ts`, pre-authorization overlay, its own `perm-*` ids and `allow_once|allow_always|reject_*` choices, wired to `/api/permission`), while this hold parks **after** authorization keyed by the ACP `toolCallId` with `once|reject`; a bare `hold` attached with no answer route would only add a 120s park-then-deny latency to every guard `ask` — a regression, not a fix. The P6 parked row (`docs/PARKED_AND_LIMITATIONS.md`) and the "What landed" wording above are corrected to: the primitive + resolver seam landed; no production caller attaches it yet (latent); the ask still fails closed. **Do not read this seat as a live operator ask channel.**

**P2 test integrity.** The former pin "a stale early reply must not answer a later ask" named the timeout-clears-`earlyReplies` branch (`operator-ask-hold.ts:79`) but did not exercise it. That branch is unreachable by construction: `park` consumes and deletes an early reply at `operator-ask-hold.ts:71-75` **before** it ever arms the timeout timer, so at the timeout `earlyReplies` cannot hold that id; the prior test's second park timed out for the ordinary reason. The real guarantee is the **consumption clearance** at line 73, and the pin is re-labeled and strengthened to test exactly that: after the racing park consumes the early reply, a later same-id ask parks afresh (`pendingCount === 1` — proof the stale reply did not resolve it) and resolves from its own answer, not the consumed one. The old comment's attribution to the timeout is removed.

**Verification (this repair):** the focused battery `test/operator-ask-hold.test.ts test/acp-workflow-resolver.test.ts test/acp-opencode-permission-shape.test.ts test/acp-cline-tool-matrix.test.ts test/acp-cline-metadata.test.ts test/acp-session.test.ts` green; `npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped). No production source changed in this repair (docs + one test only).
