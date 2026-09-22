# Protocol planes — the communication-architecture position (2026-09-22)

> Purpose: the operator asked whether the repo is **over-committing to the
> wrong direction** in how agents and tools communicate with the Workflow
> hub. This is the position summary, written to be attacked: the plane map
> (refreshed to include the surfaces the first draft missed), the bet each
> plane makes, the falsifiers, and the one open extension point. Bases:
> `origin/main@1d6f9e8` (PRs #76/#78/#79/**#80** merged; PR #81 open) — the
> first draft pinned `a80dead` and described PR #80 as open; the frontier
> reviewer caught it via `git ls-remote` before any human did (§7 round 1),
> which is precisely why these pins are re-stated per review round.
> Companion docs: `docs/HUB_PROTOCOL.md`, `docs/HOST_ADAPTERS.md`,
> `docs/OPENCODE_REMOTE_ACP_SPEC.md`, `docs/CONTROL_PLANE_MIGRATION_
> BOUNDARY_2026-09-22.md` §1 (the four-home rule).

## 1. The plane map (as the territory actually is)

| # | Plane | Protocol | Commitment | Where |
|---|---|---|---|---|
| 1 | Model calls | **OpenAI-compatible by commitment, at the provider layer only** — agent runtime → metering proxy/vendor. Honesty nit (frontier round 1): `model-profile.ts` already ships a per-pool `wire: "anthropic"` option, so "only" describes the *commitment*, not every code path | Deliberately *below* the authority line; replaceable without touching Workflow | `opencode-agent-config.ts` (`@ai-sdk/openai-compatible` → loopback metering proxy), `goose-agent-config.ts` (goose composes `/api/v1/chat/completions`), `model-profile.ts` |
| 2 | Agent orchestration — **two transports, one rule** | (2a) **ACP** over stdio: `opencode acp`, stock `cline --acp`, contained `goose acp`; (2b) **Workflow-owned server topology**: the W071/W074 opencode-server stack (`opencode-server-{runtime,gateway,authority,...}`) fronts a contained `opencode serve` with hub-side HTTP/SSE orchestration, its own permission broker (`permission.asked → WorkflowApplication.authorize`), and the **stock OpenCode web UI — the operator-designated primary operator surface** | The orchestration bet: interception points, permission requests, session lifecycle. **The rule that keeps 2a/2b coherent** (frontier round 1): Workflow speaks server HTTP only to servers *it launches and configures*; foreign HTTP agents get the ACP-side bridge (B4), never a polyglot hub | `src/adapters/` (ACP wire/subprocess), `workflow-tui --driver acp`; `src/integrations/opencode-server-*.ts`, `opencode-v2-*.ts`, `opencode-live-state.ts`, `opencode-client.ts`; `HOST_ADAPTERS.md` ("not an ACP adapter row") |
| 3 | Control plane | **Workflow's own HTTP API** — loopback-only (`127.0.0.1`, ephemeral port, discovery-file tokens), two credential classes (operator token vs verifier credential); operational verbs (`/run/begin|review|finish`, `/review/rubric`, `/bash`, `/rsi/*`, `/schedule/*`, `/snapshot`) | Proprietary by design; small, credential-scoped, internal | `hub-http.ts` (`server.listen(0, "127.0.0.1")`), `HUB_PROTOCOL.md` |
| 3′ | Operator browser channel | **Uncredentialed loopback JSON** — the browser operator UI talks to `src/ui/web.ts` on `127.0.0.1` (default 4173; `PORT` override exists); the web service composes `WorkflowApplication` in-process and proxies plane-3 routes server-side, so the browser never holds a hub token | Threat-model-accepted loopback posture (`THREAT_MODEL.md`: "No authentication; exposing/reverse-proxying it beyond loopback is unsupported"). **Named here because it is the only channel reachable with no credential at all — not even the discovery-file read that plane 3 requires**; a per-launch token is the cheap hardening if any remote-attached ambition collides with it | `src/ui/web.ts`, `web-service.ts`, `THREAT_MODEL.md` |
| 4 | Tools/capabilities | **MCP** (stdio; toolbox-mounted) | Portable pure capabilities only (migration-boundary HOME-C); never the enforcement seat | `mcp-toolbox/`, `mcp-toolbox-guard.ts` (the vendored guard exposes exactly `guard_check`/`guard_status`) |

## 2. The vision, in one paragraph

**Authority lives in the control plane; everything a fast-moving industry
could replace is an adapter at the edge.** The kernel/application/seat stack
owns state, evidence, and mutation authorization; ACP (and the
Workflow-owned server topology for agents that ship one) owns the agent
conversation; MCP owns portable capabilities; the OpenAI-compatible surface
stays confined to the model-provider hop where it is genuinely the lingua
franca. The rule that generated this shape is the interaction test from the
migration-boundary doc: *protocols are chosen by what must cross them* —
tool-call interception and permission semantics cross plane 2 (chat
completions cannot carry them), operational verbs cross plane 3 (bearer
credential classes, not chat), portable capability calls cross plane 4
(advisory, host-enforced), and nothing about authority crosses plane 1 at
all.

## 3. The bets, stated as falsifiable claims

- **B1 (agent-session protocols):** the convergence point for *interactive
  coding agents* is session-style protocols (ACP), not chat-style ones.
  **Falsifier:** a major agent runtime standardizing on a chat-shaped agent
  API that Workflow cannot translate at parity — the adapters are isolated
  (`src/adapters/`, one per SDK family; `opencode.ts` proves a non-ACP
  adapter is viable), so the failure mode is "write one more adapter", not
  a rewrite. **Structural watch added (round 1):** the two largest coding
  agents (Claude Code, Codex) are the ACP *holdouts* (adapter-only) —
  native ACP there would validate the bet; their moving to server-mode
  distribution instead would stress it.
- **B2 (proprietary control-plane HTTP):** an internal, loopback,
  credential-classed operational API is safer than exposing a
  general-purpose or OpenAI-shaped surface. **Falsifier:** a need for
  third-party/untrusted clients to drive the hub — re-read `THREAT_MODEL.md`
  before any surface widening. (Frontier round 1: adding an OpenAI-shaped
  hub surface would be the one genuinely wrong move available.)
- **B3 (MCP for capabilities only):** MCP's value is portability of pure
  capabilities; MCP-as-enforcement-seat is rejected. **Half-triggered
  watch, named (round 1):** MCP **elicitation** is in the spec — but it is
  user-input prompting with no pre-mutation deny semantics and is
  host-mediated, so it does not trip the *pre-mutation interception* half
  of the falsifier. MCP-Apps packaging is pre-committed in §5.3.
- **B4 (remote agents):** HTTP-only agents are reachable through an
  **ACP-agent-side bridge** (draft, advisory-only M1, `OPENCODE_REMOTE_
  ACP_SPEC.md`), not by making the hub polyglot — with the §1 rule as the
  reconciliation: the hub speaks server HTTP to servers it spawns; the
  bridge speaks server HTTP to servers it doesn't. **Consolidation queued
  (round 1):** `remote-acp/{engine,projection}.ts` and
  `opencode-server-authority.ts` are two implementations of the same
  opencode HTTP/SSE event/permission mapping — share the
  upstream-client/broker layer before more code lands on either, or they
  drift.

## 4. Known costs and the honest residuals

- **ACP holdout concentration (corrected roster, round 1):** native ACP is
  broad — Gemini CLI, goose, OpenCode, Cline, GitHub Copilot CLI (Jan
  2026), OpenHands, Mistral Vibe, Auggie, Blackbox — and *holdout
  concentrated* at the two largest coding agents (Claude Code, Codex;
  adapter-only). Workflow-side, the Cline connector remains **probe-PENDING
  on stock 3.0.62** (`HOST_ADAPTERS.md` carries the verdict). The bet is
  that translation is cheaper at the adapter
  edge than authority being outside the control plane; the vendored-Cline
  SDK runtime was already retired (W050 step 6) rather than deepening that
  dependency. **Doc rot noted:** `HOST_ADAPTERS.md`'s "Current adapter
  files" table still lists the deleted `src/adapters/cline.ts` — fixing
  that table is queued (it is the citation this doc's predecessor
  inherited).
- **The remote bridge is draft/advisory**: no `enforced` claim until its
  probe plan (§10 of the spec) passes on the pinned version.
- **MCP churn**: the toolbox pins servers and re-verifies; the vendored
  guard's two-tool exposure keeps the surface small.
- **Stale-dist artifact skew** (observed in W090) is a plane-4 deployment
  cost; the queued in-process import (with the dual-surface parity
  precondition) addresses it without changing the plane's role.
- **The uncredentialed operator channel (plane 3′)** is accepted loopback
  posture today; recorded here so any future remote-attach ambition meets
  it explicitly instead of silently (per-launch token = cheap hardening).

## 5. What would make this the wrong path (pre-commitments to watch)

1. **Agent-as-server distribution** (frontier round 1, named the most
   damaging structural shift): all three supported agents now ship server
   modes (`opencode serve`, goose `serve`, Cline hub/dashboard) — eroding
   plane 2a's stdio assumption *and* the bwrap containment foundation at
   once. The hedge exists (plane 2b + B4); the watch is now structural:
   where each agent's gravity moves, not just whether the operator's host
   ships ACP.
2. If the **ask channel** (G3) cannot be delivered through the seats — the
   T1 tier is the one requirement plane 3's flat HTTP must grow (a
   structured question surface), and it is in-process work by design.
