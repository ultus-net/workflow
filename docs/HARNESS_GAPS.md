# Harness Gaps: candidates to build (C7)

**Created:** 2026-10-11. **Status of the whole document:** a roadmap of
**Planned** candidates. **Nothing described here is built.** Every section
names what exists today in this repository and what is missing; no item is a
claim that Workflow already has the feature.

**Provenance / direction.** An external research pass (2026-10-11) produced a
prioritized list of harness-engineering capabilities a coding-agent control
plane should own. The operator's direction is explicit: **build our own, do
not adopt a third-party harness.** These are gaps the control plane should
close itself so the authority stays in Workflow rather than in a vendored
product. This document captures the candidates so they can be scheduled and
tracked; it does not schedule them and does not edit `TASKS.md`.

**How to read the statuses.** This repo's honest-claims culture
(`AGENTS.md`, "Honest-claims culture") requires statuses to mean what they
say. Here every gap is **Planned**: designed direction, not built. Where an
adjacent capability already exists, the section states exactly what exists
(with a file citation) and exactly what is missing. "Partially covered" below
means *some adjacent mechanism exists and is named; the named gap does not.*

| # | Gap | Status | Nearest existing mechanism (not the gap) |
| --- | --- | --- | --- |
| 1 | Egress proxy + credential vault at the network boundary | Planned | Loopback metering proxy holds model keys; keyring/Key Vault custody is local-only |
| 2 | Append-only, vendor-neutral session/event log with replay | Planned | Per-surface bounded/in-memory journals; OpenCode-v2 event log is in-memory |
| 3 | Skill/plugin supply-chain install gate | Planned | Build-time `vendor-skills` + sha256 fleet manifest; no runtime install vetting |
| 4 | Per-tool / per-MCP-server authorization at discovery | Planned | Per-call guard + capability classes; no discovery-time tool/server gate |
| 5 | Fleet observability: OTel GenAI spans + tool-return inspection | Planned | Metering usage + egress ledger; prompt-seat unicode strip only |
| 6 | Code-execution / progressive-disclosure tool surface | Planned | Skills metadata-only discovery; no code-mode tool path |
| 7 | Evidence lineage wired into task states | Planned | Kernel evidence gates + W072 ledger audit; claims advisory, lineage incomplete |
| 8 | Cost governance with agent-level semantics | Planned | Session/run budget caps + per-task metering; no per-agent semantics |
| 9 | Harness-regression evals on model upgrade | Planned | W057 assumption ledger + probes; operator-invoked, no run recorded |

---

## 1. Egress proxy + credential vault at the network boundary

**What it is.** A single allow-listed egress proxy that holds real tokens and
attaches them to outbound requests at the network boundary, so the credential
value never enters the sandbox (agent process, tool process, or MCP stdio
server environment).

**Why it matters.** The capability-grant framing in
`docs/EGRESS_CAPABILITY_AUDIT.md` (function/token granularity, Cowork
incident) shows that holding a credential inside the agent's reach is a
laundering surface: an agent-supplied key can route a request under the
attacker's identity, and a credential materialized into a child process is
readable by that process.

**Current-state evidence in this repo.**

- The model-traffic boundary exists and is real, for model traffic only:
  `src/integrations/model-usage-proxy.ts` is a loopback metering proxy that
  holds the real upstream key and rewrites the inbound `authorization` header
  before forwarding; agents receive the placeholder
  `workflow-metered` (`src/integrations/egress-credential.ts:22`).
- Two pure credential gates exist: `checkEgressCredential`
  (`src/integrations/egress-credential.ts:63`, token provenance) and
  `checkCredentialEndpoint` (`src/integrations/egress-credential.ts:125`,
  destination scoping against `CredentialDefinition.allowedEndpoints` in
  `src/integrations/credentials.ts:15`).
- A parent-side forward proxy exists for the `network: "proxied"` containment
  posture: `src/integrations/egress-forward-proxy.ts` (W183). Its own header
  states the honesty boundary: it gates **proxy-passed** traffic only, and a
  process that opens a raw socket is not fenced.
