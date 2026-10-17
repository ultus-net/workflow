# Agent Working Standards

> Operator standards for autonomous agents working in any repo I own. These are
> my workflow rules and coding standards: a bar agents must clear and a bar I
> hold my own work to. They are not a per-project template.
>
> This is the canonical copy, shipped in the dotfiles golden tree at
> `install/opencode/STANDARDS.md`. It is harness-portable: the intent is that
> the Workflow control plane loads it, and every harness points at this one
> file rather than forking it. Project-specific rules live in that repo's own
> `AGENTS.md` and the target repo's rules win on conflict.

## How this file is loaded (do not fork it)

- **OpenCode** auto-injects it via the golden config's `instructions` list, so
  every session and every subagent sees it with no read step to skip.
- **Other harnesses** reference it by a one-line pointer from their own global
  file, never a copy:

  | Harness | Global file | Line |
  |---|---|---|
  | Claude Code | `~/.claude/CLAUDE.md` | `Follow ~/.config/opencode/STANDARDS.md and ~/.config/opencode/style/coding-style.md.` |
  | Codex | `~/.codex/AGENTS.md` | same |
  | Gemini CLI | `~/.gemini/GEMINI.md` | same |
  | Cursor | `~/.cursor/rules/standards.mdc` | same |
  | Copilot | `.github/copilot-instructions.md` | point at the repo's `AGENTS.md`, which points here |

- **Per repo**: the repo's `AGENTS.md` references this file and adds only
  repo-specific rules. The repo wins on conflict. `AGENTS.md` is the
  cross-tool standard, so a repo that uses it reaches almost every harness.

---

## Git & Workflow Rules

- **Never push directly to `main`.** All changes go through short-lived branches and PRs.
- **Allowed branch prefixes:** `feature/*`, `fix/*`, `chore/*`, `docs/*`, `experiment/*`, `hotfix/*`, `refactor/*`. Enforced by CI.
- **Commit subjects use the same verbs:** `feat:`/`fix:`/`chore:`/`docs:`/`experiment:`/`hotfix:`/`refactor:` (e.g. `docs: evidence round — asset manifest`). One logical change per commit.
- Leave **Delete source branch** enabled when completing PRs (GitHub: also enable *Automatically delete head branches* under repo Settings > Pull Requests).
- **PR lifecycle: open vs closed.** While a PR is open, its branch and worktree stay put; merge the latest `origin/main` into a parked branch before opening and whenever it sits while other streams land. Once the PR completes (merged or abandoned), clean up in the same session: remove the worktree with `git worktree remove <path>` (only clean worktrees go without `--force`; never `rm -rf`, which strands the entry in `.git/worktrees` until `git worktree prune`), then `git fetch --prune` and `git branch -d <branch>` (`-D` only for a deliberately abandoned attempt; the PR page keeps the commits reachable).
- **Never remove a worktree the current session is sitting in.** Move the session to the main checkout first. When the harness (workflow guard) created the worktree, use its cleanup command so it commits a final snapshot before removal.
- **Session-start sweep.** `git fetch --prune`, then `git worktree list`: a worktree whose branch is gone from the remote is a closed-PR leftover. Remove it.
- **Update `CHANGELOG.md` and relevant `docs/` files for every change.** No exceptions.
- **Work tracking: a tasks file (`todo.md`, `TASKS.md`, …) is bootstrap-only.** Once the repo is established on GitHub or Azure DevOps, migrate every open task to a GitHub issue or Azure DevOps work item, delete the file, and track all subsequent work there.
- **Break work down into work items before starting, and link every PR to its item** (GitHub: `Fixes #<id>` in the PR description; Azure DevOps: `Fixes AB#<id>` in the PR/commits). Rationale: shared mutable files are the conflict hotspot for concurrent agent streams; forge work items are per-task and never conflict.
- **Completing a work item = close it in the same PR that lands the work + record it in `CHANGELOG.md`, in the same commit.** While the tasks file still exists, completing an entry = delete it there + record it in the changelog, same commit. No `[x]` tombstones, no batch cleanups. If it's tracked it's open; if it's done it's in the changelog. Stale entries are bugs.
- **Lessons are one file per lesson, never a shared log.** `/retro` and `/rsi-loop` write `docs/agents/lessons/<UTC-timestamp>-<slug>.md` (filename stem is the id). Never edit or delete an existing lesson file; supersede with a new file referencing the old id. Per-lesson files cannot merge-conflict, for the same reason work items replace the tasks file.
- **Process rules live in this file only.** If they change, update this file in the same commit. Do not create per-tool rules files (`.clinerules`, `.cursorrules`, …) — they drift.

---

## Teaching Feed

- Follow the machine-global teaching feed (`~/.config/opencode/AGENTS.md`):
  when work touches constructs likely new to the operator, label them inline
  in the response shape already required (`/* <- LABEL */` callouts, table
  rows, diagram nodes). Teaching adds rows and labels to evidence, never a
  separate lecture.
- Labels are stable per repo: one construct, one label. Recurring construct
  families get persisted via the `code-cheatsheet` skill and linked by path,
  never re-pasted. `/explain` forces a full breakdown; `/tldr` re-anchors a
  drifting session.

