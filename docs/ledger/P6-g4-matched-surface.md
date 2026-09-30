<!-- Ledger fragment: opened 2026-09-30 as the P6 G4 matched-surface ask-path record (issue #285). Write-once — append dated supersession notes, never rewrite. -->

### P6 G4 matched surface — the W121 rule-matched surface becomes a first-class field on the broker's ONE answer surface (Landed — the last leg of the ask-path projection; issue #285) (2026-09-30)

**Source:** issue #285, the parked P6 queue's "G4 matched-surface field" sub-item
(`docs/PARKED_AND_LIMITATIONS.md`, P6 row). Dispatched as the 2026-09-30 wave's
`feat/g4-matched-field` subtask, based on `origin/main`.

**The G4 definition as found (the repo's, not a paraphrase).** The parked
"G4 matched-surface field" is the agents-research assessment's **F6 residual**
(`docs/AGENTS_RESEARCH_PORT_ASSESSMENT_2026-09-22.md:71,:138`): the guard's
structured decision record carried rule ID + reason but the concrete **surface
the rule matched** (the path/command/toolName) was embedded in `reason` text,
not a separate queryable field. It **already landed in W121**
(`docs/ledger/W121-the-decision-record-carries-the-matched-surface-g4-the-asses.md`;
vendored `GuardDecision.matched` in
`mcp-toolbox/apps/workflow-guard-mcp/src/policy.ts:46`; seat normalization in
`src/integrations/mcp-toolbox-guard.ts:47-51`). W121's discipline is
LESS-0046: *the matched surface is a query, not prose*. The prior P6 subtask
already recorded this as landed and did not re-implement it
(`docs/ledger/P6-ask-channel-remaining.md:11`; the P6 row's dated note).

**What was still missing (this slice).** W121 threaded `matched` from the
vendored guard to the seat's decision record, and the P6 seats already forward
it to the ask hold (`OperatorAskRequest.matched`,
`src/integrations/operator-ask-hold.ts:29-30`). But on the broker's **answer
surface** — the ONE `/api/permission` pending projection the operator (and any
observability surface) reads — the matched surface was only reachable as a
side effect: `tool: request.matched ?? request.policy` and a nested
`input.matched`. Per LESS-0046 it should be first-class and queryable. That is
the last leg of the G4 chain: **vendored guard → seat decision record → held
ask → answer surface.**

**What landed (additive; posture untouched).**

- `PendingPermissionRequest` gains `matched?: string`
  (`src/ui/permission-broker.ts:125-129`) — the concrete surface the guard rule
  matched, first-class on every projection of a parked request
  (`pendingRequest`, the `/api/permission` body via `transportPermissionView`,
  the hub bridge route, the standalone route).
- The held-ask projection (`askView`, `src/ui/permission-broker.ts:525`) sets it
  from the seat's `OperatorAskRequest.matched` via a conditional spread:
  **absent-never-fabricated** — an unmatched ask and a permission prompt (no
  rule matched a surface) omit the field entirely.
- No new route, no new wire field, no signature change; the answer path, the
  fail-closed posture (no-operator denies; reject/timeout rejects), and
  tighten-never-loosen are unchanged. `trustedRole` stays unsupplied.

**The task's alternate reading, recorded precisely (not guessed).** The dispatch
also described G4 as "a held ask's provenance/answer records which surface/seat
raised it, MATCHED against the answer surface." That is **not** the repo's G4
definition, and the repo has no answer-surface identity to match against: the
answer body is exactly `{ id, decision }` (`permissionAnswerRoute`,
`src/ui/permission-broker-route.ts:47-58`), and **one** broker transport answers
every seat in the process. Adding an "which surface answered" stamp would mean
(a) defining a surface/seat vocabulary for the asks and (b) deciding whether a
client-supplied answer-surface stamp is trusted — a security-shaped operator
decision (the same class as the operator-gated Q4/Q5 in
`docs/P6_SEATS_ASK_DESIGN_BRIEF.md`). Per the task's escape hatch, that reading
is **recorded here rather than fabricated**. What is implemented is the part
that needs no decision: the rule-matched surface (the repo's G4) on the answer
surface.

**Red-first (no fabricated red).** `test/p6-g4-matched-surface.test.ts` was
captured RED against the unmodified `src/ui/permission-broker.ts` (stashed; the
test kept). Verbatim excerpt:

```
# Subtest: P6 G4: the rule-matched surface rides first-class onto the broker answer surface
not ok 1 - P6 G4: the rule-matched surface rides first-class onto the broker answer surface
  error: |-
    the matched surface is queryable, not only embedded in input/tool
    + actual - expected
    + undefined
    - '/etc/hosts'
# Subtest: P6 G4: tighten-never-loosen holds for a matched ask (an allow_always is only once, no grant)
not ok 3 - P6 G4: tighten-never-loosen holds for a matched ask (an allow_always is only once, no grant)
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    + undefined
    - '/etc/hosts'
1..4
# tests 4
# pass 2
# fail 2
```

The two passing hold-outs (pin 2: unmatched/prompt honesty; pin 4: the
no-operator fence) are green before and after BY DESIGN — the
absent-never-fabricated and posture fences, not product reds. `src/` was NOT
modified to manufacture a red.

**Green:** `node --import tsx --test test/p6-g4-matched-surface.test.ts`
`# tests 4 / # pass 4 / # fail 0`. Focused battery (`p6-g4-matched-surface`,
`p6-hub-answer`, `p6-standalone-answer`, `p6-live-seats`, `permission-broker`,
`operator-ask-hold`, `permission-approvability`, `permission-grants`,
`acp-workflow-resolver`, `acp-session`) **102/102 pass, 0 fail, 0 skipped**.
`npm run lint` exit 0; `npm run typecheck` exit 0 (both unpiped).

**Honest boundary.** The field's **display** (the webapp approval card rendering
the matched surface distinctly from `tool`) is not part of this slice — the
W121 ledger already recorded the display as queued. The projection exists and is
pinned; a card that reads `pending.matched` can render it.

**Files changed:** `src/ui/permission-broker.ts` (`PendingPermissionRequest.matched`
+ `askView` conditional spread); pin `test/p6-g4-matched-surface.test.ts`.

**Deviations:** the doubled G4 reading is recorded above. No `trustedRole`; no
posture change; no wire-contract change.

**Evidence:** `src/ui/permission-broker.ts:125-129,525`;
`src/integrations/operator-ask-hold.ts:29-30`;
`docs/ledger/W121-the-decision-record-carries-the-matched-surface-g4-the-asses.md`;
`test/p6-g4-matched-surface.test.ts`; the P6 row's dated note
(`docs/PARKED_AND_LIMITATIONS.md`). Branch `feat/g4-matched-field`, issue #285.
