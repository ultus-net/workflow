# W213: the care fact store (Decision 2, Option C) and the curated-core-only assertion gate

Status: implemented, pending review. Branch `feat/w213-care-fact-store`.

## Problem

`docs/decision-brief-seam-stores.md` Decision 2 (lines 133-238) settled the
shape of the authoritative care-fact store: **Option C (hybrid)** — a curated,
human-edited core is the ONLY source of factual assertions, and an
agent-written annotation channel lives beside it as inert audit data with NO
automatic promotion path (promotion is a deliberate human core edit). The
cross-cutting Q31 read rule is sharper than a category split: a claim is a
KEYED lookup against the small curated core, never a per-claim LLM grounding
call, and an ungrounded claim is DROPPED (fail-closed, silence is the
fallback — no policy value needed). Q28 (how to respond when the USER asserts
something false) is explicitly DEFERRED: the operator sets that value later
with clinical input. This slice builds the data side the brief calls "the
store and the read": the store, the gate, the Q28 seam, the hub read path,
and the wiring. The care UI view is the next slice (W214); the care loop and
fact-grounded replies stay out of scope.

Placement: the hub is plane, and the plane never imports `src/assistant/`
(one-way arrow, pinned by `test/assistant-isolation.test.ts`), so the store
lives in `src/integrations/` beside its M7 peers `reminder-state-machine.ts`
(W210) and `notify-delivery.ts` (W208). The future assistant-side care loop
imports these plane modules, which the arrow permits.

## Finalized contract

### `src/integrations/care-facts.ts` (the store)

Two channels under an injectable care dir, kept separate by construction:

- **Core** — `core.yaml` (YAML, human-edited). Zod schema:
  `CareFact = { key: string(min 1), value: string, category: "person"|"medication"|"schedule"|"preference"|"other", note?: string }`,
  `CareCore = { facts: CareFact[] (default []) }`.
- **Annotations** — `annotations.json` (agent-written, INERT).
  `CareAnnotation = { key: string, value: string, observedAt: string, source: string, note?: string }`,
  `CareAnnotations = { annotations: CareAnnotation[] (default []) }`.

`createCareFacts({ dir, maxFacts = 500, maxAnnotations = 500 })` loads a
snapshot and returns:

- `facts()` — the core ONLY, bounded (first N, document order).
- `annotations()` — the inert channel, bounded. NEVER asserted.
- `assertion(key)` — `{ present: true, value } | { present: false }`; reads
  the core ONLY. An annotation with the same key is NEVER returned. Duplicate
  core keys resolve first-wins in document order.
- `gate(keys)` — `{ grounded: [{key, value}], dropped: [key] }`: the
  curated-core-only rule over intended claim keys. Present keys ground (input
  order preserved); absent keys drop (fail closed); duplicates collapse
  (first occurrence decides position).
- `readonly dir`.

**Absence vs. malformation (the honest-error decision, tested):** a MISSING
dir or file is the honest EMPTY channel. A MALFORMED core or annotations file
(present but unparseable, or schema-invalid) THROWS a `TypeError` naming the
file and the violation — it never reads as empty, because a silently-empty
core would unground every fact the rule exists to assert, and a fabricated
"empty" is exactly the dishonesty the store forbids. This mirrors
`ReminderStateMachine.load`'s discipline (ENOENT → empty; parse failure →
throw).

### `src/integrations/care-policy.ts` (the Q28 seam, deferred value)

- `CareRealityOrientation = z.enum(["unset", "orient_gently", "validate_without_endorsement", "redirect"]).default("unset")`
- `readCarePolicy(dir)` reads `policy.yaml` under the SAME care dir. A
  missing dir/file is `{ realityOrientation: "unset" }` — honest absence,
  never a fabricated default behavior. A malformed file throws. The value is
  NOT wired to any behavior in this slice; Q28 is deferred and this is the
  seam only. The two Q28 behaviors stay un-conflated, per the brief:
  dropping an ungrounded LLM claim is structural (the gate above, no policy
  value); responding to a false USER assertion is this deferred value.

### The core/annotation boundary, enforced in code

`assertion` and `gate` consult ONLY the core index built from `core.yaml`;
the annotation channel has no code path into either. The hub projection
carries `facts` and `annotations` as SEPARATE payload fields so the boundary
is visible on the wire, plus a static, versioned rule statement
(`CARE_ASSERTION_RULE`, `"curated-core-only/v1: ..."`, no interpolated data).

### Hub read path (mirrors W212 exactly)

