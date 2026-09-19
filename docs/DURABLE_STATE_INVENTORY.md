# Durable-State Inventory (W054)

Dated 2026-09-19. Scope: persistent state that can reach model context in a
Workflow session, classified by writer authority, with the provenance stamp
and startup-attestation coverage that exists as of this change. This is a
living inventory — update it when a surface adds or moves a durable store.

Research basis: `docs/AI_LANDSCAPE_RESEARCH.md` §3.1 ("persistent memory
poisoning") and §6.4; plan item W054 in
`docs/superpowers/plans/2026-09-19-ai-landscape-followups.md`.

## Writer authorities

- **operator** — a human, or a file a human placed/approved. Trusted to author
  policy, but still not truth.
- **agent** — the coding agent, or a bridge acting on the agent's behalf. This
  is the injection-bearing class: an injection that reaches agent output can
  be laundered into durable state.
- **external-evidence** — observations produced by the environment, tools, or
  deterministic collectors. Evidence authority, still not truth.

## Inventory

| Surface | Store / location | Writer authority | Reaches model context | Stamp (W054) | Startup attestation today |
| --- | --- | --- | --- | --- | --- |
| Project memory records | `${PROJECT_MEMORY_DATA_DIR:-$XDG_DATA_HOME/project-memory-mcp:-~/.local/share/project-memory-mcp}/<sha256(realpath(workspace))>.json`, mode 0600 | agent (via `record_memory` and the compaction bridge) | **Yes** — recalled at session start and injected into the system prompt by the vendored-Cline runtime (`src/integrations/cline-runtime.ts`) | **Yes** — required `provenance` stamp: writer, authority, originSurface, stampedAt; unstamped writes fail loudly, unstamped stores fail closed (`mcp-toolbox/apps/project-memory-mcp`) | **Yes** — `attestProjectMemory` before first turn; flagged recall is suppressed and reported (`src/integrations/durable-state-attestation.ts`) |
| Continuity checkpoints | none — `recover_continuity` is read-only and does not persist state (`mcp-toolbox/apps/continuity-checkpoint-mcp`) | external-evidence (derived from review/verification/context/memory sources) | **Yes, when invoked** — composes review, verification, project-context, and project-memory envelopes | N/A (no own store); carries the provenance of consumed sources | Consumes already-stamped project memory; the composed output is not itself stamped |
| Skills | `SKILLS_MCP_DIR` (default `~/.agents/skills`), served by `skills-mcp`; `levels.json` for pedagogy gating | operator / external (installed skill packages) | **Yes** — skill names, descriptions, and instructions are surfaced to the agent through the skills mount and prompt guidance | No | Generic engine available; a skills collector is a follow-up |
| Scheduled-agent state | `${WORKFLOW_HUB_SCHEDULES:-~/.workflow/scheduler.json}`, mode 0600; schedule `prompt` text is composed into scheduled turns | operator (table written by the hub/operator, not the agent) | **Yes, at fire time** — the scheduled prompt and advisory guidance become the turn prompt | No (plain schedule table) | Only project memory is attested today; a schedules collector is a follow-up |
| Review provenance journal | `${WORKFLOW_HUB_PROVENANCE:-~/.workflow/review-provenance.jsonl}`, mode 0600 | operator/hub (`src/integrations/review-provenance-store.ts`) | Indirect — reviewer sessions read it as evidence; it does not inject into ordinary agent turns | Fingerprinted records (W041), not W054 stamps | Not attested by the W054 pass (separate W041 provenance discipline) |
| ACP agent session storage | `~/.workflow/acp-home/**` and each host agent's own session store under the scratch home | agent / host SDK | **Yes on resume** — replayed history becomes context when a session resumes | No | Follow-up; host-owned format |
| Hub task graph / tasklist projection | In-memory per hub/TUI/web process; a `JsonWorkflowStore` exists (`src/application/persistence.ts`) but is not composed in current surfaces | operator (canonical transitions); agent proposals are advisory only | **Yes** — active task titles and the advisory plan projection are shown to the agent | N/A (no durable file in current composition) | Not applicable until task state is persisted |
| Agent-facing rule files | `AGENTS.md`, `THREAT_MODEL.md`, project docs read at startup | operator | **Yes** — operator material surfaced to the agent | No | Repo content, outside the W054 store scope |
| Credential configuration | `~/.workflow/credentials.json`; values live only in the OS secret service | operator | **No** — opaque `secret://<id>` references, never values | N/A | Out of scope (not model-visible) |

## Provenance stamp contract (project memory)

Each stored record carries `provenance`:

```json
{
  "origin": "project-memory-mcp/record_memory",
  "writer": "<launch identity>",
  "authority": "operator | agent | external-evidence",
  "originSurface": "<launch surface id>",
  "stampedAt": 1700000000000
}
```

The stamp is **server launch configuration** (`PROJECT_MEMORY_WRITER`,
`PROJECT_MEMORY_WRITER_AUTHORITY`, `PROJECT_MEMORY_ORIGIN_SURFACE`), never a
tool argument, so an agent cannot relabel a write in-band. A record with no
valid stamp fails the write loudly; a store holding an unstamped or forged
record fails closed on load. The Workflow-side compaction bridge stamps as
`writer=workflow-compaction-bridge`, `authority=agent`,
`originSurface=workflow:cline-runtime`.

## Startup attestation (W054)

`attestProjectMemory` (called before the first model turn in the vendored-Cline
runtime) reads the project-memory store tolerantly and flags, deterministically:

- `missing-stamp` — no valid writer/authority/originSurface/stampedAt;
- `unexpected-writer` — writer not in the surface's trusted set;
- `untrusted-origin` — origin surface not in the trusted set;
- `canary-hit` — content matches a known canary string;
- `unreadable-store` — malformed/unreadable store (never silently skipped).

Findings are reported to the operator (stderr) and suppress project-memory
recall for that session. This is **advisory observability, not enforcement**:
it does not gate tool calls, mutate state, or validate that an assertion is
true. The same admission principle as evidence applies — structure and
provenance are checked, truth is not.

## Canary mechanism

A stable canary (`DEFAULT_DURABLE_STATE_CANARY`) plus operator-supplied
strings (`WORKFLOW_DURABLE_STATE_CANARIES`, comma-separated) are matched
against record id and content. The canary is for investigation surfaces and
tests: seed it where agent-read content would be, and a reappearance in any
attested store is detectable end-to-end. The report never echoes canary
values. Demonstrated by `test/durable-state-attestation.test.ts`.

## Coverage gaps / follow-ups

- Collectors for skills, scheduled-agent state, ACP session history, and task
  artifacts are not implemented; the rule engine accepts normalized records
  for any surface, so each is a bounded collector plus policy entry.
- Attestation is wired only at the vendored-Cline memory-injection boundary.
  Hub/ACP surfaces that inject memory should call the same pass before their
  first turn; wire it where each surface assembles its startup context.
- A local user with store access can strip or forge stamps; W054 raises the
  cost and observability of in-band poisoning, it does not create an OS
  boundary. See `THREAT_MODEL.md`.