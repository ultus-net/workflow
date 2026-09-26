<!-- Ledger fragment: extracted from TASKS.md at line 634 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W036 - ACP surface decision inputs

**Objective:** Convert spike evidence into a clean Workflow terminal surface decision without prematurely committing to patched Cline.

**Depends on:** W035

**Acceptance criteria:**
- [x] Research documents what the hub session stream can and cannot project reliably. (`docs/ACP_SURFACE.md` §1–2, grounded in Cline 3.0.61 `session-updates.ts`: projections incl. message/reasoning/tool/mode/config; explicit non-projections incl. usage, error, iteration, plan content, commands.)
- [x] A clean Workflow terminal surface evaluation identifies daily-driver parity requirements and gaps. (`docs/ACP_SURFACE.md` §3, gaps G1–G6.)
- [x] Patched Cline Ink remains explicitly classified as fallback/migration surface unless spike evidence shows the clean surface cannot yet satisfy a material requirement. (`docs/ACP_SURFACE.md` §4: fallback unless G1 token economy or G2 commands/mentions are judged material.)

**Verification:** updated research/decision documentation plus independent five-axis review.

Current 2026-09-14 status: **decision recorded — GO** (`docs/ACP_DECISION.md`). The operator judged G1 (token/cost visibility) deferrable and G2 (commands/mentions) satisfied by ACP `configOptions` model/settings switching. The clean Workflow surface over stock-ACP Cline with whole-agent Bubblewrap containment is the lead path; patched Cline Ink is the fallback/migration surface. **G4 resolved:** the gated resume probe proves `session/load` replays faithfully after a full agent restart and continuation works. **G1 mitigated:** the hub metering proxy (`src/integrations/model-usage-proxy.ts`, `meteredProviderSettings`) holds the provider key proxy-side, forces usage accounting, and recorded real turn metrics (2 requests / 8,668 tokens / $0.0132 on the post-P1-fix re-run; originally 8,790 tokens / $0.0140) with a placeholder-only sandbox env; the clean surface CLI now routes all model traffic through the proxy (placeholder-only contained env) and prints metrics at exit — remaining G1 work is budget enforcement. **Post-decision phase in progress 2026-09-14:** session lifecycle is wired into hub `authorize` by `AcpSessionDriver` (`src/integrations/acp-session.ts` — per-request permission resolution through `createWorkflowAcpPermissionResolver` → `WorkflowApplication.authorize` with fail-closed title classification), the default spawn path is whole-agent containment via `AcpSessionDriver.contained` → `launchContainedAcpAgent`, and the clean surface UI composes the host-neutral `WorkflowCodingSession` over the ACP projection (`src/cli/acp-tui.tsx`, `npm run tui:acp`; `WORKFLOW_ACP_RESUME=<sessionId>` resumes). Remaining follow-ups tracked in the decision record (G5 error surfacing, G7 context/compaction, per-prompt task decomposition).

## Phase 9: Universal Surfaces
