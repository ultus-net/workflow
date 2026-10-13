# Fleet plane-compat: make the ported golden tree function on the control plane (2026-10-13)

Dated plan; append, do not rewrite. Supersedes nothing; follows the W086
fleet port (PR #542, released v0.1.10). Scope: the three plane-compat defects an
in-plane interactive test surfaced, plus the docs/prompt corrections they imply.

## What the in-plane test found (evidence)

Verified against the deployed image `ghcr.io/ultus-net/workflow@sha256:2edc82fa…`
and the code on `main` (bb529efe):

1. **Agent model pins are inert on the plane (P1).** The port added
   `model: synthetic/syn:{small,large}:text` to all six agents
   (`assets/opencode-fleet/agents/*.md`). The plane never registers a `synthetic`
   provider — `meteredOpencodeConfig` emits only the metered id
   (`OPENCODE_V2_METERED_PROVIDER_ID = "openrouter"`, `opencode-agent-config.ts:35`)
   — and opencode v2.0.10 ships no `synthetic` provider (verified: `strings
   /usr/local/bin/opencode` finds no `syn:` alias / `synthetic.new`). The host
   resolves the pins only because `opencode-auto-router` is auto-discovered from
   the host plugins dir. On the plane every agent falls back to the composed
   default; an explicit `--model synthetic/syn:*` errors "Model unavailable".
   The dotfiles contract `lib/agent-model-pin.cjs` *requires* an established
   synthetic alias, so the fix must preserve tiering (operator decision).

2. **The runtime lane installs only agent+command (P1, systemic root).** 
   `installFleetIntoOpencodeConfig` passes `kinds: ["agent","command"]`
   (`src/integrations/fleet-payload.ts:228`). So `instructions/`, `style/`,
   `templates/`, and `skills/` are never placed on the plane, even though the
   ported agents reference them (e.g. `reviewer.md` step 7 relies on
   `coding-style.md`; `/explain` loads `code-cheatsheet`). The plane also denies
   `skill` (`opencode-agent-config.ts:379`, the single-delivery-path rule), so
   the fleet skill is doubly unreachable. The agent prompts are wired to use
   these resources; "deny" is not acceptable (operator decision).

3. **`external_directory` rules fail closed and churn (P2).** The port added
   `external_directory` allow rules to four agents (`executor.md:17`,
   `reviewer.md:38`, `executor-strong.md:17`, `screener.md:32`). The adapter
   throws `invalid ACP tool subject` for them (`src/adapters/acp.ts:59`), surfacing
   as `deny … unmappable permission request (fail closed)` in the plane logs
   (`opencode-server-authority.ts:212`). The rules grant nothing; they only
   produce deny churn.

4. **Prompt/docs mis-statements.** The interactive-test prompt asserted the CLI
   lane must not write workspace docs; the CLI lane installs the `doc` kind into
   `<workspace>/docs/agents/` by design (`installIfMissingOnly`). Only the
   runtime lane restricts kinds. Correct the prompt and any docs implying
   otherwise.

## Decisions (operator, 2026-10-13)

- **Tiering is preserved**: honor per-agent tiers on the plane via proxy
  mapping, not by stripping pins.
- **Skills are delivered, not denied**: the agents are wired to use fleet
  skills; the plane must provision and serve them (the `skill: "deny"` +
  single-delivery-path posture must be reconciled so `read_skill` reaches fleet
  skills).

## Design

### D1 — Runtime lane installs the dependency kinds (and skills into the store)

Widen the runtime-lane install from `["agent","command"]` to the config-dir
kinds the agents depend on: `agent`, `command`, `instruction`, `style`,
`template`, `skill`. Keep excluding `doc` (workspace-owned) and `host-config`
(reference-only). Skills do not belong in the config dir; provision the fleet
`skills` kind into the plane's hub-owned skills store (the `skills-mcp` delivery
path the journaled `read_skill` reads), alongside the existing `workflow-toolbox`
provision.

Acceptance: a plane launch places agent+command+instruction+style+template under
`<configDir>/opencode/**`, places the fleet skills under the skills store, and
never writes `docs/` or `host-config/`. The doctor fleet check still passes
(compare must know the runtime-lane expected set; no false "differs").

### D2 — Model tiers via proxy mapping

- The runtime installer rewrites each agent's `model:` from
  `synthetic/syn:X` to the metered provider id that the plane actually
  registers (`<meteredId>/syn:X`), so the pin resolves.
- `meteredOpencodeConfig` composes the tier ids (`syn:small:text`,
  `syn:large:text`) into the metered provider's model catalog so the config and
  picker accept them.
