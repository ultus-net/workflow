# Workflow Security Assurance Case (W042)

This is the executable assurance map for Workflow's security guarantees. `THREAT_MODEL.md` states the threats, trust zones, and controls; this document binds every **material security claim** to its implementation boundary and to the verification that proves it — an automated test (exact file and title), a gated live probe, or an explicitly identified manual verification. `test/security-assurance.test.ts` parses this document and asserts that every cited automated test, gated probe, and manual command actually exists, that every claim row carries a non-empty verification, that implementation-boundary references point at files that exist, and that every surface section keeps real verification weight (per-section citation floors) — so the map cannot silently drift from the tests it cites, cannot hide an unverified claim behind an empty cell, and cannot be gutted one section at a time while the aggregate holds.

Honesty rules that govern this case (unchanged from the threat model):

- **Advisory is observability, never enforcement.** Claims below never upgrade advisory or policy-only behavior to enforced; the `enforced`/`policy-only` isolation markers and the per-version probe verdicts (`docs/HOST_ADAPTERS.md`) are the source of truth for what any surface may claim.
- **Known residual risks are stated, not hidden.** The final section records them; nothing in this document implies a guarantee the code does not provide.

Citation syntax (parsed by `test/security-assurance.test.ts`):

- `test/<file>.test.ts#"<exact test title>"` — an automated test; the checker asserts the file exists and contains the title.
- `gated[<ENV_VAR>]: test/<file>.test.ts#"<title>"` — an env-gated live probe; the checker additionally asserts the gate variable appears in the probe file.
- `manual[npm run <script>]` — a manual/gated command; the checker asserts the script exists in `package.json`.

## S1 — Kernel and application authority

The deterministic kernel owns task state and transitions; the application is the single authorization authority for host proposals.

| Claim | Implementation | Verification |
| --- | --- | --- |
| Illegal state transitions are rejected with stable machine-readable reasons | `src/kernel/task-graph.ts:144` | test/task-graph.test.ts#"illegal transitions have stable rejection codes" |
| Task readiness is derived from dependency verification; callers cannot unlock work manually | `src/kernel/task-graph.ts:245` | test/task-graph.test.ts#"readiness is derived from dependency verification" |
| Missing, self, and cyclic dependencies are rejected without mutating the graph | `src/kernel/task-graph.ts:184` | test/task-graph.test.ts#"graph rejects missing, self, and transitive cyclic dependencies" |
| Verification requires fresh passing evidence admitted at a valid mutation epoch | `src/kernel/task-graph.ts:116` | test/task-graph.test.ts#"verification requires fresh passing evidence admitted at a valid mutation epoch" |
| A relevant mutation invalidates evidence and VERIFIED state | `src/kernel/task-graph.ts:123` | test/task-graph.test.ts#"a relevant mutation invalidates evidence and verified task state" |
| Restored graphs reject incoherent state (orphaned in-progress, future-epoch evidence, verified-without-evidence) | `src/kernel/task-graph.ts:38` | test/persistence.test.ts#"persisted verified state cannot self-certify without required evidence" |
| The application is the policy authority for host proposals | `src/application/workflow.ts:120` | test/application.test.ts#"application is the policy authority for host proposals" |
| High-blast-radius capabilities (process, credentials, network, spawn) are withheld independently of task state and prompts | `src/application/workflow.ts:50` | test/application.test.ts#"high-blast-radius capabilities are withheld independently of task state and prompts" |
| Host metadata cannot downgrade known process tools | `src/application/workflow.ts:72` | test/application.test.ts#"host metadata cannot downgrade known process tools" |
| Real host adapters cannot disguise process execution or credential access as ordinary mutation | `src/adapters/host.ts` | test/application.test.ts#"real host adapters cannot disguise process execution as ordinary mutation" |
| File subjects are confined to the authorized workspace; lexical and symlink-mediated escapes are denied | `src/application/workflow.ts:290` | test/application.test.ts#"application confines file subjects to its authorized workspace" |
| A dangling in-workspace symlink whose target escapes is denied | `src/application/workflow.ts:300` | test/application.test.ts#"application denies a dangling in-workspace symlink whose missing target is outside" |
| Mutations are gated on the active IN_PROGRESS task; blocked canonical work cannot mutate | `src/application/workflow.ts:144` | test/application.test.ts#"blocked canonical task cannot mutate while its eligible dependency can" |
| Host enforcement level is derived truthfully from authoritative pre-mutation capability | `src/application/host.ts` | test/host-adapter.test.ts#"host enforcement level is derived from authoritative pre-mutation capability" |

## S2 — Hub authority and run control plane

The hub owns run lifecycle, review gating, verifier-token separation, and workspace canonicalization.

