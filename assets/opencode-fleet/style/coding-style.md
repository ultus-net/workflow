# Coding Style: fleet-wide defaults

> The style floor for fleet agents that write or review code (`executor`,
> `reviewer`). Language-agnostic by design: every rule here is checkable
> by reading a diff, so it survives routing to cheap models.

## Precedence (who wins)

1. **The file being edited**: match its style, density, naming, and
   import order. Consistency with surrounding code outranks every general
   rule, including everything below.
2. **The target repo's rules**: its `AGENTS.md` and lint/format config.
   Run the repo's formatter. Never fight a configured linter.
3. **This file**: fills gaps only. A repo rule that conflicts with one
   of these silently replaces it. Do not report the conflict.

## Rules

1. **Smallest viable diff.** Only lines the change requires. No drive-by
   fixes, no reformatting of untouched lines, no editor churn. Refactors
   and reformatting ship as their own PRs, never mixed with features.
2. **Prefer deletion.** Code orphaned by a change is deleted in the same
   PR. Git remembers. The codebase does not need the tombstone.
3. **Simplicity first (KISS).** Simple, readable code beats clever or
   over-engineered code. Reuse existing modules and libs instead of
   duplicating their logic, but three similar lines still beat a
   premature helper: extract on the third use, not the first.
4. **Match the file's density.** No banner comments, no section dividers,
   no comments that restate the next line. Comment only the *why* that is
   not visible in the code, and keep comments short.
5. **Errors fail loud.** Typed or explicit errors, never bare strings.
   Never swallow them, and never log-and-continue. One log per failure,
   at the boundary that owns it.
6. **Naming follows the file.** The module's existing conventions first,
   then the repo's, then the language's standard. Renames are their own
   subtask, never mixed into behavior changes.
7. **Formatter and imports.** Run the repo's formatter and import
   ordering when configured. When none exists, follow the file's current
   order exactly.
8. **No orphan TODOs.** A `// TODO` cites an id in the repo's tracking
   (`todo.md` or issues) or it does not survive the PR.
9. **Verification gate.** The repo's lint + typecheck + test commands
   must pass, observed not assumed, before claiming done. Never loosen a
   test or weaken an assertion to get there. Failures are data.

10. **Comments read as instructions.** When a comment tells a reader
    what to do, write one instruction per sentence, 20 words or fewer,
    in the active voice. Do not drop the subject or verb to shorten it.
    A comment terse by hiding its actor is ambiguity, not brevity.

> Aspiration, not a finding: keep modules small, single-purpose, and
> reusable as the code grows. This guides how *new* code is shaped. It is
> never a reason to restructure untouched code (rule 1).

## Reviewer additions

For `reviewer`, treat violations of rules 1-8, and of the repo's own
documented conventions, as findings:

- Reformatting churn, scope creep, or "improvements" mixed into a
  functional diff is a **blocker**: it hides what actually changed.
- Any violation of the repo's configured linter is a **blocker**.
- Weakened tests or assertions (rule 9) are a blocker under the honesty
  check. Other style violations are warnings.

## Wiring

- Deployed path: `~/.config/opencode/style/coding-style.md`. The source is
  `install/opencode/style/`; the live entry is a symlink into it, so editing
  the golden tree is the deploy.
- **Auto-injected, not read on request.** `install/opencode/config.jsonc`
  lists this file in `instructions`, so OpenCode loads it into the system
  prompt for every session and every agent. The former "read this file before
  editing" bullets in `executor`/`reviewer` were removed because a read the
  agent can skip is a weaker guarantee than injected context. The
  `external_directory` grant in both agents' frontmatter is retained so an
  explicit read still works, but loading no longer depends on it.
- `executor` follows the floor before editing. `reviewer` enforces it while
  judging. Both treat the target repo's rules as senior (Precedence).
- The prompts referencing this file live in `install/opencode/agents/executor.md`
  and `install/opencode/agents/reviewer.md` (the golden tree, which the live
  `~/.config/opencode/agents/` path symlinks to).
- OpenCode only scans `{agent,agents}/**/*.md` as agents, so a non-agent
  doc under `style/` is safe: it will never be loaded as a role.

## Maintenance

These rules are load-bearing wiring, not aspiration. A change here
changes `executor` and `reviewer` behavior in every repo at once. Edit
deliberately, and keep this file the single source of truth. Never copy
the rules into agent prompts or per-project docs, link or load instead.
