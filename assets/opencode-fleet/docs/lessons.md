# Lessons — append-only agent memory

Itemized, id'd, evidence-backed bullets (ACE-style). Append only — never
rewrite, renumber, or delete existing bullets. Dedupe by listing ids in a
DEDUPE note for a later pass; a human or a dedicated consolidation pass does
the merging.

## Format

- L<nnn> — <one-line lesson> (evidence: <file, run, or PR reference>)

## Lessons

- L001 — Files handed to a human for manual saving must use single-level code fences; nested fences terminate the outer block early and silently corrupt the saved copy (missing closers, swallowed neighboring content). (evidence: this session — chat-rendered agent files saved to `docs/agents/` lost closing ``` and glued decompose+executor into one file; correct copies landed via direct write in `.config/opencode/`)
- L002 — A citation can be real and still mischaracterized: the docs attributed "workspace edits free, deployment gated" to AHE (2604.25850), but the paper confines harness edits to a workspace and gates each edit; the phrase appears nowhere in it. Verify the *claim* against the primary source, not just that the citation resolves. (evidence: 2026-09-22 citation sanity check of `reading-list.md`; correction applied in `policy-review.md` F2)
- L003 — Reference titles must be copied verbatim from the source: two entries used paraphrase/descriptor titles (Weng "Reward Hacking in LLMs"; METR "Task-Completion Time Horizon") that fail a title lookup even though the works are correct. (evidence: same 2026-09-22 sanity check; corrections in `reading-list.md`)
