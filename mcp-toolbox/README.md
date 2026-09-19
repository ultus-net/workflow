# MCP Toolbox

A monorepo of focused Model Context Protocol (MCP) tools for software-engineering
agents. Each product owns a bounded capability and remains independently
publishable.

## Tools

- `workflow-guard-mcp` - portable workflow policy and enforcement decisions.
- `code-intelligence-mcp` - TypeScript definitions, references, symbols, and diagnostics.
- `test-intelligence-mcp` - test discovery, relevance, and bounded execution.
- `git-intelligence-mcp` - read-only local Git status, diff, and history evidence.
- `change-intelligence-mcp` - composed local change and verification evidence.
- `ci-intelligence-mcp` - read-only bounded CI run and job evidence.
- `project-context-mcp` - bounded discovery of durable repository planning context.
- `project-memory-mcp` - durable typed project knowledge with bounded retrieval.
- `review-accountability-mcp` - subject-bound review attestations and follow-up debt.
- `verification-accountability-mcp` - authority-backed verification observations with bounded freshness assessment.
- `learning-mcp` - adaptive pedagogy engine (learner profile, stage progression, intervention budgeting, Socratic checkpoints).
- `continuity-checkpoint-mcp` - bounded read-only continuity recovery for coding agents.
- `egress-audit-mcp` - append-only bounded egress-reach ledger with anomaly flags (advisory evidence).

Several lifecycle-oriented tools advertise model-visible guidance about when they are
useful so different MCP clients can use them proactively without a custom harness.
That guidance does not grant extra authority: repository content and stored assertions
remain evidence with their documented trust boundaries, and Workflow Guard MCP policy
is advisory unless the host integrates an enforcement adapter.

Product documentation lives under `apps/<product>/README.md`. Architecture and
roadmap decisions live under `docs/architecture`, `PLAN.md`, and `ROADMAP.md`.

## Development

Requires Node.js 22+ and pnpm 11.5.2.

```sh
pnpm install
pnpm run verify
```
