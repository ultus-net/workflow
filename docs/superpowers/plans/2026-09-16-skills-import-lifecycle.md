# Skills import & update lifecycle

## Goal

Make skills-mcp the owner of the operator's skills corpus: curated upstream
skill sets (obra/superpowers, mattpocock/skills) vendor into the operator's
skills directory — the one surface skills-mcp and the hub's pedagogy gating
both read (`SKILLS_MCP_DIR`, default `~/.agents/skills`) — replacing the
handcrafted corpus, with a deliberate update path and fail-closed ownership.

The delivery side is already live: the lead-agent runtime mounts skills-mcp
as the single delivery path (3ac0f73) and the contained delivery is proven
end-to-end (6379d7b). This plan covers the acquisition side: where directory
content comes from, who may write it, and how it updates.

## Decisions

- **Repo-owned vendoring tool over the `skills.sh` CLI.** The Vercel `skills`
  CLI installs per-agent paths and symlinks by default (two properties this
  system does not want — see the symlink decision below), reports telemetry
  (opt-out env), and offers no prune/archive/provenance lifecycle. There is
  no npm package of either upstream repo; the npm package named `superpowers`
  is an unrelated 2019 stub and must not be installed. `scripts/vendor-skills.mjs`
  shallow-clones the two sources (ambient git credentials apply), copies
  skills flattened, and records provenance.
- **Curation.** obra/superpowers is flat (`skills/<name>`), taken whole.
  mattpocock/skills is category-nested; `engineering/` and `productivity/`
  are curated in; `deprecated/`, `in-progress/`, and `misc/` stay out. Name
  audit 2026-09-16: the two selections do not collide. Semantic overlap
  (tdd vs test-driven-development, diagnosing-bugs vs systematic-debugging,
  code-review vs requesting-code-review, grilling vs brainstorming) is
  accepted at the availability layer and resolved per pedagogical mode by
  `levels.json` gating, not by hard curation.
- **Ownership and collisions.** The vendor script is the only writer of the
  directories it imports; `vendor-skills.json` (inside the skills directory,
  scanner-invisible like `levels.json`) records what it owns. An existing
  directory with a selected name that provenance does not own is never
  overwritten — the import refuses. `--archive` moves pre-existing
  skill-shaped unowned directories into `.archive/<timestamp>/` (a dot
  directory the scanner's name pattern rejects) so a vendored corpus can
  replace a handcrafted one without deleting anything.
- **Update policy.** Updates are deliberate operator re-runs, never
  scheduled. skills-mcp keeps no cache — `list_skills` rescans on every call
  and `read_skill` re-screens content at every delivery ("the file may have
  changed since discovery") — so upstream drift lands live and screened;
  that is the designed compensating control. Prune (removing owned skills
  that left the selection) refuses to run when any source failed: pruning on
  a partial selection view would delete live skills.
- **Symlinked skill directories are skipped by discovery, pinned by test.**
  The runtime binds the skills directory into containment by realpath; a
  symlink pointing outside the bound set dangles inside the boundary, and a
  listed-but-undeliverable skill is a delivery lie. Discovery fails closed
  (`scanSkills` keeps directory entries only). This makes symlink-based
  installers invisible by design — copy skills in; the vendor script always
  copies.
- **Migration of the handcrafted corpus.** The operator's existing
  `~/.agents/skills` set (31 skills) is replaced by: `--list` dry run, then
  `--archive` + import, then verification (`list_skills` count and the gated
  delivery probe), then archive removal at the operator's discretion. Live
  opencode sessions load that directory natively, so the migration runs at
  a quiet moment, not mid-session. Skills not mounted through skills-mcp
  (sessions outside the hub runtime) have no skills after the swap — that
  is F1's single-delivery-path intent, applied to the corpus too.

## Contracts

- `scripts/vendor-skills.mjs` exports `resolveSkillsDir` (same default-dir
  semantics as the skills-mcp server and the pedagogy gating resolver),
  `listSkillCandidates`, `loadProvenance` (malformed provenance throws —
  fail closed), and `importSkills` (returns an honest report; `dryRun`
  writes nothing). CLI: `--dir`, `--sources`, `--list`, `--prune`,
  `--archive`. Exit code 1 when anything was refused, skipped, or failed.
- A candidate skill directory must contain `SKILL.md` with a frontmatter
  `description`; the directory name is the skill name (identity matches the
  scanner's). Description-less candidates are reported as skips — they would
  be invisible to `list_skills`.
- Tests: `test/vendor-skills.test.ts` covers flattening, updates, collision
  refusal, archive, prune (including the partial-view refusal), duplicate
  refusal, malformed provenance, and the CLI dry run, all against local
  fixture sources (no network). The symlink skip is pinned in
  `mcp-toolbox/apps/skills-mcp/test/skills.test.ts`.

## Follow-ups

- Operator runs the live migration on `~/.agents/skills` (archiving the
  handcrafted 31) once this lands and the delivery path is mounted — the
  live skills count assertion in the delivery probe re-verifies the swap.
- `levels.json` per-mode gating over the vendored corpus is operator
  configuration, not part of this tool.