| Claim | Implementation | Verification |
| --- | --- | --- |
| A review-gated run cannot reach VERIFIED without reviewer evidence | `src/integrations/run-registry.ts:196` | test/hub-runs.test.ts#"a review-gated run cannot finish until an independent review is recorded" |
| A run cannot review itself (anti-rubber-stamp) | `src/integrations/run-registry.ts:224` | test/hub-review.test.ts#"a review from the same run is rejected (anti-rubber-stamp)" |
| Approvals naming fewer than three review axes are rejected | `src/integrations/run-registry.ts:225` | test/hub-review.test.ts#"a review referencing fewer than three axes is rejected" |
| Verifier-only routes reject the ordinary bearer token | `src/integrations/cline-tui-bridge.ts:94` | test/cline-tui-bridge.test.ts#"Cline team tasks require explicit task-bound evidence before verification" |
| Verifier and ordinary tokens are separate random values, with verifier authority kept out of the ordinary discovery document (constant-time comparison is an implementation property of `src/integrations/cline-tui-bridge.ts:432`, not separately test-verified) | `src/integrations/cline-tui-bridge.ts:94` | test/hub-workspace.test.ts#"hub namespaces Cline team tasks by workspace and keeps verifier authority out of discovery" |
| Run begin stales the workspace test subject — a later run cannot verify on a predecessor's green tests | `src/integrations/run-registry.ts:207` | test/hub-runs.test.ts#"a later run in the same workspace cannot verify on a predecessor's test evidence" |
| A fail-closed reviewer outcome leaves the run VERIFYING with a surfaced blocking reason — never a silent pass | `src/integrations/run-registry.ts:287` | test/hub-runs.test.ts#"a fail-closed reviewer outcome leaves the run VERIFYING with a surfaced blocking reason" |
| Reviewer infrastructure failure surfaces as a blocking reason and never fabricates evidence | `src/integrations/run-registry.ts:270` | test/hub-runs.test.ts#"reviewer infrastructure failure leaves the run VERIFYING with a surfaced blocking reason" |
| Review-gated runs also require hub-run test evidence; failing or crashing tests block verification | `src/integrations/run-registry.ts:303` | test/hub-runs.test.ts#"a review-gated run also requires hub-run test evidence: failing tests block verification" |
| The hub authorizes tool proposals through WorkflowApplication.authorize (/before-tool, /bash) | `src/integrations/cline-tui-bridge.ts:192` | test/hub-protocol.test.ts#"hub authorizes an allowed tool and denies a withheld capability with a reason" |
| The hub fails closed on an invalid workspace declaration; aliases canonicalize before task identity | `src/integrations/run-registry.ts:44` | test/hub-workspace.test.ts#"hub fails closed on an invalid workspace declaration" |
| Verifier discovery is 0600, protected, and removed on shutdown | `src/integrations/workflow-hub.ts:96` | test/hub-workspace.test.ts#"hub protects and removes verifier discovery on shutdown" |
| A second hub instance refuses to start; stale locks from dead processes are reclaimed | `src/integrations/workflow-hub.ts:144` | test/hub-lifecycle.test.ts#"a second hub refuses to start while the first is alive" |
| Malformed and oversized hub requests fail closed; every endpoint requires the bearer token | `src/integrations/cline-tui-bridge.ts:98` | test/hub-protocol.test.ts#"hub rejects malformed and unknown requests" |
| Completion claims are journaled observability-only and never satisfy kernel evidence | `src/integrations/run-registry.ts:115` | test/g5-observability.test.ts#"completion claims journal the claim with kernel verification state, observability-only" |
| Team-task verification requires task-bound environment evidence; the ordinary token cannot verify | `src/integrations/cline-tui-bridge.ts:281` | test/cline-tui-bridge.test.ts#"Cline team tasks require explicit task-bound evidence before verification" |

## S3 — Host adapters fail closed

Adapters translate host events into the generic contract; malformed or downgrade-shaped input fails closed.

