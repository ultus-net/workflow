# Project Memory Contract

## P702 Scope

Project Memory preserves bounded repository knowledge across coding sessions and
harnesses on the same machine. The initial MCP supports only `record_memory` and
`search_memory` for explicit `fact`, `decision`, `constraint`, and `lesson`
records. It does not inject context automatically, discover tasks, record review or
verification evidence, synchronize remotely, or create a universal event store.

Memory kinds describe retrieval intent, not proof strength. P702 records are agent
assertions under the P701 evidence contract. Calling a record a `fact` does not turn
it into deterministic observation evidence.

## Project Identity And Storage

Every operation receives an absolute workspace root. The product canonicalizes the
existing directory with `realpath`; that canonical root is the initial workspace
subject and project identity. Symlink aliases to the same root therefore share
memory, while different canonical roots remain isolated even when repository names
or contents match.

The working index is local application data, not repository content. By default it
lives below `XDG_DATA_HOME/project-memory-mcp`, falling back to
`~/.local/share/project-memory-mcp`. `PROJECT_MEMORY_DATA_DIR` may override that root
as trusted process configuration for tests/deployment. The project filename is a
SHA-256 digest of the canonical workspace identity; caller input never becomes a
storage path.

Each project is stored as one bounded JSON document and replaced atomically through
a same-directory temporary file. P702 is single-server-process safe; cross-process
locking, hosted synchronization, retention/eviction, import/export, and conflict
resolution are deferred until dogfooding demonstrates their need. A malformed or
oversized store fails closed rather than being overwritten as though it were empty.

## Record Contract

`record_memory` accepts the canonicalizable workspace root, one memory kind, content,
zero to 20 associated workspace-relative paths, and an optional record ID to
supersede. Content is trimmed and limited to 4 KiB UTF-8. Paths are non-empty,
normalized relative paths with no absolute form, traversal, NUL/newline, or escape
through an existing symlink target. Associated paths are retrieval context only and
need not currently exist; for non-existing paths the nearest existing ancestor must
remain inside the canonical workspace.

The server generates an opaque UUID and creation timestamp. Provenance identifies
the record as an `assertion` originating from the Project Memory MCP record tool and
binds it to the canonical workspace subject. Host session IDs, Git commits, user
identity, and machine paths beyond the project identity are not persisted because
P702 does not need them.

Supersession is explicit and atomic. The target must be a current record in the same
project and cannot equal the new generated ID. Recording the replacement marks that
target `superseded`; search excludes superseded records. A missing/already-superseded
or cross-project target is an error. Historical records remain stored so provenance
is not rewritten or deleted.

Workspace-scoped memory is `fresh` while it remains current because ordinary source
edits do not invalidate durable repository knowledge. `superseded` records are
stale for current retrieval. P702 intentionally does not infer worktree-sensitive
freshness; P704/P705 add stronger subject semantics for review/verification evidence.

## Search Contract

`search_memory` accepts a non-empty query of at most 500 characters and a positive
limit defaulting to 8 and capped at 20. Search tokenizes Unicode letters/numbers plus
`_`/`-`, uses at most 12 query terms, and returns current records containing any term
case-insensitively in content, kind, or associated paths. Results rank by number of
distinct matching terms, then newest creation time, then record ID for deterministic
ties. Empty-token queries return an empty result.

Search returns compact records with ID, kind, bounded content, paths, creation time,
assertion provenance, workspace freshness, and optional `supersedes`. `truncated` is
true only after an additional permitted match is observed. There is no endpoint to
dump all project memories in P702; retrieval requires an explicit query.

## Bounds, Privacy, And Failure

The store permits at most 1000 records and 5 MiB serialized data per project. Hitting
the record bound rejects new writes; exceeding the byte ceiling before a trustworthy
document can be parsed is an error. These are safety limits rather than retention:
P702 never silently evicts current knowledge.

Content and path strings are untrusted context. They never become commands,
filesystem reads, URLs to follow, or policy authority. Before persistence, content
and path strings are checked for common high-confidence credential forms including
private-key blocks, GitHub tokens, OpenAI-style API keys, AWS access-key IDs, and
credential-bearing URL syntax. Matches are rejected with a generic error that does
not echo the secret. This detection is defense in depth, not proof arbitrary text is
secret-free; callers remain responsible for not submitting secrets.

Malformed input is rejected at the MCP schema boundary. Invalid/non-directory
workspaces, path confinement failures, secret-like content, invalid supersession,
malformed/oversized storage, persistence failures, and cancellation are domain/tool
errors. Potentially long filesystem operations observe caller cancellation between
bounded operations. Failed writes leave the previous complete store authoritative.

## Deterministic Verification

P702 tests use temporary workspace and data roots. Domain coverage must prove durable
record/search across store instances, all four kinds, deterministic ranking and
evidence-based truncation, explicit supersession, workspace and symlink-alias
identity, cross-project isolation, associated-path confinement, malformed/oversized
store failure, secret rejection without secret echo, cancellation, and record/store
bounds. Compiled stdio tests cover tool discovery, schemas, structured results, and
invalid input. A packed-artifact test installs and launches the published package in
an isolated npm consumer and performs real record/search calls without another
toolbox product dependency.

## Deliberately Deferred

P702 does not approve automatic prompt/compaction injection, Git freshness inference,
review or verification evidence, follow-up debt, project task discovery, repository
export/import, remote synchronization, cross-machine project identity, multi-process
write coordination, retention/eviction, encryption-at-rest claims, or host-specific
orchestration/enforcement.
