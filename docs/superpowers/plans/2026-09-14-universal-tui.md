# Universal TUI — staged convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `workflow-tui` composes any registered host session driver (cline/opencode/acp) and renders the SDK-neutral `WorkflowTui`, with a documented parity checklist gating primary-surface migration.

**Architecture:** Pure driver registry maps a driver name to a composer (cline = existing `createConfiguredClineRuntime`; opencode = fetch client + `OpenCodeSessionDriver`; acp = contained `createConfiguredAcpRuntime`). Entry mirrors monitor-standalone composition (one local authority, labelled). Parity checklist in `docs/TUI_PARITY.md` defines the convergence gates.

**Tech Stack:** Node 22, node:test, ink, fetch/SSE (no new deps).

---

### Task 1: Driver registry

**Files:**
- Create: `src/cli/driver-registry.ts`
- Test: `test/driver-registry.test.ts`

- [x] **Step 1: failing tests**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkflowApplication } from "../src/application/workflow.js";
import { hostCapabilities } from "../src/adapters/host.js";
import { TaskGraph } from "../src/kernel/task-graph.js";
import { taskId } from "../src/kernel/contracts.js";
import { WorkflowCodingSession } from "../src/application/coding-session.js";
import type { CodingSessionDriver } from "../src/application/coding-session.js";
import { composeDriver, parseUniversalArgs, resolveDriverName } from "../src/cli/driver-registry.js";

const noopDriver: CodingSessionDriver = {
  async start() {}, async cancel() {},
};

function application() {
  return new WorkflowApplication(
    new TaskGraph([{ id: taskId("A"), title: "t", state: "READY", dependencies: [], requiredEvidence: [] }]),
    hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  );
}

test("resolveDriverName defaults to cline and honours WORKFLOW_DRIVER", () => {
  const original = process.env.WORKFLOW_DRIVER;
  delete process.env.WORKFLOW_DRIVER;
  try {
    assert.equal(resolveDriverName(undefined), "cline");
    process.env.WORKFLOW_DRIVER = "opencode";
    assert.equal(resolveDriverName(undefined), "opencode");
    assert.equal(resolveDriverName("opencode"), "opencode");
  } finally {
    if (original === undefined) delete process.env.WORKFLOW_DRIVER;
    else process.env.WORKFLOW_DRIVER = original;
  }
});

test("resolveDriverName fails closed on unknown names", () => {
  assert.throws(() => resolveDriverName("nope"), /unknown driver 'nope' \(valid: cline, opencode\)/);
});

test("parseUniversalArgs extracts driver and opencode url", () => {
  assert.deepEqual(parseUniversalArgs(["--driver", "opencode", "--opencode-url", "http://x:1"]), {
    driver: "opencode",
    opencodeUrl: "http://x:1",
  });
  assert.deepEqual(parseUniversalArgs([]), {});
});

test("composeDriver uses an injected composer before built-ins", async () => {
  const composed = await composeDriver("opencode", application(), process.cwd(), {
    opencodeUrl: "http://127.0.0.1:4096",
    composers: {
      opencode: async () => ({ label: "fake", session: new WorkflowCodingSession(noopDriver), dispose: async () => undefined }),
    },
  });
  assert.equal(composed.label, "fake");
});
```

- [x] **Step 2: run — fails (module missing)**

`node --import tsx --test test/driver-registry.test.ts`

- [x] **Step 3: implement `src/cli/driver-registry.ts`**

```ts
import type { WorkflowApplication } from "../application/workflow.js";
import type { CodingSessionDriver } from "../application/coding-session.js";
import { WorkflowCodingSession } from "../application/coding-session.js";
import type { SessionStyle } from "../integrations/response-style.js";
import { createConfiguredClineRuntime } from "../integrations/cline-runtime.js";
import { createOpenCodeSessionClient } from "../integrations/opencode-client.js";
import { OpenCodeSessionDriver } from "../integrations/opencode-session.js";

export const DRIVER_NAMES = ["cline", "opencode"] as const;
export type DriverName = (typeof DRIVER_NAMES)[number];

export interface ComposedDriver {
  readonly label: string;
  readonly session: WorkflowCodingSession;
  setSessionStyle?(style: SessionStyle): void;
  dispose(): Promise<void>;
}

export type DriverComposer = (application: WorkflowApplication, workspace: string) => Promise<ComposedDriver>;

export function resolveDriverName(raw: string | undefined): DriverName {
  const name = raw ?? process.env.WORKFLOW_DRIVER ?? "cline";
  if ((DRIVER_NAMES as readonly string[]).includes(name)) return name as DriverName;
  throw new TypeError(`unknown driver '${name}' (valid: ${DRIVER_NAMES.join(", ")})`);
}

