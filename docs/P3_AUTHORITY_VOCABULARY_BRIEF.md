# P3 decision brief — the kernel authority vocabulary and the authorized-attach machinery

**Date:** 2026-09-30 · **Status:** decision INPUT only — **this brief is the
input; the decision is the operator's.** Nothing here authorizes a code
change, and nothing here decides operator-level policy. · **Item:** parked
P3 (docs/PARKED_AND_LIMITATIONS.md:32, issue #282). · **Sources read in
full:** the P3 row and limitation L6 (docs/PARKED_AND_LIMITATIONS.md:32,
:59); the W114 removal record
(docs/ledger/W114-evidence-endpoint-governance-the-claim-shaped-evidence-endpo.md)
and its lesson LESS-0035 (docs/agents/lessons.md:266–273); the kernel
contracts (src/kernel/contracts.ts); the application authority
(src/application/workflow.ts); the review fingerprint discipline
(src/review/provenance.ts); the trust zones (THREAT_MODEL.md:11–18);
residual #26 and its P10 disposition (docs/SECURITY_ASSURANCE.md:271–272);
the permission broker's operator-answer and grant shapes
(src/ui/permission-broker.ts); the evidence producers
(src/integrations/run-registry.ts, src/application/task-commands.ts,
src/adapters/mcp.ts) and the missing-artifact diagnosis
(src/kernel/task-graph.ts:458–466).

## 0. Why this is a decision-first item, and what P3 actually asks

The P3 row bundles two halves (docs/PARKED_AND_LIMITATIONS.md:32):

1. **The authorized-attach machinery** — "surface the producing flow per
   missing artifact, route around claim-shaped endpoints."
2. **The kernel-side operator/claim authority class** — "a kernel design
   with gate semantics of its own — its own iteration."

The row's dependency column is the load-bearing sentence: **"Depends on the
kernel authority-vocabulary design decision (operator input
recommended)."** So P3 is not a code item waiting for a slot; it is waiting
for a vocabulary decision that only the operator can make. This brief
supplies the input. The second half is a kernel design (purity rule,
`AGENTS.md`), so it cannot be smuggled into a surface change.

The brief does **not** touch the operator-level policy questions it names
(§5); it records them as questions, not answers.

## 1. The problem, restated precisely

### 1.1 Missing artifacts cannot name their producing flow

When a transition is refused for want of evidence, the kernel already
produces a per-requirement diagnosis — the W110 "refusal legibility" leg
(src/kernel/contracts.ts:148–157, built at src/kernel/task-graph.ts:458–466):

```ts
readonly missing?: readonly {
  readonly authority: EvidenceAuthority;
  readonly subject: string;
  readonly why: string;
}[];
```

It says **which requirement** is unsatisfied (`environment:test run`) and
**why** (`no fresh passing evidence`). It does **not** say **which
authorized flow would produce that artifact** — the hub test runner, the
run registry's reviewer-verdict flow, the environment adapter, the MCP
normalizer. An operator (or agent) reading the refusal must already know
the producer inventory to route the work. That is the authorized-attach
gap: the diagnosis is legible about the *lack* and mute about the *route*.

### 1.2 Claim-shaped endpoints were removed, and must stay removed

`POST /api/evidence` once accepted client-chosen `subject` + `result` and
minted kernel evidence with a **hardcoded** `authority:"reviewer"` from any
same-origin tab. W114 removed the route and the webapp's
`RecordEvidenceForm` rather than gating them, because the kernel's
authority vocabulary has **no honest class for an operator-typed claim**
(docs/ledger/W114-*.md:13–33). LESS-0035: "a claim-shaped endpoint cannot
be gated into honesty" (docs/agents/lessons.md:266–273). Limitation L6
records the closure as `landed+verified` and parks the replacement here
(docs/PARKED_AND_LIMITATIONS.md:59).

**Constraint inherited by any design below:** no new surface may accept a
claim as a gate input; the removed endpoint is not reintroduced in any
form, claim-shaped or claim-gated. The authorized-attach replacement must
be a *pointer to a producer*, never a *producer of evidence*.

### 1.3 The kernel lacks an explicit operator/claim authority vocabulary

Today the kernel has exactly one authority axis, the evidence *producer*
union (src/kernel/contracts.ts:17):

```ts
export type EvidenceAuthority = "environment" | "host" | "mcp" | "reviewer";
```

Every member answers *who OBSERVED this fact*: the environment supplied
it (`task-commands.ts:137`, `run-registry.ts:615/645`), the host adapter
translated it, MCP normalized it (`adapters/mcp.ts:31`), the hub's own
review flow adjudicated it (`run-registry.ts:447–448/500`) under the
fingerprinted-provenance discipline (src/review/provenance.ts:98–140).
There is **no member for who DECIDED an action** — the operator. A
transition's attribution vocabulary (W157,
src/kernel/contracts.ts:131–137) can *name* an operator as actor, but
attribution is descriptive history, not a gate: it cannot be required, and
it cannot authorize anything. And there is **no member for a claim**, by
design — a claim is not an authority at all.

