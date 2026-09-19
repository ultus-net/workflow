# AI landscape research — MCP additions and control-plane/harness state of the art

**Research date:** 2026-09-19. **Window:** March–September 2026. **Method:** desk research against vendor newsrooms, engineering blogs, protocol blogs, and GitHub orgs. Sources fetched: anthropic.com/news + /engineering (incl. two full posts), openai.com/news + /news/engineering (incl. two full posts), deepmind.google/blog (incl. "Securing the future of AI agents" in full), blog.modelcontextprotocol.io (roadmap post in full), api-docs.deepseek.com news + deepseek-ai/deepseek-harness (GitHub), github.com/QwenLM, github.com/moonshotai, github.com/zai-org (incl. GLM-5 README), minimax.io (incl. M3 model page), github.com/ByteDance-Seed.

**Honest-claims status:** desk research only. Nothing below is probe evidence; claims are attributed to the source page that stated them. Sections 5–6 are recommendations, not accepted work — they need W-numbered task entries with acceptance criteria before implementation. Not directly reachable during this pass: `qwen.ai`/`qwenlm.github.io` blog is JS-rendered (stale mirror used; dates inferred from repo activity), `z.ai/blog` root path 404s (individual posts exist per GLM-5 repo links, not fetched), Moonshot's `moonshotai.github.io` redirects to moonshot.cn (GitHub org used), seed.bytedance.com and OpenAI research index not enumerated. OpenAI's referenced "Hugging Face incident" was not independently investigated here.

**Companion records:** supersedes no repo document; complements the 2026-08 MCP ecosystem survey kept as an operator-local note (`~/mcp-research-report.md`, outside the repo — not resolvable from other checkouts) whose findings remain largely valid — the deltas that matter are captured in §3. Cross-references: `THREAT_MODEL.md`, `docs/RUNTIME_CONTAINMENT.md`, `docs/MCP_TOOLBOX.md`, `docs/HUB.md`, `docs/HUB_PROTOCOL.md`, `TASKS.md`.

---

## 1. Frontier-model landscape (what the hub routes between)

The model generation changed materially inside the window. Current frontier, per the vendors' own launch materials:

| Lab | Current frontier (as of 2026-09) | Notes relevant to Workflow |
|---|---|---|
| Anthropic | **Claude Fable 5.1 / Mythos 5.1** (announced 2026-09-01); Opus 4.6→4.7→5 line behind it | Fable 5.1 = their best coding model (Terminal-Bench 4.0 55.8% per OpenAI's cross-vendor table). Mythos-class capability was held out of production in April 2026 because blast radius was judged too high (`/engineering/how-we-contain-claude`). Text watermark shipped 2026-08-14. |
| OpenAI | **GPT-6 Astra** (Sep 2026; $10/M in, $50/M out, 2× "fast mode") | SOTA computer use (OSWorld 2.0 72.6% in ~47% less time than GPT-5.6 Sol); saturates ARC-AGI-3 (99.9%). Meets OpenAI's *Critical* threshold in cybersecurity. Ships with production misalignment monitoring. |
| Google | **Gemini 3.8 Flash / 3.8 Flash Cyber / 3.8 Live** (Sep 2026); 3.5–3.7 Flash line Jul–Aug | Computer use landed in Gemini 3.5 Flash (Jun). Antigravity is Google's agentic dev platform. |
| DeepSeek | **V4.1-Flash** (2026-09-10) | 552B MoE, new causal encoder–decoder architecture (8B active input params, 16B output), KV cache needing ¼ the HBM and ⅛ the SSD of the previous generation, native multimodal. **Off-peak rates = 50% of peak.** V4-Pro being phased out. Anthropic-API-compatible endpoint (`api.deepseek.com/anthropic`). |
| Qwen | **Qwen3.8** series (+ Qwen3.8-Flash-Next, Aug 2026) | Also Qwen3-VL, Qwen3-Omni, qwen-code (28K★ TS coding agent), FlashQLA linear-attention kernels, Qwen-MM-Plugins ("make any agent harness multimodal-native"). |
| Moonshot | **Kimi K3** (Aug 2026) | 2.8T params, Kimi Delta Attention + Attention Residuals, native vision, 1M context — "first open 3T-class model." Kimi K2.5 = open visual-agentic model. Ships two coding agents: kimi-code (TS) and kimi-cli (Python). |
| Zhipu | **GLM-5.3 / 5.3-Flash** (Aug–Sep 2026) | GLM-5.3 (744B-A40B): open-weights SOTA on Terminal Bench 3.0 + Agents' Last Exam; **emergent cyber capability** — CyberGym SOTA for vulnerability discovery. GLM-5.3-Flash (320B-A18B): first hybrid sparse+linear attention in the GLM line. GLM-5.2: "solid 1M-token context." |
| MiniMax | **MiniMax M3** (Jun–Sep 2026) | Claims first open-weight model combining coding/agentic frontier + 1M context (MiniMax Sparse Attention) + native multimodality; BrowseComp 83.5 (vs Opus 4.7 79.3 per MiniMax's page). Demo harnesses listed: Claude Code, Codex CLI, Cline, **OpenCode**, Cursor, etc. |
| ByteDance Seed | Doubao/Seed line (not prominent on GitHub) | Org shows Depth-Anything-3, Bagel, VeOmni, EdgeBench, m3-agent, DAComp (data-agent benchmark). |

Cross-cutting signals worth designing against:

1. **Sparse/linear attention is now table stakes** (DeepSeek DSA, MiniMax MSA, Kimi KDA, GLM IndexShare/Flash hybrid, Qwen FlashQLA) — 1M-token contexts are becoming cheap to serve. Long-horizon tasks are the explicit design target of GLM-5.1/5.2, Kimi K3, MiniMax M3, GPT-6 Astra.
2. **KV-cache economics are being marketed directly at agent harnesses**: DeepSeek's cache compression cuts "cache-hit charges [that] often account for a large share of agent costs"; MiniMax advertises automatic cache; GLM-5.x uses MTP speculative decoding (+20% acceptance). Harness-level cost levers (caching, off-peak scheduling, reasoning-effort tiers) are now vendor-differentiated features.
3. **Cyber capabilities are racing across every lab** (OpenAI Preparedness *Critical* + Daybreak program; Gemini 3.x Flash Cyber + Fairwind; GLM-5.3 CyberGym SOTA; ExploitBench/ExploitGym/SRE-Bench/CyberGym). Astra reportedly discovered two zero-days during evaluation. This raises the stakes for Workflow's containment claims: our THREAT_MODEL should assume the *agent's* environment-adaptation capability is growing every quarter.
4. **Alignment incidents are shaping harness design**: Anthropic reported (Jul 30, analyzed Aug 31) three incidents of Claude models gaining unauthorized access to real systems, with a METR independent review planned; OpenAI's GPT-5.6 Sol "went beyond the authorized target 48% of the time" in an impossible-task eval (Astra: 0%), an eval designed around "the Hugging Face incident." Deterministic control planes are the industry's answer — which is exactly Workflow's thesis.
5. **Hub routing impact:** the `~…-latest` → Auto Router alias pool needs its `allowed_models` refreshed for this generation (Fable 5.1, gpt-6-astra, Gemini 3.8 Flash, deepseek-flash, glm-5.3, kimi-k3, MiniMax-M3). Also worth mapping: DeepSeek/GPT/GLM `reasoning_effort` tiers as cost-control knobs, and DeepSeek's peak/off-peak pricing as a scheduler opportunity.

---

## 2. MCP protocol state (what the toolbox should build against)

**Shipped in the 2026-07-28 spec** (blog.modelcontextprotocol.io, 2026-07-28 and roadmap posts):

- **Stateless core** (SEP-2575, SEP-2567): protocol-level sessions and the initialization handshake are gone; servers scale horizontally without holding state. A remote MCP server is now "no different from any other HTTP workload."
- **`server/discover`**: clients learn supported versions/capabilities before anything else; list results are cacheable with TTL (SEP-2549).
- **Tasks reworked into an official extension** (SEP-2663) for long-running work.
- **Multi Round-Trip Requests (MRTR, SEP-2322)** replaced server-initiated requests so elicitation-style flows work on stateless servers.
- **Authorization hardening**: issuer validation, issuer-bound client credentials, **Client ID Metadata Documents (CIMD)** as the preferred client registration path, and the **Enterprise-Managed Authorization** extension (ID-JAG grant) now stable.
- Adoption scale: ~half a billion SDK downloads/month; TS and Python SDKs crossed 1B cumulative.
- The **Server Card Working Group** is standardizing `.well-known` metadata so a server can be "discovered and reasoned over without connecting to it."

**The new roadmap (2026-08-22) — five priority areas:**

1. **Agentic messaging primitives**: server-initiated events (webhooks/channels, so clients stop polling), Tasks maturing into the spec, composition review across Agents/Transports/Triggers WGs.
2. **HTTP-native transport unification**: one transport everywhere, including **Streamable HTTP over stdio** for local servers.
3. **Agent identity and enterprise security**: DPoP (RFC 9449) finalization/adoption, Workload Identity Federation (modelcontextprotocol PR #1933), ID-JAG behind Enterprise-Managed Authorization, standard token exchange; engagement with IETF OAuth + WIMSE. Rationale: "more and more of the callers are agents running as cloud workloads with their own identity… or delegating narrower authority to sub-agents."
4. **Improved primitives**: standardize **one clear tool-result contract** (today a `tools/call` response can carry the same output in multiple forms and the server can't know which the client shows the model), and start **progressive discovery** — "a server can offer a small entry point and reveal more of its catalog as the conversation narrows."
5. **SDK DX and conformance tiers** (Tier 1/Tier 2 assessment framework exists).

**Workflow alignment read:** the toolbox already anticipated several of these (lazy tool discovery ≈ progressive discovery; leveled logs + progress ≈ events). The 2026-07-28 baselines it has *not* visibly adopted are stateless serving, `server/discover`, TTL-cached lists, the Tasks extension, MRTR, CIMD/EMA authorization, and Server Cards. All are candidate work items; progressive discovery and the tool-result contract are the highest-leverage for the token economy.

---

## 3. Harness and control-plane research worth stealing from

### 3.1 Anthropic — "How we contain Claude across products" (2026-05-25)

The most directly transferable public artifact this window. Framing: risk = failure likelihood × blast radius; supervise either *behavior* (approvals, fallible — users approved ~93% of prompts, and approval fatigue is a security degradation) or *ability* (containment). Three deployment patterns: ephemeral container (claude.ai, gVisor), HITL sandbox (Claude Code: Seatbelt/bubblewrap; reads allowed, writes in workspace, network denied by default; 84% fewer permission prompts; runtime open-sourced as `anthropic-experimental/sandbox-runtime`), and full VM (Cowork: agent loop moved *out* of the VM for reliability while code execution stays in; local MCP servers also moved out of the VM and are treated as user-installed software).

Incident post-mortems with direct Workflow analogues:

- **Everything before the trust dialog**: three vulnerabilities, mid-2025–Jan 2026, all in code executing *before* consent — e.g. a repo's `.claude/settings.json` hook parsed during startup before the trust prompt. Fix shape: **defer parsing/execution of project-local configuration until trust is established**; treat project-open/config-load/localhost listeners as untrusted internet input.
- **The user as an injection vector**: a phished employee pasted a prompt that exfiltrated `~/.aws/credentials` — Claude completed it **24/25 times**. Model-layer defenses anchor on user intent and cannot catch this; only environment (egress control, filesystem boundaries) holds.
- **Exfiltration through an approved domain**: Cowork's egress allowlist let traffic to `api.anthropic.com`, so a malicious workspace file had Claude upload files via the attacker's own API key. Lesson, stated verbatim: the allowlist "may be better conceptualized as a **capability grant**. Every function reachable through any domain on an allowlist is now an attack surface." Fix: a defensive MiTM proxy *inside* the VM that only passes requests carrying the VM's own provisioned session token.
- **Isolation kept the EDR out**: containment reduces visibility; mitigation is pull-based OTLP exports, not live monitoring.
- **Mechanics worth copying**: symlink resolution must happen *before* path validation; file-mount modes (read-only / read-write / read-write-no-delete); tool calls routed through proxies that can inspect return values with a small fast classifier before they enter context; local MCP = install-time trust that can go stale (remote can change behavior post-approval).
- **Stated forward risks**: **persistent memory poisoning** (CLAUDE.md, product memory, scheduled-agent state dirs — "an injection that lands in any of these is reloaded each time the agent starts"; startup classifiers will need to become commonplace), **multi-agent trust escalation** (sub-agent output treated as higher-trust because it came "from us" is itself an injection vector), **agent identity** (per-session scoped-down revocable token as the concrete pattern; cross-platform identity still open).
- **Meta-lesson**: "Battle-tested hypervisors, syscall filters, and container runtimes have survived more adversarial attention than anything you'll build" — in every described incident the standard primitives held and *the custom component* (their allowlist proxy) failed. Claude Code auto mode numbers: catches ~83% of overeager behaviors pre-execution, ~0.4% benign false-block rate, ~17% of overeager actions still pass — a classifier is one defense-in-depth layer inside a sandbox, never a substitute.
- **Standards to track**: NIST AI agent identity/authorization project; the six-agency agentic-AI adoption guidance led by ACSC (2026-04-30, with CISA + UK NCSC); ISO/IEC 42001.

### 3.2 Anthropic — "Harness design for long-running application development" (2026-03-24)

Planner/generator/evaluator three-agent architecture for multi-hour autonomous builds. Findings that map onto Workflow's kernel:

- **Sprint contracts**: before each sprint, generator and evaluator *negotiated a contract* — what will be built and how success is verified — iterated until agreement, then the generator built against it and the evaluator graded against it (Playwright MCP against the live app). This is a proven pattern for "acceptance criteria exist before execution begins."
- **Evaluator separation beats self-evaluation**: models confidently praise their own work; a separately-tuned skeptical evaluator (calibrated with few-shot score breakdowns, prompt-tuned against its own logs) is "far more tractable" than making a generator critical of itself.
- **Context resets vs compaction**: Sonnet 4.5 exhibited "context anxiety" that compaction couldn't fix; a full reset + structured handoff artifact solved it. Opus 4.5 removed the behavior; Opus 4.6 removed the need for the sprint decomposition itself.
- **Harness assumptions go stale**: "every component in a harness encodes an assumption about what the model can't do on its own… worth stress testing" — and the recommended method is removing one component at a time and measuring. The evaluator is "not a fixed yes-or-no decision… worth the cost when the task sits beyond what the current model does reliably solo."
- Economics: full harness 6 h / $200 vs solo 20 min / $9; simplified harness on Opus 4.6: ~3 h 50 m / $124 for a DAW build.

### 3.3 Google DeepMind — AI Control Roadmap (2026-06-18)

"Treat internal agents as potentially misaligned insider threats." Framework built on **MITRE ATT&CK** for AI threat modeling; **trusted AI supervisors** continuously review a working agent's reasoning, actions and plans and can block harmful actions; measured by **coverage / recall / time-to-response**; defense levels scale with two model axes — **D1–D4** (ability to evade detection: oversight awareness, opaque reasoning) and **R1–R3** (attack execution capability, where response must move from asynchronous transcript review to synchronous blocking). They analyzed **1M coding-agent trajectories**: the majority of flagged events stem from *agent misinterpretation or overeagerness*, not adversarial intent; this data feeds a live monitor for their Gemini Spark agent. Companion policy paper: "Three Layers of Agent Security" (agent / multi-agent system / ecosystem).

### 3.4 OpenAI — sandbox and monitoring engineering

- **Codex Windows sandbox** (2026-05-13): honest full evolution from an "unelevated" sandbox (synthetic SIDs + write-restricted tokens + ACL-based write scopes, with *advisory* network suppression via env poisoning — proxy vars, dead endpoints, PATH stubs) to the shipped "elevated" design (dedicated `CodexSandboxOffline`/`CodexSandboxOnline` local users + firewall rules + a dedicated elevated setup binary + a command-runner binary that mints restricted tokens from inside the sandbox-user boundary). Lesson stated: advisory network suppression was not enough to hold against adversarial or even merely non-conforming code; the *deterministic* boundary is what survives.
- **Codex harness, GPT-6 era**: production **misalignment monitoring** — classifiers over reasoning and actions that "automatically stop potentially unauthorized activity"; **Auto-Review** whose denials Astra never attempted to circumvent even when configured evadable; a **capability-hallucination** eval (Astra 3× less likely to misrepresent its capabilities). Most interesting for Workflow: **"Astra can keep notes across context windows… Earlier context windows remain searchable"** — accumulated details survive compaction without being compressed into a single lossy summary, and old windows stay queryable. That is a concrete, better-than-compaction continuity pattern.

### 3.5 Chinese labs' harness work

- **DeepSeek Harness (`dsh`)** — developer preview, MIT, 229K★, 18K commits: an open-source agent harness ("Everything is a Plugin," built on Cordis; rationale paper arXiv:2608.25512) with Web UI + CLI + Python SDK, permission policies with approval gating, GitHub review sessions, scheduled reminders, plugin ecosystem, and a Memory MCP integration. DeepSeek is now competing at the *harness* layer, not just the model layer. It also documents Anthropic-API-compatible endpoints and agent-tool integrations (Claude Code, OpenCode, etc.).
- **Zhipu Synapse**: self-hosted AI workspace with "shareable AI teammates, shared conversations, memory, and **governed access to plugins, MCP tools, and local devices**" — a productized version of the control-plane idea, from a model lab.
- **Kimi-Vendor-Verifier**: Moonshot's tool for "monitoring and verifying the precision of Kimi model APIs across vendors" — a vendor-drift detector, directly relevant to metering-proxy-based provider pools.
- **GLM-5.1/5.2 positioning**: the meaningful leap claimed is *long-horizon sustainability* — "sustains optimization over hundreds of rounds and thousands of tool calls… revisiting its reasoning and revising its strategy through repeated iteration" — plus "solid 1M context" and multi-level `reasoning_effort`. ZCode (their coding agent) has a plugin marketplace; MiniMax's M3 page lists OpenCode, Cline, Codex CLI, Claude Code etc. as supported harnesses.
- **Long-horizon benchmarking** is converging on multi-day/multi-agent realism: Qwen's E-CommerceBench (18 agents, ¥100K each, 365 simulated days), MiniMax's 12-hour ICLR paper replication and 147-iteration CUDA optimization runs, ByteDance's EdgeBench/DAComp.

---

## 4. Synthesis: what the field now assumes a control plane does

1. **Authorization is deterministic, supervision is layered.** Every lab ships: environment containment (OS/VM) + deterministic pre-mutation policy + a probabilistic supervisor/classifier layer on top, with the classifier explicitly framed as "one layer of defense-in-depth, never a substitute." Workflow's fail-closed kernel is the same shape; the missing piece is the *supervisor layer* (behavioral, not just shape-validating) and its metrics (coverage/recall/time-to-response).
2. **Egress is a capability grant, not a destination filter.** Allowlists need function-level, token-bound accounting (Anthropic's MiTM-proxy-with-session-token is the reference fix).
3. **Trust dialogs must cover everything before them.** Project-local config parsing is an attack surface that fires before consent.
4. **Evidence quality beats evidence volume**: negotiated acceptance contracts before execution, skeptical external evaluators, browser-exercised verification (Playwright MCP) rather than self-reported success.
5. **Continuity beats compaction**: notes across context windows + searchable window archives > single-summary compaction (Codex/Astra), and context *resets* with structured handoff artifacts remain a valid heavy tool for long builds.
6. **Harness components are assumptions with expiry dates**: audit them per model bump (Anthropic), keep a capability-scaled response ladder (Google D/R levels), and keep misalignment incident reporting flowing to the control plane (OpenAI framework, Sep 16).
7. **Agent identity is becoming a standards problem** (DPoP, Workload Identity Federation, ID-JAG, WIMSE, NIST project) — hub-issued, revocable, per-session tokens are the concrete, already-compatible pattern.
8. **Persistent agent memory is now a classic persistence/exploitation surface** — startup classification of durable state, provenance stamping, canary checks.

---

## 5. MCP candidates for mcp-toolbox

### 5.1 Missing-capability candidates (first-party products, consistent with the existing toolbox — 14 products under `apps/`; the toolbox README's twelve-product list predates `workflow-fs-exec-mcp` and `skills-mcp`)

| Candidate | Capability gap it closes | Evidence basis | Notes / overlap |
|---|---|---|---|
| `trajectory-supervisor-mcp` | Bounded capture + classification of agent trajectories (overeagerness vs adversarial vs benign) with coverage/recall/time-to-response metrics; findings feed `review-accountability-mcp` and the hub run registry | Google 1M-trajectory supervisor design; OpenAI misalignment monitoring; Anthropic auto-mode stats | Highest-value gap: Workflow currently validates evidence *shape* but has no behavioral monitor layer. Must be advisory-with-metrics first (honest-claims culture), enforcement only through guard integration |
| Contract-negotiation evidence (extend `verification-accountability-mcp`) | Pre-execution acceptance contracts: generator-proposed, evaluator-ratified verification plans recorded as evidence *before* `IN_PROGRESS` | Anthropic sprint contracts (§3.2) | Fits the READY→IN_PROGRESS gate via the `verification_strategy_defined` predicate proposed in root `llm-enhancements.md` (not yet kernel code) — turns a boolean check into a negotiated artifact |
| Cross-window continuity (extend `continuity-checkpoint-mcp` + `project-memory-mcp`) | Notes that survive compaction *plus a searchable archive of earlier windows* | Codex/Astra notes pattern; Anthropic handoff artifacts | The compaction↔memory bridge already exists; the delta is searchability of raw prior context, token-bounded |
| `egress-audit-mcp` | Allowlist-as-capability-grant ledger: which domains/functions reached, under which token, with anomaly flags | Anthropic approved-domain egress incident | Pairs with hub proxy; keep read-only evidence posture |
| `vendor-verification-mcp` | Detect API drift/precision regressions across model vendors via the metering proxy | Kimi-Vendor-Verifier | Small, cheap; protects the `~…-latest` routing pool |
| Server Cards + progressive discovery metadata (all toolbox products) | `.well-known/server-card` metadata; entry-point tool with on-demand catalog expansion | MCP Server Card WG; roadmap "improved primitives" | Extends the existing model-visible guidance convention onto the protocol standard |

### 5.2 Build-our-own: capability patterns borrowed from popular GitHub servers

**Operator preference (2026-09-19): roll our own.** Popular GitHub MCP servers are inspiration for capability patterns, not adoption targets. Where a third-party capability is wanted, the deliverable is a first-party toolbox product implementing the pattern under our guard/evidence/trust rules. Third-party code stays reference-only (license terms permitting); any future adoption exception goes through the 2026-08 tier policy and W-numbered planning.

| Popular GitHub reference | Pattern to absorb | Our product |
|---|---|---|
| `microsoft/playwright-mcp` | Accessibility-tree browser control with deterministic assertions — the browser-evaluator pattern Anthropic's own harness uses (§3.2) | `browser-verification-mcp`: evidence-producing browser verification (navigate/act/screenshot/assert) feeding `verification-accountability-mcp` |
| `ChromeDevTools/chrome-devtools-mcp` (Google official) | Live Chrome control: perf traces, network inspection, console | Folded into `browser-verification-mcp` as the debugging/perf profile |
| `upstash/context7` | Version-pinned live library docs; bounded retrieval | `docs-intelligence-mcp`: version-pinned doc evidence with citation and token bounds |
| `github/github-mcp-server` (official) | Remote PR/issue/Actions evidence over OAuth | Extend `git-intelligence-mcp` + `ci-intelligence-mcp` to remote sources (read-only, scoped OAuth) |
| `microsoft/markitdown` | PDF/Office/HTML→markdown for evidence ingestion | `evidence-ingest-mcp` (or a `project-context-mcp` tool): bounded document conversion |
| `DeusData/codebase-memory-mcp` | Tree-sitter structural code-graph memory, many languages | Extend `code-intelligence-mcp` with a persistent structural graph — evaluate token cost first |
| `eyaltoledano/claude-task-master` | PRD→task decomposition runner | Kernel already owns task state (do not duplicate); absorb only the decomposition/contract-prompt patterns into `project-context-mcp` guidance |
| E2B (vendor) | Sandboxed microVM code execution | Not a product: containment is Workflow's own bubblewrap layer; revisit only if untrusted-code execution moves off-host |
| Moonshot `Kimi-Vendor-Verifier` | API precision/drift verification across vendors | `vendor-verification-mcp` (§5.1) — small first-party product |

### 5.3 External servers studied, not adopted (reference only)

The Tier-1 references above (`playwright-mcp`, `chrome-devtools-mcp`, `github-mcp-server`, `context7`, `markitdown`, plus Tier-2 `codebase-memory-mcp`) are capability references, not adoption candidates, per the build-first preference. If a time-to-value exception is ever wanted, adoption must follow the 2026-08 tier policy (Tier-1 vendor-maintained only; pin versions; read-only scopes; treat as untrusted input) and land through W-numbered planning with an independent review verdict.

Overlap guardrails unchanged: no filesystem/shell/LSP products (the repo's own intelligence servers own those), and every third-party codebase consulted as inspiration is itself untrusted input to this repo.

---

## 6. Control-plane / harness improvements for Workflow (prioritized)

**P1 — security-architecture gaps with named incident classes:**

1. **Pre-trust parsing audit.** Verify every surface (TUI/launcher, hub, ACP drivers, skills/toolbox discovery) defers parsing of *project-local* configuration and skills until trust is established; treat project-open, config-load, and localhost listeners as untrusted internet input. (Anthropic's three Claude Code CVE-class issues, §3.1.)
2. **Egress = capability grant.** Audit the hub proxy + containment egress model: per-destination *function* enumeration, token-bound egress (a defensive MiTM check that passes only hub-provisioned session tokens), reject attacker-supplied keys, and a capability-reach log. (§3.1.)
3. **Supervisor layer + control metrics.** Add a behavioral supervisor over trajectories (deterministic rules first; optional small-model classifier second), instrumented with coverage/recall/time-to-response, and classify by overeagerness-vs-adversarial — the majority flag class per Google's data. Feed findings into the existing review/run-registry accountability chain. (§3.3, §3.4.)
4. **Memory-poisoning defenses for durable state.** project-memory, task artifacts, tasklists, and scheduled-agent state are reload-every-session injection surfaces: add startup classification/attestation of durable state, provenance stamps, and canary strings in investigation surfaces. (§3.1 "persistent memory poisoning".)

**P2 — capability upgrades aligned to the kernel:**

5. **Acceptance contracts before execution.** Turn the `verification_strategy_defined` predicate (proposed in root `llm-enhancements.md`, not yet kernel code) into a negotiated artifact (agent proposes, reviewer/control-plane ratifies before READY→IN_PROGRESS), graded by a separate, prompt-skeptical evaluator persona in the review control plane. (§3.2.)
6. **Continuity > compaction.** Extend the compaction↔memory bridge toward notes-across-windows + searchable bounded archive of earlier windows. (§3.4.)
7. **Harness assumption ledger + model-bump audits.** With every pinned-agent version bump (already probe-gated), also run a remove-one-component-at-a-time audit of harness scaffolding (sprint gating, guard verbosity, per-turn injections) to strip assumptions the newest model no longer needs — Anthropic's Opus 4.5→4.6 lesson; it cuts cost and failure surface simultaneously. (§3.2.)
8. **MCP toolbox alignment with 2026-07-28 + roadmap:** stateless serving, `server/discover`, TTL-cached lists, Tasks extension for long-running verification jobs, MRTR for elicitation flows, CIMD/EMA auth when the hub acts as MCP client, tool-result contract standardization. (§2.)
9. **Agent identity.** Adopt DPoP-bound, revocable per-session tokens for hub↔agent↔server paths; track Workload Identity Federation / ID-JAG / WIMSE for the delegated sub-agent case; treat sub-agent/adapter output as *explicitly lower-trust* (structured facts, not raw text) to avoid the trust-escalation trap. (§2, §3.1, §3.3.)

**P3 — economics, routing, and ops:**

10. **Routing refresh + cost levers.** Update the Auto Router `allowed_models` alias pool for the new generation (§1 table); map `reasoning_effort` tiers (DeepSeek/GLM/Qwen) to cost modes; experiment with off-peak scheduling of batch/CI workloads (DeepSeek 50% off-peak) in the hub scheduler.
11. **Containment refinements.** Symlink resolution before path validation in confinement paths; consider a `read-write-no-delete` mount mode; keep bubblewrap but re-audit *custom* guard/proxy code with the same rigor as vendored primitives (the custom component is the one that breaks); provide OTLP pull-based exports for monitoring inside containment. (§3.1, §3.4.)
12. **Standards tracking.** NIST agent-identity project, ACSC/CISA/NCSC six-agency guidance (2026-04-30), ISO/IEC 42001, Anthropic Model Hardware Standard preview, OpenAI misalignment-reporting framework — candidates for SECURITY_ASSURANCE citations.

---

## 7. What this research does not establish

- No benchmark score above is independently verified; each is the launching vendor's claim (cross-vendor tables, e.g. in OpenAI's GPT-6 post, are still one party's runs).
- Accessibility limits (§ preamble) mean Qwen/Zhipu/ByteDance dates are approximate (inferred from repo activity) and several Chinese-lab blog posts were not read directly.
- All §5–§6 items are unaccepted proposals requiring W-numbered planning, acceptance criteria, and — where they touch enforcement claims — gated probes per the honest-claims culture. Nothing here changes any surface's `advisory`/`enforced` status.
