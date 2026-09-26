<!-- Ledger fragment: extracted from TASKS.md at line 893 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W063 - Containment refinements

**Status (2026-09-19, implemented + reviewed [APPROVE]):** resolve-before-validate symlink ordering pinned by tests (non-exploitable audit recorded honestly; W025 fix acknowledged); type-level `read-write-no-delete` mount mode (bwrap ro-bind + per-file binds; delete AND creation blocked — limitation documented; platform passthrough refuses the mode); custom-component audit `docs/CUSTOM_COMPONENT_AUDIT.md` (P2/P3 findings GA-1/GA-2/MX-2/MX-3/MX-4/CB-1/CT-1/CT-3 recorded); OTLP pull-based export deferred with design note. Also repaired a stale `web-sessions` citation in `test/security-assurance.test.ts` left by the main rewrite.
