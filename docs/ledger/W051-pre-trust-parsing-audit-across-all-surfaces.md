<!-- Ledger fragment: extracted from TASKS.md at line 881 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W051 - Pre-trust parsing audit across all surfaces

**Status (2026-09-19, implemented + reviewed [APPROVE]):** inventory in `docs/PRETRUST_PARSING_AUDIT.md` (dated; includes the levels.json startup-parse row; toolbox-discovery row marked removed-by-W050 with mcp-settings.ts); directory-canary ordering tests prove no reads of poisoned fixtures on covered helpers (`test/pretrust-parsing-audit.test.ts`, 3/3). **Residual (PARTIAL):** criterion 3 covers only the inventory-covered helper paths; universal/acp TUI startup, web-service, hub discovery/scheduler, skills-mcp process startup, ACP tool-call reads, and persistent state need a process-level harness or per-runtime probes.
