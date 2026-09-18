# AGENTS.md — Workflow repo guide for agent sessions

Read this first; it is generated from the reconciled docs (W043) so you do
not have to rediscover them. Truth lives in the cited files — if this file
and reality disagree, reality wins and this file gets fixed.

## What this repo is

Workflow is a **control plane for coding-agent hosts** (`README.md`). Models
and host SDKs are replaceable surfaces that propose work; Workflow is the
deterministic authority that owns task state, legal transitions, mutation
authorization, evidence, and verification:

```text
model proposes -> Workflow authorizes -> tool acts -> environment supplies evidence -> Workflow validates -> state may advance
```

Nothing mutates without authorization; nothing advances without fresh
evidence; authorization fails **closed** (no hub, no mutations).

**Default surfaces (post-2026-09-16 pivot):** `workflow` launches the browser
operator UI over stock-ACP OpenCode; goose is the qualified general-purpose/backup
agent selected with `WORKFLOW_ACP_AGENT=goose`. The terminal surface is
`workflow-tui --driver acp` (or `--driver opencode`), with the agent kind chosen
by `WORKFLOW_ACP_AGENT` (valid kinds: `opencode`, `cline`, `goose`). These
compose the `WorkflowApplication` authority
**in-process** — the hub is the shared authority for hub-resolving launchers.
The patched-Cline TUI launcher is retired; the vendored-Cline SDK runtime,
its `.workflow-cline/` checkout, and the Workflow patch were removed in W050
step 6 (2026-09-18). The `cline` agent kind remains only as a thin stock-ACP
connector (`src/integrations/cline-launch.ts` resolves ambient `cline --acp`),
probe-PENDING on stock 3.0.62.

## Architecture layers (and the kernel-purity rule)

| Layer | Path | Rule |
|---|---|---|
| Kernel | `src/kernel/` | deterministic task state, transitions, evidence freshness, mutation epochs. **Purity rule: no LLM, IO, UI, or SDK imports** — the kernel is pure contracts and can never depend on a host surface |
| Application | `src/application/` | the single authorization authority (`src/application/workflow.ts`): capability withholding, workspace confinement, task-list gating |
| Adapters | `src/adapters/` | translate host events into kernel-neutral proposals (OpenCode, ACP wire/subprocess); fail closed on malformed recognized safety metadata |
| Integrations | `src/integrations/` | composition: hub, run registry, scheduler, guard dispatch, credential custody, metering proxy, review control plane (`src/review/` + `src/integrations/hub-reviewer.ts`) |
| Containment | `src/containment/` | Linux Bubblewrap backend; `enforced` vs `policy-only` isolation is a type-level distinction |
| Surfaces | `src/cli/`, `src/ui/`, `src/pedagogy/` | TUIs, hub CLI, web projection; presentation never owns canonical state |
| Toolbox | `mcp-toolbox/` | vendored MCP servers incl. `workflow-guard-mcp` (the guard) and the executable policy corpus |

Security claims, trust zones, and residual risks: `THREAT_MODEL.md`; every
material claim bound to its verification: `docs/SECURITY_ASSURANCE.md`
(kept executable by `test/security-assurance.test.ts`).

## Verification commands (the discipline)

- `npm run lint` — eslint over src and test
- `npm run typecheck` — tsc --noEmit (strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`)
- `npm run build` — tsc -p tsconfig.build.json
- **Focused tests, not the full suite**: `node --import tsx --test test/<file>.test.ts`
  **Never run `npm test` by default** (operator resource directive): the full
  suite spawns PTYs, agents, and hub daemons. Full-suite runs belong to
  explicit release gates only.
- Gated live probes (`test/acp-*-probe.test.ts`, `test/hub-scheduled-turn-probe.test.ts`)
  skip without their env gate (`WORKFLOW_ACP_*`, e.g.
  `WORKFLOW_ACP_CLINE_SUBAGENT=1`); their live verdicts are recorded per
  pinned agent version in `docs/HOST_ADAPTERS.md` and must be re-run on
  every version bump.
- Guard corpus stays executable: `npm run toolbox:verify`

## Git / PR conventions

- The working trunk is `main`. Base every PR on `main` and merge it back to
  `main` — never onto another feature branch. (The old
  `feat/opencode-conformance-probes` integration branch was retired once main
  caught up via PR #31; long-lived side trunks are how main fell behind.)
- **Worktrees**: `git worktree add /var/home/hunter/worktrees/<name> -b <branch> <base>`
  from the main checkout; symlink `node_modules` into it (`.git/info/exclude`
  already covers it).
- **Stacked PRs strand.** A PR merged into its stacked base branch does not
  reach the trunk — that happened twice (PRs #15/#17, #19) and needed sync
  PRs (#20, #23) to repair. Fold shared content into one branch when two PRs
  touch the same region, so either merge order stays conflict-free.
- Never commit or push without the operator's direction; PRs get a
  `## Summary` body section.

## Review discipline (five axes, anti-rubber-stamp)

Every substantive change gets an independent review across the five axes —
**test integrity, task completeness, cleanliness, security, platform** —
with P0-P3 findings (`src/review/rubric.ts`). An approval that names fewer
than three axes is rejected (the anti-rubber-stamp gate, wired into the hub
run registry and mirrored for human reviews). The reviewer records its
verdict BEFORE the change is treated as approved; interrupted reviews resume
from fingerprinted provenance, never from stale approvals
(`src/review/provenance.ts`).

## Honest-claims culture (non-negotiable)

- **Advisory is observability, never enforcement.** An `advisory` host may
  display decisions but guarantees nothing; the per-version probe verdicts in
  `docs/HOST_ADAPTERS.md` decide what any surface may claim.
- **Statuses mean what they say** in `docs/FEATURES.md` (Complete / Partial /
  Planned / Disabled), and superseded claims are marked, not deleted.
- **Dated records are append-only**: research and decision docs
  (`docs/ACP_RESEARCH.md`, `docs/ACP_DECISION.md`,
  `docs/OPENCODE_QUALIFICATION.md`, `docs/GOOSE_RESEARCH.md`) get dated
  supersession notes; history is never silently rewritten.
- **Residual risks stay stated** — `docs/SECURITY_ASSURANCE.md` keeps nineteen
  of them on record, and its checker pins the honesty statements.
- Probe-gated, never date-gated: an agent version bump without a re-run of
  its probes caps that surface `advisory`.

## Where things live

- Roadmap and task ledger: `TASKS.md` (W-numbered work items with acceptance
  criteria; Phase 11 = daily-driver replacement qualification, W043-W050)
- Hub design `docs/HUB.md`; versioned SDK-neutral contract
  `docs/HUB_PROTOCOL.md`; adapter matrix and probe verdicts
  `docs/HOST_ADAPTERS.md`; honest feature status `docs/FEATURES.md`;
  goose's full ACP implementation map `docs/GOOSE_ACP_IMPLEMENTATION.md`
- Cline connector: the thin stock-ACP connector
  (`src/integrations/cline-launch.ts` resolves the ambient `cline --acp`; the
  `cline` driver/agent kind composes the generic ACP runtime). The vendored
  pin/patch, `.workflow-cline/` checkout, and `npm run tui:cline:build` were
  removed in W050 step 6; the connector is probe-PENDING on stock 3.0.62
  (stock's `CLINE_API_KEY`/`CLINE_PROVIDER` headless path is source-inferred,
  not yet live-verified — `docs/HOST_ADAPTERS.md`)
- Containment guarantees: `docs/RUNTIME_CONTAINMENT.md`
