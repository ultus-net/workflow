# Host Adapters

Workflow keeps policy host-neutral, not host adapters. Add one concrete adapter per SDK/tool family so host schemas, lifecycle guarantees, and control responses stay explicit.

An adapter implements `TranslatingHostAdapter`: translate the SDK's pre-tool event into `ProposedToolAction`, report `HostCapabilities`, and translate `PolicyDecision` back into the SDK's native deny control. Do not move SDK types into `src/kernel/` or make the kernel infer tool behavior from arbitrary payloads.

```ts
import {
  hostCapabilities,
  taskId,
  type PolicyDecision,
  type ProposedToolAction,
  type TranslatingHostAdapter,
} from "../src/index.js";

interface ExampleBeforeTool {
  readonly sessionId: string;
  readonly tool: string;
  readonly input: unknown;
}

interface ExampleControl {
  readonly cancel: true;
  readonly reason: string;
}

function normalizeExampleEvent(event: ExampleBeforeTool): ProposedToolAction {
  if (!event.sessionId || !event.tool) throw new TypeError("invalid example SDK event");
  return {
    sessionId: event.sessionId,
    taskId: taskId("example-task"),
    tool: event.tool,
    capability: "read",
    mutating: false,
    subjects: [],
    input: event.input,
  };
}

class ExampleSdkAdapter implements TranslatingHostAdapter<ExampleBeforeTool, ExampleControl> {
  readonly capabilities = hostCapabilities({
    transport: "other",
    authoritativePreMutation: false,
  });

  proposalFromBeforeTool(event: ExampleBeforeTool): ProposedToolAction {
    // Validate the real SDK schema here before constructing the proposal.
    return normalizeExampleEvent(event);
  }

  beforeToolControl(decision: PolicyDecision): ExampleControl | undefined {
    return decision.kind === "deny" ? { cancel: true, reason: decision.reason } : undefined;
  }
}
```

`authoritativePreMutation: true` is a runtime integration claim, not a transport feature. Use it only when the host cannot perform the relevant mutation before Workflow returns `allow`. Otherwise report advisory operation. ACP, for example, is not automatically enforced merely because ACP carries permission events.

For Cline SDK hosts, `createWorkflowClinePlugin(application, adapter)` returns the plugin object to pass in `ClineCore` session `config.extensions`. Configure that adapter with `authoritativePreMutation: true` only at this concrete hook boundary. The integration uses Cline's `hooks` capability and documented `beforeTool({ toolCall, input })` callback; a Workflow denial returns Cline's native `{ stop: true, reason }` control before tool execution. The factory rejects advisory adapters so merely constructing `ClineHostAdapter` cannot promote a session to enforced mode. This is an explicit SDK-extension integration, not a `cline.plugins` auto-discovery package.

**2026-09-18 (W050 step 5 — Cline connector re-point, probe PENDING):** the retained ACP Cline connector now resolves the ambient stock `cline` first (`resolveClineLaunch`: `WORKFLOW_CLINE_BIN` → PATH → the vendored compiled binary as a deprecated fallback until W050 step 6 removes the checkout). The connector probe family has **not** been re-run against stock `cline --acp`; stock 3.0.62's `CLINE_API_KEY` / `CLINE_PROVIDER` headless path is source-inferred (`apps/cli/src/acp/acpAgent.ts:151` accepts `CLINE_API_KEY` without `authenticate`) but live-unverified. The connector is therefore **probe-PENDING / dormant on the stock surface** — never silently claimed enforced; the vendored 3.0.61 verdicts below remain the version of record until the stock probes run.

**2026-09-18 (W050 step 6 — vendored runtime removed):** the vendored-Cline SDK runtime, its `.workflow-cline/` checkout, and the Workflow patch were removed on branch `feat/w050-cline-removal` (not yet merged), along with the hub's Cline-specific `/before-tool` and `/team-task` routes. The retained connector is the thin stock-ACP launch described above; it remains probe-PENDING on stock 3.0.62. Body references below to `src/adapters/cline.ts`, the Cline plugin factory, the `test:cline-*` scripts, and the vendored pinned entry are historical.