That conflation is the whole issue. "The operator approved this parked
action" is not an observation and must not satisfy an observation gate;
"a client asserts the tests passed" is not evidence and must never
satisfy an evidence gate. The kernel needs to say **who asserts what, on
what basis, and which gate that basis can open** — with fail-closed
directions of its own.

## 2. The design

### 2.1 Two authority axes, and a non-authority

The proposed vocabulary separates authority into **observation** and
**decision**, and names the claim as *no authority*:

| Class | Answers | Kernel shape | Opens an evidence gate? | Opens a decision gate? |
|---|---|---|---|---|
| Observed evidence | who OBSERVED this fact | `EvidenceAuthority` = `environment` \| `host` \| `mcp` (existing) | yes | no |
| Adjudicated evidence | who ADJUDICATED, over observed evidence | `EvidenceAuthority` = `reviewer` (existing), fingerprinted | yes, only at matching fingerprint | no |
| Operator decision | who DECIDED this action | `DecisionAuthority` = `operator` (NEW) | no | yes |
| Derived fact | what FOLLOWS deterministically from the above | kernel-computed, no stored authority | no | no |
| Claim | who merely ASSERTS (no basis) | **no class — not representable as a gate input** | never | never |

The first two rows are the existing `EvidenceAuthority` union, unchanged.
The third is the new class the row asks for. The fourth is already how
freshness/staleness and dependency resolution work (pure kernel
derivation). The fifth is the W114 hazard made unrepresentable: a claim has
no type, so no endpoint can mint one, and no gate can read one.

### 2.2 Gate semantics per class

- **Observed / adjudicated evidence** keeps today's gate exactly:
  a transition needing evidence requires a fresh passing record whose
  `authority` and `subject` match the `EvidenceRequirement`
  (src/kernel/contracts.ts:21–24), admitted only at the current mutation
  epoch. `reviewer` evidence is valid only while its provenance
  fingerprint matches (src/review/provenance.ts:99–140) — the precedent
  this brief reuses for decision provenance.
- **Operator decision** satisfies a **decision requirement** and nothing
  else. An `EvidenceRequirement` is never satisfiable by a decision: the
  operator cannot assert that a test passed. Fail-closed directions:
  absent decision → the transition is refused with the same
  `missing`-style diagnosis; a decision that is unknown, malformed,
  stale, or names an actor other than the calling surface → refused.
  This mirrors the W112 grant validation ("unknown, stale, malformed, or
  foreign-session grant re-asks fail-closed",
  src/ui/permission-broker.ts:134–139) and the W157 caller-names-itself
  join (src/kernel/contracts.ts:62–64).
- **A decision never satisfies an evidence requirement, and evidence never
  satisfies a decision requirement.** The two axes are disjoint by
  construction; that disjointness is the property to pin.
- **Claims** are admitted to no gate. If a claim is recorded at all, it is
  recorded in a non-kernel proposal channel as context, and the kernel
  reads none of it. The honest minimal option is that a claim stays
  unrecorded, as W114's read-only evidence panel already states
  (docs/ledger/W114-*.md:23–28).

### 2.3 Where each class may appear in a transition's requirements

The kernel already models requirements as data on the entity
(`WorkflowTask.requiredEvidence`, `WorkflowStep.requiredEvidence`,
src/kernel/contracts.ts:77/102). The additive shape:

- `requiredEvidence: readonly EvidenceRequirement[]` — unchanged; only the
  observation/adjudication axis may appear here.