- `src/integrations/hub-http.ts`: an `assistantCare` capability FIELD on both
  `HubRequestContext` and `HubBridgeCapabilities` (never a positional), and a
  POST-only operator-token `POST /care` route answering
  `{ care: { root, facts, annotations, realityOrientation, rule } }` — 200 on
  success, `404 { error: "not found" }` when the capability is absent
  (withheld, fail closed).
- `src/cli/hub.ts`: composes the capability from the new env gate
  `WORKFLOW_CARE_FACTS` (absolute care dir; unset/empty → withheld → 404; a
  non-absolute path throws at hub start, the same `isAbsolute` posture
  `WORKFLOW_ASSISTANT_WORKSPACE` takes). ONE care-dir resolution feeds both
  `care-facts` and `care-policy` via `readCareProjection(dir)`, which
  re-reads from disk per call (an operator core edit is live on the next
  read).
- `src/ui/web.ts`: `GET /api/care` relays the browser's GET onto the hub's
  POST-only read (fail-closed `{ care: null, reason }`, exactly like
  `hubNotes`/`hubAssistantWorkspace`). The care VIEW is W214; this pins the
  read seam.

### The W212 P0 lesson applied

W212's P0 was a capability the CLI passed but `createWorkflowHub` never
declared on its options type and never forwarded to the bridge — silent at
`tsc` because the spread-call shape bypasses excess-property checks — so the
routes 404ed only in production. W213 declares `assistantCare` on the options
type (`src/integrations/workflow-hub.ts`, beside
`assistantNotes`/`assistantNoteRead`) AND forwards it into the capabilities
object beside the same peers, as one deliberate pair, and extends
`test/hub-composition-forwarding.test.ts` (the regression suite W212 added
for exactly this class) so the route is pinned through the REAL
`createWorkflowHub` composition (present → 200, withheld → 404, verifier →
401), plus a throwaway end-to-end probe of the same path (evidence below).

## Acceptance criteria and evidence

All acceptance criteria met:

1. Store + policy seam with the finalized contract above. ✅
2. `assertion`/`gate` read the core only; annotations never assert. ✅
3. Missing vs malformed honesty (empty vs throw), pinned by tests. ✅
4. Hub POST /care route (operator-token, POST-only, 404 withheld) through
   BOTH `createWorkflowHubBridge` and the production `createWorkflowHub`. ✅
5. CLI env gate `WORKFLOW_CARE_FACTS` with the workspace posture. ✅
6. Web relay `GET /api/care`. ✅
7. Focused tests pass; lint/typecheck/build clean. ✅

Exact commands and results:

```text
$ node --import tsx --test test/care-facts.test.ts
# tests 11  # pass 11  # fail 0

$ node --import tsx --test test/hub-assistant-care.test.ts
# tests 5   # pass 5   # fail 0

$ node --import tsx --test test/hub-composition-forwarding.test.ts
# tests 3   # pass 3   # fail 0   (the /care forwarding pins ride the same file)

$ node --import tsx --test test/ci-suites-manifest.test.ts \
    test/hub-web-service.test.ts test/hub-assistant-note.test.ts
# pass, no failures (the relay/route additions break no neighbor pins)

$ npm run lint        -> clean (3 initial preserve-caught-error findings on the
                          malformed-file rethrows, fixed with { cause: error })
$ npm run typecheck   -> clean
$ npm run build       -> clean

W213 production-composition probe (throwaway script at the workspace root,
run with `node --import tsx`, deleted after):
  present  -> status 200, body {"care":{"root":...,"facts":[{"key":"resident-name",
              "value":"Margaret Ellis","category":"person"}],"annotations":[],
              "realityOrientation":"unset","rule":"curated-core-only/v1: ..."}}
  withheld -> status 404, body {"error":"not found"}
  W213 probe PASS: /care is reachable through createWorkflowHub
  (200 present, 404 withheld, through the REAL composition — the W212 P0 class)
```

Test files: `test/care-facts.test.ts` (11), `test/hub-assistant-care.test.ts`
(5), `test/hub-composition-forwarding.test.ts` (extended with the /care
pins). Both new files added to `test/ci-suites.txt` in sorted position.

## Not built in this slice (scope discipline)

- The care UI view (W214), the care loop and fact-grounded replies, and the
  Q28 VALUE (the seam reports "unset" until the operator sets `policy.yaml`
  with clinical input). No automatic annotation-to-core promotion path exists
  or is planned — promotion is a deliberate human edit by design.
- `TASKS.md` is operator-frozen: not appended (the W208-W212 ledgers note
  the same).
