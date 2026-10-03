# workflow-task-mcp (W072)

The canonical Workflow **step ledger** over MCP: define, list, start, complete,
and cancel evidence-bound task steps. It is the host-agnostic retirement target
for the native todo bridge (`docs/TASK_TODO_LEDGER_PARITY.md` §4, Stage 3).

**The ledger is authoritative, the host is not.** A host's local todo list is a
view; the canonical step ledger (roadmap → tasks → steps, I-1…I-10) is the
authority on what should happen and what actually happened. This server drives
the hub's ordinary-token `/steps/*` routes; it never fabricates a transition.

**Enforced, not advisory.** `/steps/complete` re-queries the real file
fingerprint on the hub side (I-9 state-diff gate) before the kernel admits a
completion. A step whose declared evidence is missing or stale, or whose claimed
change did not actually re-appear, is refused with the kernel's own code. The
server surfaces that refusal verbatim — it never rewrites it to a success.

## Tools

- `step_list` — the task's ordered step ledger. Read-only.
- `step_define` — define/replace the ordered ledger. Every step declares its
  done-condition (`requiredEvidence`, and optionally `requiredPostcondition`);
  the kernel enforces I-2 (no silent deletion of an active step) and rejects a
  malformed proposal without touching the prior ledger.
- `step_start` — start the single active step (I-8: at most one IN_PROGRESS).
- `step_complete` — complete a step after the hub's real re-query.
- `step_cancel` — cancel a step; the entry is preserved, never deleted.

Every transition result is the kernel's own `StepTransitionResult`: `accepted`,
or `rejected` with a stable code surfaced as a tool error.

## Configuration

The hub endpoint + ordinary token are read from the hub's published discovery
file (`WORKFLOW_HUB_DIR` or `~/.workflow`, file `hub/discovery.json`), re-read on
every call so a hub restart is picked up. The token is never passed on argv.
`WORKFLOW_HUB_URL` / `WORKFLOW_HUB_TOKEN` override the discovery read (used by
tests, or by a caller that already holds the credentials).

## Trust boundaries

- **The hub is the authority.** This server holds no state; it is a typed client
  over loopback HTTP. A refusal is the hub/kernel's decision.
- **No evidence is minted here.** The tool cannot satisfy an evidence
  requirement, only report that the hub refused.
- **Loopback + ordinary token.** The step routes are a workspace-scoped tracking
  surface (`src/integrations/hub-http.ts`), not an autonomous mutation loop.

## Development

Requires Node.js 22+.

```sh
pnpm run verify
```
