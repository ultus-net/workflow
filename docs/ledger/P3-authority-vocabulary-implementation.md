<!-- Ledger fragment: the P3 authority-vocabulary IMPLEMENTATION (issue #282). The operator APPROVED the design (Option A in docs/P3_AUTHORITY_VOCABULARY_BRIEF.md); this file records the decided parts that landed and the SIX operator policy questions that stay OPEN. Write-once record — append dated supersession notes, never rewrite. -->

### P3 — The kernel authority vocabulary + authorized-attach pointer (the operator approved Option A; the decided parts landed) (2026-09-30)

**Source:** parked item P3 (docs/PARKED_AND_LIMITATIONS.md:32, issue #282)
— "W114 follow-on — the authorized-attach machinery: surface the producing
flow per missing artifact, route around claim-shaped endpoints; plus the
kernel-side operator/claim authority class." Fed by the W114 removal
record and LESS-0035 ("a claim-shaped endpoint cannot be gated into
honesty"); limitation L6 (docs/PARKED_AND_LIMITATIONS.md:59) records the
claim-shaped endpoint as removed and this replacement as parked. The design
input is `docs/P3_AUTHORITY_VOCABULARY_BRIEF.md` (recorded 2026-09-30,
ledger `docs/ledger/P3-authority-vocabulary-brief.md`); the operator
APPROVED its recommended Option A (separate decision axis + inert
producing-flow pointer) and this fragment records the implementation.
Branch `feat/p3-authority-impl`, based on `origin/main`; no push/PR from the
executor.

**What landed (the decided parts):**

- **The decision axis** (`src/kernel/contracts.ts`): `DecisionAuthority =
  "operator"` and `DecisionRequirement { authority, subject, producingFlow? }`
  — a NEW axis DISJOINT from `EvidenceAuthority` (unchanged:
  `environment | host | mcp | reviewer`). `requiredDecisions?` is optional on
  `WorkflowTask` and `WorkflowStep`; a task without it behaves
  byte-identically (verified by the held-out existing suites).
- **The gate wiring** (`src/kernel/task-graph.ts`): the VERIFIED validator
  now checks `requiredDecisions` fail-closed alongside the evidence check
  (the W110 template). A missing decision joins the refusal `missing`
  diagnosis with `source: "decision"` and code `DECISION_REQUIRED`; an
  evidence-only refusal keeps its exact W110 shape and `EVIDENCE_REQUIRED`
  code. Disjointness is structural: a decision can satisfy only a
  `DecisionRequirement`, evidence only an `EvidenceRequirement`.
- **Fail-closed decision validation** (the W112 grant-validation
  discipline): an offered `OperatorDecisionRecord` is refused without
  consuming state when it is malformed (`DECISION_MALFORMED`), stale
  (`DECISION_STALE`; its `mutationEpoch` is superseded), or names an actor
  other than the calling transition's actor (`DECISION_ACTOR_MISMATCH`; the
  W157 caller-names-itself join). A decision offered to a task with no
  decision gate is inert — it satisfies nothing and opens no evidence gate.
- **The application seam** (`src/application/workflow.ts`): `transition`
  forwards `decisions` to the kernel — this is the ONLY application seam
  that admits an operator decision into a proposal, and it never accepts a
  claim (no such shape exists). No new route: the decision rides the
  existing transition/answer path; the removed `POST /api/evidence` stays
  removed (L6 `landed+verified`).
- **The inert authorized-attach pointer** (the W114 route-around): an
  optional `producingFlow?: { flow, ref? }` on a requirement, authored by
  the authority at declaration time and mirrored onto the refusal diagnosis.
  A client-supplied pointer on a decision record is REJECTED outright
  (`DECISION_MALFORMED`): the pointer is projection, never an input path,
  produces nothing, and satisfies nothing.
- **Claim unrepresentability** (`test/contracts.test.ts`): compile-time
  `expect-error` pins prove `"claim"` has no authority class and `"operator"`
  is a `DecisionAuthority`, never an `EvidenceAuthority`. Widening
  `EvidenceAuthority` to admit either would make the directives unused and
  `npm run typecheck` fails (the W114 hazard held closed by construction).

**Evidence (red-first):**

- **Reds captured verbatim** against the unmodified base (`git stash` of the
  src + contracts.test changes; the focused suite run on the pre-change
  tree): 11 tests / 2 pass / **9 fail**. The 9 reds are the new behavior
  (a missing decision accepted instead of `DECISION_REQUIRED`; evidence
  accepted as satisfying a decision gate; malformed/stale/actor-mismatched
  decisions accepted; client pointer accepted; authority-recorded pointer
  absent from the refusal; the application seam not gating). The 2
  pre-passing pins assert behavior the change must NOT break: a decision
  does not satisfy an evidence gate, and a matching decision opens the
  decision gate. Raw capture rode the executor scratch
  `.p3-red-capture.txt` (deleted pre-commit per the .tmp convention).
- **Green:** 67/67 across the focused battery — `p3-authority-vocabulary`
  11/11 and the seven held existing kernel/application suites
  (`task-graph`, `contracts`, `application`, `task-graph-invariants`,
  `task-graph-admission-divergence-pin`, `application-pedagogy-gate`,
  `application-policy-failure-tracker`) 56/56. The held-out W114 closure pin
  `test/web.test.ts` stays GREEN and UNMODIFIED: 28/28.
- `npm run lint` and `npm run typecheck` exit 0 unpiped.

**THE SIX OPEN OPERATOR QUESTIONS STAY OPEN (the brief §4 — NOT decided here):**

1. **Actor binding.** What binds an `operator` decision to the operator's own
   surface given the unauthenticated loopback (residual #9)? The reference
   implementation uses the W157 caller-names-itself join (decision actor ==
   transition actor) and accepts the documented boundary, exactly as P10's
   posture does; whether something more is required is the operator's call.
2. **One-shot / expiry.** The reference implementation admits a decision
   transiently per transition (never stored); whether a decision should carry
   the W112/W160 grant one-shot or bounded-expiry lifecycle, or stand until
   superseded, is open.
3. **Scope of decision gates.** The reference implementation wires the
   VERIFIED transition only, mirroring the evidence gate; which transitions
   may declare a decision requirement (only named ones — e.g. BLOCKED → READY
   admission, an evidence waiver — or any transition) is open.
4. **Claim recordability.** Claims remain UNRECORDED (W114's read-only-panel
   posture); whether non-kernel proposal context may record them outside any
   gate is open.
5. **Pointer placement.** The reference implementation follows the brief's
   sketch — `producingFlow` on the requirement at declaration time, surfaced
   on the refusal diagnosis; whether the operator prefers declaration-time or
   diagnosis-only placement is open and revisitable without changing the
   gate semantics.
6. **Naming.** The class is named `operator` (consistent with the W157 actor
   set) and the non-authority is reserved as "claim"; whether a different
   split is preferred is open.

**Follow-ups (recorded, not claimed):**

- The reviewer-evidence fingerprint-as-validity gate for decision provenance
  (reusing `src/review/provenance.ts` by analogy) is a recorded follow-up,
  NOT a claimed mechanism; the kernel admits a decision without a fingerprint
  re-check today.
- The operator-decision class **inherits residual #9** (the unauthenticated
  loopback) and does NOT close it. Whether the class exposes a NEW boundary
  (and so a new SECURITY_ASSURANCE residual entry) turns on open question #1
  and is deliberately not decided here; no SECURITY_ASSURANCE count change was
  made.
- `docs/PARKED_AND_LIMITATIONS.md` P3 row carries the dated landed note.

**Deliberately NOT done:** the six operator policy questions above; any new
or reintroduced claim-accepting route; any widening of `EvidenceAuthority`
(Option B, rejected by LESS-0035); a `SECURITY_ASSURANCE.md` residual-count
change (the inheritance of #9 is stated, not a new number).
