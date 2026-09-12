# Project Memory MCP

Durable, bounded repository knowledge for coding agents across sessions and
harnesses on the same machine.

## Tools

- `record_memory` records an explicit fact, decision, constraint, or lesson with
  optional workspace-relative path associations and supersession.
- `search_memory` returns bounded current records matching an explicit query.

Records are workspace-scoped agent assertions, not deterministic proof. Ordinary
source edits do not invalidate them; explicit supersession does. The server stores a
local per-workspace index under `XDG_DATA_HOME/project-memory-mcp` (or
`~/.local/share/project-memory-mcp`) and does not automatically write memory into the
repository or inject it into prompts.

## Development

Requires Node.js 22+.

```sh
pnpm run verify
```