| Claim | Implementation | Verification |
| --- | --- | --- |
| Cline normalizes beforeTool input and fails closed on malformed input | `src/adapters/cline.ts:27` | test/cline-adapter.test.ts#"Cline adapter fails closed on a malformed lazy call_tool payload" |
| Cline exposes every batched read and apply_patch target path to policy | `src/adapters/cline.ts:90` | test/cline-adapter.test.ts#"Cline adapter exposes every batched read path to Workflow policy" |
| Cline conservatively classifies editor, patch, and shell tools as mutating; only extension tools may carry explicit least-privilege metadata | `src/adapters/cline.ts:57` | test/cline-adapter.test.ts#"Cline adapter conservatively classifies editor, patch, and shell tools as mutating" |
| Workflow denial maps to native host stop control | `src/adapters/cline.ts:52` | test/cline-adapter.test.ts#"Cline adapter maps Workflow denial to beforeTool stop control" |
| The ACP adapter is advisory unless the bridge guarantees mutation permission interception | `src/adapters/acp.ts:6` | test/acp-adapter.test.ts#"ACP adapter is advisory unless the bridge guarantees mutation permission interception" |
| ACP host metadata cannot downgrade a write into a non-mutating read | `src/adapters/acp.ts:42` | test/acp-adapter.test.ts#"ACP host metadata cannot downgrade a write into a non-mutating read" |
| ACP non-mutating classification requires kind and tool name to agree | `src/adapters/acp.ts:16` | test/acp-adapter.test.ts#"ACP non-mutating requires kind and tool name to agree on read" |
| ACP mutating proposals without checkable subjects fail closed | `src/adapters/acp.ts:51` | test/acp-adapter.test.ts#"ACP mutating proposals without checkable subjects fail closed" |
| Spawn tools classify to the default-deny spawn capability regardless of kind or host metadata | `src/adapters/acp.ts:22` | test/acp-adapter.test.ts#"spawn tools classify to the spawn capability regardless of kind" |
| OpenCode patch proposals expose every patch target; path-bearing tools fail closed without a subject | `src/adapters/opencode.ts:81` | test/opencode-plugin.test.ts#"OpenCode path-bearing tools fail closed when their subject is missing" |
| MCP observations become evidence only after boundary validation; malformed observations never self-certify | `src/adapters/mcp.ts:20` | test/mcp.test.ts#"malformed MCP observations are rejected instead of self-certifying" |
| Cline, ACP, and OpenCode each pass the same shared conformance trace (per-harness titles generated from the template literal in the file) | `test/adapter-conformance.test.ts` | test/adapter-conformance.test.ts#"passes the shared host adapter conformance trace" |
| Per-version tool surfaces stay classified: gated tools recognized, path-subject tools fail closed without a path, process tools never leak command text into subjects | `src/adapters/acp.ts:51` (mutation subject fail-closed) + `src/adapters/acp.ts:112` (capability classification/escalation) | test/acp-cline-tool-matrix.test.ts#"every path-subject tool fails closed without a usable path" |

## S4 — ACP session and wire

The hub-side ACP client: framing, permission resolution, config-option discipline, and the fs server.

| Claim | Implementation | Verification |
| --- | --- | --- |
| NDJSON framing rejects malformed lines fail-closed | `src/adapters/acp-wire.ts:47` | test/acp-wire.test.ts#"ACP wire decoder rejects malformed NDJSON lines fail-closed" |
| Unknown or malformed safety-relevant messages are rejected | `src/adapters/acp-wire.ts:68` | test/acp-wire.test.ts#"ACP wire rejects unknown or malformed safety-relevant messages" |
| The subprocess client fails closed on invalid envelopes, malformed session updates, and child exit | `src/adapters/acp-subprocess.ts:202` | test/acp-subprocess.test.ts#"hub-side ACP subprocess spike rejects malformed agent output fail-closed" |
| The default permission resolver denies inbound requests | `src/adapters/acp-subprocess.ts:77` | test/acp-permission-ingress.test.ts#"ACP subprocess client default resolver denies inbound permission requests" |
| Denial selects the agent-provided rejecting option; without one it fails closed (never fabricated, never ordinary cancelled) | `src/adapters/acp-permission.ts:61` | test/acp-permission.test.ts#"ACP permission denial fails closed when no rejecting option exists" |
| The Workflow resolver consults the guard after kernel authorization and denies on guard policy or guard error | `src/adapters/acp-workflow-resolver.ts:49` | test/acp-workflow-resolver.test.ts#"ACP resolver consults the guard after kernel authorization and denies on guard policy" |
| Unknown tool kinds and titles fail closed to the mutation capability | `src/integrations/acp-session.ts:506` | test/acp-session.test.ts#"unknown tool titles fail closed to the mutation capability" |
| Enforcement-altering config options are denied client-side before any wire call; agent-originated updates are rejected from retained config | `src/integrations/acp-session.ts:33` | test/acp-session.test.ts#"enforcement-altering config options are denied client-side, before any wire call" |
| The hub fs server rejects relative paths fail-closed before authorization | `src/integrations/acp-session.ts:437` | test/acp-session.test.ts#"the hub fs server rejects relative paths fail-closed before authorization" |
| Malformed session/config notifications fail closed; cancellation produces explicit terminal states | `src/integrations/acp-session.ts:236` | test/acp-session.test.ts#"ACP session driver fails closed on malformed session notifications" |
| session/load is refused when the agent does not advertise it (no silent fresh session) | `src/integrations/acp-session.ts:197` | test/acp-session.test.ts#"ACP session driver refuses session/load when the agent does not advertise it" |
| Multi-byte UTF-8 split across stdout chunks survives framing | `src/adapters/acp-subprocess.ts:202` | test/acp-subprocess-utf8.test.ts#"ACP subprocess client preserves multi-byte UTF-8 split across stdout byte chunks" |
| Unknown update kinds (e.g. usage_update) reach listeners untouched — forward-compat projection, not interpretation | `src/adapters/acp-subprocess.ts:213` | test/acp-subprocess.test.ts#"unknown update kinds like usage_update reach listeners untouched (E2 forward-compat)" |

