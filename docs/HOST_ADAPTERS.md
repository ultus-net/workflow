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
| Cline 3.0.61 (ACP) | unprobed | unprobed | unprobed | **Probe pending** — run `WORKFLOW_ACP_CLINE_SUBAGENT=1` with Cline credentials (`CLINE_API_KEY` or `CLINE_API_KEY_FILE`) via `node --import tsx --test test/acp-cline-subagent-probe.test.ts`; the probe launches the vendored pinned 3.0.61 entry (stock PATH cline is account-cloud-only in ACP mode and cannot authenticate headlessly — `docs/ACP_RESEARCH.md`); until green evidence exists, spawn stays default-denied and unprobed agents are not labeled `enforced` for spawn-inclusive workflows |
| OpenCode (ACP) | — | — | — | Advisory-capped: default ACP mode mutates without permission requests (`docs/ACP_DECISION.md`); re-evaluation requires the ask-config probe (plan Task G1) |

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
