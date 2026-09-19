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

## Provenance stamps (W054)

Every record carries a provenance stamp (writer identity, authority, origin
surface, timestamp). The stamp is launch configuration, not a tool argument:
the hosting surface sets `PROJECT_MEMORY_WRITER`,
`PROJECT_MEMORY_WRITER_AUTHORITY` (`operator` | `agent` | `external-evidence`),
and `PROJECT_MEMORY_ORIGIN_SURFACE` in the server environment. Without a valid
stamp, `record_memory` fails loudly and a store holding unstamped records fails
closed. This lets a reload-time attestation pass distinguish writes made
through a trusted surface from bytes injected directly into the store; it does
not make stored assertions true.

## Development

Requires Node.js 22+.

```sh
pnpm run verify
```