- Custody adapters exist: `src/integrations/credentials.ts` (`SecretStore`
  port, `createCredentialControlPlane`), `src/integrations/key-vault.ts`
  (W156 Azure Key Vault backend, managed identity / azure-cli token chain).
- MCP credentials are materialized **into the child process environment**:
  `src/integrations/credential-mcp.ts:8` (`materializeMcpEnvironment` writes
  each value into `env[VARIABLE]`), consumed by
  `src/integrations/mcp-toolbox-guard.ts`.
- The egress ledger (`src/integrations/egress-ledger.ts`) is append-only but
  **advisory evidence, not enforcement** (its header states this).

**What is missing.** The operator already uses Azure Key Vault, but Key Vault
is only valid where it is installed locally (managed identity / IMDS at the
host). **Proxy-side credential attachment for non-model, arbitrary egress is
the actual gap.** Today a general-purpose credential reaches the consuming
process in its environment (`materializeMcpEnvironment`); there is no single
allow-listed proxy that attaches credentials to tool/non-model egress at the
network boundary with the value never leaving the proxy. The model lane has
this property; the general egress lane does not.

**What "build our own" means concretely.** Extend the proxy-side attachment
discipline from the model lane to all agent egress: one allow-listed proxy
that (a) receives only a reference/placeholder from the sandbox, (b) resolves
the real value from the custody port at the proxy, (c) applies the existing
two credential gates, and (d) attaches at the boundary. Retire
value-into-child-env materialization for anything that can route through the
proxy.

**Status.** **Planned.** No proxy-side attachment for general egress exists.

---

## 2. Append-only, vendor-neutral session/event log with replay

**What it is.** One append-only, vendor-neutral log of session and event
history with deterministic replay, serving four needs: crash recovery,
cross-harness continuity (OpenCode / Cline / goose all writing one log), audit,
and deterministic replay of a run.

**Why it matters.** The control plane's authority is only as good as its
history. A vendor-shaped, in-memory, or evicting journal cannot replay a run
after a crash, cannot carry continuity across a harness switch, and cannot
furnish a durable audit trail.

**Current-state evidence in this repo.**

- `src/integrations/opencode-v2-event-log.ts` is an append-only event journal
  with a `replay()` method, but it is **in-memory** (`readonly #entries`
  at line 39) and **OpenCode-v2-specific** (its interface is built from
  OpenCode SSE frames; `consumeOpenCodeV2EventStream` at line 60).
- `src/review/provenance.ts` binds a review verdict to a fingerprint
  (commit + prompt/manifest/partition/rule-set digests) and
  `src/integrations/review-provenance-store.ts` persists those records as
  append-only NDJSON with a bounded trim. This is a **review-specific**
  journal, not a session/event log.
- The hub run registry (`src/integrations/run-registry.ts`) keeps several
  bounded journals in memory: `taskUsage` (FIFO 64, line ~331),
  completion claims (bounded 64), run usage (bounded 64). These are
  hub-epoch, evicting, and per-surface.
- `docs/DURABLE_STATE_INVENTORY.md` states the hub task graph is
  **in-memory per process** and that `JsonWorkflowStore`
  (`src/application/persistence.ts`) is not composed in current surfaces.

**What is missing.** A single vendor-neutral append-only session/event log
with deterministic replay. What exists is per-host (OpenCode-v2), in-memory,
or bounded/evicting; there is no cross-harness unified history that survives a
crash or a harness switch.

**What "build our own" means concretely.** Define a harness-neutral event
envelope (session, turn, tool call, evidence, transition) and an append-only
durable store with a replay reducer, then have every adapter emit into it.
Deterministic replay is the test: same log in, same reconstructed state out.

**Status.** **Planned.** No vendor-neutral durable event log exists.

---

## 3. Skill/plugin supply-chain install gate

**What it is.** Runtime vetting at install time for skills and plugins an
agent (or operator) installs: signature/checksum verification, provenance
attestation, and an allowlist, enforced before the artifact becomes
model-reachable.