- The loopback proxy already passes non-`openrouter/auto` ids through to
  Synthetic on the primary hop (`model-usage-proxy.ts` `primaryBytes`) and
  re-pins to `openrouter/auto` on failover (`fallbackBody`). Verify `syn:*`
  passthrough and add tests.

Acceptance: a plane agent pinned to `synthetic/syn:small:text` runs on the small
tier; a Synthetic 429/5xx fails over to `openrouter/auto`; the vendored assets
stay byte-identical (the rewrite is an install-time transform, never a source
edit).

### D3 — `external_directory` and host-specific permission actions

Strip (or map) host-specific permission actions the plane cannot honor at
runtime-lane install, so an agent frontmatter never produces unmappable-request
deny churn. Prefer delivering `style` via the composed config `instructions`
key (D1) over an `external_directory` read, since the plane's config dir is
outside the workspace the rule targets.

Acceptance: no `unmappable permission request` for a fleet agent on the plane;
`coding-style.md` reaches the agent by a supported path.

## Tasks

- **T1 (foundation, critical path)** — D1 + D3: widen the runtime-lane
  installer, provision fleet skills into the skills store, neutralize
  host-specific permission actions, update the doctor compare + tests + docs.
- **T2 (after T1)** — D2: install-time agent model rewrite + tier catalog
  composition + proxy passthrough tests.
- **T3** — Ledger/FEATURES/README honesty rows and the interactive-test prompt
  correction (D4).

## Verification

Focused suites only (never `npm test`): `test/install-doctor.test.ts`,
`test/e2e-doctor.test.ts`, `test/acp-runtime-agent.test.ts`,
`test/opencode-server-runtime.test.ts`, `test/synthetic-provider.test.ts`, plus
new tests per task. `npm run lint`; `tsc --noEmit`.

## Outcome (2026-10-13): implementation in flight on `fix/fleet-plane-compat`

