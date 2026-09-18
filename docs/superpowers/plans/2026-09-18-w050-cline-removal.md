# W050 execution plan — retire the vendored-Cline runtime

**Status:** draft plan, 2026-09-18. **Gate:** do not execute until W050
criterion 1 (backup-slot takeover) and criterion 2 (SDK-seam decision
signature, `docs/ACP_DECISION.md` "W050 SDK-seam decision — PROPOSED") have
resolved. This plan removes nothing by itself.

## Why a plan first

The W050 removal touches more than Cline files: two shared substrates are
physically entangled with the Cline modules and must be untangled *before*
deletion or the ACP surfaces break. This plan inventories the exact removal
set, the shared-substrate refactors, the reference updates, the archive
obligation, and the verification.

## Gate checklist

1. W050 criterion 1: the operator's W049 daily-driver period holds, so goose
   demonstrably covers the fallback/insurance role (TASKS.md W050).
2. W050 criterion 2: the SDK-seam accepted-risk is signed (closes the reason
   the seam was retained), or a live Cline-side subagent-internal proof lands
   and the seam is retained instead — in which case this plan is abandoned.
3. Operator direction to land a removal PR (repo rule: Cline removal is
   evidence-gated, never date-gated).

## A. Removal set — Cline-specific files

Delete:

- Host adapter: `src/adapters/cline.ts`.
- SDK integration: `src/integrations/cline-launch.ts`,
  `cline-plugin.ts`, `cline-runtime.ts`, `cline-session.ts`,
  `cline-shell-executor.ts`, `cline-tui-bridge.ts` (after step C1), and
  `src/cli/mcp-settings.ts` (verify orphaned — see C3).
- Build/patch: `scripts/build-cline-tui.mjs`, `scripts/bump-cline-tag.mjs`,
  `patches/cline-cli-v3.0.61-workflow.patch`.
- Vendored checkout: `.workflow-cline/` (untracked; remove the directory and
  the `.gitignore` / `.git/info/exclude` entries).
- Tests: `test/cline-adapter.test.ts`, `test/cline-launch.test.ts`,
  `test/cline-plugin.test.ts`, `test/cline-session.test.ts`,
  `test/cline-tui-bridge.test.ts`, `test/cline-probe-helpers.ts`, and the
  whole `test/acp-cline-*.test.ts` family (10 files:
  contained, mcp-mount, metadata, metered, mutation, probe, resume, shell,
  subagent, tool-matrix).
- Integration regressions: `test/integration/cline-coding-session.mjs`,
  `cline-plugin-fixture.mjs`, `cline-resume.mjs`, `cline-runtime.mjs`.

## B. Removal set — the Cline agent kind

Edit (not delete):

- `src/integrations/acp-runtime.ts` — drop `createClineRuntime`, the
  `"cline"` branch in `createConfiguredAcpRuntime`, the `resolveClineLaunch`
  import, and `"cline"` from the `AcpAgentKind` union and the error text.
- `src/cli/driver-registry.ts` — drop `"cline"` from `DRIVER_NAMES`, the
  cline composer, and the `createConfiguredClineRuntime` import.
- `src/ui/web-agents.ts` — drop the `"cline"` `WebAgentId`, its `listWebAgents`
  entry, `clineApiKeyPresent`, and `isWebAgentId` membership.
- `src/index.ts` — drop the four `cline-*` re-exports (lines 7, 8, 16, 17).
- `package.json` — remove scripts `tui:cline:build`, `build:cline-agent`,
  `cline:bump`, `test:cline-runtime`, `test:cline-coding-session`,
  `test:cline-resume`; replace `pretest` (currently the Cline build) with
  either removal or a non-Cline pretest.
- `scripts/install.mjs`, `scripts/prepare-tool.mjs` — remove the Cline build
  steps.
- `packaging/workflow-web.service` — remove the `ExecStartPre` Cline build.

## C. Shared substrates — untangle before deleting

These are load-bearing for the remaining ACP surfaces (OpenCode, goose); do
each **before** the corresponding removal above.

1. **Run-controller types live in `cline-tui-bridge.ts`.** General modules
   import `WorkflowRunController` / `WorkflowApplicationResolver` from it
   (`src/integrations/workflow-hub.ts:8-14`, `hub-scheduler.ts:4`,
   `run-registry.ts:8`, `hub-reviewer.ts:21`). Relocate these types (and any
   other non-Cline exports still consumed) to a neutral module
   (e.g. `src/integrations/run-controller.ts`) and re-point the consumers
   before deleting the bridge. Note `WorkflowClineTuiBridge`,
   `recordClineTeamTaskEnvironmentEvidence`, and `shellExecutorFor` are
   Cline-only and go with it.
2. **`CLINE_API_KEY` / `~/.config/workflow/cline-api-key` is the shared
   upstream metering key for *all* ACP runtimes** (`acp-runtime.ts:461,609`);
   goose availability even reports it (`web-agents.ts:39,103,110`). Do **not**
   delete it with Cline. Introduce a canonical name (e.g.
   `WORKFLOW_UPSTREAM_KEY` + `~/.config/workflow/upstream-key`) with
   back-compat reads of the old names, update the proxy/agent modules, and
   mark the old names deprecated in docs. This is a small feature, not a
   rename-in-place, because the key file is the operator's live credential.