**Why it matters.** Skills and plugins are instructions and code that reach
model context and execution. `docs/DURABLE_STATE_INVENTORY.md` classifies
skills as operator/external-writer content that **reaches model context**;
without an install gate, a compromised or typosquatted skill package installs
silently.

**Current-state evidence in this repo.**

- Skills are delivered through `mcp-toolbox/apps/skills-mcp`:
  `src/skills.ts` does metadata-only discovery, on-demand `read_skill`,
  skips symlinked directories on purpose (a listed-but-unreadable skill would
  be a lie), and enforces pedagogical level gating
  (`gateSkills`, `skillReadableAt`).
- `scripts/vendor-skills.mjs` vendors curated skills **at build time** with a
  `vendor-skills.json` provenance record; it is operator-invoked, not a
  runtime gate.
- `src/integrations/fleet-payload.ts` (W086) vendors fleet assets with a
  committed sha256 manifest, again **build-time/PR-reviewed**, and its own
  header says the assets are versioned source audited by PR review.
- `src/integrations/toolbox-catalog.ts` is a static manifest of vendored MCP
  apps, executed against the real tree by `test/toolbox-catalog.test.ts`.

**What is missing.** Runtime install-time vetting. Everything above is
build-time or operator-invoked: there is no check that verifies a
signature/checksum at install, no provenance attestation gate, and no
allowlist enforced when an artifact is installed at runtime.

**What "build our own" means concretely.** An install gate in the skills/
plugin delivery path that verifies provenance (signature or pinned checksum)
and refuses unsigned/unlisted installs, fail closed, before the artifact is
surfaced by `skills-mcp` or composed as a plugin.

**Status.** **Planned.** No runtime install gate exists.

---

## 4. Per-tool / per-MCP-server authorization at a gateway choke point

**What it is.** Authorization decided per tool and per MCP server at a single
gateway choke point, **enforced at discovery time** (which tools/servers an
agent may even see), not only per call.

**Why it matters.** Per-call gating still advertises every tool to the model,
which forces the model to know and reason about tools it is not permitted to
use, and leaves the discovery surface unaudited. A discovery-time choke point
makes the granted tool set the visible tool set.

**Current-state evidence in this repo.**

- Capability classes exist and default-deny: `THREAT_MODEL.md:22` states
  `WorkflowApplication` allows `read`/`mutation` and denies `process`,
  `credentials`, `network` unless granted.
- The guard runs per call, after kernel authorization:
  `src/integrations/opencode-plugin.ts` (`tool.execute.before` →
  `application.authorize` → guard) and the shared mapping
  `guardInputFromToolCall` (`src/integrations/mcp-toolbox-guard.ts:331`).
- The guard provider lists tools (`client.listTools()` at
  `src/integrations/mcp-toolbox-guard.ts:91`) but exposes all of them.
- A gateway choke point exists for route classes:
  `src/integrations/opencode-server-gateway.ts` is a loopback reverse proxy
  that qualifies routes (`qualifyOpenCodeV2Route`) and enforces a mandatory
  broker hook in the enforced posture, but its route classes are protocol
  routes, not per-tool/per-server discovery authorization.

**What is missing.** Per-tool and per-MCP-server authorization **at discovery
time**. Today authorization is per call on the wired hosts, and the gateway
qualifies routes, not tool/server visibility.

**What "build our own" means concretely.** Extend the gateway to gate the
`tools/list` (and per-server) discovery surface: an agent is shown only the
tools/servers its authorization grants, fail closed. The per-call guard stays
as defense in depth.

**Status.** **Planned.** No discovery-time per-tool/per-server gate exists.

---

## 5. Fleet observability: OTel GenAI spans + live tool-return inspection

**What it is.** Two observability capabilities: (a) OpenTelemetry GenAI spans
for fleet-wide traces, and (b) live inspection of tool-return payloads for
injection before those payloads enter model context.

**Why it matters.** (a) A fleet without a standard trace substrate cannot be
correlated across hosts and runs. (b) `THREAT_MODEL.md` records injection
pressure; tool returns are a prime carrier, and scanning them at the boundary
is the seat that stops injection from entering context.

**Current-state evidence in this repo.**

