<!-- Ledger fragment: opened 2026-09-27 as a post-freeze W-item (TASKS.md is frozen; live tracking is the GitHub Project). Write-once record — append dated supersession notes, never rewrite. -->

### W158 - Evidence content capture: screenshots and test outputs recorded as evidence at capture time (Planned - the W154 artifact-strip capture gap, split out per the borrowings spec) (2026-09-27)

**Source:** the Paperclip borrowings spec's Wave 5 (work products over evidence) and its data-projected note: "if screenshots or test outputs are not currently recorded as evidence, the honest first step is recording them at capture time in the existing evidence pipeline, not inventing an upload channel." Verified 2026-09-27: kernel `Evidence` (src/kernel/contracts.ts:26-36) carries `{id, observationId, authority, subject, result, freshness, mutationEpoch, observedAt}` — no content payload — so the W154 artifact-strip slice renders evidence records as plain records with their freshness state (the strip's criterion-1 half that needs no new capture), and this item is the capture-time recording that would give the strip something to preview.

**Objective:** at the moments the environment already produces inspectable outputs, the existing evidence pipeline records them as evidence with a bounded content reference — screenshot captures from the contained runtime and test-runner outputs from the run-registry's test evidence path — each linked to the owning run. No agent-initiated upload channel (the spec's cut line stands: different trust model; Workflow's evidence is environment-captured).

**Acceptance criteria:**
- [ ] A screenshot the contained runtime produces during a run is recorded as evidence with a bounded content reference linked to the run (focused test on the capture path, LESS-0051 posture).
- [ ] A test-runner output recorded as evidence is the same record the run's verification consumed — one record, not a parallel copy (asserted).
- [ ] Content is bounded (size cap, eviction like the web image store's) and rides no kernel purity line (the capture lives in the integration layer; the kernel evidence record references it).
- [ ] The W154 artifact strip renders the preview in place when content exists and the plain record with freshness when it does not — the same strip code, no silent fallback.

**Residuals (cut):** agent-initiated uploads, anchored document comments, cross-task stacks, a workspace file browser (the spec's cut lines, unchanged).
