<!-- Ledger fragment: extracted from TASKS.md at line 1389 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W077 - Hub orientation briefing (prompt-level block; skill depth layer behind a dated decision)

**Objective:** Give hub-launched agents a deterministic orientation so toolbox/guard tools are used
correctly. Design decision recorded 2026-09-20: a static, versioned, provenance-tagged prompt-level
orientation block is the guaranteed/discovery layer (~100–150 tokens: hub role, tool presence,
"check `guard_next_tasks` before planning", pointer to the skill); detailed tool data lives in a
skill body **generated from `toolbox-catalog.ts`** (single source of truth, written as a workspace
file at session create for OpenCode first). Native host skill injection stays **off** per the
2026-09-15 hub-owned-enforcement plan — the skill-file route needs an explicit dated supersession or
a file-provisioning framing before it ships.

**Depends on:** W076 (probes establish the host-version behavior the skill-discovery claim needs).

**Acceptance criteria:**
- [x] `buildOrientation()` (extending `src/integrations/prompt-guidance.ts`): static template,
      `ORIENTATION_VERSION` stamp, no interpolation of task/repo/env data, silence-when-unset,
      prepended at scheduled-turn session start. (Implemented as `buildOrientation` +
      `hubPromptGuidanceFromEnv` — the hub composes orientation first, operator advisory second;
      `WORKFLOW_HUB_ORIENTATION=0` opts out. The block is composed once at hub startup and
      **prepended per scheduled turn** — each scheduled run's session start; bounded ~160 tokens.
      Version "2" drops the pointer to the not-yet-delivered skill, review P2.)
- [x] Composition pin + no-interpolation pin in focused tests (scheduler composition like
      `test/hub-scheduler.test.ts:178`). (Pinned in `test/g5-observability.test.ts`: **full-text
      frozen pin** — any wording change must fail the test and force a version bump — plus
      no-placeholder and hedged-tool-presence pins, opt-out pin, ordering pin; the scheduler's own
      `promptGuidance` seam is unchanged so the existing composition pin holds.)
- [x] Orientation version + fingerprint recorded in the run registry for review provenance. (The
      version is embedded in the block text; the scheduler now records the **composed** prompt as
      the run's `taskPrompt` — pinned by a scheduler test (`begin records the composed prompt`) —
      so the W041 provenance digest binds exactly what the agent received and an orientation change
      invalidates recorded fingerprints. Review P1: the original claim was false because `begin`
      recorded the raw schedule prompt; fixed in the same slice.)
- [x] Skill body generated from the toolbox catalog with a content-pinning test against the corpus;
      per-host delivery (OpenCode skill dir; goose/cline) only when that surface qualifies.
      (`toolboxSkillBody` generates from the resolved catalog — names, descriptions, truthful
      availability; corpus-pinned in `test/toolbox-catalog.test.ts`. **Delivery is deliberately NOT
      implemented**: native host skill injection stays off per the 2026-09-15 plan — a dated
      decision or file-provisioning framing is the prerequisite, stated in `docs/FEATURES.md` —
      and the orientation block does not reference the skill until it ships.)
- [x] Ledger rows in `docs/HARNESS_ASSUMPTION_LEDGER.md` (advisory orientation block, skill recall)
      and a `docs/FEATURES.md` status entry; advisory only — enforcement stays in the guard MCP
      server. (Orientation row added; the skill-delivery row lands with the delivery decision.)

**Verification:** `test/g5-observability.test.ts` (W077 composition/opt-out/no-interpolation pins) +
`test/toolbox-catalog.test.ts` (skill-body corpus pin) + `test/hub-scheduler.test.ts` (seam
unchanged) — 23/23; typecheck and lint clean; ledger + FEATURES rows dated 2026-09-20. Five-axis
review round 1: REQUEST_CHANGES (P1 provenance claim false — begin recorded the raw prompt; P2
block pointed at the undelivered skill; three P3s) — all fixed in `c296415` (composed prompt is the
recorded ask, orientation v2 drops the skill pointer, full-text frozen pin, hedged tool presence,
precise wording). Re-review 2026-09-20: **APPROVE** recorded.
