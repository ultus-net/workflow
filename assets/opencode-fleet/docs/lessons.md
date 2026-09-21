# Lessons — append-only agent memory

Itemized, id'd, evidence-backed bullets (ACE-style). Append only — never
rewrite, renumber, or delete existing bullets. Dedupe by listing ids in a
DEDUPE note for a later pass; a human or a dedicated consolidation pass does
the merging.

## Format

- L<nnn> — <one-line lesson> (evidence: <file, run, or PR reference>)

## Lessons

- L001 — Files handed to a human for manual saving must use single-level code fences; nested fences terminate the outer block early and silently corrupt the saved copy (missing closers, swallowed neighboring content). (evidence: this session — chat-rendered agent files saved to `docs/agents/` lost closing ``` and glued decompose+executor into one file; correct copies landed via direct write in `.config/opencode/`)