- `requiredDecisions?: readonly DecisionRequirement[]` — NEW, optional;
  only the operator-decision axis may appear here. Absence means no
  decision gate (today's behavior, byte-identical).
- The `TransitionResult.rejected.missing` diagnosis (contracts.ts:148–157)
  is extended **additively** with a producing-flow pointer per entry
  (§2.4), and with the source axis (`evidence` | `decision`) so a reader
  can tell which gate refused.

Placing the two axes in **separate arrays** rather than widening one union
is the load-bearing choice: it makes "a decision satisfied an evidence
gate" a type error, not a policy check. That is the kernel-purity way to
fail closed.

### 2.4 The authorized-attach shape

The authorized-attach machinery is the *diagnostic* half, and it is
deliberately inert:

- Each requirement, when declared by the authority, records the
  **producing flow** that can satisfy it — a bounded pointer of the form
  `{ flow: string; ref?: string }`, e.g. `{ flow: "hub-test-runner" }`,
  `{ flow: "run-registry-reviewer-verdict", ref: "run:<id>" }`,
  `{ flow: "operator-decision-route" }`. The pointer names an **existing,
  authorized producer**; it is descriptive metadata, never an input path.
- The refusal diagnosis surfaces the pointer per missing artifact, so the
  reader is routed to the flow instead of being left to guess.
- **The pointer is recorded by the authority at requirement-declaration
  time, never accepted from a client.** A client-supplied "producing flow"
  would be a claim by another name; the W114 removal is the precedent that
  forbids it. The pointer produces nothing, satisfies nothing, and cannot
  be minted through any route — it is projection, not evidence.
- This is exactly "route around claim-shaped endpoints": instead of a
  surface that mints evidence from prose, the surface tells the operator
  which authorized flow to run, and that flow alone produces the record.

The producers this pointer names are the ones W114 left untouched
(docs/ledger/W114-*.md:26–28): the run registry's `run:<id>` reviewer
verdicts (src/integrations/run-registry.ts:447–448/500), the hub test
runner's environment evidence (src/integrations/run-registry.ts:615/645),
the MCP normalizer (src/adapters/mcp.ts:31), and the environment adapter
(src/application/task-commands.ts:137). The operator decision's producer is
the existing answer/transition path (src/ui/permission-broker.ts:193–223,
src/ui/web.ts:899), not a new evidence route.

### 2.5 Trust-zone mapping (THREAT_MODEL.md:11–18)

| Class | Originating zone | Boundary and honest limitation |
|---|---|---|
| `environment` | hub-owned run / test runner (trusted after validation) | the test command is only as honest as the project's `verifyCommand` (THREAT_MODEL.md:46) |
| `host` | host adapter (external input; enforced adapters fail closed) | advisory hosts guarantee nothing (THREAT_MODEL.md:14) |
| `mcp` | MCP server (untrusted observation; `normalizeMcpEvidence`) | a compromised evidence authority can lie; choose authorities accordingly (THREAT_MODEL.md:34) |
| `reviewer` | hub-owned review flow (trusted after fingerprint check) | validates shape, not truth (THREAT_MODEL.md:45) |
| `operator` (NEW) | the operator surface over the **unauthenticated loopback** (THREAT_MODEL.md:16, residual #9) | **the crux:** the loopback is a development surface, not an authenticated remote control plane; an operator decision is therefore not cryptographically attributable — it is bounded by the accepted residual, exactly as the P10 gate already is (docs/SECURITY_ASSURANCE.md:271–272) |
| claim | none (not representable) | a claim has no zone because it has no class |

The operator-decision class must not be read as raising the loopback's
assurance. It is a *vocabulary* for a decision that already crosses that
boundary (P10's answer-route gate is the landed precedent); it fails closed
on malformed metadata and cannot be minted by an agent or a non-operator
surface, but it inherits residual #9 unchanged. Any claim that
"operator-decision authority" hardens the loopback would be exactly the
advisory-as-enforcement dishonesty `AGENTS.md` forbids.

### 2.6 Migration / compatibility

- **The removed endpoint stays removed.** No route is added, re-added, or
  reshaped to accept `subject`/`result` or any claim; the W114 closure pins
  (the catch-all 404 for every origin, the unchanged evidence snapshot,
  test/web.test.ts) remain green and unmodified. L6 stays `landed+verified`.
- **Existing contracts are additive.** `EvidenceAuthority`,
  `EvidenceRequirement`, `Evidence`, and `TransitionAttribution` keep their
  current members and shapes. `requiredDecisions` is optional; a task
  without it behaves byte-identically. The `missing` diagnosis gains fields
  but no existing field changes meaning (W110's legibility contract is
  preserved).
- **The two axes do not cross.** No existing evidence gate becomes
  satisfiable by a decision; no decision gate becomes satisfiable by
  evidence.
- The P10 answer-route gate is the compatibility anchor: this design
  generalizes the *shape* P10 landed (a server-side re-check of an
  already-classified operator action, fail-closed, refusing without
  consuming state) but does not alter it.

## 3. The options the record implies, and a recommendation

Exactly three coherent options follow from the record; no fourth appears in
it.

### Option A — separate decision axis + inert producing-flow pointer (recommended)

- **Shape:** §2 in full — a NEW `DecisionAuthority`/`DecisionRequirement`
  axis disjoint from `EvidenceAuthority`; an inert, authority-recorded
  producing-flow pointer on the refusal diagnosis; claims remain
  unrepresentable.
- **Gate semantics:** decision requirements fail closed; evidence gates
  untouched; the disjointness is enforced by the type split, not a runtime
  check.
- **Pins that move:** none existing. New pins only: a decision requirement
  refuses when absent; a decision cannot satisfy an evidence requirement
  and evidence cannot satisfy a decision requirement; the producing-flow
  pointer is authority-recorded and never client-supplied; the W114 404
  closure pins stay green.
- **Security posture delta:** strictly vocabulary-additive. It makes an
  existing decision class explicit and makes the W114 hazard
  unrepresentable; it does not widen the loopback trust boundary.
- **Cost:** a kernel type/task-graph change, an additive diagnosis field,
  and a pin battery — a real iteration, not a one-liner. It also forces the
  operator questions in §5 before the type can be finished honestly.

### Option B — widen `EvidenceAuthority` with an `operator` member

- **Shape:** add `"operator"` to the existing union
  (src/kernel/contracts.ts:17) so an operator decision satisfies one
  `EvidenceRequirement` like any other authority.
- **Why the record pushes against it:** it re-creates the W114 hazard at a
  different layer — an operator-typed assertion would satisfy an evidence
  gate, which is precisely "an operator claim recorded as kernel
  evidence" (docs/ledger/W114-*.md:15–17, LESS-0035). It also collapses
  the decision/observation distinction the design exists to protect.
- **Pins that move:** the W114 closure pins are about the endpoint, not the
  union, so they would *stay green* while the hazard returns through the
  gate — the most dangerous kind of regression. Rejecting B is a
  correctness argument, not a taste argument.

### Option C — authorized-attach only, defer the kernel axis

- **Shape:** land only §2.4 (the inert producing-flow pointer) as a
  diagnosis improvement; leave the operator/claim authority class queued.
- **Trade-off:** it delivers the routing half of P3 cheaply and safely, and
  it does not require the vocabulary decision. But the row pairs the two
  halves for a reason: without the decision axis, a future "operator
  approved this" need will re-open the question and risk re-inventing the
  claim shape. C is a valid *partial* land only if the operator wants the
  routing benefit before deciding the vocabulary.
- **Cost:** small (one additive diagnosis field + pins); leaves the kernel
  axis explicitly parked.

### Recommendation (input, not decision)

**Recommend Option A**, with C as the honest fallback if the operator wants
the routing benefit decoupled from the vocabulary decision. A is the only
option that makes "a decision satisfied an evidence gate" a type error
while closing the W114 hazard by construction; B is rejected by the record
itself (LESS-0035); C is safe but leaves the row's central dependency
unresolved. Trade-offs stated plainly:

- A is the largest change and it cannot be finished honestly until the §5
  operator questions are answered — the type's actor-binding and
  one-shot/expiry semantics are operator policy, not design taste.
- The operator-decision class **inherit residual #9** (the unauthenticated
  loopback). A does not close it and must not be claimed to; P10 already
  accepted the same boundary.
- If the operator's priority is routing legibility over vocabulary
  closure, C delivers it today at low risk.

**Restated verbatim for the record: this brief is the input; the decision
is the operator's.** (The row itself: "Depends on the kernel
authority-vocabulary design decision (operator input recommended)",
docs/PARKED_AND_LIMITATIONS.md:32.)

## 4. Implementation sketch (so a later iteration is executable)

**Kernel contracts** — `src/kernel/contracts.ts`:

1. Add the decision axis, mirroring the evidence axis:
   `export type DecisionAuthority = "operator";`
   and `DecisionRequirement { readonly authority: DecisionAuthority;
   readonly subject: string; }`. Keep `EvidenceAuthority`,
   `EvidenceRequirement`, `Evidence`, `TransitionAttribution` unchanged.
2. Add the producing-flow pointer as descriptive metadata on the
   requirement: `readonly producingFlow?: { readonly flow: string;
   readonly ref?: string }` (or a parallel authority-recorded map), and
   extend `TransitionResult.rejected.missing` entries additively with
   `source: "evidence" | "decision"` and the pointer.
3. Add `requiredDecisions?: readonly DecisionRequirement[]` to
   `WorkflowTask` and `WorkflowStep` (optional, additive).

**Gate wiring** — `src/kernel/task-graph.ts` + `src/application/workflow.ts`:

4. The transition validator checks `requiredDecisions` fail-closed
   alongside the existing evidence check (src/kernel/task-graph.ts:458–466
   is the template); a missing decision joins the `missing` diagnosis with
   `source: "decision"`. The evidence gate is untouched.
5. The application authority (src/application/workflow.ts) is the only
   site that accepts an operator decision into a proposal; it never accepts
   a claim, and it verifies the decision's actor names the calling surface
   (the W157 caller-names-itself precedent, contracts.ts:62–64). No new
   web route is added — the decision rides the existing answer/transition
   path (permission-broker.ts:193–223, web.ts:899).
6. The producing-flow pointer is authored by the authority at
   requirement declaration; it is never read from a request body.

**Pin plan** (red-first; focused suites only, never `npm test` per
`AGENTS.md`):

- New kernel pin: a required decision absent → transition rejected with
  `source: "decision"`.
- New disjointness pin: an operator decision does **not** satisfy an
  `EvidenceRequirement`; evidence does **not** satisfy a
  `DecisionRequirement`.
- New provenance pin: a decision that is malformed/stale/actor-mismatched
  is refused without changing state (the W112 grant-validation template).
- New inert-pointer pin: the refusal diagnosis carries the
  authority-recorded producing flow; a client-supplied pointer is ignored.
- **Held-out closure pin:** the W114 404 catch-all and the unchanged
  evidence snapshot (test/web.test.ts) stay green, proving no
  claim-accepting route returned.
- Verification battery: the focused kernel + task-graph + application +
  web suites; `npm run lint` + `npm run typecheck` exit 0 unpiped
  (LESS-0035's deletion lint tail is the precedent for never trusting
  typecheck alone); fresh-eyes five-axis review recorded BEFORE approval.

**Records if A lands:** a TASKS.md/ledger item for the iteration; a dated
disposition note on P3; and, if the decision class exposes a new boundary,
a SECURITY_ASSURANCE residual entry that states it inherits #9 rather than
closing it.

### Open operator questions (policy, not design — separated deliberately)

1. **Actor binding.** What binds an `operator` decision to the operator's
   own surface given the unauthenticated loopback (residual #9)? Accept it
   as the documented boundary (P10's posture), or require something more?
2. **One-shot / expiry.** Does an operator decision carry one-shot or
   bounded-expiry semantics like the W112/W160 grant lifecycle, or does it
   stand until superseded?
3. **Scope of decision gates.** Which transitions may declare a decision
   requirement — only named ones (e.g. `BLOCKED → READY` admission, an
   evidence waiver), or any transition?
4. **Claim recordability.** Do claims stay entirely unrecorded (W114's
   read-only-panel posture), or may non-kernel proposal context record them
   outside any gate?
5. **Pointer placement.** Does the producing-flow pointer live on the
   requirement at declaration time, or only on the refusal diagnosis?
6. **Naming.** Is the operator class named `operator` (consistent with the
   W157 actor set) and the non-authority reserved as "claim," or is a
   different split preferred?

These six are the decision the row queued. The brief does not answer them.

## 5. What this brief does not do

- No code change, no new route, no gate implementation. Docs-only.
- No operator-level policy decision (the §4 questions stay open).
- No reintroduction of `POST /api/evidence` or any claim-accepting shape;
  L6 stays `landed+verified`.
- No lint/typecheck claim — **not applicable to a docs-only change**; the
  verification commands that matter for the later code iteration are listed
  in §4.
