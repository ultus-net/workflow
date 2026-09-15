# Hub-Owned Enforcement — Implementation Plan

**Status:** Proposed — 2026-09-15
**Direction:** ACP-first. Features land at the hub/control-plane level, never as
CLI-agent plugins, host hooks, or host-side MCP injection. The patched vendored
Cline SDK path remains the working fallback only (`docs/ACP_DECISION.md`).
**Enforcement basis:** ACP permission interception is agent-cooperative UX
projection; real enforcement is the OS boundary (whole-agent Bubblewrap) plus
hub-owned key custody. Nothing prompt-side or tool-side is ever enforcement.

> **Coordination note (2026-09-15):** a concurrent agent is reworking the ACP
> web UI (`src/ui/webapp`). No task below edits web files; UI-facing tasks
> (A3) are marked as coordination points and must be merged against the
> in-flight web work before landing.

**Goal:** Move the remaining plugin-dependent enforcement features — review
gating, subagent control, scheduled runs, evidence quality, token economy,
skills, and the opencode-workflow-guard policy engine itself — behind the hub
so any conformant ACP agent gets the full gated workflow with zero host-side
plugins.

**Vision (operator-confirmed 2026-09-15):** the working plugin
(`opencode-workflow-guard`, ~6.2k lines: ~20 policies, evidence, audit, worktree,
checkpoint, learning, review) shifts to the control plane. Its **policies and
adversarial test corpus** are the durable assets; the **plugin seat**
(`tool.execute.before` in-process veto) is temporary scaffolding. The hub becomes
the single policy evaluator and veto owner for every host; the plugin demotes to
a thin forwarder and is retired per probe-verified agent (Phase G).

**Honesty constraints carried through every phase:**
- Evidence validates shape, not truth. A skill read, reviewer verdict, or test
  exit code is admitted evidence; it never proves the work is *good*.
- Reviewer anti-rubber-stamp rules are gamable process discipline; docs and UI
  must frame them as such, never as determinism.
- Per-agent enforcement claims are empirical, probe-verified per pinned agent
  version, and displayed (`enforced` vs `advisory` never blurs).
- Verifier-token separation disciplines honest clients only, not compromised
  same-user processes; the hub process must never be treated as isolated from
  its own data dir.

---

## Phase A — Hub-owned review gate (replaces agent-side workflow-guard plugin)

**Why:** the 5-axis review currently depends on an external reviewer run
(plugin-spawned in the opencode-workflow-guard pattern). On the ACP path the
hub itself must be able to produce the reviewer run, or review-gated runs
cannot close without host-specific tooling.

### Task A1: Reviewer runner module

**Files:**
- Create: `src/integrations/hub-reviewer.ts`
- Test: `test/hub-reviewer.test.ts`

- [ ] **Step 1: failing tests** — stub ACP agent factory; assert: hub spawns a
      *distinct* reviewer runId via `/run/begin` (anti-rubber-stamp rule:
      reviewer run ≠ subject run); the hub sources the diff itself by running
      `git diff` through contained execution (the hub stores no diffs and
      `/review/rubric` takes caller-supplied `diffText` — the reviewer runner
      is that caller); reviewer prompt embeds the rubric text from
      `src/review/rubric.ts` (30k diff cap); verdict parsed from the
      reviewer's final agent message with the rubric's exact format;
      **unparseable verdict fails closed** — records `changes_requested`
      (kernel records nothing for non-approved) and never promotes; verdict
      submitted through the verifier capability path (`/run/review`), never
      the ordinary token; reviewer session runs contained
      (`launchContainedAcpAgent`) with placeholder-only credentials via the
      metering proxy.
- [ ] **Step 2: implement** — compose existing pieces only:
      `AcpSessionDriver`/`acp-session.ts` (contained spawn),
      `model-usage-proxy.ts` (key custody + metering), `src/review/rubric.ts`
      (rubric text), `run-registry.ts` (run bookkeeping). No new deps.
- [ ] **Step 3: run — passes**; lint + typecheck clean.