**2026-09-18 (remote ACP bridge — M1 scaffold, advisory):** branch `feat/opencode-remote-acp-bridge` adds an ACP-agent-side bridge to a remote/attached OpenCode server over its HTTP/SSE API (`src/integrations/remote-acp/{engine,projection,agent}.ts`, `src/cli/acp-remote.ts`), specified in `docs/OPENCODE_REMOTE_ACP_SPEC.md`. Posture is **advisory only**: the bridge forwards `permission.asked` to the ACP client and relays the answer. Enforcement additionally requires the remote ruleset to emit `ask` and the PERMISSION/RULE-CONFIG probes (gated on `WORKFLOW_ACP_REMOTE_SSE` / `WORKFLOW_ACP_REMOTE_AUTH`) to run green; they have **not** been run, so this surface must not be labeled `enforced`.

For OpenCode hosts, `createWorkflowOpenCodePlugin(application, adapter)` registers a `tool.execute.before` hook: the adapter returns its typed `{ kind: "deny", reason }` control for a Workflow denial and the plugin throws it, so the host aborts the tool before execution. The factory likewise rejects advisory adapters.

## Current adapter files

| File | Role |
|---|---|
| `src/application/host.ts` | the contract vocabulary (`TranslatingHostAdapter`, `ProposedToolAction`, `HostCapabilities`, `ToolCapability`); the application layer owns its port |
| `src/adapters/host.ts` | deprecated re-export shim of the above for existing adapter/CLI import paths |
| `src/adapters/cline.ts` | Cline SDK adapter (production: TUI + hub) |
| `src/adapters/opencode.ts` | OpenCode adapter (production: plugin hook) |
| `src/adapters/acp.ts` | ACP adapter (production: `AcpSessionDriver` — the lead surface, hub runs, the hub reviewer, and the universal TUI `acp` driver; wire layer in `acp-subprocess.ts`; conformance-covered) |
| `src/adapters/acp-wire.ts` | minimal ACP v1 wire parsing + NDJSON stdio framing (multi-byte/split/malformed tested) |
| `src/adapters/acp-permission.ts` | permission-request/response translation — `selected(optionId)` or an explicit fail-closed signal |
| `src/adapters/acp-subprocess.ts` | ACP subprocess session driver incl. the `AcpFsServer` (client-delegated fs writes route through authorization + guard) |
| `src/adapters/acp-contained-agent.ts` | `launchContainedAcpAgent` — contained ACP agent launches (fails closed on non-enforced isolation) |
| `src/adapters/acp-workflow-resolver.ts` | auto permission resolution through `WorkflowApplication` + the guard (tool-coverage matrix, fail-closed unknown tools) |
| `src/adapters/lsp.ts` | LSP diagnostics helper — not a `TranslatingHostAdapter` |
| `src/adapters/mcp.ts` | MCP capability/evidence normalization — not a `TranslatingHostAdapter` |

Classify capabilities at normalization. Known command/process tools require `process`; credential-bearing operations require `credentials`. If one action requires both, include both in `requiredCapabilities`. `WorkflowApplication` unions those requirements with the primary `capability`, so metadata cannot remove a restriction. Event-supplied capability metadata may escalate (make stricter) but never relax the adapter's built-in classification. New high-blast-radius SDK tools require adapter classification before that integration can claim complete enforcement coverage.

`credentials` classification today: no adapter has a built-in credential tool table; it is assigned via extension metadata — OpenCode's `capabilityForTool` option, or an explicit event capability in ACP (escalation-only) — and always lands in `requiredCapabilities` so the application can withhold it.

Fail closed on malformed recognized safety metadata. A malformed `path`, location, command classification, or credential classification must not silently become an ordinary subjectless/read action. A mutating proposal whose subjects cannot be established at all fails closed too; only genuinely subjectless SDK actions (e.g. process-classified shell calls) may use `subjects: []`, and they are governed by the process capability gate rather than the workspace path gate.

Adapter conformance should prove at least: truthful enforced/advisory reporting, valid event normalization, malformed safety metadata rejection, denial-to-native-control translation, known process classification, credential classification when the SDK exposes it, combined capability requirements, and application authorization using the normalized proposal. `test/adapter-conformance.test.ts` runs the shared trace for Cline, OpenCode, and ACP; `test/cline-adapter.test.ts`, `test/acp-adapter.test.ts`, `test/opencode-plugin.test.ts`, and `test/application.test.ts` are the per-adapter executable examples.

## Subagent conformance matrix (plan Task B3)

Subagent spawning classifies as the `spawn` capability — default-deny on every
surface; host metadata may escalate but never relax it (`src/adapters/acp.ts`).
An `enforced` label for spawn-inclusive workflows requires probe evidence for
the pinned agent version:

| Agent (version of record) | Spawn tool advertised | Spawn gateable | Internal subagents visible to hub | Verdict |
|---|---|---|---|---|
| Cline 3.0.61 (ACP) | yes — `spawn_agent` exists and was used unprompted | no — no spawn tool call projected and no spawn permission reached the hub | no — the subagent's workspace write arrived with no accounting tool call | **Red (live 2026-09-16, vendored pinned entry)** — the spawn path is invisible to the hub: `spawn_agent` ran and the subagent wrote the canary, yet `spawnToolCallObserved: false` and `spawnPermissionObserved: false` in the probe evidence (`permissionCount: 3` unrelated permissions). Per the rules below the agent stays capped `advisory`/spawn-denied for spawn-inclusive workflows and must not be labeled `enforced`. Re-run on every pinned version bump: `WORKFLOW_ACP_CLINE_SUBAGENT=1` with Cline credentials (`CLINE_API_KEY` or `CLINE_API_KEY_FILE`) via `node --import tsx --test test/acp-cline-subagent-probe.test.ts` (vendored pinned entry — stock PATH cline is account-cloud-only in ACP mode and cannot authenticate headlessly — `docs/ACP_RESEARCH.md`) |
| OpenCode 1.18.31 (ACP, `--pure`) | yes — the `task` tool call projected to the hub | yes — the spawn's `session/request_permission` reached the client (deniable); gateability is config-owned (`permission: { task: "ask" }` in the hub-written per-runtime config under the process's `XDG_CONFIG_HOME`, composed by `src/integrations/acp-runtime.ts`; probe-proven honored on the project surface as well) | partially — the spawn is projected; the subagent's internal tool activity stays in its own session (its write ran under `edit: "allow"`; whether a subagent-side `ask` surfaces to the hub is unprobed) | **Green (live 2026-09-16)** — the spawn tool call was projected AND its permission request reached the client, so per the rules below `spawn` may be granted per operator policy under the capability gate; the default-mode advisory cap (`docs/ACP_DECISION.md`) is superseded by the G1 ask-config pass (permission requests emitted, denials honored) whenever the hub pins the config. MCP mounts from hub-written config verified on both surfaces the same day (project `opencode.json` and `XDG_CONFIG_HOME` config — `test/acp-opencode-mcp-mount-probe.test.ts`) and `session/load` restores model context across restart (exact keyword recalled — `test/acp-opencode-resume-probe.test.ts`). Re-run whenever the ambient `opencode` version changes (unlike Cline it is not vendored-pinned; the version lands in each probe's `agentInfo` evidence): `WORKFLOW_ACP_OPENCODE_SUBAGENT=1`, `WORKFLOW_ACP_OPENCODE_MCP_MOUNT=1`, `WORKFLOW_ACP_OPENCODE_RESUME=1` via `node --import tsx --test` on each probe file (launches pass `--pure` to measure the stock surface without operator plugins) |
| goose 1.50.1 (AAIF, ambient, contained `goose acp`) | yes — the summon extension's `delegate` tool call PROJECTS under approve mode (live evidence 2026-09-17, superseding the plan's expected-absent) and routes through `session/request_permission` | yes — `delegate`'s permission request reached the hub and was denied; nothing spawned unprojected | projected-and-asked — the delegation tool is hub-gateable (spawn-classified in `KNOWN_SPAWN_TOOLS` on this evidence, mirroring OpenCode's `task` precedent); subagent-internal tool activity stays inside the spawn (its `load` sibling never projected and stays unclassified) | **Green per probe (live 2026-09-17, six runs against 1.50.1 via the loopback metering proxy, openrouter provider, ambient-PATH version recorded in each `agentInfo`)** — PERMISSION **Green**: every mutating call (a todo-write, a `write` to the canary path, even a `shell` fallback) reached `session/request_permission` with the FULL option set (`allow_always`/`allow_once`/`reject_once`/`reject_always`) and the hub's deny-all was honored — the canary was never written (pre-mutation interception with usable reject options PROVEN; the decisive run logged all three asks); SUBAGENT **Green (denied)**: `delegate` projected and was denied at the hub — absence-or-denial per the plan, the "denied" arm, zero unprojected spawns; MOUNT **Green**: the hub-written `GOOSE_PATH_ROOT/config/config.yaml` (the DOCUMENTED map-shaped `extensions:` schema — the first live run rejected a list-shaped candidate with `NO_MCP_TOOLS`, and the documented schema then mounted) loads the skills-mcp stdio extension and the agent called `list_skills` returning the probe skill verbatim (F1 single-delivery-path POSITIVE on goose; the research record's GOOSE_PATH_ROOT unknown resolves positive — `goose info` confirms the config path, `goose acp` reads it); RESUME **Green**: `session/load` across a full contained restart replayed the transcript and restored model context (the exact keyword recalled); METERED **Green (openrouter)**: placeholder-only credential inside the boundary, the loopback proxy recorded 3 requests / 5,279 tokens / $0.0005, and TWO `usage_update` channels projected into the session record (goose's custom notification works end-to-end through W047's tolerance) — the azure_foundry run is PENDING CREDENTIALS (no `AZURE_FOUNDRY_*` in the probe environment; re-run when provisioned); HOOKS **Green**: a project-scope deny plugin in the documented structure (`plugin.json` + `hooks/hooks.json` + executable script) with exit-2 deny + `on_failure: block` BLOCKED the mutation under containment (the Cline-seam decision input resolves positive on the deny path; the first live run's `NO_HOOK_EFFECT` was a probe-composition artifact — an undocumented candidate manifest shape, fixed against the docs). Per the probe rules below, goose is reportable **`enforced` for this proven launch mode** (contained `goose acp`, `GOOSE_MODE=approve`, hub-written config, proxy metering): the pivotal permission probe proved pre-mutation interception with denials honored. Re-run the family on every goose version bump (weekly release cadence; record the ambient version in `agentInfo` evidence): `WORKFLOW_ACP_GOOSE_{PERMISSION,SUBAGENT,MCP_MOUNT,RESUME,METERED,HOOKS}=1` with OpenRouter credentials (`CLINE_API_KEY` or the key file) or `WORKFLOW_GOOSE_PROVIDER=azure_foundry` with `AZURE_FOUNDRY_*`. W049 dogfood (2026-09-17, agent-run, same launch mode through the production runtime path — `docs/GOOSE_DOGFOOD.md` records the full matrix): five cells ran green or green-with-finding, and the matrix forced two runtime-path fixes, both test-pinned — unknown ACP mutation tools are denied fail-closed (deny-and-adapt) instead of tearing down the session (goose's built-in `todo` tool was killing turns via the old throw), and the goose config root is workspace-keyed persistent state (`config.ws-<tag>`, never deleted by dispose or the pruner) so `session/load` finds the store across a full restart. MCP read-policy finding recorded honestly: `skills-mcp__list_skills` was denied by default authorization on the runtime path and goose adapted — read-policy for MCP tools is an explicit operator decision, not a defect. W050 SDK-seam input (2026-09-17, live twice): the granted-spawn SUBAGENT-HOOKS probe (`WORKFLOW_ACP_GOOSE_SUBAGENT_HOOKS=1`) resolved **subagent-internal hooks NEGATIVE** — the delegated subagent's file-write fired NO PreToolUse record and projected NO ACP tool_call update; only the top-level session's calls and the `delegate` spawn itself intercept (the delegate route stays hook-gateable at spawn, but the work INSIDE the spawn is hook- and projection-invisible). |

Probe rules (fail closed):

- **Green** — the spawn tool call is projected and its `session/request_permission`
  reaches the client (deniable) → `spawn` may be granted per operator policy,
  governed by the capability gate.
- **Red** — either probe invariant trips: (a) a workspace mutation arrives with
  no permission request that can account for it (ungated subagent mutation —
  including a projected-but-never-asked tool call), or (b) a spawn-family
  tool call runs without its own `session/request_permission` reaching the
  client (ungated spawn) → the agent is capped `advisory` or spawn-denied;
  it must not be labeled `enforced`.
- The probe re-runs for every pinned agent version bump; stale probe evidence
  never carries to a new version.

Run `npm test`, `npm run typecheck`, and `npm run build` after adding an adapter. `npm run test:cline-runtime` is the bounded Cline smoke flow: it loads the built Workflow fixture through the real `@cline/core` plugin loader supplied by an installed Cline CLI, then exercises the loaded `beforeTool` hook without starting a model session. It intentionally fails when that host runtime is unavailable rather than silently downgrading runtime evidence. This host check does not replace conformance tests.