## S5 — Runtime containment (Linux Bubblewrap)

Policy permission is never represented as sufficient for containment; unavailable or insufficient backends fail closed.

| Claim | Implementation | Verification |
| --- | --- | --- |
| Contained process execution requires Workflow process authorization before the runtime | `src/containment/workflow-process.ts:13` | test/containment.test.ts#"contained process requires Workflow process authorization before runtime enforcement" |
| Ambient credentials are cleared and networking is disabled by default | `src/containment/linux-bwrap.ts:100` | test/containment.test.ts#"Linux containment clears ambient credentials and disables network by default" |
| Explicit environment requires credential authorization; host networking requires network authorization | `src/containment/workflow-process.ts:24` | test/containment.test.ts#"explicit environment requires Workflow credential authorization" |
| Ambient filesystem paths are hidden unless explicitly granted; writes require an explicit writable grant plus mutation authorization | `src/containment/linux-bwrap.ts:104` | test/containment.test.ts#"Linux containment hides ambient filesystem paths unless explicitly granted" |
| Filesystem grants that escape the workspace fail closed before runtime | `src/containment/workflow-process.ts:28` | test/containment.test.ts#"contained process fails closed before runtime when a filesystem grant escapes the workspace" |
| The network namespace has no host interfaces without the network capability | `src/containment/linux-bwrap.ts:75` | test/containment.test.ts#"Linux containment creates a network namespace with no host interfaces" |
| Containment fails closed when bubblewrap is unavailable, and never reports enforcement when a boundary cannot be mounted | `src/containment/linux-bwrap.ts:117` | test/containment.test.ts#"Linux containment never reports enforcement when a requested boundary cannot be mounted" |
| A non-executable or fake backend is never mistaken for a working boundary | `src/containment/linux-bwrap.ts:178` | test/containment.test.ts#"Linux containment does not mistake an executable for a working backend" |
| Passthrough backends stay policy-only, never enforced; requests still validated | `src/containment/platform.ts:17` | test/platform-containment.test.ts#"passthrough containment executes with validation but reports policy-only, never enforced" |
| External hardlink aliases stay read-only inside writable trees across overlapping grants | `src/containment/linux-bwrap.ts:12` | test/containment-spawn.test.ts#"bubblewrap keeps external hardlinks read-only across overlapping writable grants" |
| Spawned children run behind a PID namespace with a cleared host environment | `src/containment/linux-bwrap.ts:134` | test/containment-spawn.test.ts#"bubblewrap spawn clears host environment and applies explicit entries" |
| Repository-scoped contained writes preserve unrelated dirty worktree content | `src/containment/linux-bwrap.ts:104` | test/containment.test.ts#"repository-scoped contained writes preserve unrelated dirty worktree content" |
| The guard runs before every contained execution and its failure denies | `src/containment/workflow-process.ts:14` | test/guarded-process.test.ts#"WorkflowContainedProcess fails closed when the guard throws" |
| Contained ACP agent launch fails closed on policy-only backends and backends without streaming spawn; scratch-home wins HOME | `src/adapters/acp-contained-agent.ts:41` | test/acp-contained-agent.test.ts#"contained ACP launch fails closed on a policy-only backend" |

## S6 — Model proxying

The metering proxy is the only mandatory model-egress point: the real key never enters the boundary.