- No OpenTelemetry dependency exists: `grep -i opentelemetry package.json`
  returns nothing, and no span/traceparent code exists in `src/`.
- Metering and observability today are bespoke: the metering proxy records
  usage (`src/integrations/model-usage-proxy.ts`), the egress ledger records
  reaches/rejections (`src/integrations/egress-ledger.ts`), and the hub
  surfaces run gates via `/snapshot` (`src/integrations/hub-http.ts`).
- A prompt-injection control exists at the **prompt seat only**:
  `src/application/text-hygiene.ts` (W138) strips named hidden-Unicode classes
  from operator/authority prompts. Its own header calls it "the control-plane's
  first seat against it, NOT a solve." It does **not** scan tool outputs.

**What is missing.** Both capabilities. There are no OTel GenAI spans and no
live tool-return inspection for injection. `text-hygiene` strips prompt text,
not tool returns.

**What "build our own" means concretely.** Emit OTel GenAI spans from the
runtime/tool boundary into a trace exporter, and add a tool-return inspection
seat (named-class + policy checks, value-free logging) that runs before a tool
result is admitted to model context.

**Status.** **Planned.** Neither capability exists.

---

## 6. Code-execution / progressive-disclosure tool surface

**What it is.** A code-mode tool surface where the model writes code that
calls tools, instead of emitting one tool call per step, so context cost stays
bounded as the toolbox grows, with the guard able to see the plan the code
encodes.

**Why it matters.** The toolbox is large (15 vendored MCP apps,
`src/integrations/toolbox-catalog.ts`). Per-tool-call interaction blows context
as the surface grows. `mcp-toolbox/PLAN.md:197` states the principle: durable
knowledge should be retrieved progressively, with bounded references the
harness loads just in time.

**Current-state evidence in this repo.**

- Progressive disclosure exists for **skills only**: `skills-mcp` does
  metadata-only discovery and a content-costing `read_skill`
  (`mcp-toolbox/apps/skills-mcp/src/skills.ts:5`).
- `mcp-toolbox/PLAN.md:197` and `:195` articulate the progressive-disclosure
  intent as a design principle, not an implementation.
- The guard sees tool calls one at a time via `guardInputFromToolCall`
  (`src/integrations/mcp-toolbox-guard.ts:331`).

**What is missing.** Any code-mode tool path. There is no execution surface
where the model writes tool-invoking code, and no guard view of a plan
expressed as code.

**What "build our own" means concretely.** A sandboxed code-mode executor
whose tool bindings are the authorized tool set, plus a guard integration that
inspects the submitted code/plan before execution. Progressive disclosure of
tool metadata is the retrieval half; code mode is the execution half.

**Status.** **Planned.** No code-mode path exists.

---

## 7. Evidence lineage wired into task states

**What it is.** Task completion ("done") requires observed artifacts, with
lineage from each completed state back to the environment-produced evidence
that backs it, not a model assertion.

**Why it matters.** The kernel's core promise is "nothing advances without
fresh evidence." Where completion can rest on an assertion, the promise
weakens.

**Current-state evidence in this repo.**

- The kernel models this: `src/kernel/contracts.ts` defines
  `EvidenceRequirement`, `Evidence` (with `authority`, `freshness`,
  `mutationEpoch`, and an optional bounded `EvidenceContentRef`), and
  `StepState` requires "Fresh passing evidence … before the step can be
  COMPLETED" (`contracts.ts:149`). `EvidenceAuthority` excludes `operator`/
  `claim` by construction (`contracts.ts:19`), so an assertion cannot be
  minted as evidence.
