# W050 execution plan — retire the vendored-Cline runtime

**Status:** draft plan, 2026-09-18. **Gate:** do not execute until W050
criterion 1 (backup-slot takeover) and criterion 2 (SDK-seam decision) have
resolved. The criterion-2 draft currently lives on branch
`feat/w050-sdk-seam-decision` (PR #37) as `docs/ACP_DECISION.md` "W050 SDK-seam
decision — PROPOSED"; it is not yet on `main`. This plan removes nothing by
itself.

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
  the `.gitignore:4` / `.git/info/exclude:9` entries).
- Cline-named tests: `test/cline-adapter.test.ts`, `test/cline-launch.test.ts`,
  `test/cline-plugin.test.ts`, `test/cline-session.test.ts`,
  `test/cline-tui-bridge.test.ts`, `test/cline-probe-helpers.ts`, and the
  whole `test/acp-cline-*.test.ts` family (10 files: contained, mcp-mount,
  metadata, metered, mutation, probe, resume, shell, subagent, tool-matrix).
- Integration regressions: `test/integration/cline-coding-session.mjs`,
  `cline-plugin-fixture.mjs`, `cline-resume.mjs`, `cline-runtime.mjs`.
- **Non-Cline-named tests that assert Cline behavior** — these must be edited,
  not deleted outright: `test/driver-registry.test.ts:20-52` (the `cline`
  driver cases), `test/web-agents.test.ts:14-38` (the cline registry entry),
  `test/tui-cli.test.ts:9,19` (patched-Cline source checks),
  `test/toolbox-mcp-settings.test.ts` (with C3),
  `test/interactive-containment-cli.test.ts` (ClineHostAdapter wiring).

## B. Removal set — the Cline agent kind and its live importers

Edit (not delete):

- `src/integrations/acp-runtime.ts` — drop `createClineRuntime`, the
  `"cline"` branch in `createConfiguredAcpRuntime`, the `resolveClineLaunch`
  import, and `"cline"` from the `AcpAgentKind` union and the error text.
- `src/cli/driver-registry.ts` — drop `"cline"` from `DRIVER_NAMES`, the
  cline composer, and the `createConfiguredClineRuntime` import.
- `src/ui/web-agents.ts` — drop the `"cline"` `WebAgentId`, its `listWebAgents`
  entry, `clineApiKeyPresent`, and `isWebAgentId` membership.
- **Live importers of the Cline runtime/adapter beyond the driver registry**
  (the reviewer surfaced these; grep after editing to confirm none remain):
  `src/cli/ink-tui.tsx:7,136-138` and `src/cli/style-eval.ts:4,35` import
  `createConfiguredClineRuntime`; `src/cli/contained-shell.ts:7,37` uses
  `ClineHostAdapter` (real code, not a comment). Decide per file: re-point at
  the OpenCode/goose runtime, or drop the Cline path.
- `src/index.ts` — drop **five** re-exports:
  `./adapters/cline.js` (line 9), `./integrations/cline-plugin.js` (7),
  `./integrations/cline-shell-executor.js` (8), `./integrations/cline-session.js`
  (16), `./integrations/cline-runtime.js` (17). This is the package's public
  compatibility boundary.
- `package.json` — remove scripts `tui:cline:build`, `build:cline-agent`,
  `cline:bump`, `test:cline-runtime`, `test:cline-coding-session`,
  `test:cline-resume`; replace `pretest` (currently the Cline build) with
  either removal or a non-Cline pretest.
- `scripts/install.mjs`, `scripts/prepare-tool.mjs` — remove the Cline build
  steps.
- `packaging/workflow-web.service` — remove the `ExecStartPre` Cline build.

## C. Shared substrates — untangle before deleting

These are load-bearing for the remaining ACP surfaces (OpenCode, goose) or the
hub; do each **before** the corresponding removal above.

1. **Shared types live in `cline-tui-bridge.ts`.** General modules import
   `WorkflowRunController` / `WorkflowApplicationResolver` from it
   (`src/integrations/workflow-hub.ts:8-14`, `hub-scheduler.ts:4`,
   `run-registry.ts:8`, `hub-reviewer.ts:21`), and **`shellExecutorFor` is not
   Cline-only** — `src/cli/hub.ts:9,101` uses it. Relocate the still-consumed
   exports (`WorkflowRunController`, `WorkflowApplicationResolver`,
   `shellExecutorFor`, and any other non-Cline symbols) to a neutral module
   (e.g. `src/integrations/run-controller.ts`) and re-point every consumer
   before deleting the bridge. `WorkflowClineTuiBridge` and
   `recordClineTeamTaskEnvironmentEvidence` are Cline-only and go with it.
2. **`CLINE_API_KEY` / `~/.config/workflow/cline-api-key` is the shared
   upstream metering key for *all* ACP runtimes** (`acp-runtime.ts:461,609`);
   goose availability even reports it (`web-agents.ts:32-40,103,110`). Do **not**
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
   `src/containment/linux-bwrap.ts`, `src/integrations/goose-agent-config.ts:99,118,143`,
   and the `hub*.ts` comments (e.g. `src/cli/hub.ts:83`).

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
  `test/cline-*` or `test/acp-cline-*` file must be removed or re-pointed at
  the surviving equivalent, and the Cline rows in the S12 gated-probe catalog
  removed. The affected sections are **S2, S3, S6, S7, and S12** (S4 cites no
  Cline tests). **The checker enforces per-section citation floors**
  (`test/security-assurance.test.ts:47,57,67`), so a section that loses most of
  its rows must rebalance honestly (re-point at OpenCode/goose evidence), not
  pad with unverified claims. Run
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
2. C1 relocate shared types + `shellExecutorFor` → verify (no behavior change).
3. C2 upstream-key canonicalization + back-compat → verify.
4. C3/C4 retire mcp-settings + genericize comments → verify.
5. B adjust live importers (runtime branch, driver/web registry, ink-tui,
   style-eval, contained-shell, index, package scripts) → verify.
6. A delete files, tests, scripts, patch, checkout, excludes; edit the
   non-Cline-named tests that assert Cline behavior.
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
- `src/index.ts` is the package's public export surface; dropping five Cline
  re-exports is the compatibility boundary to check. No external consumers are
  known.