| Claim | Implementation | Verification |
| --- | --- | --- |
| The agent holds only the placeholder credential; the real key is injected proxy-side | `src/integrations/model-usage-proxy.ts:22` | test/acp-runtime-agent.test.ts#"meteredOpencodeConfig points the agent at the proxy with only the placeholder credential" |
| Inbound credentials are stripped and the authorization header is replaced; hop-by-hop headers dropped | `src/integrations/model-usage-proxy.ts:238` | test/model-usage-proxy.test.ts#"model usage proxy strips hop-by-hop and Connection-named request headers" |
| Absolute-form request targets are rejected without leaking the key (exfiltration regression) | `src/integrations/model-usage-proxy.ts:120` | test/model-usage-proxy.test.ts#"model usage proxy rejects absolute-form request targets without leaking the key (P1 regression)" |
| Usage accounting is forced on completions and metered from JSON and final SSE chunks | `src/integrations/model-usage-proxy.ts:96` | test/model-usage-proxy.test.ts#"model usage proxy injects the real key, forces usage accounting, and meters JSON responses" |
| The proxy fails closed on construction and malformed completion bodies | `src/integrations/model-usage-proxy.ts:73` | test/model-usage-proxy.test.ts#"model usage proxy fails closed on construction and on malformed completion bodies" |
| The loopback bind and https-or-loopback upstream rule hold | `src/integrations/model-usage-proxy.ts:73` | test/model-usage-proxy.test.ts#"model usage proxy passes non-completion traffic through untouched" |
| Live proof (gated): contained Cline and OpenCode turns complete with only the placeholder inside the boundary while the proxy records usage | `src/integrations/acp-runtime.ts:95` | gated[WORKFLOW_ACP_OPENCODE_METERED]: test/acp-opencode-metered-probe.test.ts#"OpenCode ACP metered proxy proves key-free agent env, working turns, and per-session usage metrics" |
| Live proof (gated): the same posture on the vendored Cline path | `src/integrations/acp-runtime.ts:236` | gated[WORKFLOW_ACP_CLINE_METERED]: test/acp-cline-metered-probe.test.ts#"Cline ACP metered proxy proves key-free agent env, working turns, and per-session usage metrics" |

## S7 — Persistence and recovery

Persisted state is authority only after validation; recovery is deterministic; resume never manufactures verification.

| Claim | Implementation | Verification |
| --- | --- | --- |
| Persisted workflow restores tasks, evidence, epoch, and history after restart | `src/application/persistence.ts:19` | test/persistence.test.ts#"persisted workflow restores tasks, evidence, epoch, and history after restart" |
| Restart fails orphaned in-progress work instead of guessing mutation outcomes | `src/application/persistence.ts:22` | test/persistence.test.ts#"restart fails orphaned in-progress work instead of guessing mutation outcome" |
| Stale writers are rejected by the optimistic version check; concurrent writers cannot both commit | `src/application/persistence.ts:54` | test/persistence.test.ts#"concurrent writers cannot both commit the same version" |
| Malformed persisted domain values fail closed; history rejects unknown tasks and impossible transitions | `src/application/persistence.ts:105` | test/persistence.test.ts#"malformed persisted domain values fail closed" |
| Persisted history rejects work started before its dependency was verified; readiness must match dependency state | `src/application/persistence.ts:178` | test/persistence.test.ts#"persisted history rejects work started before its dependency was verified" |
| Restart restores workspace confinement and capability withholding | `src/application/workflow.ts:279` | test/persistence.test.ts#"restart restores workspace confinement and capability withholding" |
| Persisted state retains only opaque SDK session correlation — conversation history is never canonical authority | `src/application/workflow.ts:80` | test/persistence.test.ts#"persisted Workflow state retains only opaque SDK session correlation" |
| A leftover writer lock fails closed | `src/application/persistence.ts:85` | test/persistence.test.ts#"leftover writer lock fails closed" |
| Session resume fails closed when correlated SDK history is unavailable | `src/integrations/cline-session.ts` | test/cline-session.test.ts#"Cline session resume fails closed when correlated SDK history is unavailable" |
| Live proof (manual): restart-through-completion against a real Cline CLI requires fresh post-restart environment evidence | `test/integration/cline-resume.mjs` | manual[npm run test:cline-resume] |
| Live proof (manual): a real Cline plugin runtime loads and runs the host integration end to end | `test/integration/cline-runtime.mjs` | manual[npm run test:cline-runtime] |
| Live proof (manual): the W020 composed E2E runs the built package through authorize, bwrap, evidence, and VERIFIED | `test/integration/workflow-e2e.mjs` | manual[npm run test:e2e] |
| Live proof (manual): a real Cline runtime coding session independently checks the resulting repository state | `test/integration/cline-coding-session.mjs` | manual[npm run test:cline-coding-session] |

## S8 — Review control plane (W039-W041)

Review scope, partitioning, and provenance are deterministic control-plane facts; approvals fail closed.