---

## Code Conventions & Architecture Rules

### 1. Environment Configuration

- **No naked `process.env` reads.** Route configuration through a single shared `config` module.

### 2. Layering

- Name the enforcer of any layering convention (lint/type config) so "the rules" are executable, not aspirational.

### 3. Language / Toolchain

- Pin the exact compiler and toolchain settings in the project config.

### 4. Database Access

- **All DB access goes through one shared pool.** No ad-hoc pools.

### 5. Shared Utilities First

- Check the shared modules before writing new helpers or copying logic.

### 6. Write Gates

- Every write path ships off-by-default and UAT-first.
- Correlate outbound calls with a request id (`x-correlation-id`).

### 7. Naming

- Identifiers use the domain glossary. A new domain term is added to the glossary in the same PR that introduces it.

### 8. Error Handling

- Fail closed. Throw typed errors, never bare strings.
- Log once at the boundary, with the correlation id. Never swallow.

### 9. Simplicity (anti-bloat)

- **Prefer deletion over addition** — code orphaned by a change is deleted in the same PR; git remembers.
- **No speculative abstractions** — three similar lines beat a premature helper; extract on the third use, not the first.
- **Smallest viable diff** — refactors ship as their own PRs, never mixed with features.
- **Match the file's existing density** — no banner comments, no comments that restate the next line, no section dividers.
- **No orphan TODOs** — every `// TODO` cites a tracked work item (`#<id>` GitHub, `AB#<id>` Azure DevOps) or doesn't survive the PR.

---

## Platform & Portability Principles

Prefer commodity substrates over opinionated products, and keep business logic in your own code.

### Service Selection

- **Use commodity primitives.** Storage, queues, relational databases, secrets, identity, telemetry. Managed is preferred for these. Do not hand-roll them.
- **Avoid opinionated products on load-bearing paths.** Workflow engines, managed connectors, and vendor-specific orchestration platforms get renamed and retired on the vendor's schedule. New work does not adopt one. An existing system that uses one is grandfathered, and migrates only on a load-bearing failure or a vendor-forced change.
- **Keep logic in your own code.** Business logic belongs in the repository as code, not in a vendor workflow or a connector config. Code is portable; a workflow product is not.
- Serverless compute is acceptable and preferred where it fits. Do not self-host compute, databases, or queues merely to avoid a managed service.

### Portability & Data Boundaries

- Consume data through a contract you own (a versioned schema, an open format, an API you control), never by binding application code to the mechanism that produces it.
- Treat any contract another system owns as versioned and subject to drift: it can move on the owner's schedule. Isolate reads behind one thin access module so a forced re-point or schema change touches one place.
- Prefer open formats (for example Parquet/Delta, OTLP, OpenAPI) over proprietary ones for anything crossing a system boundary. Open formats outlive the mechanism that wrote them.
- When a format or schema has more than one consumer, treat it as a shared contract. A change must update every consumer.

### Ingestion & File-Based Integration

- Any new file- or folder-oriented ingestion mechanism must enumerate a bounded set. Never walk an unbounded or growing tree.
- It must have an explicit completion contract: a manifest or marker file, never lock files.
- It must be restart-safe and idempotent when reprocessed.
- It must enforce timeouts with per-unit observability.
- Unbounded enumeration and never-finalising locks cause silent outages. Decoupling alone does not prevent re-selecting that failure mode.

### Language, Hosting & Dependencies

- Keep one standard language and hosting model per project. Do not introduce a second one into an existing working project unless a load-bearing failure or a separately documented decision requires it.
- A rewrite requires the same test. "New work touched this area" is not, by itself, a trigger.
- Pin dependency versions centrally. Version bumps are deliberate, reviewed changes, never incidental.
- Build and tests are the verification of API correctness. Do not rely on recall of framework APIs.

---

## Boundaries

- Never commit secrets, `.env`, or credentials.
- Never add a dependency without a one-line justification in the PR description — prefer stdlib and existing deps.
- Never disable a lint/type rule without a comment citing a tracked work item (`#<id>` GitHub, `AB#<id>` Azure DevOps).
- Ask before changing wire types or DB schema — downstreams break silently.
- Ask before any destructive or irreversible operation (drops, deletes, force-push, prod flags).

---

## Testing

- **Verification gate:** lint and the test suite must pass with zero errors before any task is marked complete.
- New behavior ships with tests that fail without it. Replay-safety and idempotence assertions are required wherever a retry can re-run the work.
- Every new externally-triggered entry point gets a smoke test (happy path + edge case + key output fields) before PR merge.

---

## Agent Decision Checklist

Before finishing any change:

1. Run tests.
2. Run lint.
3. Run typecheck (if the project has one).
4. **Fresh-eyes test:** would this diff make sense to a reviewer with zero
   conversation history, reading only `AGENTS.md` + the diff?
5. Update `CHANGELOG.md` and relevant `docs/` files.
6. If touching infrastructure, ensure secrets use vault references.
7. If adding a write path, ensure the off-by-default gate is respected.
8. Open a PR to `main`; do not push directly.
9. If a PR completed during this session (merged or abandoned), run the branch/worktree cleanup from Git & Workflow Rules.
