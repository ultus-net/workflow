# skills-mcp

Hub-owned skills delivery over MCP (plan Task F1). `list_skills` is
metadata-only; `read_skill` is the single content delivery path. Skills are
screened at ingestion and delivery — malicious-shaped content (remote-code-
execution pipelines, credential harvesting, instruction hijacking, hidden
unicode, oversized payloads) is quarantined and surfaced with findings.
Availability and read access are gated by the operator-managed `levels.json`
(pedagogical modes to unlocked/required), with honest `off`/`active`/`closed`
states that fail closed.

Configuration: `SKILLS_MCP_DIR` (default `~/.agents/skills`),
`SKILLS_MCP_LEVEL` (optional pedagogical mode).

Honest limits: screening is heuristic, not a sandbox — the guard dispatcher
still gates every executed command at run time, and prompts are never a
security boundary. Delivery is enforced; adherence is not.

## Import & update lifecycle

The skills directory is operator-owned surface, not a repo artifact.
`scripts/vendor-skills.mjs` (repo root) vendors curated upstream skills into
it and is the single writer of what it imports:

    node scripts/vendor-skills.mjs --list        # dry run: what would import
    node scripts/vendor-skills.mjs               # import / update (deliberate)
    node scripts/vendor-skills.mjs --archive     # move handcrafted skills to .archive/
    node scripts/vendor-skills.mjs --prune       # drop owned skills that left the selection

- Provenance lives in `vendor-skills.json` inside the skills directory — a
  plain file, invisible to this scanner exactly like `levels.json`. Re-runs
  update owned skills in place; unowned directories are never overwritten
  (fail-closed refusal — `--archive` moves skill-shaped ones aside rather
  than deleting). Prune only removes provenance-owned names, and refuses to
  run at all when a source failed (no pruning on a partial view).
- Updates are deliberate operator re-runs, never scheduled. This server keeps
  no cache: `list_skills` rescans on every call and `read_skill` re-screens
  content at every delivery ("the file may have changed since discovery") —
  the designed compensating control for upstream drift between runs.
- Symlinked skill directories are skipped by design: the runtime binds the
  skills directory into containment by realpath, so a symlink pointing
  outside the bound set dangles inside the boundary. Copy skills in — the
  vendor script always copies. (The `skills.sh` CLI is an ad-hoc alternative
  for individual skills, but its default install method is symlinks, which
  this scanner will not see; pass `--copy` if you use it.)

Default curation: `obra/superpowers` (flat `skills/`) and
`mattpocock/skills` (`engineering/` + `productivity/` only —
`deprecated/`, `in-progress/`, and `misc/` stay out). The two selections do
not collide on names (audited 2026-09-16). Design record:
`docs/superpowers/plans/2026-09-16-skills-import-lifecycle.md`.
