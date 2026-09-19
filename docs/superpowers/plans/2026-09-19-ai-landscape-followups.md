# AI-landscape follow-up plans — one plan per research item

**Plan date:** 2026-09-19. **Status:** DRAFT for operator review — nothing here is scheduled, accepted, or promoted to `TASKS.md`. Each item becomes a W-numbered task (next free numbers, W051+) only after the operator's review; numbering below is a proposal to make review concrete.

**Provenance:** derived item-by-item from `docs/AI_LANDSCAPE_RESEARCH.md` (2026-09-19 desk research; web-verified, independent-reviewed). Where the research doc listed a §5 toolbox candidate and a §6 control-plane item as two faces of the same work (e.g. supervisor layer), they are merged into one plan here to avoid duplicate W-numbers. Build-first operator preference (2026-09-19) applies throughout: third-party MCP servers are capability references, not adoption targets; deliverables are first-party toolbox products or Workflow-core changes. Every §5/§6 research item maps to a W-number below or to an explicit disposition (see "Explicit dispositions" after W069).

**Cross-cutting honest-claims rules for every item below:**

- Nothing here changes any surface's `advisory`/`enforced` status. Anything that would touch an enforcement claim is gated behind the per-version probes (`docs/HOST_ADAPTERS.md`) and lands only through those gates.
- Every new toolbox product starts `advisory` by construction: its outputs are evidence with documented trust boundaries, never authority. Policy remains `workflow-guard-mcp`'s; enforcement remains the WorkflowApplication/hub integration.
- New models in the routing pool change probe expectations, not claims: an agent version bump without a probe re-run caps that surface `advisory`. The harness-assumption audit (W057) is *offered* at every bump as an operator-invoked procedure — available on every bump, run only when the operator invokes it. This is a deliberate softening of the research doc's §6.7 per-bump cadence, recorded here so the softening is dated, not silent.

**Proposed Phase 12 heading (for TASKS.md, on approval):** `Phase 12: AI-landscape follow-ups (2026-09 research)` containing W051–W069 below.

---

## Group A — P1 security architecture (named incident classes)

### W051 (proposed) - Pre-trust parsing audit across all surfaces

**Objective:** Prove (or fix) that no surface parses or executes project-local configuration, skills, or tool discovery inputs before operator trust is established — the incident class Anthropic disclosed (repo-local `.claude/settings.json` hooks executing pre-trust; three CVE-class issues).

**Research basis:** `AI_LANDSCAPE_RESEARCH.md` §3.1 ("everything before the trust dialog"), §6.1.