export function parseUniversalArgs(args: readonly string[]): { driver?: string; opencodeUrl?: string } {
  const out: { driver?: string; opencodeUrl?: string } = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--driver") out.driver = args[++i];
    else if (args[i] === "--opencode-url") out.opencodeUrl = args[++i];
  }
  return out;
}

export async function composeDriver(
  name: DriverName,
  application: WorkflowApplication,
  workspace: string,
  options: { opencodeUrl: string; composers?: Partial<Record<string, DriverComposer>> },
): Promise<ComposedDriver> {
  const override = options.composers?.[name];
  if (override !== undefined) return override(application, workspace);
  if (name === "cline") {
    const runtime = await createConfiguredClineRuntime(application, workspace);
    return {
      label: "cline",
      session: runtime.session,
      setSessionStyle: (style) => runtime.setSessionStyle(style),
      dispose: () => runtime.dispose(),
    };
  }
  const client = createOpenCodeSessionClient(options.opencodeUrl);
  return {
    label: "opencode",
    session: new WorkflowCodingSession(new OpenCodeSessionDriver(client)),
    dispose: async () => undefined,
  };
}
```

- [x] **Step 4: run — passes** (registry/OpenCode/ACP/TUI focused run: 32/32 on 2026-09-15.)

- [ ] **Step 5: commit** `feat(cli): driver registry with cline/opencode composers`

---

### Task 2: OpenCode session client

**Files:**
- Create: `src/integrations/opencode-client.ts`
- Test: `test/opencode-client.test.ts`

- [x] **Step 1: failing tests** — stub `globalThis.fetch`; assert request paths/methods/bodies, error mapping on non-ok, SSE frame parsing:

```ts
test("create posts to /session and maps non-ok to error", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ id: "s1" }), { status: 200 });
  }) as typeof fetch;
  try {
    const client = createOpenCodeSessionClient("http://x:1");
    const result = await client.create({});
    assert.equal(result.data?.id, "s1");
    assert.equal(calls[0]!.url, "http://x:1/session");
    assert.equal(calls[0]!.init?.method, "POST");
  } finally { globalThis.fetch = original; }
});

test("abort maps non-ok status to error", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  try {
    const result = await createOpenCodeSessionClient("http://x:1").abort({ path: { id: "s1" } });
    assert.ok(result.error !== undefined);
  } finally { globalThis.fetch = original; }
});

test("event.subscribe parses SSE frames into an async stream", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    `data: {"type":"session.status","properties":{}}\n\ndata: {"type":"session.error","properties":{"error":"x"}}\n\n`,
    { status: 200 },
  )) as typeof fetch;
  try {
    const { stream } = await createOpenCodeSessionClient("http://x:1").event.subscribe();
    const events = [];
    for await (const event of stream) events.push(event);
    assert.equal(events.length, 2);
    assert.equal(events[1].type, "session.error");
  } finally { globalThis.fetch = original; }
});
```

- [x] **Step 2: run — fails**

- [x] **Step 3: implement `src/integrations/opencode-client.ts`**

```ts
import type { OpenCodeSessionClient } from "./opencode-session.js";

export function createOpenCodeSessionClient(baseUrl: string): OpenCodeSessionClient {
  return {
    create: () => request(`${baseUrl}/session`, {}),
    prompt: ({ path, body }) => request(`${baseUrl}/session/${path.id}/message`, body),
    abort: ({ path }) => request(`${baseUrl}/session/${path.id}/abort`, {}),
    event: { subscribe: () => subscribeSse(`${baseUrl}/event`) },
  };
}

async function request(url: string, body: unknown): Promise<{ data?: never; error?: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch((error) => ({ error }));
  if (!("ok" in response)) return { error: (response as { error: unknown }).error };
  if (!response.ok) return { error: new Error(`opencode request failed with status ${response.status}`) };
  return { data: (await response.json()) as never };
}

async function subscribeSse(url: string): Promise<{ stream: AsyncIterable<unknown> }> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) throw new Error(`opencode event stream failed with status ${response.status}`);
  return { stream: sseFrames(response.body) };
}

async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data.length > 0) yield JSON.parse(data);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

- [x] **Step 4: run — passes**

- [ ] **Step 5: commit** `feat(integrations): fetch-based OpenCode session client (no new deps)`

---

### Task 3: Universal entry + bin

**Files:**
- Create: `src/cli/universal-tui.tsx`
- Modify: `package.json` (bin + script)

- [x] **Step 1: write entry** (mirror monitor-standalone composition):