| Claim | Implementation | Verification |
| --- | --- | --- |
| Review scope is derived from git status including untracked files — not `git diff HEAD` and never an LLM judgment | `src/review/manifest.ts:80` | test/review-manifest.test.ts#"the manifest covers a real repository: untracked, renamed, deleted, and security-sensitive files" |
| An approval whose [COVERAGE] line omits a manifest path fails closed; changes_requested is never coverage-gated | `src/integrations/hub-reviewer.ts:250` | test/hub-reviewer.test.ts#"an approved verdict that omits a manifest path fails closed as incomplete coverage" |
| Verdict parsing fails closed on missing or ambiguous tokens | `src/integrations/hub-reviewer.ts:100` | test/hub-reviewer.test.ts#"parseReviewVerdict fails closed on missing or ambiguous tokens" |
| Partitioning groups deterministically and never drops a file or obligation from the manifest | `src/review/partition.ts:226` | test/review-partition.test.ts#"partitionPreservesManifest holds and detects tampering" |
| Each review unit receives only its applicable focused rules — never every rule in one prompt | `src/review/partition.ts:130` | test/review-partition.test.ts#"focused rules attach per risk without injecting every rule into every unit" |
| Any unit rejection or incomplete coverage fails the whole partitioned review closed | `src/integrations/hub-reviewer.ts:497` | test/hub-reviewer.test.ts#"one unit's rejection fails the whole partitioned review closed" |
| Provenance fingerprints match fail-closed on every component (commit, prompt, diff, manifest, partition, rules) | `src/review/provenance.ts:99` | test/review-provenance.test.ts#"fingerprint matching fails closed on every component" |
| Resume requires the newest same-fingerprint approval with complete coverage — rejections shield older approvals | `src/review/provenance.ts:118` | test/review-provenance.test.ts#"resume requires approval with complete coverage under the exact fingerprint" |
| A different ask never resumes: the prompt is part of the fingerprint | `src/integrations/hub-reviewer.ts:182` | test/hub-reviewer.test.ts#"a different ask never resumes: the prompt is part of the fingerprint" |
| Records from another workspace never resume here, even at identical fingerprints | `src/integrations/hub-reviewer.ts:320` | test/hub-reviewer.test.ts#"records from another workspace never resume here, even at identical fingerprints" |
| Approvals journal before recording — an unprovenanced approval is never recorded | `src/integrations/hub-reviewer.ts:268` | test/hub-reviewer.test.ts#"the single-session flow journals the manifest decision before recording it" |
| A corrupt provenance journal fails closed; a missing one reads as empty | `src/integrations/review-provenance-store.ts:45` | test/review-provenance-store.test.ts#"a missing journal reads as empty, a corrupt one fails closed" |
| The reviewer run is distinct from the subject run and registered before review | `src/integrations/hub-reviewer.ts:192` | test/hub-reviewer.test.ts#"the reviewer run is distinct from the subject run and registered before review" |
| Status sourcing failures fail closed before any review prompt | `src/integrations/hub-reviewer.ts:111` | test/hub-reviewer.test.ts#"status sourcing failures fail closed before any review prompt" |

## S9 — Local UI surfaces

UIs consume the application API only; browser surfaces are loopback, origin-guarded, content-type-enforced.

| Claim | Implementation | Verification |
| --- | --- | --- |
| Cross-origin browser mutations are denied by Origin and Fetch-Metadata guards; non-JSON content types rejected | `src/ui/web.ts:504` | test/web.test.ts#"web UI denies cross-origin browser mutations" |
| The web UI reads snapshots and submits commands through the application API only | `src/ui/web.ts` | test/web.test.ts#"web UI reads snapshots and submits commands through the application API" |
| A new turn is not admitted until a cancelled ACP turn settles (no overlapping turns) | `src/ui/web-session-channel.ts:84` | test/web.test.ts#"web UI does not admit a new turn until a cancelled ACP turn settles" |
| Invalid prompt images are rejected before touching the session | `src/ui/web.ts:518` | test/web.test.ts#"web UI rejects invalid prompt images before touching the session" |
| Session switching refuses mid-turn and serializes concurrent switches without leaking runtimes | `src/ui/web-sessions.ts` | test/web-sessions.test.ts#"session manager serializes concurrent switches without leaking runtimes" |
| TUI actions never change canonical task state; the activity panel surfaces blocking reasons and verdicts | `src/ui/tui.tsx` | test/tui.test.ts#"legacy Ink projection cancels a coding session without changing canonical task state" |
| The admin credential API requires its distinct capability, rejects cross-origin requests, and never returns secret values | `src/ui/admin-control-plane.ts:31` | test/admin-control-plane.test.ts#"admin credential API requires its distinct capability and never returns secret values" |
| Ask mode never prompts for hard policy denials; concurrent permission requests fail closed | `src/ui/permission-broker.ts` | test/permission-broker.test.ts#"ask mode never prompts for hard policy denials" |
| Driver enforcement claims must match the installed authorization seam; unknown driver names fail closed | `src/cli/driver-registry.ts` | test/driver-registry.test.ts#"driver enforcement claims match the installed authorization seam" |
| A failed turn still drains the queue; a cancelled turn never auto-continues | `src/application/coding-session.ts` | test/coding-session-queue.test.ts#"cancellation clears the queue — a cancelled turn never auto-continues" |

## S10 — Guard corpus and credential custody

The vendored guard corpus stays alive hub-side; credentials are a separate custody boundary with no reveal operation.

