# Agent routing and switching across the TUI and web frontend

## Goal

Let the operator direct requests to the right agent and switch agents from either surface — without moving workflow truth out of the hub. The routing policy encodes the operator's role split: **OpenCode stays the coding lead; goose (once qualified) becomes the assistant and recurring-jobs runtime** — conversational, ops, and scheduled workloads on one agent, refactors on the other; the reviewer role goes to whichever qualified runtime the hub designates.

Two facts shape the design. An ACP session is bound to its agent process (G4 evidence: `session/load` is per-agent and context restore is agent-specific), so "switching agents" is never rebinding a live session — it is session-level selection. And the session manager already proves the hard switch semantics (refuses to switch while a turn runs, serializes concurrent switches, denies parked prompts on switch, persists its registry) — this plan extends, not replaces.

## Decisions

- **AgentRegistry (application layer, net-new).** One entry per qualified `acpAgentKind`: its HOST_ADAPTERS conformance row (spawn-gated, mounts honored, usage streaming, enforced-eligibility), its config writer (the `opencode-agent-config.ts` pattern per agent), and its provider composition (opencode → OpenRouter through the metering proxy; goose → OpenRouter or direct Azure AI Foundry per the goose plan). The conformance matrix becomes load-bearing at runtime instead of documentation-only. The kernel stays agent-agnostic; the registry sits beside the session manager.

- **Switching is session-level selection.** The `/` menu gains a hub-owned `Agent: opencode | goose | cline` toggle — deliberately not an ACP `configOption` (those are agent-advertised per-session; agent selection is hub-owned like mode/speech/build). Selecting it means session-manager switch: new session bound to the target runtime, mid-turn switch refused, parked prompts denied (all existing rules). The mode bar projects the active agent and its enforcement posture; `enforced` and `advisory` stay visibly distinct per the PRODUCT.md invariant. The web UI's session-create routes gain an `agent` field resolved through the same registry, with the runtime label projected per session.

- **Optional handoff bridge.** "Switch agent" may carry context: export the running session's transcript (Ctrl+E export already exists) and inject its summary as the new session's first prompt — the `handoff` skill's pattern. A small bridge reusing three existing surfaces.

- **Routing levels, in build order.**
  1. *Operator hint* — an `@goose:`-style mention or `/agent` prefix, parsed hub-side before submit; ordinary keys stay with the composer (TUI rule).
  2. *Capability routing* — a request's required capabilities resolve to registry entries whose matrix rows qualify; fail-closed when none does (a spawn-requiring task can never silently land on a non-gated agent).
  3. *Role routing* — the operator's split: assistant/conversational/ops queries and recurring jobs route to the goose runtime; coding/refactoring routes to OpenCode; the reviewer runs on a designated headless runtime (goose headless is the candidate once its probes pass). Provider routing composes per role: cheap OpenRouter models for assistant/recurring work, frontier models for coding.
  4. *Task-graph routing (last)* — tasks may declare an agent requirement as a constraint string the application resolves against the registry; the kernel contract is untouched.

- **Scheduling authority stays hub-side.** The hub already owns scheduled turns end-to-end (schedule fires → contained turn → reviewer → test evidence → VERIFIED, `test/hub-scheduled-turn-probe.test.ts`). goose's own scheduling surface — the `schedules/*` ACP methods and `goose serve --enable-scheduler` — stays disabled/denied in hub-composed runtimes: two schedulers is a conductor conflict, and unattended goose-internal recipe runs would bypass the hub's authorization and evidence chain. The composition instead: the hub owns the WHEN (its scheduled chain), goose recipes own the WHAT (parameterized workflow payload submitted as the turn's prompt, via `GOOSE_RECIPE_PATH` pointing at hub-approved recipe directories inside the workspace), and the recipe's success criteria align with the hub's verify command and evidence gate.

- **Webhook gateways: two front doors, split by authority class.** goose ships a pluggable inbound gateway surface — `goose gateway start <platform>` with secure pairing and persistent auto-compacting sessions (Telegram first, aaif-goose/goose PR #7199) — and its integration gateways are webhook-based. The boundary rule is two-tier, matching what the traffic is authorized to do:
  - *Advisory, read-mostly assistant chat MAY run on a direct goose gateway instance* under hardening conditions: its own `GOOSE_PATH_ROOT` composition (never the operator's config), metering through the loopback proxy, a capped tool posture (`GOOSE_MODE=chat` or a read-only `available_tools` set), and an explicit advisory label — it must never appear equivalent to an enforced surface (PRODUCT.md invariant). Direct mode cannot provide hub authorization, workspace confinement, evidence, or per-task skill gating, and this plan says so plainly rather than implying parity.
  - *Mutating work and recurring jobs terminate at the hub, full stop.* Authorization, guard dispatch, containment, and evidence are non-negotiable for authority-carrying traffic; goose permission prompts to the operator are operator-approval, not policy. The hub owns the WHEN of scheduled work (its VERIFIED chain); recipes remain payload.
  - Webhooks need an inbound port: the hub-owned receiver is the hardened webhook surface (pairing, signature/payload validation — untrusted input —, dispatch authorization), built beside the web UI's guarded-route discipline. A direct goose webhook listener exposed on the host is a THREAT_MODEL hole, recorded as such; the receiver and any direct chat door both land as THREAT_MODEL entries before either ships.

## Contracts

- Session-manager rules reused verbatim; no kernel changes; no new `TranslatingHostAdapter`.
- Switching mid-task invalidates the task's enforced claim exactly like a mutation-epoch invalidation — the active agent's capability row re-gates or refuses, never silently downgrades.
- Every registry entry's matrix row is probe-derived (Green/Red per probe, never aggregate); an agent without a passing enforcement-relevant row cannot receive enforcement-requiring work.
- The TUI and web surfaces project the same registry state — UI is projection only.

## Follow-ups

- Sequence: registry + TUI agent toggle + web `agent` field first (two agents already justify it); goose becomes the third registry entry when its probe family passes (the merged goose qualification plan); reviewer-as-goose is the first genuinely routed role; task-graph requirements last.
- THREAT_MODEL entry for the hub-owned webhook/gateway receiver before any external trigger lands (pairing, payload validation, dispatch authorization).
- Handoff-bridge ergonomics (what the exported summary includes) defer to implementation review.
- If assistant traffic outgrows terminal sessions, evaluate a hub-owned gateway frontend (Telegram via the hub's receiver) rather than exposing goose's gateway directly.