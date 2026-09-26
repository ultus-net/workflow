<!-- Ledger fragment: extracted from TASKS.md at line 838 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W049 - Goose as the operator's general-purpose daily agent

**Objective:** Dogfood goose (contained, hub-composed) in the general-purpose/ops-plus-development workload on the universal surface, as the qualification plan's daily-driver criterion.

**Depends on:** W048

**Acceptance criteria:**
- [ ] A recorded dogfood matrix covers representative real work: repo edits, shell/ops tasks, MCP participation, resume across restart, and a denial case.
- [x] Material gaps versus the current opencode+plugin setup are recorded with severity/workaround; no critical gap is hidden by the result.
- [ ] Cost/usage visibility from W044/W045 is exercised in real sessions on both operator providers.

**Verification:** the dogfood record plus full gates on any code changes it produces.

**Status (2026-09-17, agent-run):** the dogfood matrix is recorded in `docs/GOOSE_DOGFOOD.md` — five cells (repo edit, shell/ops, MCP participation, resume across restart, denial case) plus the W044/W045 cost/visibility exercise, all through the real production runtime path (`createConfiguredAcpRuntime`, `WORKFLOW_ACP_AGENT=goose`, goose 1.50.1, openrouter via the metering proxy). The matrix forced two product fixes, both pinned by tests: unknown ACP mutation tools are now denied fail-closed instead of tearing down the session (goose's built-in `todo` tool was killing turns), and the goose config root is workspace-keyed persistent state so `session/load` finds the store across a full restart (the per-launch pid+uuid dir deleted on dispose made resume impossible on the runtime path). Gaps recorded, not hidden: MCP read-policy is an explicit operator decision (`skills-mcp__list_skills` denied by default authorization — goose adapted and reported honestly); assistant text arrives via the turn result and surfaces must read both channels; subagent-internal hook coverage still needs a granted-spawn session (W050 input). Criterion 2 is checked on that record; criteria 1 and 3 stay open on their operator arms — the agent-run sessions are smoke sessions on scratch workspaces, the azure arm pends `AZURE_FOUNDRY_*` credentials, and the operator's own daily-driver period remains the takeover gate (W050, Checkpoint D).