| Claim | Implementation | Verification |
| --- | --- | --- |
| The hub intercepts destructive commands and protected paths on every surface | `src/integrations/mcp-toolbox-guard.ts:130` | test/hub-guard-interception.test.ts#"Workflow hub with guard intercepts destructive commands and protected paths" |
| The hub refuses to start guardless — the startup awaits the guard provider, and a guard that cannot start fails the hub itself rather than running permissive | `src/cli/hub.ts:69` | test/hub-guardless-startup.test.ts#"the guard provider composition fails closed when the guard server cannot start" |
| The guard child receives only explicitly brokered credential environment bindings | `src/integrations/mcp-toolbox-guard.ts:57` | test/credential-mcp.test.ts#"MCP environment contains only explicitly brokered credential bindings" |
| The broker materializes a secret only for an allowed consumer and workspace | `src/integrations/credentials.ts` | test/credentials.test.ts#"credential broker materializes a secret only for an allowed consumer and workspace" |
| Credential metadata never exposes stored secret material; secrets travel on stdin, never command arguments | `src/integrations/credentials.ts` | test/secret-service.test.ts#"Secret Service writes secret material on stdin rather than command arguments" |
| The broker and secret lookups fail closed when a referenced secret is absent or the backend is down | `src/integrations/credentials.ts` | test/credentials.test.ts#"credential broker fails closed when a referenced secret is absent or reference is invalid" |
| The shell-safety/secret/protected-path corpus stays executable in the vendored toolbox (evasion, laundering, aliasing, ANSI-C, pagers, interpreter payloads — `mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts`), reachable via `npm run toolbox:verify` | `mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts` | test/mcp-toolbox-guard.test.ts#"workflow-guard-mcp provider discovers and invokes guard_check over stdio" |

## S11 — Scheduler

Unattended runs are review-gated by default, budget-capped, and fail closed.

| Claim | Implementation | Verification |
| --- | --- | --- |
| Cron parsing fails closed on malformed expressions | `src/integrations/hub-scheduler.ts:102` | test/hub-scheduler.test.ts#"cronMatches fails closed on malformed expressions" |
| A due schedule spawns a review-gated run and verifies only on turn success | `src/integrations/hub-scheduler.ts:271` | test/hub-scheduler.test.ts#"a due schedule spawns a review-gated run and verifies it on turn success" |
| A crashed turn fails the run closed and never escapes the tick | `src/integrations/hub-scheduler.ts:296` | test/hub-scheduler.test.ts#"a crashed turn fails the run closed and never escapes the tick" |
| A rejected finish gate stays VERIFYING and is surfaced — never fabricated failed | `src/integrations/hub-scheduler.ts:311` | test/hub-scheduler.test.ts#"a rejected finish gate (review/test evidence) is surfaced and left VERIFYING, never fabricated failed" |
| A budget-aborted turn fails the run with the budget as the blocking reason | `src/integrations/hub-scheduler.ts:62` | test/hub-scheduler.test.ts#"a budget-aborted turn fails the run with the budget as blocking reason" |
| A runId is never reused; a schedule never fires twice in one minute | `src/integrations/hub-scheduler.ts:272` | test/hub-scheduler.test.ts#"a runId is never reused across fires" |
| The schedule table round-trips and fails closed on malformed or future versions | `src/integrations/hub-scheduler.ts:177` | test/hub-scheduler.test.ts#"the schedule table round-trips and fails closed on malformed or future versions" |
| Live proof (gated): the full scheduled chain — fire, contained ACP turn, review gate, test evidence, VERIFIED — ran live closed on 2026-09-16 | `test/hub-scheduled-turn-probe.test.ts` | gated[WORKFLOW_ACP_SCHEDULED]: test/hub-scheduled-turn-probe.test.ts#"scheduled real-agent run: fire -> contained ACP turn -> review gate + test evidence decide the outcome" |

## S12 — Gated live probes and manual verification catalog

Automated suites prove composition; live claims carry only through these gated runs (skip without the gate; never silently pass). Per-version probe discipline: evidence is per pinned agent version; an unprobed bump is capped advisory (`docs/HOST_ADAPTERS.md`).

