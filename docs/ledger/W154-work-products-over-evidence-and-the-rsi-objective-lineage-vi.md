<!-- Ledger fragment: extracted from TASKS.md at line 5592 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W154 - Work products over evidence, and the RSI objective lineage view (Planned - Paperclip borrow wave 5; spec Wave 5) (2026-09-26)

**Source:** Paperclip's artifacts shelf + work-timeline discipline, mapped onto the Evidence/Changes panels and W073's self-improvement registry. Two panels, one wave: (a) an artifact strip in the Evidence and Changes panels — screenshots render inline, test outputs render as text, each linked to the owning run/evidence record; durable inspectable outputs are first-class while in-worktree paths are signposts and must not present as durable artifacts; (b) the RSI lineage view — objective → iteration → verdict → commit-ref chain projected from self-improvement registry records, one row per iteration, verdict and commit ref clickable into the run record.

**Acceptance criteria:**
- [ ] Evidence with image content renders a preview in place; without previewable content renders a plain record with its freshness state (no silent fallback).
- [ ] The RSI lineage view renders the full chain for a registry objective with honest empty states for absent verdicts/commit refs.
- [ ] A test proves the artifact strip refuses to render a bare filesystem path as a durable artifact.

**Residuals (cut):** agent-initiated uploads (different trust model — Workflow evidence is environment-captured), anchored document comments, workspace file browser, cross-task stacks.

**Design conventions for W150-W154 (from Paperclip DESIGN.md, projection-compatible):** one semantic status token set (running/paused/blocked/awaiting-review/over-budget) shared across badge/row/chart/log (styles.css/theme.ts before W150 lands); machine values monospace with shared formatters (presenters.ts); no redundant toasts; late terminal outcomes refresh silently. No Paperclip vocabulary (hire/CEO/board/company/heartbeat) enters Workflow copy — runs, schedules, reviews, evidence, objectives stay canonical.