Append-only supersession note; the plan above stays as written. The
implementation is landing on branch `fix/fleet-plane-compat`, based on `main`
at `bb529efe` (the W086 golden-tree port, PR #542, released v0.1.10). Status is
source-verified, NOT yet re-deployed to the plane and NOT yet live-probed, so
every affected claim stays **Partial** until a rebuilt image is deployed and the
fleet loads on the plane.

Operator decisions (recorded):

- **Tiers preserved via proxy mapping.** The runtime installer rewrites each
  agent's `model: synthetic/syn:X` pin to the metered provider id the plane
  registers (`<meteredId>/syn:X`), and the metered catalog composes the tier
  ids, so per-agent tiers are honored on the plane. The vendored assets stay
  byte-identical (install-time transform, never a source edit).
- **Skills delivered through the journaled `read_skill` path, not denied.**
  The fleet `skill` kind is provisioned into the hub-owned skills store that
  skills-mcp serves through the journaled `read_skill`, rather than weakening
  the native `skill: "deny"` posture.

Task mapping: T1 = D1 + D3 (widen the runtime-lane kinds to
`agent`/`command`/`instruction`/`style`/`template`, provision fleet skills into
the skills store, strip unmappable host-specific permission actions); T2 = D2
(install-time model rewrite + tier catalog composition + proxy passthrough);
T3 = this note plus the `docs/FEATURES.md` and `README.md` honesty rows.

Defect 4 (the interactive-test prompt) is not a checked-in file: a repo-wide
search (docs, `docs/agents/**`, vendored `assets/opencode-fleet/`) found no
prompt or doc stating that the CLI lane must never write workspace docs. The
correct fact already stands in this ledger (lines 43-47) and the installer
source (`src/integrations/fleet-payload.ts:112,239-258`): the CLI lane installs
the `doc` kind into `<workspace>/docs/agents/` (`installIfMissingOnly`); only
the runtime lane restricts kinds. No in-repo prompt needed correction, so none
was changed.

### Append 2026-10-13: D3 delivery corrected after an independent review

Append-only note; the plan and the outcome above stay as written.

An independent five-axis review (branch `fix/fleet-plane-compat`) found the D3
delivery mechanism unsound, and the finding was confirmed by measurement, not
inference:

- **OpenCode v2 does not resolve the config `instructions` array.** Official v2
  docs: "The V2 config schema accepts an `instructions` array, but V2 does not
  currently resolve its files, glob patterns, or URLs. This configuration does
  not add instructions to the model yet." Only a discovered `AGENTS.md` is
  injected.
- **Measured against the pinned v2.0.10 binary** (`/tmp/opencode` harness,
  `--print-logs --log-level all`): with a config carrying
  `instructions: [STANDARDS.md, coding-style.md]`, the binary's own log
  referenced `AGENTS.md` 6 times and both other docs ZERO times, with no
  `instruction*` lines. Confirmed separately: this session's system prompt
  carries `Instructions from: .../AGENTS.md` blocks (v2 discovery works).

So the earlier `installedFleetInstructionPaths` → `fleetInstructions`
composition was INERT: `STANDARDS.md` and `style/coding-style.md` did not reach
agents on the plane. (`AGENTS.md` did, by discovery.)

Remedies applied (Kimi K3 consulted; recommendation adopted):

- **Fold the ambient docs into the installed global `AGENTS.md`.** A pure,
  deterministic install-time transform (`foldFleetAmbientDocs`,
  `fleet-agent-install.ts`) appends `STANDARDS.md` then `style/coding-style.md`
  under fixed banners to the installed `AGENTS.md`, the one path v2 honors.
  Wired in `normalizeRuntimeFleetPayload` (`fleet-payload.ts`), which resolves
  the sibling docs from the manifest. Vendored sources stay byte-identical; the
  installed `AGENTS.md` hashes stably (idempotent `already-current`).
- **Removed the inert axis**: `installedFleetInstructionPaths` and the
  `fleetInstructions` config option, plus both call sites.

Two further findings recorded here (out of this branch's scope, not fixed):

1. **Golden-tree `instructions` gap.** The operator dotfiles golden tree
   (`assets/opencode-fleet/host-config/config.jsonc`, "Ambient instructions")
   delivers `STANDARDS.md`/`coding-style.md` via the same `instructions` array,
   which v2 ignores — so the golden tree is also missing them on v2. Filed as an
   operator-dotfiles follow-up; the plane fix is runtime-lane-local only.
2. **W181 egress guidance is inert for the same reason.** The ACP lane composes
   `instructions: [egressGuidancePath]` (`acp-runtime.ts`), which v2 never
   resolves, so the posture-gated egress-runtime-context guidance does not reach
   v2 agents. Pre-existing and outside this branch's three plane defects; needs
   its own dated disposition.

Because the delivery mechanism changed, the D3 acceptance is met by the fold
(unit-tested: fold content, order, banners, idempotency, and `compareFleet`
agreement), still source-verified only — the plane-probe status is unchanged.

A review follow-up: the fold transform is a factory (`runtimeFleetTransform(root)`)
so the installer and any compare resolve the sibling docs from the SAME root
they act on — closing a latent mismatch where the transform read the package's
own assets regardless of a caller-supplied `root`.

Two lower-severity latents the same review found, recorded (not fixed):
- **v1/v2 provider-id mismatch.** `rewriteFleetModelRef` always rewrites to the
  v2 metered id (`openrouter`), while the v1 provider id is `workflow-metered`,
  and the runtime install is not version-gated. The plane image pins v2.0.10, so
  this is latent; a v1 ambient binary (probe failure ⇒ `undefined` ⇒ treated as
  v1) would install pins that do not resolve. Low severity today.
- **`rsi-campaign` command depends on `lib/` rulers** the runtime lane does not
  install (`lib` is excluded, workspace-owned), so that command's ruler calls do
  not resolve inside the plane container. Manual RSI tooling only.

## Append 2026-10-13: round-2 in-plane findings (v0.1.11) — root causes and fixes

Append-only. The v0.1.11 test on the `clean1` revision surfaced four round-2
findings. Diagnosis is grounded in the PLANE console (`az containerapp logs show
… --revision csh-dev-plane--clean1`, the authoritative decision log) and the
pinned v2 source (`packages/schema/src/permission.ts`, `packages/core/src/permission.ts`).

### R2-1 (P0) — `deny external_directory`/`deny edit` as `invalid ACP tool subject`

**Evidence (plane console).** On session `ses_ecc8…`: `deny external_directory …
reason=unmappable permission request (fail closed): invalid ACP tool subject` (×4)
and `deny edit … invalid ACP tool subject` (×1). Zero capability/workspace/budget
denials. The round-2 report's proposed remedy (grant the main session the RSI
proposal capability set) is **misdiagnosed**: nothing was capability-withheld.

**Root cause.** The pinned v2 `Permission.Request` carries the subject in
`resources` (`{ id, sessionID, action, resources[], save?, metadata?, source? }`,
`packages/schema/src/permission.ts`); `metadata` is freeform and, on the live
wire, empty of the path. The projection built ACP `locations` from
`metadata.filepath/filePath/path` only (`projection.ts permissionLocations`), so
a v2 `edit` (path in `resources`) and `external_directory` (the directory in
`resources`) yielded no subject. The adapter's fail-closed guard
(`acp.ts` "mutating + mutation + no subjects ⇒ invalid ACP tool subject") then
threw, and the broker recorded the unmappable deny. The tester reading `/app/src`
is genuinely outside `/workspace`, so confinement was doing the right thing — the
defect was that the subject never reached the confinement gate.

**Why it looks like "the user declined this tool call".** opencode's
`PermissionV2.reply("reject")` fails EVERY pending request in the session with a
bare `DeclinedError` (message-less ⇒ `catchTag`→`die`) for the siblings
(`packages/core/src/permission.ts` reply handler). A reject that carries no
`message` is a raw decline, rendered as "The user declined this tool call" →
"Step interrupted". The broker's unmappable path rejects with
`rejectionFeedback` only when a reason exists — here the reason existed, but the
*sibling* asks fail message-less regardless.

**Fix.** `permissionToolCall` (`src/integrations/remote-acp/projection.ts`) now
derives locations from `request.resources` for PATH-subject actions
(`edit`/`write`/`patch`/`read`/`list`/`external_directory`/…), keeping
`metadata` as the higher-priority v1 signal, and uses the resource path as the
title when metadata offered none. `shell`/`webfetch`/`task` resources (a command,
URL, or agent name) AND `glob`/`grep`/`search` resources (a glob/regex pattern,
not a path) are deliberately NOT mapped, so they cannot fake a confinement
subject. The out-of-workspace path now reaches
`WORKSPACE_PATH_DENIED` (`workflow.ts:248-255`, the legible denial) instead of
`invalid ACP tool subject`.

### R2-2 (P1) — permission reply/poll 404s (`delivered=false … /reply`)

**Evidence.** Each deny logs a `delivered=true` line paired with one or more
`delivered=false … upstream reply failed: remote engine POST …/permission/…/reply`
(404), matching the tester's `opencode.log` `POST …/reply 404` lines.

**Root cause.** The v2 reject cascade above: the first reject drains every
pending ask in the session, so a follow-on reply for a sibling the server already
resolved answers 404. It is a resolution, not a transport loss.

**Fix.** `deliver` (`opencode-server-authority.ts`) journals a reply failure
whose engine status is `failed (404)`/`failed (409)` as `already resolved
upstream (the v2 reject cascade drains sibling asks)` instead of the alarming
`upstream reply failed` framing. The boolean still gates coverage seeding, so an
undelivered allow never authorizes later activity (unchanged).

### R2-3 (P2) — the fs route-template 500 (`/api/session/:id/permission/:pid`)

Characterized as a tool calling the fs read on an OpenAPI template string
(`GET /api/fs/list` on `/api/session/:id/permission/:pid`). It is a v2 fs-read
surface (read-only class, forwarded), not an authority defect; no control-plane
fix. Recorded, not fixed.

### R2-4 (P1) — in-workspace write denied (`Unable to write /workspace/…`)

Directly downstream of R2-1: an in-workspace `edit` whose path rides `resources`
was unmappable, so the mutation was denied and the write never ran. The R2-1
mapping fix resolves it (new test: an in-workspace `edit` with `resources` is
allowed). The residual `tool.execution` message, if it persists after R2-1,
would be an opencode-side write error, not the authority.

### R2-5 — skills store (`/explain` reaches no `code-cheatsheet`)

**Root cause.** `WORKFLOW_PLANE_FULL_TOOLBOX` is not set on the plane, so
`mountFullToolbox=false` and the runtime took `resolveSkillsMount()` —
mount-only-if-present — never `ensureSkillsMount()`. The hub-owned
`~/.agents/skills` store was therefore never created or provisioned, so the fleet
`skill` kind never resolved (confirmed: no `/home/node/.agents` on `clean1`).

**Fix.** New runtime option `ensureSkillsStore` (independent of the O-4
`mountFullToolbox` switch) wired `true` in the plane daemon block
(`src/cli/opencode-server.ts`); the runtime uses `ensureSkillsMount()` when either
is set and then `provisionToolboxSkill` + `provisionFleetSkills` populate the
store. `skill: "deny"` is untouched (delivery is the journaled `read_skill`).

### Posture

All fixes are source-verified with focused tests (see PR); NONE is live-probed —
the plane runs the old image, so every affected claim stays **Partial** until a
rebuilt, digest-repinned release is deployed and the fleet loads an agent turn
with an `edit`/`external_directory` and a `/explain`.