- `src/review/rubric.ts` and `src/review/ledger-audit.ts` implement the W072
  I-5 deterministic ledger-vs-diff audit: a COMPLETED step whose content no
  changed path backs is surfaced (`LedgerAuditFinding`, "advisory, never a
  gate").
- `src/integrations/run-registry.ts` journals completion claims with whether
  the task was VERIFIED at claim time, journaled, "never blocks."
- `docs/FEATURES.md:57` records that session/interactive tasks are created
  with `requiredEvidence: []`.

**What is missing.** End-to-end lineage wiring. Completion claims are
advisory-only; the ledger audit is advisory; interactive tasks carry no
required evidence. There is no enforced chain from a "done" state to the
observed artifact that produced it.

**What "build our own" means concretely.** Give each advancing state a
required evidence binding (subjects + producing authority) that the
environment satisfies, and refuse advancement without the observed artifact.
Extend the existing kernel gates to the interactive lanes.

**Status.** **Planned.** Evidence gates exist at the kernel; the enforced
lineage into task states does not.

---

## 8. Cost governance with agent-level semantics

**What it is.** Cost caps and attribution expressed in agent terms (per agent
identity/role), beyond per-session, per-run, and per-task accounting.

**Why it matters.** Without agent-level semantics, spend cannot be governed or
attributed by who/what is spending (an exploratory agent versus a fixer), only
by the run it landed in.

**Current-state evidence in this repo.**

- Session/run budget caps exist: `src/integrations/session-budget.ts`
  (env caps per axis, abort/warn tiers, downgrade config, a server-side
  OpenRouter per-key credit backstop; `createSessionBudgetGuard`).
- Metering exists: `src/integrations/model-usage-proxy.ts` records usage;
  `src/integrations/task-usage.ts` computes per-task boundary deltas and
  records `UNATTRIBUTED_TASK_ID` rather than guessing a task.
- The run registry records per-run usage (`runUsage`) and per-task usage
  (`taskUsage`).
- `session-budget.ts:66` records which enforcement mechanism is active so the
  hub surfaces it.

**What is missing.** Agent-level semantics. Attribution is per
session/run/task; there is no per-agent-identity budget or attribution, and
`task-usage.ts:1` records that the host lanes that call the tracker are still
an open decision.

**What "build our own" means concretely.** An agent-identity dimension on the
budget and usage records (per agent role/identity), with caps and rollups
computed over it, and the lane wiring `task-usage.ts` defers.

**Status.** **Planned.** No agent-level cost semantics exist.

---

## 9. Harness-regression evals on model upgrade

**What it is.** An eval suite that runs on every model bump and re-tests
whether each piece of harness scaffolding still earns its keep, re-simplifying
the harness as models improve.

**Why it matters.** Harness scaffolding encodes assumptions about model
weaknesses; those assumptions expire. `docs/HARNESS_ASSUMPTION_LEDGER.md`
states the principle directly: assumptions expire as models improve, and the
ledger makes them explicit and testable.

**Current-state evidence in this repo.**

- `docs/HARNESS_ASSUMPTION_LEDGER.md` (W057) exists: it lists current
  scaffolding components with assumed weaknesses, evidence, and owners, and
  fixes an **operator-invoked** model-bump audit procedure. Its "Audit log"
  states: "No operator-run audits recorded as of 2026-09-19."
- The ledger cites a smoke harness, `npm run style:eval`
  (`src/cli/style-eval.ts`), marked N=1 smoke-grade. **Honest correction:** on
  this branch that CLI does not exist: it was added in commit `4e762f31` and
  removed in the W050 step-6 retirement (`d2300f22`); `package.json` has no
  `style:eval` script. So even the smoke indicator the ledger names is absent
  here (the ledger is dated 2026-09-19 and is append-only).
- Per-version probes exist for host qualification: `docs/HOST_ADAPTERS.md`
  and the gated `test/acp-*-probe.test.ts`.

**What is missing.** An automated, durable harness-regression eval suite. The
assumption ledger's audit is a manual operator-invoked procedure with no run
recorded, and the `style:eval` smoke indicator it cites is not even present on
this branch.

**What "build our own" means concretely.** Turn the ledger's manual audit into
a runnable eval harness: a fixed task set plus cost and quality metrics, run on
every pinned-version bump, recording keep/strip/narrow decisions in the
append-only audit log.

**Status.** **Planned.** No automated harness-regression eval exists.

---

## Verification of this document

- Every file path cited above was confirmed to exist in this branch at
  authoring time.
- No code was changed by this document (docs-only); `npx eslint src test` is
  unaffected.
- Statuses are **Planned** throughout; no existing feature is claimed.