3. **`~/.workflow/cline_mcp_settings.json` + `src/cli/mcp-settings.ts`.** The
   only non-test consumer was the retired `src/cli/tui.tsx`; verify with
   `rg "mcp-settings|cline_mcp_settings" src test` that nothing else imports
   it, then retire it (or repurpose to a shared MCP settings path if any
   surface still needs it). `test/toolbox-mcp-settings.test.ts` goes with it.
4. **Genericize Cline-named comments/constants in shared modules** —
   `src/adapters/acp-contained-agent.ts:20`, `src/integrations/model-usage-proxy.ts:35`,
   `src/containment/linux-bwrap.ts`, `src/cli/contained-shell.ts`, and the
   `hub*.ts` comments (e.g. `src/cli/hub.ts:83`).

## D. Reference updates (docs + configuration)

- **Living docs — rewrite:** `docs/FEATURES.md` (remove/supersede the Cline
  rows), `docs/TUI_INTEGRATION.md`, `docs/HUB.md`, `docs/HUB_PROTOCOL.md`,
  `README.md`, `AGENTS.md`, `docs/GUARD_CORPUS_MAP.md`,
  `docs/OPENCODE_QUALIFICATION.md`, `docs/UI_INTEGRATION.md`.
- **Append-only dated records — add supersession notes, never rewrite:**
  `docs/ACP_DECISION.md`, `docs/ACP_RESEARCH.md`, `docs/ACP_SURFACE.md`,
  `docs/HOST_ADAPTERS.md` (remove the Cline matrix rows with a dated note that
  the surface was retired, keeping the historical verdict text),
  `docs/GOOSE_RESEARCH.md`, `docs/GOOSE_DOGFOOD.md`,
  `docs/CHAT_UI_RESEARCH_2026.md`, `docs/TUTOR_AND_LEARNING_SPEC.md`.
- **`docs/SECURITY_ASSURANCE.md` — machine-checked.** Every claim row citing a
  `test/cline-*` or `test/acp-cline-*` file (S3, S4, S6, S12 and others) must be
  removed or re-pointed at the surviving equivalent, and the Cline rows in the
  S12 gated-probe catalog removed. **The checker enforces per-section citation
  floors**, so a section that loses most of its rows must rebalance honestly
  (re-point at OpenCode/goose evidence), not pad with unverified claims. Run
  `node --import tsx --test test/security-assurance.test.ts` after editing.
- **Archive, do not silently drop:** the plugin-era findings and probe verdicts
  (the Cline ACP rows in `HOST_ADAPTERS.md`, the Cline residual risks,
  `docs/OPENCODE_QUALIFICATION.md` matrix, probe logs) are preserved in their
  dated records or moved to an explicit archive section, per the W050
  acceptance criterion.

## E. Verification (on the removal diff)

- **Grep gate:** no `cline` references remain in `src/` or `test/` except the
  intentional shared-key deprecation comments; no `WORKFLOW_ACP_AGENT=cline`,
  `WORKFLOW_CLINE_*`, `CLINE_PROVIDER*`, `CLINE_MODEL` in live code.
- **Full gates (release gate):** `npm test` (now no Cline pretest),
  `npm run typecheck`, `npm run lint`, `npm run build`, `npm run toolbox:verify`.
- **ACP conformance for the remaining kinds:** `test/adapter-conformance.test.ts`
  and the OpenCode/goose probe families still pass/skip correctly; the driver
  registry lists `opencode` and `acp` only.
- **Security-assurance checker green** after the citation rebalancing.
- Independent five-axis review of the removal diff before merge.

## F. Sequencing

1. Gate clears (A/B/C above).
2. C1 relocate run-controller types → verify (no behavior change).
3. C2 upstream-key canonicalization + back-compat → verify.
4. C3/C4 retire mcp-settings + genericize comments → verify.
5. B adjust the agent kind/driver/web registry + package scripts → verify.
6. A delete files, tests, scripts, patch, checkout, excludes.
7. D doc reconciliation (append-only for dated records) + E verification.
8. Review + PR.

## G. Risks / unknowns

- The security-assurance per-section citation floors are the most likely
  breakage; rebalancing must add *real* OpenCode/goose citations, never pad.
- Removing `"cline"` from `DRIVER_NAMES` is a user-visible CLI change
  (`workflow-tui --driver cline` stops parsing) — document it in the README
  and, if desired, keep a fail-closed error naming the replacement
  (`WORKFLOW_ACP_AGENT=goose`).
- The upstream-key rename touches a live operator credential path; ship it with
  back-compat and a docs note before the old names are removed (they may be
  removed in a later, separately-gated step).
- No external consumers of the Cline modules are known; `src/index.ts` is the
  package's public export surface, so dropping those re-exports is the
  compatibility boundary to check.
