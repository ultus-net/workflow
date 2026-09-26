<!-- Ledger fragment: extracted from TASKS.md at line 1299 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W075 - Launcher engine axis: `workflow web --agent <kind>`

**Objective:** Let the operator choose the ACP agent kind (opencode / goose / cline) at launch —
`workflow web --agent goose` — resolved through `WORKFLOW_ACP_AGENT`, with the panel's agent
switcher and posture labels driven by `listWebAgents()` (`src/ui/web-agents.ts`). One selector
implementation covers all surfaces; per-kind probe verdicts in `docs/HOST_ADAPTERS.md` decide what
each surface may claim.

**Depends on:** the committed selector (`13269a9`); connector catalog (`c221908`); model routing
(`91ab09f`).

**Acceptance criteria:**
- [x] `workflow web --agent <kind>` accepts `opencode`, `goose`, `cline`; invalid kinds fail closed
      with the valid list in the error. (`parseAgentFlag`, pinned in `test/workflow-launcher.test.ts`.)
- [x] Explicit `--agent` overrides `WORKFLOW_ACP_AGENT`; absence leaves the env default untouched.
      (`resolveAgentKind` precedence pinned; the launcher writes the same env the runtime reads, so
      every surface honors one axis. An invalid env value stays `acpAgentKind`'s fail-closed problem.)
- [x] The webapp surfaces the resolved engine kind and its containment posture (from
      `listWebAgents()`) honestly — unprobed kinds show their probe-PENDING status, not a green check.
      (Pre-existing and pinned: status-bar containment title, agent switcher, settings AgentSection,
      `/api/agents` with availability `reason`; goose/cline render `contained`, opencode `advisory`.)
- [x] Parsing lives in `src/cli/launcher-args.ts` with focused tests; `npm run typecheck`/`lint` clean;
      an independent five-axis review is recorded. (Parsing + tests + gates done 2026-09-20. Review
      round 1: REQUEST_CHANGES — three P2, three P3, no P0/P1; all six fixed in `d2c78cd` (honest
      launch-consumption copy, truthful save state + disclosed clear limitation, wired precedence,
      exact-value fact pins, `acpAgentKind` lockstep drift guard). Re-review 2026-09-20: **APPROVE**
      recorded, 35/35 focused.)

**Verification:** `node --import tsx --test test/workflow-launcher.test.ts` (10/10 after the
lockstep test; 35/35 across web-settings + webapp-surface + workflow-launcher), typecheck and lint
clean, five-axis review APPROVED (2026-09-20).
