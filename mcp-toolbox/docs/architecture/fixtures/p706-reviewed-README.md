# Project Context MCP

Read-only, bounded discovery of repository-owned task and planning context for coding agents. `discover_project_context` checks conventional sources in deterministic order (`TODO.md`, `ROADMAP.md`, `PLAN.md`, `TASKS.md`, `BACKLOG.md`, then sorted `docs/plans/*.md`) and returns bounded snippets with source references.

Repository text is returned explicitly as `untrusted_repository_content`. The server does not interpret instructions, select a next task, mutate repository files, or mutate a host's task list. Source symlinks cannot escape the canonical workspace. Snippets are capped at 4096 bytes, discovery returns at most 20 candidates, and oversized planning directories fail closed.