3. If **MCP-Apps-style packaging** becomes how agents consume tools+UI —
   plane 4's shape survives (MCP remains the capability wire); no authority
   moves.
4. **Agent↔UI standardization** (AG-UI/A2UI family) — presentation-layer
   stakes on plane 3′; cheap to watch, nothing to adopt yet.
5. **The operator-designated primary surface (resolved — operator comment,
   round 3):** two operator web surfaces exist — Workflow's own PWA and the
   stock OpenCode web UI behind the plane-2b gateway. **Resolution: the
   stock OpenCode web UI (included in the `workflow` launcher) is the
   PRIMARY operator surface and the way the operator is driving the system
   today — the pivot was to the vendors' default interfaces, with the
   Workflow-owned ACP-driven surface retained deliberately as the backup.**
   The gateway stack's cost is therefore justified by the designated
   primary; the retained ACP surface is the fallback, not a rival.

## 6. Verification

Focused frontier review (Kimi K3, fresh context, read-only, adversarial):
is any plane over-committed, is a plane missing, and which pre-commitment
should be reversed before more code lands on it? Round 1 verdict and
dispositions in §7; the durable verdict binding is `record_review`.

## 7. Frontier review record (Kimi K3)

**Round 1 — REVISE** (the substance validated; the record-keeping and the
map corrected):

