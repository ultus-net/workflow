<!-- Ledger fragment: extracted from TASKS.md at line 192 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W010 - Connect MCP Toolbox through the MCP boundary

**Objective:** Use existing portable MCP capabilities/evidence from Workflow without moving orchestration into MCP Toolbox.

**Depends on:** W006, W008

**Acceptance criteria:**
- [ ] Workflow can connect to configured MCP servers and expose their capabilities to the application layer.
- [ ] At least one read/evidence flow is demonstrated end to end.
- [ ] Disconnect, malformed response, and unavailable-server states are explicit and fail safely.

**Verification:** Integration tests against controlled MCP fixtures, followed by an optional local MCP Toolbox smoke test.

## Phase 3: Interactive UI
