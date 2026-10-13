# Lessons — append-only agent memory

Itemized, id'd, evidence-backed bullets (ACE-style). Append only — never
rewrite, renumber, or delete existing bullets. Dedupe by listing ids in a
DEDUPE note for a later pass; a human or a dedicated consolidation pass does
the merging.

Admission gate: because accumulation is non-monotonic and a defective lesson
contaminates later ones irreversibly (2608.05810), a candidate lesson must pass
an external critical check — does the cited evidence actually support the
claim? — *before* it is written here. Post-hoc dedupe clears clutter; it
cannot undo contamination. The mechanical half of that gate is enforced by
`install/lib/validate-lessons.cjs` (pre-commit Layer 11): it requires an `L<nnn>`
id, an `(evidence: ...)` citation, a single-bullet file, registration below, and
that this registry is append-only against HEAD (the committed bullet sequence
must be an in-order prefix of the staged sequence, so no existing bullet can be
rewritten, renumbered, reordered, or deleted, while the prose header stays
editable). The semantic half — evidence actually supports the claim — remains an
external review, not a regex.

## Format

- L<nnn> — <one-line lesson> (evidence: <file, run, or PR reference>)

## Lessons

- L001 — Files handed to a human for manual saving must use single-level code fences; nested fences terminate the outer block early and silently corrupt the saved copy (missing closers, swallowed neighboring content). (evidence: this session — chat-rendered agent files saved to `docs/agents/` lost closing ``` and glued decompose+executor into one file; correct copies landed via direct write in `.config/opencode/`)
- L002 — A citation can be real and still mischaracterized: the docs attributed "workspace edits free, deployment gated" to AHE (2604.25850), but the paper confines harness edits to a workspace and gates each edit; the phrase appears nowhere in it. Verify the *claim* against the primary source, not just that the citation resolves. (evidence: 2026-09-22 citation sanity check of `reading-list.md`; correction applied in `policy-review.md` F2)
- L003 — Reference titles must be copied verbatim from the source: two entries used paraphrase/descriptor titles (Weng "Reward Hacking in LLMs"; METR "Task-Completion Time Horizon") that fail a title lookup even though the works are correct. (evidence: same 2026-09-22 sanity check; corrections in `reading-list.md`)
- L004 — `npm ci` mishandles `--prefix` when the CWD has no package.json (EUSAGE help-wall), and refuses a lockfile missing entries package.json declares; cd into the project and `npm install` to resync the lock. (evidence: feat/install-scripts 2026-09-25 stage-30 run; fix `0d15059`)
- L005 — Under `set -o pipefail`, `producer | grep -q` false-fails: grep exits early on match, the producer gets SIGPIPE (141), pipefail marks the pipeline failed despite the match. Capture the producer's output into a variable, then grep the variable. (evidence: install/10-system.sh distrobox check reported drift for an existing container; PIPESTATUS showed 141/0)

### Per-file lessons (one file per lesson under `lessons/`)

Newer lessons live one-per-file under `lessons/`, each carrying its id in
the bullet. The pre-commit admission gate (`validate-lessons.cjs`, Layer 11)
requires every file to be listed here.

- L006 — `lessons/2026-10-01T23-58-57Z-check-siblings-and-venue-not-just-the-canonical-url.md`
- L007 — `lessons/2026-10-02T00-04-30Z-sweep-the-neighborhood-not-the-curated-topics.md`
- L008 — `lessons/2026-10-02T02-32-18Z-verify-the-claim-not-just-the-check.md`
- L009 — `lessons/2026-10-02T03-50-50Z-guard-idempotence-on-the-stronger-invariant.md`
- L010 — `lessons/2026-10-02T05-06-27Z-stage-guarded-config-by-neutral-name-fix-router-reach-not-the-pin.md`
- L011 — `lessons/2026-10-02T20-10-00Z-measure-the-applied-state-not-the-staged-intent-and-test-the-overwrite-predicate.md`
- L012 — `lessons/2026-10-02T20-15-00Z-transform-order-is-the-contract-and-live-confirmation-can-be-blocked-by-module-cache.md`
- L013 — `lessons/2026-10-02T21-20-00Z-score-the-runtime-not-the-declared-config.md`
- L014 — `lessons/2026-10-02T21-45-00Z-converge-a-narrow-class-by-default-and-repair-stale-live-artifacts.md`
- L015 — `lessons/2026-10-02T22-45-00Z-convergence-is-not-effect-score-the-flag-gated-consumer.md`
- L016 — `lessons/2026-10-02T23-50-00Z-a-managed-config-namespace-is-owned-by-value-not-presence.md`
- L017 — `lessons/2026-10-03T00-20-00Z-fail-loud-on-the-intent-source-too-and-check-stacked-branches-after-merge.md`
- L018 — `lessons/2026-10-03T01-40-00Z-close-review-followups-as-a-batch-and-keep-prose-in-sync-with-semantics.md`
- L019 — `lessons/2026-10-03T02-30-00Z-build-the-ruler-before-the-second-tune.md`
- L020 — `lessons/2026-10-03T03-00-00Z-measure-the-store-you-already-have.md`
- L021 — `lessons/2026-10-03T06-00-00Z-slice-a-rate-by-the-producing-tool-not-the-average.md`
- L022 — `lessons/2026-10-03T07-00-00Z-a-stable-rate-can-sit-under-an-unstable-aggregate.md`
- L023 — `lessons/2026-10-03T08-00-00Z-a-claimed-gate-may-not-exist.md`
- L024 — `lessons/2026-10-03T09-30-00Z-a-skip-where-ci-runs-is-not-a-gate.md`
- L025 — `lessons/2026-10-03T10-15-00Z-slice-the-projection-the-way-you-sliced-the-effect.md`
- L026 — `lessons/2026-10-03T12-30-00Z-a-gate-that-reads-a-different-source-is-not-gating.md`
- L027 — `lessons/2026-10-03T22-40-00Z-a-parity-gate-that-walks-one-side-proves-one-direction.md`
- L028 — `lessons/2026-10-04T04-16-19Z-a-repair-guard-needs-a-fixture-not-just-a-call-site.md`
- L029 — `lessons/2026-10-04T04-34-36Z-pin-the-round-trip-not-one-half-of-the-contract.md`
- L030 — `lessons/2026-10-06T02-55-50Z-classify-the-key-is-not-check-the-value.md`
- L031 — `lessons/2026-10-11T00-24-04Z-inject-standards-dont-tell-the-agent-to-read-them.md`
- L032 — `lessons/2026-10-11T14-05-00Z-scaffold-before-you-loop.md`
- L033 — `lessons/2026-10-12T17-00-00Z-report-selection-and-held-out-not-selection-alone.md`
- L034 — `lessons/2026-10-12T20-15-00Z-a-write-scope-must-cover-the-gates-cross-file-requirement.md`
- L035 — `lessons/2026-10-12T21-30-00Z-an-append-only-check-must-be-bullet-scoped-and-fail-closed.md`
- L036 — `lessons/2026-10-13T09-00-00Z-a-policy-port-must-name-its-residuals.md`
