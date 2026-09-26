<!-- Ledger fragment: extracted from TASKS.md at line 63 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W001 - Establish project/tooling foundation

**Objective:** Create the smallest TypeScript project structure needed to build, test, typecheck, and package host-neutral Workflow modules.

**Depends on:** None

**Acceptance criteria:**
- [ ] Repository has deterministic package/runtime configuration and standard ignore rules.
- [ ] Core, application, adapter, and UI boundaries can be represented without importing an SDK or UI framework into core.
- [ ] A minimal test proves the project can execute its test and typecheck commands.

**Verification:** Run the configured typecheck and test commands from a clean project install/runtime.
