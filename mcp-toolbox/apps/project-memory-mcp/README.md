# Project Memory MCP

Durable, bounded repository knowledge for coding agents across sessions and
harnesses on the same machine.

## Tools

- `record_memory` records an explicit fact, decision, constraint, or lesson with
  optional workspace-relative path associations and supersession.
- `search_memory` returns bounded current records matching an explicit query.
- `export_memory` promotes current records (all, or the selected `ids`) to the
  repo-local, human-readable `.opencode/memory/project-memory.jsonl` file so
  durable knowledge can be committed and shared with the team.
- `import_memory` pulls that same `.opencode/memory/project-memory.jsonl` file
  into the local index: records already present (by id) are skipped, so
  re-importing is idempotent. This round-trips the upstream guard plugin's
  `project_memory_export` / `project_memory_import` tools.

Records are workspace-scoped agent assertions, not deterministic proof. Ordinary
source edits do not invalidate them; explicit supersession does. The server stores a
local per-workspace index under `XDG_DATA_HOME/project-memory-mcp` (or
`~/.local/share/project-memory-mcp`) and does not automatically write memory into the
repository or inject it into prompts.

## Bounds and retention

Storage is bounded on four axes, two of them pre-existing and two added here:

- a per-store record cap (1000) and a per-store byte cap (5 MB) — pre-existing;
- an age-based **retention window** for records that are no longer current —
  added here, so durable storage does not balloon with superseded history.

Retention applies to **superseded** records only: a superseded record is pruned
once it is older than the window, while *current* records are never age-pruned
(a record leaves the store only by explicit supersession). The window defaults
to **90 days** and is overridable with the `PROJECT_MEMORY_RETENTION_DAYS`
environment variable (a positive integer number of days). Zero, negative, or
malformed values fall back to the default — retention always has a floor and is
never disabled. Pruning runs on read and on every mutation, so a store that is
only ever read is still bounded.

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