**Approach sketch (slices):**
1. Inventory: enumerate every path where project-local files are read at startup or session-open (TUI/launcher, hub, ACP drivers, `skills-mcp`/toolbox discovery, AGENTS.md/SKILL.md ingestion, toolboxes' workspace scans). Output: a table of read-path → trust-state.
2. Classify each path as post-trust, pre-trust-but-inert, or pre-trust-and-consequential; the third category is the finding.
3. Fix consequential paths: defer parsing/execution until the trust gate (or make them inert by construction); treat project-open, config-load, and localhost listeners as untrusted internet input.
4. Add regression tests proving the ordering (fixture repo with a poisoned project-local config; assert no parse/execution before trust).

**Depends on:** none. **Estimated size:** small-medium (audit + targeted fixes).

**Acceptance criteria:**
- [ ] Inventory table exists with every project-local read path and its trust state, reviewed into the docs tree.
- [ ] No consequential pre-trust parse/execution remains (each is fixed or has an operator-accepted risk record).
- [ ] Regression tests fail if a pre-trust read is reintroduced on an inventory-covered path.

**Verification:** focused tests on the new ordering tests; `npm run lint` + typecheck on touched code; audit table reviewed in the plan doc's follow-up.

**Honest-claims note:** pure harness hardening; no claim changes. If fixes touch adapter parsing, re-run the affected ACP probes (fail-closed on malformed safety metadata is already the adapter rule).

### W052 (proposed) - Egress as a capability grant + egress evidence ledger

**Objective:** Reframe and harden egress policy: an allowlisted destination is a grant of every function reachable on it, not "this domain is okay." Add token-bound egress checks at the boundary where they are enforceable and a capability-reach ledger (`egress-audit-mcp`, §5.1 of the research doc) so exfiltration-via-approved-domain becomes detectable everywhere and blockable at the enforced boundary.

**Research basis:** §3.1 (Cowork approved-domain exfiltration; defensive MiTM proxy passing only the VM's own provisioned session token), §4.2, §5.1, §6.2.

**Approach sketch (slices):**
1. Audit current hub-proxy + containment egress behavior against the capability-grant model: enumerate what functions each allowlisted destination exposes (model APIs, file uploads, webhooks). Honest scope note: non-model egress on a `network=host`-class path bypasses the proxy — the ledger detects, only the enforced boundary blocks; residuals are recorded, not wished away.
2. Design token binding: outbound requests that carry operator-relevant authority must present a hub-provisioned session token; attacker-supplied keys are rejected at the proxy. Where full MiTM is impractical, record the residual honestly in `THREAT_MODEL.md`.
3. Build `egress-audit-mcp` (first-party): append-only, read-only ledger of domain/function/token reaches with anomaly flags (new function class on known domain, non-session token observed). Advisory evidence product; enforcement stays with the proxy/policy layer.
4. Amend `THREAT_MODEL.md` with the capability-grant framing and the new residual risks.

**Depends on:** none strictly; composes with the credential custody work (2026-09-16 plan) for token provenance. **Estimated size:** medium.

**Acceptance criteria:**
- [ ] Egress audit document maps every allowlisted destination to its reachable functions, including the bypass note for non-proxied paths.
- [ ] Token-bound rejection demonstrated by tests at the boundary where it is enforceable; any advisory-only parts labeled advisory.
- [ ] `egress-audit-mcp` exists under `mcp-toolbox/apps/` with bounded storage, leveled logs, and README documenting trust boundaries; `pnpm run verify` green.
- [ ] `THREAT_MODEL.md` updated with capability-grant posture and residuals.

**Verification:** unit tests for token binding and anomaly flags; toolbox `pnpm run verify`; focused hub-proxy tests.

### W053 (proposed) - Behavioral supervisor layer (trajectory capture, classification, control metrics)

**Objective:** Add the missing supervision layer above shape-validation: bounded capture of agent trajectories, classification of flagged events (overeagerness vs misinterpretation vs adversarial vs benign), and coverage/recall/time-to-response metrics — the pattern all four researched control planes share.

**Research basis:** §3.3 (Google AI Control Roadmap: 1M trajectories, majority overeagerness, D1–D4/R1–R3 ladder), §3.4 (OpenAI production misalignment monitoring; auto-mode 83%/0.4%/17% stats), §3.1, §5.1 (`trajectory-supervisor-mcp`), §6.3.

**Approach sketch (slices):**
1. Deterministic first: rule-based detectors over already-captured hub events (un-projected mutations, repeated denial retries, scope drift, egress anomalies from W052's ledger). No model in the loop.
2. Define the metrics pipeline: coverage (fraction of trajectory monitored), recall against a seeded incident corpus, time-to-response. Instrument as hub counters; expose in monitor TUI.
3. Optional second stage (gated): small-model classifier over redacted trajectory summaries, running as an advisory tool — never a decision-maker; findings route to `review-accountability-mcp` and the run registry.
4. Product surface: `trajectory-supervisor-mcp` under `mcp-toolbox/apps/` (capture + classify + report), advisory-first.
5. Record where Workflow sits on Google's D/R ladder today, and what raises the level.

**Depends on:** W052 (egress anomalies feed the classifier); independent otherwise. **Estimated size:** medium-large.

**Acceptance criteria:**
- [ ] Deterministic detectors cover at least the four rule classes above with tests seeded by a fixture corpus.
- [ ] Coverage/recall/time-to-response are computed and visible; recall measured against the seeded corpus, not asserted.
- [ ] `trajectory-supervisor-mcp` ships advisory with documented trust boundaries; model-classifier stage (if built) is opt-in and cannot gate transitions.
- [ ] D/R positioning note appended to `docs/SECURITY_ASSURANCE.md` with the assurance checker green after the append.

**Verification:** focused tests for detectors and metrics; toolbox `pnpm run verify`; `test/security-assurance.test.ts` green; the metrics recall number appears in test output as evidence.

### W054 (proposed) - Memory-poisoning defenses for durable agent state

**Objective:** Treat persistent agent-facing state (project-memory records, task artifacts, tasklists, scheduled-agent state, skills) as a classic persistence/exploitation surface: reload-time validation/attestation, provenance stamps, canaries.

**Research basis:** §3.1 ("persistent memory poisoning": injections landing in durable state reload every session; startup classifiers will need to become commonplace), §4.8, §6.4.

**Approach sketch (slices):**
1. Enumerate durable state that reaches model context on session start (per surface). Classify each by writer authority (operator, agent, external evidence).
2. Add provenance stamps to `project-memory-mcp` records and continuity artifacts (writer identity, origin surface, timestamp) — already partially present in the review/verification accountability design; extend to all model-visible durable state.
3. Startup attestation: session-start validation pass over durable state with deterministic rules (unexpected writer, untrusted-origin content, known-canary hit), reporting findings to the operator and the run registry before the first turn.
4. Canary strings in investigation surfaces (review tooling, probe fixtures) so agent-read content is detectable when it reappears.
5. Residual-risk update in `THREAT_MODEL.md` (attestation validates structure/provenance, not truth — same admission principle as evidence).

**Depends on:** none; composes with W053 findings routing. **Estimated size:** medium.

**Acceptance criteria:**
- [ ] Durable-state inventory with writer authority recorded.
- [ ] Provenance stamps present on all model-visible durable state; missing stamps fail loudly, not silently.
- [ ] Startup attestation runs before first turn and surfaces findings; a poisoned-memory fixture is flagged at startup by test.
- [ ] Canary mechanism demonstrated end-to-end.

**Verification:** focused tests (startup attestation, provenance round-trip); `THREAT_MODEL.md` checker stays green.

---

## Group B — P2 capability upgrades aligned to the kernel

### W055 (proposed) - Acceptance contracts negotiated before execution

**Objective:** Turn verification planning into a negotiated, evidence-bearing artifact *before* `READY → IN_PROGRESS`: the agent proposes what it will build and how success will be verified; a separate skeptical evaluator persona (review control plane) ratifies it; execution then grades against the contract.

**Research basis:** §3.2 (Anthropic sprint contracts; evaluator separation beats self-evaluation), §5.1 (verification-accountability extension), §6.5. The `verification_strategy_defined` predicate is a *proposal* in root `llm-enhancements.md`, not kernel code — this item is its route into the kernel, if the operator accepts.

**Approach sketch (slices):**
1. Kernel-level contract type (pure, no IO/UI/SDK imports per the kernel purity rule): objective, scope, proposed-verification list, thresholds; ratification record. Legal-transition change: `IN_PROGRESS` requires a ratified contract only where configured — opt-in per task/risk class, with the legacy behavior explicit and unchanged elsewhere.
2. Negotiation flow in the review control plane: proposal → evaluator critique (separate prompt persona, few-shot calibrated per §3.2) → iteration → ratification record stored as evidence.
3. Grading: evaluator grades against the contract post-execution; failures reopen `VERIFYING → FAILED` (existing transition, no new machinery).
4. Config gate: contracts required/optional per risk class (pedagogy modes can start optional).

**Depends on:** none; W053's optional classifier stage reuses this persona tuning. **Estimated size:** medium-large.

**Acceptance criteria:**
- [ ] Contract + ratification contracts defined in the kernel with purity-rule-compliant types and boundary validation tests (model prose cannot satisfy a contract — only a ratified record can).
- [ ] Negotiation loop demonstrable in a focused test (propose→critique→revise→ratify).
- [ ] With contracts required, a task cannot enter `IN_PROGRESS` without a ratified record; with optional, behavior is byte-for-byte unchanged (regression test).
- [ ] `docs/FEATURES.md` status-matrix entry with honest statuses.

**Verification:** kernel contract tests (pure domain); focused application-layer tests; lint/typecheck.

### W056 (proposed) - Cross-window continuity: notes across compaction + searchable window archive

**Objective:** Move from single-summary compaction to notes that survive compaction verbatim plus a token-bounded searchable archive of earlier windows — the Codex/Astra pattern — built on the existing compaction↔memory bridge.

**Research basis:** §3.4 (Codex "keep notes across context windows… earlier context windows remain searchable"), §3.2 (structured handoff artifacts for context resets), §5.1, §6.6.

**Approach sketch (slices):**
1. Note ledger: agent-writable, bounded, durable notes with provenance (W054 stamps), session-scope unless promoted to durable facts.
2. Window archive: bounded, redacted capture of pre-compaction context stored per session; a search tool with token-budgeted queries; retention/size caps configurable.
3. Compaction bridge update: on compaction, notes are preserved verbatim (not re-summarized) and the archive pointer is injected.
4. Context-reset handoff artifact remains supported for long builds (heavy tool, per §3.2).
5. Measure the token-cost curve; document when archive search beats re-browsing.

**Depends on:** W054 (provenance stamps). **Estimated size:** medium.

**Acceptance criteria:**
- [ ] A note written pre-compaction is readable verbatim post-compaction (test).
- [ ] Archive search returns bounded, token-accounted results; retention cap enforced by test.
- [ ] No silent context growth: token overhead measured and recorded in the item's evidence.

**Verification:** focused integration tests around the compaction bridge; memory-mcp verify suite.

### W057 (proposed) - Harness assumption ledger + model-bump audits

**Objective:** Make "harness components are assumptions with expiry dates" operational: a ledger of every harness scaffolding component and the model-weakness it assumes, with a remove-one-component-at-a-time audit procedure available at every pinned-agent version bump.

**Research basis:** §3.2 (Anthropic's method; Opus 4.5→4.6 lesson), §4.6, §6.7.

**Approach sketch (slices):**
1. Ledger doc: per component (per-turn injections, guard verbosity, sprint/eligibility gating, evaluator presence) — assumed model gap, evidence, owner.
2. Audit procedure added to the version-bump gate as operator-invoked (never silent): for each component, one measured run without it (cost/quality deltas); keep/strip decision recorded with numbers.
3. Wire into `docs/HOST_ADAPTERS.md` probe discipline: bump → probes; audit available on request.

**Depends on:** none. **Estimated size:** small (docs + procedure + optional scripted runs).

**Acceptance criteria:**
- [ ] Ledger exists with current components and their assumed gaps.
- [ ] Audit procedure documented with one worked example (component, run, numbers, keep/strip decision).
- [ ] Version-bump gate text references the audit as operator-invoked, never automatic.

**Verification:** doc-review; any scripted runs record raw outputs under the `docs/superpowers/` evidence convention.

### W058 (proposed) - MCP 2026-07-28 alignment for the toolbox

**Objective:** Bring the toolbox onto the shipped spec baselines: stateless serving, `server/discover`, TTL-cached list results, Tasks extension for long-running verification jobs, MRTR for elicitation-style flows, standardized tool-result contract, and the CIMD/Enterprise-Managed-Authorization path for hub-as-MCP-client.

**Research basis:** §2 (spec + roadmap details, including CIMD/EMA among the un-adopted 2026-07-28 baselines), §6.8.

**Approach sketch (slices):**
1. SDK survey: confirm the vendored SDK generation supports 2026-07-28 features; pin and record.
2. Stateless serving + `server/discover` + TTL list caching; measure schema-token savings.
3. Tasks extension adopted for bounded long-running verification jobs (progress + cancellation visible in hub monitoring).
4. MRTR adopted where elicitation-style multi-turn flows exist.
5. Tool-result contract: one result shape per tool; deprecate multi-form outputs.
6. Authorization baselines: adopt CIMD as the client registration path where the hub acts as MCP client; evaluate Enterprise-Managed Authorization (ID-JAG) and record a dated accept/defer decision — W060 (agent identity) is the longer-term destination, but the disposition is recorded here, not deferred silently.

**Depends on:** none. W059 builds on this baseline. **Estimated size:** medium-large.

**Acceptance criteria:**
- [ ] Toolbox servers pass a 2026-07-28 conformance smoke (stateless operation, discover, TTL lists) added to `pnpm run verify`.
- [ ] At least one lifecycle tool uses Tasks with progress visible in hub monitoring.
- [ ] Token-economy delta measured (schema bytes at session start, before/after) and recorded.
- [ ] CIMD adoption status recorded; EMA evaluated with a dated accept/defer decision in this item's evidence.

**Verification:** toolbox verify + new conformance smoke tests; env-gated live hub probe for Tasks progress with a recorded verdict.

### W059 (proposed) - Server Cards + progressive discovery metadata for all toolbox products

**Objective:** Ship `.well-known/server-card` metadata for every toolbox product and implement progressive discovery (small entry point, on-demand catalog expansion), extending the existing model-visible-guidance convention onto the protocol standard.

**Research basis:** §2 (Server Card WG; roadmap "improved primitives"), §5.1 last row, §6.8.

**Approach sketch (slices):**
1. Adopt the Server Card WG's `.well-known` conventions for all 14 products.
2. Progressive discovery: each server exposes a minimal entry tool plus catalog-expansion flow; measure token reduction.
3. Card generation/verification tooling: a new generator task inside the `mcp-toolbox` workspace (created by this item; it does not exist today) so cards are generated from a single source of truth and validated in `pnpm run verify`, with a drift test.

**Depends on:** W058 (spec/transport baseline). **Estimated size:** small-medium.

**Acceptance criteria:**
- [ ] All products serve a valid card; validation + drift tests in toolbox verify.
- [ ] Progressive discovery path demonstrable with a measured token delta.
- [ ] Cards are generated from one source of truth; no hand-maintained duplication.

**Verification:** toolbox verify (including the new generator/drift tests); measured token report.

### W060 (proposed) - Agent identity: DPoP-bound revocable session tokens

**Objective:** Adopt the standards direction concretely: hub-issued, revocable, per-session, DPoP-bound tokens on hub↔agent↔server paths; sub-agent/adapter output marked explicitly lower-trust (structured facts, not raw text) to avoid the trust-escalation trap.

**Research basis:** §2 (DPoP RFC 9449, Workload Identity Federation PR #1933, ID-JAG/EMA, WIMSE), §3.1 (per-session scoped-down revocable token; multi-agent trust escalation), §4.7, §6.9.

**Approach sketch (slices):**
1. Token design: per-session, scoped, revocable hub tokens; revocation independent of operator identity (the Cowork pattern).
2. DPoP adoption on HTTP paths where they exist; if all current paths are stdio, record that scope honestly and keep DPoP as the HTTP-path requirement.
3. Trust-level discipline: extend the kernel's external-input separation to supervisor/evaluator outputs — structured facts, lower-trust-by-default.
4. Watch items (track, don't implement): Workload Identity Federation, ID-JAG, WIMSE — recorded in `docs/HUB_PROTOCOL.md`.

**Depends on:** W052 (token provenance thinking); composes with the 2026-09-16 credentials plan. **Estimated size:** medium.

**Acceptance criteria:**
- [ ] Session tokens revocable independently of operator credentials; revocation tested.
- [ ] DPoP bound on one HTTP path, or a dated stdio-only scope note recorded.
- [ ] Sub-agent/adapter output carries an explicit trust level end-to-end; a test proves lower-trust treatment.

**Verification:** focused security tests; `docs/SECURITY_ASSURANCE.md` checker green with the new claims.

---

## Group C — P3 economics, routing, containment, standards

### W061 (proposed) - Routing refresh + cost levers

**Objective:** Refresh the Auto Router `allowed_models` alias pool for the new generation and expose vendor cost levers (`reasoning_effort` tiers; off-peak scheduling) in the hub.

**Research basis:** §1 table + signals 2/5, §6.10. Model IDs in the research doc are vendor claims to verify against OpenRouter at implementation time.

**Approach sketch (slices):**
1. Verify availability/IDs on OpenRouter; update the alias resolution pool; document the diff.
2. `reasoning_effort` as a per-request cost-mode knob where supported (DeepSeek/GLM/Qwen/GPT families); default unchanged.
3. Off-peak scheduling experiment in the hub scheduler for batch/CI-class work (DeepSeek 50% off-peak); measure actual savings.

**Depends on:** none. **Estimated size:** small.

**Acceptance criteria:**
- [ ] Alias pool updated with verified IDs; routing probe green.
- [ ] Effort knob documented with measured token/cost deltas on one real task.
- [ ] Off-peak experiment report with honest numbers (or a recorded no-go).

**Verification:** hub routing probe; cost report under the `docs/superpowers/` evidence convention.

### W062 (proposed) - `vendor-verification-mcp` (pattern: Kimi-Vendor-Verifier)

**Objective:** Detect vendor-side drift (precision/behavior regressions) across the model pool via the metering proxy — Moonshot's Kimi-Vendor-Verifier pattern, first-party.

**Research basis:** §3.5, §5.1/§5.2, §6.10.

**Approach sketch (slices):**
1. Small deterministic probe corpus (format adherence, tool-call shape, known-answer) replayed periodically through the metering proxy per vendor/model.
2. Drift scoring + alert surface (monitor TUI + run registry); never auto-switches models — read-only posture.
3. Optional per-vendor verifier configs so resellers of the same model can be compared.

**Depends on:** W061 (stable routing pool). **Estimated size:** small.

**Acceptance criteria:**
- [ ] Corpus replay runs unattended with provenance-stamped scores.
- [ ] Drift alert demonstrable by replaying a mutated fixture in a test.
- [ ] Read-only posture documented; no automatic routing changes.

**Verification:** toolbox verify; scheduled-run probe with recorded verdict.

### W063 (proposed) - Containment refinements

**Objective:** Fold the researched containment lessons into Workflow: resolve-symlinks-before-path-validation as a pinned ordering, a `read-write-no-delete` mount mode, OTLP pull-based observability, and a custom-component audit at primitive-grade rigor.

**Research basis:** §3.1 (mechanics; EDR visibility; "the custom component is the one that breaks"), §3.4 (deterministic boundary survives), §6.11.

**Approach sketch (slices):**
1. Symlink ordering: audit `src/containment/` path validation; pin resolve-before-validate with tests. Honest outcome framing: W025 already fixed application-layer symlink escapes, so the fixture may prove non-exploitable — in that case the durable outcome is the pinned ordering test plus a recorded audit result, not a manufactured red→green.
2. `read-write-no-delete` as a type-level containment variant (alongside `enforced`/`policy-only`), tested.
3. OTLP pull-based export for containment-visible events; document visibility limits (the isolation-keeps-EDR-out lesson).
4. Custom-component audit (guard dispatcher, metering proxy, credential broker) with P0–P3 findings; fix or accept in writing.

**Depends on:** none. **Estimated size:** medium.

**Acceptance criteria:**
- [ ] Resolve-before-validate ordering pinned by test; adversarial symlink fixtures run, with either a fixed finding or a recorded non-exploitable audit result.
- [ ] `read-write-no-delete` mode type-level distinct and tested.
- [ ] OTLP pull-based export demonstrated; limits documented.
- [ ] Custom-component audit findings recorded with priorities; P0/P1 fixed or accepted in writing.

**Verification:** containment test additions; `docs/RUNTIME_CONTAINMENT.md` + `docs/SECURITY_ASSURANCE.md` updates with checkers green.

### W064 (proposed) - Standards tracking for SECURITY_ASSURANCE

**Objective:** Add the researched external standards/guidance as dated citations in `docs/SECURITY_ASSURANCE.md`, each with what Workflow claims and does-not-claim relative to it.

**Research basis:** §3.1, §3.3, §6.12.

**Approach sketch (slices):**
1. Append dated entries: NIST agent-identity project; ACSC/CISA/NCSC six-agency guidance (2026-04-30); ISO/IEC 42001; Anthropic Model Hardware Standard preview; OpenAI misalignment-reporting framework; Google "Three Layers of Agent Security."
2. Pin the statements in the assurance checker (append-only, dated).

**Depends on:** none. **Estimated size:** small (docs-only).

**Acceptance criteria:**
- [ ] Each standard cited with a dated claim/not-claim statement.
- [ ] `test/security-assurance.test.ts` green with the new pinned statements.

**Verification:** assurance checker green.

---

## Group D — build-our-own toolbox products (operator preference: roll our own)

### W065 (proposed) - `browser-verification-mcp` (patterns: playwright-mcp + chrome-devtools-mcp)

**Objective:** First-party, evidence-producing browser verification: deterministic navigate/act/screenshot/assert against a live app, feeding `verification-accountability-mcp` — the "evaluator drives the real app" pattern Anthropic's harness uses. The debugging/perf profile (traces, network, console) absorbs the chrome-devtools-mcp pattern as a second mode of the same product.

**Research basis:** §3.2 (Playwright MCP evaluator), §5.2 table, §6 (evidence quality over self-report).

**Approach sketch (slices):**
1. Bounded surface: managed Chrome via CDP; navigation, accessibility-tree queries, typed/clicked actions, screenshots, textual/assertive checks. No arbitrary shell, no unbounded downloads; result bounds enforced via `result-bounds`.
2. Evidence contract: every action produces a structured, hash-stamped record (URL, selector strategy, before/after state) consumable by verification-accountability as shape-validated external evidence.
3. Debug/perf profile: trace + network + console capture behind the same bounded surface.
4. Model-visible guidance for proactive use (existing toolbox convention).

**Depends on:** none; composes with W055 (contracts name what browser verification must check). **Estimated size:** medium-large.

**Acceptance criteria:**
- [ ] Fixture app driven end-to-end (navigate, act, assert) with evidence records; toolbox `pnpm run verify` green.
- [ ] Bounds enforced: screenshot size/count caps, action allowlist, timeouts; hostile-page fixture proves no unbounded fetch/exec.
- [ ] Evidence accepted by `verification-accountability-mcp` with authority documented (observed-at, by-what-tool).
- [ ] README documents trust boundaries (page content is untrusted input).

**Verification:** toolbox verify + adversarial fixture tests; optional gated live probe.

### W066 (proposed) - `docs-intelligence-mcp` (pattern: context7)

**Objective:** Version-pinned, live library documentation evidence with bounded retrieval and citation — deprecated-API hallucination defense without adopting the third-party server.

**Research basis:** §5.2 (context7 pattern), 2026-08 survey reaffirmation.

**Approach sketch (slices):**
1. Pluggable fetchers against official docs sites, version-pinned; normalized cache with TTL; robots/licensing posture recorded.
2. Bounded retrieval: token-accounted queries returning cited sections (source URL + version).
3. Model-visible guidance for proactive use on library questions.

**Depends on:** W058/W059 desirable (result contract, cards), not blocking. **Estimated size:** small-medium.

**Acceptance criteria:**
- [ ] Same query pinned to two versions returns different content (pinning proven by test).
- [ ] Token bounds enforced; TTL cache honored by test.
- [ ] Citations carry source URL + version.

**Verification:** toolbox verify; one env-gated live end-to-end probe with a recorded verdict (same gate discipline as W067).

### W067 (proposed) - Remote evidence extension for `git-intelligence-mcp` + `ci-intelligence-mcp` (pattern: github-mcp-server)

**Objective:** Read-only remote evidence (PRs, issues, Actions runs) via scoped OAuth, rendered into the same evidence contracts as local git/CI facts — capability of the official GitHub server, own implementation, own trust boundaries.

**Research basis:** §5.2 table.

**Approach sketch (slices):**
1. Credential integration through CredentialBroker: consumer-scoped, read-only scopes only; secret material never in server config or state.
2. Evidence mapping: remote facts → existing evidence contracts with source authority recorded (REST ref, fetched-at).
3. Bounds discipline: capped result sizes, TTL caches.

**Depends on:** the 2026-09-16 credentials plan (broker) for custody integration. **Estimated size:** medium.

**Acceptance criteria:**
- [ ] OAuth flow scoped read-only; write-scoped tokens rejected by test.
- [ ] Evidence records carry source authority and are admitted like other external evidence (shape-validated, not truth-validated).
- [ ] Bounds enforced by test.

**Verification:** toolbox verify + env-gated live probe with recorded verdict.

### W068 (proposed) - `evidence-ingest-mcp` (pattern: markitdown)

**Objective:** Bounded document→markdown/text conversion (PDF/Office/HTML) so file-shaped evidence enters the pipeline without external services; decide standalone product vs `project-context-mcp` tool at planning time.

**Research basis:** §5.2 table.

**Approach sketch (slices):**
1. Per-type parsers, dependency-light (prefer pure TS/JS; any native dependency is vendored, pinned, and disclosed).
2. Bounds: input/output caps; no network by default; hostile-file fixtures (expansion bombs, malformed XML) prove fail-closed behavior.
3. Conversion provenance (parser + version) stamped on output.

**Depends on:** none. **Estimated size:** small-medium.

**Acceptance criteria:**
- [ ] Fixture corpus (PDF/DOCX/XLSX/HTML) converts with provenance stamps.
- [ ] Bounds + hostile fixtures tested; no network by default.
- [ ] README documents trust boundaries (converted content is untrusted input).

**Verification:** toolbox verify + fixture tests.

### W069 (proposed) - Structural code-graph memory for `code-intelligence-mcp` (pattern: codebase-memory-mcp)

**Objective:** Persistent structural code knowledge (tree-sitter-class parsing, multi-language) extending `code-intelligence-mcp` — cross-session codebase understanding without per-session re-discovery — with the token cost measured before any adoption into default flows.

**Research basis:** §5.2 table; the 2026-08 survey flagged token cost as the open question.

**Approach sketch (slices):**
1. Feasibility spike: graph schema (symbols, references, modules), local storage choice (SQLite-class), incremental indexing under bounded budgets.
2. Token-cost evaluation on this repo: graph-backed answers vs current on-demand analysis; adopt only where the delta wins.
3. If go: graph queries through the existing server surface; staleness discipline aligned with W058 freshness thinking.

**Depends on:** none. **Estimated size:** medium (spike-gated; go/no-go is an operator decision point).

**Acceptance criteria:**
- [ ] Spike report with measured token/latency deltas on this repo (the honest benchmark).
- [ ] If go: bounded incremental indexing proven on a dirty-tree change set; staleness tests green.
- [ ] If no-go: recorded decision with numbers (a valid outcome).

**Verification:** spike evidence under the plans/specs convention; landed code keeps toolbox verify green.

---

## Explicit dispositions (research items with no dedicated W-number)

- **claude-task-master (§5.2)** → no separate product: the kernel owns task state and must not be duplicated. Its decomposition/contract-prompt patterns are absorbed into W055's negotiation flow (owning acceptance line: W055's negotiation-loop AC); the `project-context-mcp` part is guidance-only with no separate AC, tracked in W055's promotion text.
- **E2B sandboxed execution (§5.2)** → explicit non-product, recorded here and now in the non-goals: containment is Workflow's own bubblewrap layer; revisit only if untrusted-code execution moves off-host.
- **chrome-devtools-mcp (§5.2)** → merged into W065 as the debug/perf profile (stated on both rows).

## Deliberate non-goals recorded by this plan

- No adoption of third-party MCP servers (build-first preference; §5.3 of the research doc).
- No new model pins without probe re-runs.
- No supervisor-classifier gating transitions (advisory only, W053).
- No expansion of any surface's enforcement claims without probe-gated evidence.
- No off-host code-execution dependency (E2B-class), per the disposition above.

## Proposed sequencing (for operator triage)

| Order | Item | Why this order |
|---|---|---|
| 1 | W051, W054 | Cheap, pure hardening; no dependencies; removes two named incident classes fast |
| 2 | W052 | Enables W053's egress anomaly signals; THREAT_MODEL update unblocks Group B claims |
| 3 | W053 | Supervisor layer — highest research leverage; uses W052 as one signal source |
| 4 | W055, W056 | Kernel-adjacent capability; W055's persona tuning is reused by W053's optional stage |
| 5 | W065 | Highest-demand build-first product (browser evidence); independent, composable with W055 |
| 6 | W058 then W059 | Protocol baseline first, then cards/progressive discovery on top |
| 7 | W060, W063 | Identity + containment refinements after the security groups land |
| 8 | W061 then W062 | Economics pair; small, non-blocking |
| 9 | W066–W068, W069 | Remaining build-first products, independently schedulable |
| — | W057, W064 | Docs-only; slot anywhere after W053 (the ledger references supervisor metrics) |

**Review instructions for the operator:** approve/drop/reorder items; confirm the W051–W069 numbering and the Phase 12 heading; confirm which Group D product to schedule first (this plan proposes W065). On approval, accepted items get promoted into `TASKS.md` with the standard structure (Objective / Depends on / Acceptance criteria / Verification) and this plan gains a dated promotion note.