```tsx
#!/usr/bin/env node
import React from "react";
import { render } from "ink";

import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { TaskGraph } from "../kernel/task-graph.js";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { createCheckpointLedger } from "../pedagogy/checkpoints.js";
import { WorkflowTui } from "../ui/tui.js";
import { composeDriver, parseUniversalArgs, resolveDriverName } from "./driver-registry.js";
import { resolveTuiWorkspace } from "./tui-args.js";

const args = parseUniversalArgs(process.argv.slice(2));
const driverName = resolveDriverName(args.driver);
const workspace = resolveTuiWorkspace(process.argv.slice(2), process.cwd());

const seed: WorkflowTask[] = [
  { id: taskId("interactive"), title: "Interactive coding session", state: "READY", dependencies: [], requiredEvidence: [] },
];
const application = new WorkflowApplication(
  new TaskGraph(seed),
  hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  [],
  new Set(["read", "mutation", "process"]),
  workspace,
);

const composed = await composeDriver(driverName, application, workspace, {
  opencodeUrl: args.opencodeUrl ?? process.env.WORKFLOW_OPENCODE_URL ?? "http://127.0.0.1:4096",
});

const { waitUntilExit } = render(
  React.createElement(WorkflowTui, {
    application,
    session: composed.session,
    connectionLabel: `${composed.label} · standalone (local authority)`,
    onStyleChange: composed.setSessionStyle,
    onModeChange: (mode) => application.setPedagogyGate(createCheckpointLedger(mode)),
  }),
);
await waitUntilExit();
await composed.dispose();
```

`package.json`: add bin `"workflow-tui": "dist/cli/universal-tui.js"` and script `"tui:universal": "tsx src/cli/universal-tui.tsx"`.

- [x] **Step 2: build + typecheck** — both clean on 2026-09-15.

- [x] **Step 3: smoke** — built universal entry with explicit `--driver acp` fails closed at composition with the exact actionable missing-credential error under an isolated HOME; no fallback is attempted (2026-09-15).

- [ ] **Step 4: commit** `feat(cli): workflow-tui universal entry composing cline/opencode drivers`

---

### Task 4: Parity checklist + docs

**Files:**
- Create: `docs/TUI_PARITY.md`
- Modify: `README.md` (command table + one line), `docs/TUI_INTEGRATION.md` (convergence rule)

- [x] **Step 1: write `docs/TUI_PARITY.md`** — one checklist item per convergence gate with acceptance criteria:

```markdown
# Universal TUI parity checklist

Convergence gates for making `workflow-tui` the primary interactive surface.
Each item is an ownable task with an acceptance test; the primary surface
flips only when every box is checked.

- [ ] Composer: multi-line editing, paste, history recall (acceptance: PTY test)
- [ ] Session resume/history via SDK-native persistence (acceptance: resume after restart)
- [ ] Transcript scrollback with bounded memory (acceptance: component test)
- [ ] Style dials (speech/build) wired to composed driver (acceptance: driver applies addendum)
- [ ] Pedagogy mode gate installed (acceptance: mode change gates mutation)
- [ ] Cancel keymap aborts active driver (acceptance: driver.cancel called)
- [ ] Hub-mediated session driving: TUI projects and drives the hub's canonical state (acceptance: two surfaces share one authority)
- [ ] Monitor parity: `workflow-monitor` attaches to the same session (acceptance: joint smoke)
```

- [x] **Step 2: README command table** — documents `workflow-tui` as the driver-selectable fallback surface.

- [x] **Step 3: `docs/TUI_INTEGRATION.md`** — append the staged-convergence rule:

```markdown
## Staged universal TUI convergence

`workflow-tui` composes any host session driver onto the SDK-neutral
`WorkflowTui`. The patched Cline CLI TUI stays the primary interactive
surface until every item in `docs/TUI_PARITY.md` passes; afterwards the
primary surface flips to `workflow-tui` and per-SDK patched TUIs become
optional surfaces.
```

- [ ] **Step 4: commit** `docs: universal TUI parity checklist + convergence rule`

---

### Task 5: Gates + review

- [ ] `npm run lint && npm test && npm run typecheck && npm run build`
- [ ] Secondary five-axis review via guard (rubric → reviewer subagent → record_review)
- [ ] Final commit

---

## Self-review notes

- Spec coverage: registry=T1, client=T2, entry=T3, checklist/docs=T4, gates=T5.
- The entry's session driving is standalone-local per spec decision (hub-mediated driving is a parity item, not this branch).

## Roadmap extension: ACP universal driver (TASKS.md W037)

The registry absorbs a third composer, `--driver acp`, as the protocol-native
universal target: `AcpSessionDriver` over stdio JSON-RPC (`session/new`,
`session/prompt`, `session/cancel`, `session/update`), permission flow wired
through `AcpHostAdapter` + `WorkflowApplication.authorize`, and ACP
filesystem/terminal capabilities routed through `WorkflowContainedProcess`.
Cline stays the primary host via its bespoke driver; ACP is the
generalization path. See TASKS.md W037 for acceptance criteria.