| Surface | Probe | Gate | Live claim |
| --- | --- | --- | --- |
| Containment | containment runtime suite | manual[npm run test:containment-runtime] | fails rather than skips without Linux/bwrap — every S5 enforced-boundary claim |
| Cline ACP | contained probe | gated[WORKFLOW_ACP_CLINE_CONTAINED]: test/acp-cline-contained-probe.test.ts#"Cline ACP contained probe proves workspace writes work and host filesystem bypass cannot take effect" | in-boundary writes work; host-home and /tmp escapes contained |
| Cline ACP | subagent probe | gated[WORKFLOW_ACP_CLINE_SUBAGENT]: test/acp-cline-subagent-probe.test.ts#"Cline ACP subagent conformance probe: spawn visibility and gateability" | Red verdict recorded: spawn invisible to hub → spawn-denied/advisory cap |
| OpenCode ACP | subagent probe | gated[WORKFLOW_ACP_OPENCODE_SUBAGENT]: test/acp-opencode-subagent-probe.test.ts#"OpenCode ACP subagent conformance probe: spawn visibility and gateability" | Green: spawn projected and permission-gated |
| OpenCode ACP | resume probe | gated[WORKFLOW_ACP_OPENCODE_RESUME]: test/acp-opencode-resume-probe.test.ts#"OpenCode ACP resume probe replays and recalls a persisted session after an agent restart" | model context restored (exact keyword recalled) |
| OpenCode ACP | skills delivery | gated[WORKFLOW_ACP_OPENCODE_SKILLS]: test/acp-opencode-skills-delivery-probe.test.ts#"OpenCode lead runtime delivers skills from the hub-owned mount under containment" | F1 single-delivery-path under containment |
| OpenCode ACP | MCP mounts | gated[WORKFLOW_ACP_OPENCODE_MCP_MOUNT]: test/acp-opencode-mcp-mount-probe.test.ts#"OpenCode ACP MCP-mount probe: project opencode.json is honored" | hub-written config honored on both surfaces |
| Vendored corpus | toolbox verify | manual[npm run toolbox:verify] | the guard corpus stays executable in the toolbox |

## Known residual risks (stated, not hidden)

1. **Advisory or dishonest hosts can act outside Workflow.** Advisory is observability, never enforcement (`THREAT_MODEL.md` Operator Rule 1).
2. **Unknown host/tool schemas require adapter support** before they can be claimed enforced; adapter conformance review is mandatory when hosts add process/credential tool schemas.
3. **Compromised evidence authorities can lie about the environment**; evidence validates shape, not truth — choose authorities accordingly.
4. **OS-level access outside an intercepted host is outside Workflow's boundary**; Bubblewrap is not VM or kernel isolation, provides no syscall filtering or resource limits, and protects nothing against a hostile kernel/administrator.
5. **Materialized credentials are inspectable by the consuming process**; only narrowly scoped credentials per consumer mitigate this.
6. **A privileged same-user process is outside the confidentiality boundary** — verifier tokens, the provenance journal (0600 hub state), and the web/hub loopback surfaces discipline honest clients only.
7. **Direct (uncontained) process execution is outside the W019 guarantee**; route allowed processes through `WorkflowContainedProcess` or lose the boundary.
8. **The persistence store is not a distributed/HA consensus system**; it assumes a private store directory and is not a cryptographically authenticated audit log.
9. **Loopback servers are unauthenticated development surfaces**; exposing or reverse-proxying them beyond loopback is unsupported.
10. **Subagent-internal activity**: agents whose internal subagents emit no permission requests are capped advisory or spawn-denied unless probe-verified per pinned version (Cline 3.0.61: Red; OpenCode 1.18.31: Green with subagent-internal activity unprobed).
11. **Enforcement-altering config denials are observable but not forceable** — an agent that ignores its own permission surface degrades to the OS containment boundary.
12. **Review verdict quality is process discipline, not determinism** — the axis and [COVERAGE] rules bind reviewer claims to deterministic scope; they cannot prove reading.
13. **Run verification is only as honest as the configured verifyCommand** — a compromised workspace can pass its own tests.
14. **Model-channel exfiltration (C3) is the main containment residual**: whole-agent containment keeps `network=host` for model egress; the metering proxy observes volume but does not inspect or filter payloads; budget caps bound capacity; treat model egress as unmonitored (`THREAT_MODEL.md`).
15. **G7 compaction is outside hub control over ACP** — the plugin-era compaction-time gating has no ACP equivalent; documented regression, revisited when the ACP compaction RFD stabilizes.
16. **Plugin-internal escalation counters are not ported hub-side** — fail-closed seams bound retry storms; scheduled budget caps bound the unattended case.
17. **Provenance binds untracked files by path only** (the status source does not hash untracked bytes); mutations landing during a review remain the kernel epoch's job; the journal trim assumes a single writer.
18. **A network-served agent (e.g. `goose serve` HTTP/WS) is outside the current containment composition** — enforcement targets stdio subprocess agents; remote transports are a threat-model follow-up.
19. **Per-prompt task decomposition**: today every interactive proposal authorizes against the single session task; finer-grained decomposition is future roadmap work, not a current guarantee.

---

The executable checker for this document is `test/security-assurance.test.ts`: it parses every citation above and fails the suite if any cited automated test, gated probe file, or manual script ceases to exist or no longer contains its cited title. The assurance case is therefore itself under regression protection — the map cannot silently drift from the guarantees it claims.
