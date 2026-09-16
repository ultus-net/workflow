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

For OpenCode hosts, `createWorkflowOpenCodePlugin(application, adapter)` registers a `tool.execute.before` hook: the adapter returns its typed `{ kind: "deny", reason }` control for a Workflow denial and the plugin throws it, so the host aborts the tool before execution. The factory likewise rejects advisory adapters.

## Current adapter files

| File | Role |
|---|---|
| `src/application/host.ts` | the contract vocabulary (`TranslatingHostAdapter`, `ProposedToolAction`, `HostCapabilities`, `ToolCapability`); the application layer owns its port |
| `src/adapters/host.ts` | deprecated re-export shim of the above for existing adapter/CLI import paths |
| `src/adapters/cline.ts` | Cline SDK adapter (production: TUI + hub) |
| `src/adapters/opencode.ts` | OpenCode adapter (production: plugin hook) |
| `src/adapters/acp.ts` | ACP adapter (conformance-covered; no production integration yet) |
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

| Agent (pinned) | Spawn tool advertised | Spawn gateable | Internal subagents visible to hub | Verdict |
|---|---|---|---|---|
| Cline 3.0.61 (ACP) | yes — `spawn_agent` exists and was used unprompted | no — no spawn tool call projected and no spawn permission reached the hub | no — the subagent's workspace write arrived with no accounting tool call | **Red (live 2026-09-16, vendored pinned entry)** — the spawn path is invisible to the hub: `spawn_agent` ran and the subagent wrote the canary, yet `spawnToolCallObserved: false` and `spawnPermissionObserved: false` in the probe evidence (`permissionCount: 3` unrelated permissions). Per the rules below the agent stays capped `advisory`/spawn-denied for spawn-inclusive workflows and must not be labeled `enforced`. Re-run on every pinned version bump: `WORKFLOW_ACP_CLINE_SUBAGENT=1` with Cline credentials (`CLINE_API_KEY` or `CLINE_API_KEY_FILE`) via `node --import tsx --test test/acp-cline-subagent-probe.test.ts` (vendored pinned entry — stock PATH cline is account-cloud-only in ACP mode and cannot authenticate headlessly — `docs/ACP_RESEARCH.md`) |
| OpenCode 1.18.31 (ACP, `--pure`) | yes — the `task` tool call projected to the hub | yes — the spawn's `session/request_permission` reached the client (deniable); gateability is config-owned (`permission: { task: "ask" }` in the hub-written project `opencode.json`) | partially — the spawn is projected; the subagent's internal tool activity stays in its own session (its write ran under `edit: "allow"`; whether a subagent-side `ask` surfaces to the hub is unprobed) | **Green (live 2026-09-16)** — the spawn tool call was projected AND its permission request reached the client, so per the rules below `spawn` may be granted per operator policy under the capability gate; the default-mode advisory cap (`docs/ACP_DECISION.md`) is superseded by the G1 ask-config pass (permission requests emitted, denials honored) whenever the hub pins the config. MCP mounts from hub-written config verified on both surfaces the same day (project `opencode.json` and `XDG_CONFIG_HOME` config — `test/acp-opencode-mcp-mount-probe.test.ts`) and `session/load` restores model context across restart (exact keyword recalled — `test/acp-opencode-resume-probe.test.ts`). Re-run on every pinned version bump: `WORKFLOW_ACP_OPENCODE_SUBAGENT=1`, `WORKFLOW_ACP_OPENCODE_MCP_MOUNT=1`, `WORKFLOW_ACP_OPENCODE_RESUME=1` via `node --import tsx --test` on each probe file (launches pass `--pure` to measure the stock surface without operator plugins) |

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
