# W206 (M6): single writer for learner-profile — learning-mcp owns the file

Date: 2026-10-16. Branch: `feat/m6-learner-profile-single-writer`. Base: `6dea4684`.

## Goal

`learner-profile.json` had TWO writers sharing one `<path>.lock`: the plane
module `src/pedagogy/learner-profile.ts` and the toolbox app
`mcp-toolbox/apps/learning-mcp/src/learner-profile.ts`. The operator decided
(`augur/docs/integration-plan.md` §F item 2, option (a)): **learning-mcp is the
sole writer**; the plane module stops writing and becomes a client of the
`record_learning_evidence` MCP tool through the assistant tool lane.

The W205 S5 slice already built the daemon-side MCP dispatch seam
(`WORKFLOW_ASSISTANT_MCP_TOOLS`, `src/integrations/assistant-mcp-dispatcher.ts`),
so the tool lane exists. This slice removes the second writer.

## What changed

**Rewrite (pure):** `src/pedagogy/learner-profile.ts`.

- Deleted the whole write path and lock: `saveLearnerProfile`,
  `updateLearnerProfile`, `acquireLearnerProfileLock`, `lockIsStale`,
  `sleepSync`, `LearnerProfileLockOptions`, the M6 lock comment block, and the
  `node:fs` write imports (`mkdirSync`, `openSync`, `renameSync`, `writeFileSync`,
  `closeSync`, `unlinkSync`).
- Kept the pure functions: `createLearnerProfile`, `recordLearningEvidence`
  (unchanged monotonic in-memory merge), `selectLearningOpportunity`.
- `defaultLearnerProfilePath` reduced to a pure path helper (no IO).
- `loadLearnerProfile` kept, but read-only: no lock, no write, no directory
  creation. It now delegates parsing to the new pure `parseLearnerProfile(raw)`
  (extracted from the old load body), so the parse is directly testable.
- Added the injected port `LearnerEvidenceRecorder { record(evidence):
  Promise<void> }` and a documented no-op default `noopLearnerEvidenceRecorder`.

**New (assistant side):** `src/assistant/learner-evidence.ts`.

- `createAssistantLearnerEvidenceRecorder({ executor, context })` composes a
  `LearnerEvidenceRecorder` that routes each observation through the assistant
  tool lane by calling the `record_learning_evidence` MCP tool
  (`RECORD_LEARNING_EVIDENCE_TOOL`). It inspects the executor result and REJECTS
  on `isError` rather than silently dropping evidence.
- The tool takes `concept`, `kind`, `summary` only (it stamps the time
  server-side), so the adapter sends exactly those three fields.

**Unchanged surface:** `src/index.ts` uses `export *`, so the new pure surface
flows through with no edit needed. The TUI (`src/ui/tui.tsx`) still calls
`loadLearnerProfile`, which is now read-only — no behavior change for the
profile panel.

## The port shape

```ts
// src/pedagogy/learner-profile.ts (plane — interface only)
export interface LearnerEvidenceRecorder {
  record(evidence: LearnerEvidence): Promise<void>;
}
export const noopLearnerEvidenceRecorder: LearnerEvidenceRecorder; // documented no-op
```

```ts
// src/assistant/learner-evidence.ts (assistant — the concrete adapter)
export function createAssistantLearnerEvidenceRecorder(options: {
  executor: AssistantToolExecutor;
  context: AssistantToolContext;
}): LearnerEvidenceRecorder;
```

The plane names the port and holds no implementation. The adapter that reaches
the tool lane lives under `src/assistant/`.

## The isolation constraint honored

`test/assistant-isolation.test.ts` is an import-graph gate: the plane (`src/`)
must never import the assistant subtree (`src/assistant/`); the arrow is one-way
(assistant imports plane). The concrete adapter therefore lives at
`src/assistant/learner-evidence.ts` and imports the plane interface; the plane
module imports nothing from `src/assistant/`. The gate stays green
(1/1).

## What remains (honest status)

- **No live evidence-emission call site.** The tutor pipeline does not emit
  evidence today, so nothing composes a real recorder yet. This slice ships the
  port plus the real assistant-lane adapter (exercised by tests against a fake
  executor) and the documented no-op default. It does NOT fabricate a call site
  it cannot exercise. The follow-up wires the tutor loop to call
  `recordLearningEvidence` locally and then hand the same evidence to an
  injected `LearnerEvidenceRecorder`.
- **Deploy env:** `WORKFLOW_ASSISTANT_MCP_TOOLS` must declare
  `record_learning_evidence` → the learning-mcp server so the daemon-side
  dispatcher can fulfill the hub's dispatch directive. Until then a recording
  call fails closed inside the executor. Same deferral S5 recorded.
- **The lock's coverage** stays at
  `mcp-toolbox/apps/learning-mcp/test/learner-profile-lock.test.ts` (unchanged).

## Evidence

- `npx tsc --noEmit` → exit 0.
- `npm run lint` → exit 0.
- `npm run build` → exit 0 (clean).
- `node --import tsx --test test/pedagogy-learner-profile.test.ts
  test/pedagogy-learner-profile-purity.test.ts test/assistant-isolation.test.ts
  test/kernel-purity.test.ts` → all pass.
  - `test/pedagogy-learner-profile.test.ts` 9/9 (monotonic merge kept, pure
    parse, read-only load, no-op recorder, assistant-lane recorder routes the
    tool call and rejects on refusal).
  - `test/pedagogy-learner-profile-purity.test.ts` 4/4 (new guard: no exported
    write/lock surface, no write syscall in source, no assistant import;
    `recordLearningEvidence` is pure).
  - `test/assistant-isolation.test.ts` 1/1.
  - `test/kernel-purity.test.ts` 3/3.
- `test/ci-suites-manifest.test.ts` 5/5: `test/pedagogy-learner-lock.test.ts`
  removed from `test/ci-suites.txt`, `test/pedagogy-learner-profile-purity.test.ts`
  added in sorted position.

## Deleted

- `test/pedagogy-learner-lock.test.ts` (the lock no longer lives in the plane
  module) and its line in `test/ci-suites.txt`.