- **Plane verdicts:** 1 SOUND (one honesty nit — the anthropic-wire option),
  2 SOUND direction / **incomplete map**, 3 SOUND (mechanics verified
  end-to-end: listen shape, credential classes, routes, discovery tokens),
  4 SOUND (guard exposure verified; MCP-Apps correctly pre-committed — it
  became an official MCP extension in Jan 2026).
- **P1 — stale base pin (the repo's own P0 class, caught twice this cycle
  by frontier reviewers):** PR #80 had merged (main `1d6f9e8`); header and
  PR-state sentence refreshed in this revision.
- **P1/P2 — the map missed the territory:** the opencode-server gateway
  stack (plane-2 sibling) and the uncredentialed browser channel (plane 3′)
  added to §1; §1's coherence rule added ("servers it launches and
  configures" vs B4's foreign-server bridge).
- **P2 — ACP roster dated:** corrected to holdout concentration (§4);
  `HOST_ADAPTERS.md`'s stale adapter table recorded as queued doc rot.
- **P2 — the watch list was operator-centric:** agent-as-server
  distribution, MCP elicitation (named as half-triggered, with the reason
  it doesn't trip the falsifier), AG-UI/A2UI, and the structural
  native-ACP-at-the-holdouts watch added to §3/§5.
- **Reversals: none** — the hub must NOT grow an OpenAI-shaped surface; ACP
  stands; the bridge stays advisory-until-probes; one consolidation
  (shared upstream-client/broker layer) and one forced operator decision
  (the two web surfaces) recorded.
- **Bottom line quoted:** *"Stay the course."*

**Round 2 — REVISE (three one-line P3s; no P0/P1/P2; zero directional
disagreement):** all six round-1 corrections confirmed — base pin re-verified
live via `git ls-remote`, the plane-2 "two transports, one rule" rewrite
named as the fix that mattered, the plane-3 mechanics, guard exposure, ACP
roster, elicitation characterization, and the forced-decision reality all
confirmed against the tree. Three P3s fixed in this revision: (a) plane 3′'s
exclusivity claim was literally false — a same-UID process can also drive
plane 3 (discovery token + verifier.json are same-UID-readable; the ordinary
token's blast radius already includes `/bash`); corrected to the true and
still-forceful distinction: plane 3′ is the only channel reachable with **no
credential at all**; (b) the roster rewrite had dropped the Cline
probe-PENDING posture pointer — restored; (c) "default 4173" and "caught
twice this cycle" nits. **Operator comment relayed (resolving §5.5):** the
stock OpenCode web UI included in the `workflow` launcher is the PRIMARY
operator surface and how the operator drives the system today — the pivot
was to the vendors' default interfaces with the Workflow ACP surface
retained as backup; §5.5 records the resolution, no longer an open
decision.

**Round 3 — confirmation of the three one-liners and the operator
resolution:** pending; appended as it occurs, before commit.