### Task A2: Automatic review trigger on run completion

**Files:**
- Modify: `src/integrations/run-registry.ts` (the `/run/finish` verified path:
  `finish()` and the `requiresReview` → `requiredEvidence` declaration at
  `begin()`), `src/integrations/cline-tui-bridge.ts` (routes)
- Test: `test/hub-runs.test.ts` (extend), `test/hub-review.test.ts` (extend —
  scope new failing tests to auto-launch and failure-surfacing, not the
  already-covered deny paths)

- [ ] **Step 1: failing tests** — a `requiresReview` run whose agent finished
      (per `/run/finish` reporting session end) does **not** advance to
      `VERIFIED` until the hub-owned reviewer records fresh `reviewer`
      evidence; plain runs keep existing explicit-policy semantics (per
      `docs/HUB_PROTOCOL.md` §`/run/finish`). Reviewer launch is observable
      in the run registry; reviewer failure (agent error, budget exceeded,
      unparseable verdict) leaves the run task in `VERIFYING`, surfaced as a
      blocking reason, never silently passed.
- [ ] **Step 2: implement** — wire A1 into the run lifecycle; reviewer
      outcome recorded through the same kernel transition machinery.
- [ ] **Step 3: run — passes.**

### Task A3: Verdict + follow-up surfacing *(coordination point — web)*

