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

Classify capabilities at normalization. Known command/process tools require `process`; credential-bearing operations require `credentials`. If one action requires both, include both in `requiredCapabilities`. `WorkflowApplication` unions those requirements with the primary `capability`, so metadata cannot remove a restriction. New high-blast-radius SDK tools require adapter classification before that integration can claim complete enforcement coverage.

Fail closed on malformed recognized safety metadata. A malformed `path`, location, command classification, or credential classification must not silently become an ordinary subjectless/read action. A genuinely subjectless SDK action may use `subjects: []` when no recognized location field exists.

Adapter conformance should prove at least: truthful enforced/advisory reporting, valid event normalization, malformed safety metadata rejection, denial-to-native-control translation, known process classification, credential classification when the SDK exposes it, combined capability requirements, and application authorization using the normalized proposal. `test/cline-adapter.test.ts`, `test/acp-adapter.test.ts`, and `test/application.test.ts` are the current executable examples.

Run `npm test`, `npm run typecheck`, and `npm run build` after adding an adapter. `npm run test:cline-runtime` is the bounded Cline smoke flow: it loads the built Workflow fixture through the real `@cline/core` plugin loader supplied by an installed Cline CLI, then exercises the loaded `beforeTool` hook without starting a model session. It intentionally fails when that host runtime is unavailable rather than silently downgrading runtime evidence. This host check does not replace conformance tests.
