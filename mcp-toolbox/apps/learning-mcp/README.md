# Learning MCP

Adaptive pedagogy engine for coding agents over MCP: evidence-based learner
profile, monotonic stage progression, per-mode intervention budgeting, and
Socratic checkpoints, consumable from any agent harness.

## Tools

- `learning_checkpoint` consults the engine before interrupting the learner.
  Autonomous mode never interrupts; socratic-tutor enforces the session
  intervention budget (default 3, configurable per call); mastered
  (`independent`) concepts are suppressed unless marked `needs-reinforcement`;
  concepts whose §4.1-graph prerequisites need reinforcement are suppressed.
  Interrupting records `exposed` evidence in the profile.
- `record_learning_evidence` applies monotonic stage updates
  (`exposed → developing → demonstrated → independent → critique`);
  `needs-reinforcement` flags a concept without regressing its stage.
- `decision_checkpoint` records a co-architect decision brief in a session
  ledger; the brief always requires human approval.
- `resolve_decision_checkpoint` approves or rejects a pending brief; unknown
  brief ids are a tool error.
- `learner_profile` (read-only, idempotent) returns all tracked concepts with
  their current stages.

The profile persists across sessions in a versioned, locked JSON store with
atomic writes at `$XDG_DATA_HOME/workflow/learner-profile.json` (fallback
`~/.local/share/workflow/learner-profile.json`), overridable with
`LEARNING_MCP_DATA_DIR`. It is shared with the Workflow pedagogy engine by
format and path, not by code.

The profile is also exposed as the MCP resource `workflow://learner-profile`
(`application/json`) with `resources/subscribe` support: subscribers receive
`notifications/resources/updated` whenever `record_learning_evidence` or an
interrupting `learning_checkpoint` mutates the profile. Tool calls emit
leveled `notifications/message` log notifications (`{tool, phase, detail}`)
at debug/info around profile load, gate evaluation, evidence persistence, and
ledger operations, and `learning_checkpoint` emits `notifications/progress`
(phases `profile-loaded`, `gate-evaluated`, `evidence-recorded`) when the
request carries `_meta.progressToken`.

## Development

Requires Node.js 22+.

```sh
pnpm run verify
```