**Files:**
- Modify: monitor TUI activity panel (`src/ui/` Ink surfaces)
- Web: `docs/web-ui-feature-tiers.md` is the in-flight web roadmap (the
  concurrent agent's plan); verdict/follow-up projection belongs there as a
  tier item, not in this repo's web code while that work is active

- [ ] **Step 1:** surface latest review verdict, blocking reason, and open
      P2/P3 follow-ups (client exists: `review-followups.ts` →
      `review-accountability-mcp`) in the Activity panel. The real gap is
      verdict/blocking-reason display — follow-ups already surface in the
      Ink panels (`tui.tsx`, `ink-tui.tsx`); do not duplicate that work.
- [ ] **Step 2:** add web projection as a feature-tier item in
      `docs/web-ui-feature-tiers.md` once that roadmap's batches land, or as
      a coordinated batch with the web agent.

---

## Phase B — Subagent and mode-drift gating (close the bypass lane)

**Why:** gap G6. Internal subagents emit no permission requests — the hub sees
nothing they do. Enforcement that gates only the main session is a gate around
half the work.

### Task B1: Capability-bearing classification for spawn tools

**Files:**
- Modify: `src/adapters/host.ts` (capability set), `src/adapters/acp.ts`
- Test: `test/acp-adapter.test.ts`, `test/acp-permission.test.ts`

- [ ] **Step 1: failing tests** — `spawn_agent`/subagent/task-spawn tool
      proposals classify to a **new `spawn` capability** — explicitly *not*
      `process`, which the hub CLI already grants by default
      (`src/cli/hub.ts:30`) and would make spawn default-allow; `spawn` is
      default-deny on every surface; event metadata may escalate but never
      relax (existing `stricterCapability` rule).
- [ ] **Step 2: implement + run — passes.**

### Task B2: Enforcement-altering config options are capability-bearing

**Files:**
- Modify: `src/integrations/acp-session.ts` (config-option handling from G2)
- Test: `test/acp-session.test.ts` (extend)

- [ ] **Step 1: failing tests** — a `session/set_config_option` or
      agent-originated `config_option_update` that switches a
      bypass/auto-approve-everything mode is denied (or visibly downgrades the
      surface's enforcement marker) instead of silently applying. Mode changes
      must never let `advisory` look like `enforced` (PRODUCT.md constraint).
- [ ] **Step 2: implement + run — passes.**

### Task B3: Subagent conformance matrix

**Files:**
- Modify: `docs/HOST_ADAPTERS.md`
- Test: gated probe `test/acp-cline-subagent-probe.test.ts` (env-gated, real
      agent, pattern of existing `acp-cline-*-probe` tests)

- [ ] **Step 1:** probe whether subagents emit gateable permission requests per
      pinned agent version; record the matrix. Agents with unverifiable
      subagent behavior are capped `advisory` or spawn-denied — the "enforced"
      label fails closed without probe evidence.
- [ ] **Step 2:** document in FEATURES.md honestly.

---

## Phase C — Hub-native scheduled runs (adoption wedge)

**Why:** enforcement value is strongest unattended; scheduled runs currently
need external connectors/plugins to drive them.

### Task C1: Hub scheduler

**Files:**
- Create: `src/integrations/hub-scheduler.ts`, `src/cli/hub.ts` (wiring)
- Test: `test/hub-scheduler.test.ts`

- [ ] **Step 1: failing tests** — cron table persisted under the data dir
      (versioned, lock-consistent with existing store); schedules spawn
      contained ACP runs (`/run/begin` → prompt → agent turn → `/run/finish`)
      with their own task and evidence; `requiresReview` defaults true;
      scheduler failure never mutates state (fail closed).
- [ ] **Step 2: implement + run — passes.**

### Task C2: Budget enforcement

**Files:**
- Modify: `src/integrations/model-usage-proxy.ts` (recorded usage → cap
  check), `src/integrations/acp-session.ts` (abort hook)
- Test: `test/model-usage-proxy.test.ts` (extend)

- [ ] **Step 1: failing tests** — per-run token/cost caps from proxy records;
      exceeding a cap aborts the session (`session/cancel`) and the run task
      ends `FAILED` with the budget as blocking reason.
- [ ] **Step 2: implement + run — passes.**

### Task C3: Threat-model addendum

- [ ] With `network=host` retained for model egress, note data-exfiltration
      via the model channel as the main residual risk and the metering proxy
      as the future egress-policy point (root `THREAT_MODEL.md`).

---

## Phase D — Evidence-quality defaults (test evidence before VERIFIED)

**Why:** evidence validates shape, not truth; reviewer evidence alone is weak.
Hub-executed tests are the strongest cheap evidence the control plane owns.

### Task D1: Hub-run test evidence

**Files:**
- Modify: `src/integrations/run-registry.ts` (`/run/finish` verified path),
  `src/integrations/cline-tui-bridge.ts` (routes)
- Test: `test/hub-runs.test.ts` (extend)

- [ ] **Step 1: failing tests** — `outcome: "verified"` for review-gated runs
      additionally requires fresh passing `environment` evidence with subject
      `test:<workspace>` at the current mutation epoch, produced by the hub
      executing the workspace test command through contained execution
      (existing `/bash` machinery); failing tests → run stays `VERIFYING` /
      fails closed with the test output as blocking reason.
- [ ] **Step 2: implement + run — passes.** The test command comes from the
      same project config surface the guard uses today
      (`verifyCommand` in `.opencode/workflow-guard.json[c]` and the
      `WORKFLOW_*` equivalents) — the hub must learn it from project config,
      never from the agent. Richer parsing via `test-intelligence-mcp` /
      `verification-accountability-mcp` is a later enhancement, not a
      dependency.

---

## Phase E — Token economy de-plugined (ACP-compatible)

**Why:** lazy discovery + truncation currently live in the vendored patch
(`CLINE_LAZY_MCP_TOOLS`); stock ACP agents have neither.

### Task E1: Server-side bounds + discover/read meta-tools

**Files:**
- Modify: `mcp-toolbox/apps/*` (shared helper), per-server adoption
- Test: toolbox `verify` command

- [ ] **Step 1:** shared toolbox helper for bounded results (48k middle-cut
      parity) and optional discover/call meta-tools per server, so any
      MCP-capable agent inherits the token economy without host patches.
- [ ] **Step 2:** adopt in the noisiest servers first (code/test-intelligence).

### Task E2: usage_update adoption

- [ ] Forward ACP `usage_update` into hub metrics when agents upgrade their
      pinned ACP SDKs (projection already passes unknown update types
      through); metering proxy stays canonical until then.

---

## Phase F — Skills at the control plane (delivery gate, not adherence)

**Why:** pedagogy-driven skill unlock; enforceable boundary is availability +
delivery, never adherence (prompts are not a security boundary).

### Task F1: Skills server (single delivery path)

**Files:**
- Create: `mcp-toolbox/apps/skills-mcp` (`list_skills` metadata-only,
      `read_skill` content), own package.json per toolbox convention
- Modify: `src/integrations/acp-runtime.ts` (agent launch env/MCP-config
      injection — this is the enforcement machinery that makes "hub owns
      agent MCP config" true rather than assumed), `src/integrations/acp-session.ts`
      (observation journal for `read_skill` calls)
- Test: toolbox `verify`, `test/acp-session.test.ts` (extend)

- [ ] **Step 1:** hub owns agent MCP config → skills reach the model only
      through this server. Native host skill injection stays **off** on all
      hosts (`cline-runtime.ts` `enableSkills: false` becomes the enforcement
      precondition, not a limitation). For opencode, its native `skill` tool
      is denied via permission config (`"skill": "deny"`), same
      single-delivery-path rule.
- [ ] **Step 2:** skill storage readable by the host's raw `read_file` is a
      bypass — classify reads under skill paths as recording the same
      `read_skill` observation, or move skill storage outside
      workspace-readable scope. Decide up front.

### Task F2: Availability gating by learner level

**Files:**
- Modify: `src/pedagogy/` (level → `{unlocked, required}` mapping),
  skills-mcp config
- Test: extend pedagogy tests

- [ ] **Step 1:** learner level gates which skills `list_skills` returns and
      which are required (below).

### Task F3: Delivery precondition in the application layer

**Files:**
- Modify: `src/application/workflow.ts`
- Test: `test/application.test.ts` (extend)

- [ ] **Step 1: failing tests** — tasks carrying `requiredSkills` deny
      `mutation` until the session log contains a `read_skill` observation for
      each required skill, fresh within the current task/mutation-epoch; skill
      reads are **preconditions, never `requiredEvidence`** (model-initiated
      tool calls must not self-certify); kernel stays prompt/skill-free.
- [ ] **Step 2: implement + run — passes.** Docs state the honest limit:
      delivery is enforced, adherence is not.

---

## Phase G — opencode-workflow-guard migration to the control plane

**Why (the vision, operator-confirmed 2026-09-15):** `mcp-toolbox` was the
first portability attempt — it proved the guard's policies can evaluate from
any MCP host (`guardCheck` in the vendored `workflow-guard-mcp`). It also
proved the structural limit: **MCP can evaluate, it cannot veto.** The hub is
the missing enforcement seat that turns evaluation into enforcement. The
plugin (~7.3k lines in `opencode-workflow-guard`) keeps working as the
enforcement seat and *reference implementation* while its durable assets move
behind the hub; it is then demoted to a thin forwarder and retired per
probe-verified agent.

**Decomposition — what moves where:**

| Plugin component | Control-plane home | Task |
|---|---|---|
| Policy logic (18 pure policy modules) | Hub `/before-tool` evaluates the vendored guard dispatcher for every surface | G2 |
| The veto (`tool.execute.before` throw) | Enforcement seat: ask-mode ACP, tool substitution, or overlay quarantine | G1/G3/G4 |
| `tool.execute.after` outcomes | ACP `tool_call_update` + hub observation journal | G2 |
| `experimental.text.complete` claims journal (Policy 24, observability-only) | Hub parses end-of-turn agent message over ACP; stays non-blocking | G5 |
| `permission.ask` journaling | Hub journals its own permission resolutions natively | G2 |
| Custom tools (`guard_status`, `guard_why`, …) | Read-only toolbox MCP server (MCP is for capabilities — correct fit) | G5 |
| sqlite audit / verify cache, worktree, checkpoint, learning, project-memory | Hub persistence + hub endpoints (worktree/checkpoint tooling already exists hub-side) | G5 |
| `tool.definition` honesty edits, `experimental.chat.system.transform` guidance | Hub-side prompt prepend (client owns what it sends); stays honestly advisory | G5 |
| `experimental.session.compacting` hook | **No ACP equivalent** (gap G7) — accepted regression until compaction signaling stabilizes; hub-side per-turn approximation if needed | G6 |

### Task G1: Retake the opencode ACP probe under ask/deny permissions

**Files:**
- Create: gated probe `test/acp-opencode-ask-probe.test.ts` (env-gated,
      credentials required; pattern of `acp-cline-*-probe` tests)
- Modify: `docs/HOST_ADAPTERS.md` (matrix rows)

- [ ] **Step 1:** launch opencode ACP with permission config
      `{"edit": "ask", "bash": "ask"}` (the `edit` permission governs
      `edit`/`write`/`apply_patch`) instead of the default all-allow config the
      original advisory verdict was earned under.
- [ ] **Step 2:** assert over the wire: does the agent emit
      `session/request_permission` to the hub-as-client, and are rejections
      honored (mutation never applied)?
- [ ] **Step 3:** record the matrix honestly. Pass → opencode joins Cline as an
      enforced ACP surface with zero plugin. Fail → G3 is the path. Either way
      the probe is the release gate for every future pinned agent version.

### Task G2: Hub evaluates the guard dispatcher on every tool call

**Files:**
- Modify: `src/integrations/mcp-toolbox-guard.ts` (provider → run per
      `/before-tool` call), `src/integrations/cline-tui-bridge.ts` (route
      wiring)
- Test: `test/hub-guard-interception.test.ts` (extend), `test/mcp-toolbox-guard.test.ts` (extend)

- [ ] **Step 1: failing tests** — every `/before-tool` call is evaluated by the
      vendored guard dispatcher (`guardCheck`) in addition to kernel/capability
      authorization; a guard deny is a hub deny (fail closed, `{stop: true}`),
      identical policy decisions for Cline ACP and opencode sessions;
      guard-unavailable → deny, never allow (fail closed).
- [ ] **Step 2: implement + run — passes.** Single policy source of truth:
      the plugin stops being the only place policies run; it becomes one
      caller among several.
- [ ] **Step 3:** in `opencode-workflow-guard`, demote the plugin to a thin
      forwarder (its `tool.execute.before` already throws on hub deny — that
      shape is correct; policy imports move behind the hub call). The plugin
      repo's release cadence can then slow to "conformance shim maintenance."

### Task G3: Tool substitution for non-cooperative agents

**Files:**
- Create: `mcp-toolbox/apps/workflow-fs-exec-mcp` (`workflow_edit`,
      `workflow_write`, `workflow_bash` — each calls hub `/before-tool` +
      contained execution, fails closed)
- Modify: `src/integrations/acp-runtime.ts` (launch agents with built-in
      mutations denied via host config and the toolbox server mounted)

- [ ] **Step 1:** built-in mutation tools denied via host permission config
      (`"edit": "deny", "bash": "deny"`); the model's only mutation path is
      hub-owned tools. This is the same single-delivery-path logic as F1,
      generalized to fs/exec.
- [ ] **Step 2:** rawInput fidelity per agent is probe-verified
      (`acp-cline-tool-matrix` pattern); policy corpus cases (below) run
      against the substituted tools.

### Task G4: Overlay quarantine (universal fallback)

- [ ] Contained agent workspace on an overlay; the real tree changes only when
      the hub promotes the diff after gates pass (evidence, review, tests).
      "Deny the write" becomes "deny the merge" — this is the escape hatch for
      agents that offer neither interception nor deniable built-ins. Design
      task; not blocking G1–G3.

### Task G5: Port the observability + extras

- [ ] Claims-vs-evidence journaling (Policy 24) at end-of-turn, hub-side, observability-only.
- [ ] `guard_status`/`guard_why`/review tools as a read-only toolbox server.
- [ ] Audit/verify-cache/worktree/checkpoint/learning behind hub persistence
      and endpoints (much already exists: `review-followups.ts`,
      `project-memory.ts`, hub run registry).
- [ ] Guidance (`tool.definition`, `system.transform` equivalents) as
      client-side prompt prepend; honestly advisory.

### Task G6: Port the adversarial corpus as hub conformance probes

**This is the asset that must not be lost.** The plugin's regression history —
symlink-alias bypasses, chained-command laundering, wrapper-shell variants,
parent/subagent freshness inheritance, `# allow-live` escapes — becomes a
hub-side probe suite every pinned agent version must pass before its surface
is labeled `enforced`.

- [ ] Inventory `opencode-workflow-guard` test cases by policy; map each to a
      hub probe or unit test (policy logic ports 1:1; hook-specific cases
      become ACP wire probes).
- [ ] Any corpus case that cannot be expressed hub-side is a documented hole,
      not a silent drop.

---

## Maintenance & achievement strategy (how this stays true over time)

1. **The plugin remains the enforcement seat and reference implementation
   until G1/G2 land.** Do not delete or freeze
   `opencode-workflow-guard` early; a working fallback is a working tree, not
   an archeology project (same rule as the vendored Cline patch).
2. **One policy source of truth.** After G2, policies live behind the hub; the
   plugin, the vendored guard MCP, and any future host shims are callers, not
   owners. Policy changes land hub-side first, then propagate to callers in
   the same release cycle.
3. **Conformance over trust.** No agent version gets an `enforced` label
   without passing the G6 corpus probes for that pinned version. Enforcement
   claims are per-agent-version empirical facts (the lesson of the original
   opencode advisory verdict, which was earned under default config).
4. **Fail-closed everywhere, including at the new seams.** Guard-unavailable
   → deny. Probe unverifiable → advisory cap. Overlay promotion ungated →
   never promote. `spawn` → default-deny.
5. **Honest limits in docs, permanently:** evidence is shape not truth;
   reviewer rules are process discipline; skills enforce delivery not
   adherence; the verifier token disciplines honest clients only.
6. **Retirement criteria (per agent):** a host's plugin is removed when, for
   the pinned agent version: (a) G1 probe passes OR G3 substitution is live;
   (b) G2 has run the corpus probes green; (c) the plugin's remaining
   unported surface (G5 items) is either ported or explicitly accepted as a
   documented gap (G6-style). Until all three: plugin stays, forwarder mode.

---

## Gates

- [ ] Per task: `npm run lint && npm run typecheck` + the task's test run.
- [ ] After the last mutation: full `npm test` (once the concurrent web-UI
      work has landed) + gated probes where credentials are available.
- [ ] Secondary five-axis review (guard rubric → reviewer → record_review)
  before merging any phase.

## Self-review notes

- Phases are ordered by architectural leverage, not effort: A closes the
  user-asked review-enforcement loop; B closes a real bypass lane; C is the
  adoption wedge; D raises evidence quality; E/F are de-plugining and the
  skills boundary; G is the operator-confirmed endgame — the
  opencode-workflow-guard plugin becomes a forwarder and then a retirement
  candidate, with its policies and adversarial corpus absorbed by the hub.
- Nothing in this plan requires a host hook, host plugin, or host-side prompt
  injection. Every feature is either a hub endpoint, a toolbox server, or an
  application-layer precondition. The plugin's continued existence during G is
  explicitly temporary scaffolding with defined retirement criteria.
- Skills honesty: availability and delivery are enforceable; adherence is not,
  and no doc or UI may imply otherwise.
- Review-finding corrections applied (2026-09-15 secondary review): A1 diff
  sourcing (hub runs `git diff` contained; rubric module is `src/review/rubric.ts`);
  A2/D1 corrected file maps (`run-registry.ts` owns the `/run/finish` verified
  path; routes in `cline-tui-bridge.ts`); B1 uses a new `spawn` capability
  (never `process`, which the hub grants by default at `src/cli/hub.ts:30`);
  F1 enforcement machinery assigned (`acp-runtime.ts` MCP-config injection);
  A3 scoped to verdict display (follow-ups already surface in Ink panels) and
  coordinated against `docs/web-ui-feature-tiers.md`.
