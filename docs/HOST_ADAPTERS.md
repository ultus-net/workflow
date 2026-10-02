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

**2026-09-18 (W050 follow-up — merged; launch fallback removed):** steps C1-C7 merged to `main` via PR #40. `resolveClineLaunch` no longer carries the deprecated `.workflow-cline` compiled-binary branch (the step-5 "PATH → vendored fallback" precedence above is superseded): it resolves `WORKFLOW_CLINE_BIN` → ambient PATH `cline`, else fails closed. The connector remains **probe-PENDING on stock 3.0.62** — no live stock probe run has been recorded.

**2026-09-20 (Cline 3.0.62 hub/dashboard surfaces — observed, no verdict):** stock `cline` now ships its own authority family: a background hub daemon (`cline hub`, sessions via `cline -z --zen`), a bindable dashboard web UI (`cline dashboard` — `--host/--port/--public-url/--room-secret`), a kanban app (`cline kanban`), external channel connectors (`cline connect [channel]` with daemon supervision/autostart), and scheduled tasks (`cline schedule`). Two consequences recorded per honest-claims culture: (1) cline has independently converged on the hub + web-frontends topology, but its dashboard supervises **cline's own hub** — driving cline sessions through it bypasses Workflow authority entirely, so Workflow-governed cline work must continue to enter through `cline --acp` into the Workflow hub; (2) fronting cline's dashboard/kanban behind the Workflow hub (the opencode-web-UI pattern) would require a **cline-hub-shaped facade** — a distinct facade from the opencode-API one, probe-PENDING until someone verifies what API cline's dashboard expects and whether its hub can host externally driven sessions. Until probed, the dashboard/kanban must not be presented as Workflow-governed surfaces.

**2026-09-18 (remote ACP bridge — M1 scaffold, advisory):** branch `feat/opencode-remote-acp-bridge` adds an ACP-agent-side bridge to a remote/attached OpenCode server over its HTTP/SSE API (`src/integrations/remote-acp/{engine,projection,agent}.ts`, `src/cli/acp-remote.ts`), specified in `docs/OPENCODE_REMOTE_ACP_SPEC.md`. The ACP surface covers session new/load (assistant replay)/resume/list/close, mode/model/effort config options, prompt (threading the selection), cancel, and permission interception. Posture is **advisory only**: the bridge forwards `permission.asked` to the ACP client and relays the answer. Enforcement additionally requires the remote ruleset to emit `ask` and the PERMISSION/BYPASS/RULE-CONFIG/SUBAGENT probes to run green (gated on `WORKFLOW_ACP_REMOTE_{SSE,AUTH,PERMISSION,BYPASS,RULE_CONFIG,SUBAGENT}`); they have **not** been run, so this surface must not be labeled `enforced`.

For OpenCode hosts, `createWorkflowOpenCodePlugin(application, adapter)` registers a `tool.execute.before` hook: the adapter returns its typed `{ kind: "deny", reason }` control for a Workflow denial and the plugin throws it, so the host aborts the tool before execution. The factory likewise rejects advisory adapters.

**2026-09-19 (W071 standard-TUI server surface — advisory, probe-PENDING):** branch `feat/w071-standard-tui-background-authority` adds a Workflow-owned OpenCode server path: a contained `opencode serve` (`src/integrations/opencode-server-runtime.ts`, hub-written metered config + pinned `ask` ruleset), an authority gateway with a client/upstream credential split (`src/integrations/opencode-server-gateway.ts`), a policy broker mapping `permission.asked` → `ProposedToolAction` → `WorkflowApplication.authorize` (+ guard) → `once`/`reject` (`src/integrations/opencode-server-authority.ts`), a workspace-scoped daemon (`src/cli/opencode-server.ts`), and a launcher that runs the **stock** `opencode attach` (`src/cli/opencode-attach.ts`; discovery at `~/.workflow/opencode-server`, client password only). Operator-intent modes (`auto-resolve` / `ask-me`), an enforced posture with startup ruleset verification (`WORKFLOW_OPENCODE_ENFORCEMENT=enforced`), and a bypass alarm on undecided mutating activity are implemented. Posture is **advisory only**: the live `permission.asked` → authorize → reply path, RULE-CONFIG (effective ruleset read), and BYPASS probes have **not** been run (they need a model key), so this surface must not be labeled `enforced`. It is **not** an ACP adapter row; the enforcement claim will be earned per the same probe discipline as the ACP surfaces and recorded here as a dated verdict when the probes run.

**2026-09-20 (W074a stock opencode web UI behind the enforced gateway — live-verified on v2.0.10; W071 attach topology re-qualified live the same day, enforcement claims still open):** the route-class matrix gained a deliberate `app-shell` class (§2.5 row: `GET`/`HEAD` forward of exactly `/`, `/_assets/` hashed bundles, `/icons/`, `/site.webmanifest`, `/favicon.ico`; no root catch-all), and the gated probe `test/opencode-webui-gateway-probe.test.ts` (`WORKFLOW_OPENCODE_WEBUI_PROBE=1`) ran **live** against stock `opencode serve` v2.0.10 through the **enforced** gateway: the app shell serves as `text/html`, its referenced hashed bundle as `text/javascript`, the manifest forwards, unauthenticated `GET /` is `401`, and an unknown root read plus the credential-bearing config read stay `403` fail-closed. En route the probe surfaced two honest findings: (1) stock v2.x serves the web UI as an SPA fallback on **every** bare path (`/global/health`, `/session`, `/config` all return HTML — the JSON API lives under `/api/*`), so the W071 runtime's health wait was written against the v1.18 API shape; the health wait and the authority broker's SSE subscription are now version-tolerant (v1 JSON `{healthy:true}` or v2 `/api/info` for health; `/api/event` by content-type with a `/global/event` fallback for the stream). (2) The **M1 attach probe** (`test/opencode-server-attach-probe.test.ts`, gated `WORKFLOW_OPENCODE_SERVER_ATTACH=1`) was **re-qualified to the v2 spellings and ran live green on v2.0.10 the same day**: hub-written config loaded and parsed (the metered provider is in the loaded config documents), `/api/session` create through the gateway returns the v2 `data.id` envelope, the authority split holds (a gateway-only credential gets `401` upstream), the broker subscribes to the real server's event stream and intercepts a reply without forwarding it. **Still advisory**: the live `permission.asked` → authorize → reply path against a real model turn needs a model key; no `enforced` claim is earned. (3) Fresh research against the brand-new v2 API docs (`opencode.ai/v2/docs/api`, §9 of the migration spec) reconciled the route-class matrix with the documented 136-operation inventory and surfaced a real v2 behavior: **config-defined custom providers do not appear in `/api/provider` or `/api/model` on v2.0.10, and `/api/model/default` ignores the config `model` field** — provider visibility follows the credential-activation model (`/api/credential/{id}/activate`), matching the upstream custom-provider-visibility issue class; the metered provider is asserted via the loaded config documents, not the provider list.

**2026-09-20 (W082 operator-triggered compaction through the enforced gateway — live-verified on v2.0.10):** the gated probe `test/opencode-compact-probe.test.ts` (`WORKFLOW_OPENCODE_COMPACT_PROBE=1`) ran **live** against stock `opencode serve` v2.0.10 through the **enforced** gateway: unauthenticated compact stays `401`; the documented `POST /api/session` creates a probe session through the gateway (v2 `data.id`, `^ses`); and `POST /api/session/{id}/compact` is **admitted** — the server returns the documented `{ data: Session.Inbox.Compaction }` inbox item (`type: "compaction"`), i.e. the request is **queued and runs at the session's next step boundary**, matching the documented steering semantics ("Steers by default: it runs at the next step boundary instead of waiting behind queued prompts"). The §9 research note records the two compaction kinds (`native` provider-local vs `summary` persisted) and the overflow failure mode (a `400` telling the operator to start a new session or `/compact`) that motivated the manual control. The PWA control (`POST /api/sessions/compact` → the gateway walk → the documented route) is wired to this same path; the hub-side threshold auto-trigger remains **open** and no `enforced` claim is made for any auto-compaction behavior (manual operator control only, per the W080/W082 design).

**2026-09-20 (W078 follow-up — the machine-readable probe verdict register):** every gated probe family this document writes up in prose now has a durable machine-readable row in `docs/PROBE_VERDICTS.json` (schema v1, fail-closed validation in `src/integrations/probe-verdicts.ts`; bidirectional anti-drift pinned by `test/probe-verdict-register.test.ts` — every row's probe file must exist and still name its gate, and every gate-style probe file in the test corpus must have a row). The register records host + version of record, probe file, gate env, date, result (`green`/`red`/`negative`/`pending`/`blocked`), the enforcement posture the verdict supports, the evidence pointer into this document, and — for every `blocked` row — the missing operator environment/credential (the remote-ACP family, the model-key permission/rule-config/bypass probes, the open-model live probe, stock-Cline auth, and the azure metered run are blocked, never silent). `workflow doctor` renders the register state (`checkProbeVerdicts`) instead of a hardcoded gate list. This document remains the human write-up; when a probe re-runs on a version bump, BOTH the dated prose here and the register row move together.

**2026-09-21 (W082 hub-side auto-trigger — config-side decision, config-load arm live-verified on v2.0.10):** the hub-side automatic compaction trigger is **config-side** (the §9 addendum records the owner decision): the settings preference `agents.<id>.autoCompact` (explicit boolean, default off, workspace-over-global, panel toggle for opencode) composes `compaction: { auto: true }` into the hub-written per-runtime config — consumed by the ACP subprocess composition AND the topology server config (the daemon resolves the same preference fail-soft). Ownership: the session runtime under hub-written config (the §9 research note: the ACP lane auto-compacts exactly when the model's compaction config enables it); the hub scheduler and session manager are rejected as owners and the topology-daemon monitor is recorded as the data-lane follow-up behind a per-session usage-read probe. Budget-guard-aware by construction — a compaction turn is a normal metered model turn through the same loopback proxy the W045 interactive budget guard watches, the sticky refusal gate bounds later prompts, and no bypass lane is composed. **No plugin hook is composed** (the v2 `ctx.session.hook("compaction")` stays excluded per W082). Probe evidence: `test/opencode-auto-compact-probe.test.ts` (`WORKFLOW_OPENCODE_AUTO_COMPACT_PROBE=1`) ran live green on stock v2.0.10 — the composed config carries the block beside the pinned ask ruleset and `/api/config` lists the hub-written document with `compaction.auto === true` parsed; the **LIVE auto-compact turn arm stays PENDING** (needs a real model key) — register row `opencode-auto-compact-config-load` in `docs/PROBE_VERDICTS.json`, so **no `enforced` claim is made for the runtime's auto-compaction behavior**. Store finding recorded the same day (honest-claims): the web session registry's agent-session ids live in the ACP subprocess's scratch-HOME store while the gateway fronts the topology server's own store — the manual control's admit path is route-qualified and its session-level reachability for web-UI ACP sessions is unprobed; the control surfaces the gateway's refusal verbatim, never a fabricated success.

**2026-09-21 (v2 route qualification — live run recorded, register row moves pending→green):** `test/opencode-v2-probe.test.ts` (`WORKFLOW_OPENCODE_V2_PROBE=1`) ran **live** against a contained stock v2.0.10 server started for the probe (fake-proxy hub-written config, no model turn, no credentials consumed): `/api/info` reports the pinned version, authenticated `/api/experimental/session/stats` returns the documented data envelope, `/api/event` is an observable SSE stream, and the unauthenticated auth boundary covers every route class. The route-class matrix itself remains test-pinned in `test/opencode-v2-route-class.test.ts`; register row `opencode-v2-route-qualification` now carries the dated green (posture advisory — the qualification is route-observability, not an enforcement claim).

**2026-09-26 (event-stream keepalive in the server gateway — unit-proven, live-ingress probe PENDING):** the W071 gateway's `forward()` path now keeps a quiet `text/event-stream` response alive: for an unencoded event stream it flushes the response head immediately (a buffered head left the client waiting on a body that may not arrive for minutes) and writes an SSE comment frame `: workflow-keepalive\n\n` from an idle timer — 15s default, `WORKFLOW_SSE_KEEPALIVE_MS` override (positive integer, else the default). The timer is re-armed on every upstream chunk (a busy stream is never interleaved) and cleared on upstream end/error/close and on response finish/close (no timer outlives a disconnect), and it is `unref()`ed. A comment frame carries no `event:`/`data:` field, so a conforming parser ignores it: the client sees byte activity, never a phantom event. Proof is `test/opencode-server-gateway.test.ts` against a stub upstream: repeated frames during quiet, no frame on a busy stream, no frame appended past a self-ending stream, and no frame injected into a `content-encoding: gzip` stream (a compressed event stream is proxied byte-identical — a broken decoder is strictly worse than a drop-prone stream, and that residual is stated, not hidden). **Advisory, probe-PENDING**: the reason for the change is an ingress proxy with a ~4-minute idle timeout, and that end-to-end path has **not** been probed against a real proxy — no register row is claimed, and the keepalive is transport liveness only, never evidence of upstream health or hub authority.

**2026-09-26 (event-stream keepalive — the ingress probe now runs; a deployed-ingress qualification stays open):** `test/opencode-server-gateway-ingress-probe.test.ts` stands a real idle-timeout ingress — an L7 forwarder that destroys any response with no bytes for N ms, its watchdog armed when the request goes out — in front of the **production** gateway in the enforced posture, backed by a stub `opencode serve` whose `/api/event` delivers its head and then stays silent, with an attached raw client on the far side. Three arms, none vacuous: with `WORKFLOW_SSE_KEEPALIVE_MS=100` against a 400ms proxy idle window the attached stream survives ~2.5 idle windows with the ingress watchdog never firing and every frame a comment (no `event:`/`data:` field, so a conforming parser sees liveness, not a phantom event); the **control** arm — keepalive 5s against the same 400ms window — is destroyed by the proxy, so a proxy that never times out cannot make the first arm pass for free; and the **stated residual** arm pins that a `content-encoding: gzip` event stream (the same route, `?encoding=gzip` on the stub) is still dropped, because it is proxied byte-identical. The frame-level unit proof above is unchanged. **Advisory, ungated, and NOT a deployed-ingress qualification**: the probe is hermetic on loopback (a real proxy hop, a stub upstream, no live host, no credentials), so it runs in the ordinary suite and claims no dated gate verdict — no `docs/PROBE_VERDICTS.json` row — and a real nginx/ALB/Cloudflare read-timeout configuration in front of a live `opencode serve` remains unprobed. The keepalive is transport liveness only, never evidence of upstream health or hub authority.

**2026-09-26 (event-stream reconnect in the SSE client — the surviving half of the ingress story, unit-proven and ungated):** the frame above reduces ingress drops; it does not prevent them (a `content-encoding: gzip` stream gets no frame by design, and a proxy may destroy an idle response anyway). `RemoteEngine.events()` in `src/integrations/remote-acp/engine.ts` was one-shot: any such drop silently ended the async generator and the attached session stopped receiving events with nothing reporting the loss. The subscription is now bounded-reconnect: a premature end — a clean early close **or** a reset read, which is how a dropped ingress connection actually surfaces — re-opens the route (v2 `/api/event`, then the v1 `/global/event` fallback, re-decided on every attempt) after a backoff that doubles from `DEFAULT_EVENT_RECONNECT_BACKOFF_MS = 250` and is capped at `EVENT_RECONNECT_MAX_BACKOFF_MS = 5000`, up to `DEFAULT_EVENT_RECONNECT_ATTEMPTS = 10` re-opens, after which the generator ends and the caller records authority loss exactly as before. Deliberate boundaries: a caller abort is never a fault, so an aborted subscription never re-opens; a failed open still throws (a 401 surfaces instead of being retried into silence); a read fault is rethrown once the bound is spent rather than swallowed into a quiet end; and nonsense bounds (non-integer or negative) fall back to the defaults, with `maxAttempts: 0` as the explicit one-shot escape. Proof is `test/remote-acp-engine.test.ts` against a stub `fetch`: the event before a dropped stream and the one after the re-open both reach the caller, the v1 fallback is re-evaluated on a reconnect, the attempt cap terminates instead of looping, an aborted subscription never re-opens, a spent cap rethrows, and a non-OK open throws. **Advisory, ungated, and no register row**: the probe arm above is unchanged and still not a deployed-ingress qualification, and the reconnect is the same kind of claim as the frame — transport liveness only. A re-opened route is never evidence that upstream is healthy or that the hub is the authority, and an SSE resume does not replay: an event emitted while the route was down is missed, so a consumer needing that gap must re-read state. The recipe for both halves is pinned in `infra/c0/README.md`.

**2026-09-26 (remote ACP bridge — SSE idle-window arm added, probe PENDING):** `test/acp-remote-sse-probe.test.ts` gains a second, separately gated arm (`WORKFLOW_ACP_REMOTE_SSE_IDLE=1`) that holds **one** `/api/event` subscription open through a 4-minute window in which no events are delivered, and fails only on two conditions: the ingress **dropped** the stream (the iterator ended or errored mid-window) or it **silently resumed** (a second `text/event-stream` subscription appeared under a probe that never re-opens one — an engine-side resume (the bounded reconnect in the entry above) surfaces as exactly that second subscription, so the arm keeps the gap visible instead of quietly swallowing it). Anything delivered during the window is reported as a diagnostic, not a pass: a non-event-free window means the idle premise was only partially exercised. Register row `acp-remote-sse-idle` is **pending** — the arm has never run live, and even a green run caps the bridge at **advisory**, because it measures transport liveness, never enforcement. (The `240_000` literals elsewhere in `test/` are per-probe timeouts, not an ingress window; there is no separate ingress-idle surface to qualify.)

**2026-09-26 (same arm — the survival decision extracted and test-pinned; verdict still PENDING):** the decision above was inline asserts inside a test that only runs under its gate, for 240 seconds, against a live server, so nothing a reviewer or CI runs in a minute could tell whether the arm still refused a drop, a silent resume, or a window that closed early — a weakened check would have stayed green until the next four-minute live run. The decision now lives in `classifySseIdleHold` (`src/integrations/probe-verdicts.ts`), a pure function over the facts the live arm recorded, and the arm is the only place the **evidence** is gathered. `test/probe-verdict-sse-idle.test.ts` pins the conditions in the normal suite: a mid-window drop, a second `text/event-stream` subscription, a short hold (reported as probe integrity *first*, so a window cut short can never be recorded as an ingress drop it may have manufactured), a subscription that never opened, a clean 240s hold, and a non-event-free window that still survives but is reported as a partially exercised premise. An anti-drift pin in the same file keeps the gated arm calling the shared function instead of re-inlining the finding. No change to what the arm measures: row `acp-remote-sse-idle` stays **pending**/**unqualified** until it runs live.

**2026-09-27 (same arm — the register row's `green` is re-derived from its own hold facts, never read; verdict still PENDING):** a pure decision pinned by tests still leaves one hole: once the live run exists, the *record* of that run is a string in `docs/PROBE_VERDICTS.json`, and a string can be edited. A register row may now carry `idleHold` — the facts the arm recorded (`heldMs`, `idleWindowMs`, `delivered`, `subscriptions`, `openedBefore`, and a mid-window `drop` if one happened) — and `validateProbeVerdictRegister` runs them back through the same `classifySseIdleHold` the arm decided with. So a `green` on `WORKFLOW_ACP_REMOTE_SSE_IDLE` must carry facts that classify as `survived`; facts that classify as `dropped`, `resumed`, `never-opened` or `short-hold` are an error, and so is a `green` with **no** facts at all — a survival with nothing measured behind it. The facts are optional everywhere else and on every other result (a `pending` row has not run; a `red` row reports a finding, not a survival), but facts that *are* present must classify, and unmeasurable ones fail closed with the row named. When the arm does run live, the honest sequence is: run the arm, copy the facts it printed into the row, and let the register confirm the `green` rather than assert it. Pinned in `test/probe-verdict-register.test.ts`; row `acp-remote-sse-idle` remains **pending**/**unqualified** with no facts, because the window has still never been held live.

**2026-10-02 (W183 proxied-network containment — new gated probe, live green on this host):** `test/acp-contained-egress-probe.test.ts` (gate `WORKFLOW_ACP_CONTAINED_EGRESS=1`) proves the two claims the W183 `network: "proxied"` posture rests on, inside a real `ProxiedBubblewrapContainment` sandbox: a contained process's proxy-aware HTTP egress reaches an allowed origin **through the parent forward proxy** (`src/integrations/egress-forward-proxy.ts`, returning the upstream body), and a request to an **unlisted** host is denied at the proxy (`403`, deny-by-default). The live arm ran **green 3/3** on this host (bwrap + slirp4netns present, unprivileged user namespaces available); register row `acp-contained-egress-probe` records `green`/**advisory**. The probe sends proxy-directed requests only, so it supports the proxy-aware narrowing and nothing about the unfenced raw-socket path (slirp is not given `--disable-host-loopback`); even this green earns evidence only for the W183 **narrowing**: raw-socket egress from a hostile process is not fenced and stays a stated `THREAT_MODEL.md` residual #1. No `enforced` claim. The mechanism is activation-pending in production: `launchContainedAcpAgent`/`launchContainedAcpAgentAsync` select `proxied` only when the backend advertises `supportsProxiedNetwork` and a `proxiedEgressPolicy` is supplied, and `src/integrations/acp-runtime.ts` does not yet thread `loadEgressPolicyFile()` into the launch, so production keeps `network: "host"` until that wiring lands.

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
- Harness scaffolding is audited separately and only on operator request: the
  remove-one-component-at-a-time model-bump audit in
  `docs/HARNESS_ASSUMPTION_LEDGER.md` is available at every pinned-version
  bump but is never automatic, and never substitutes for the probe re-runs
  above.

Run `npm test`, `npm run typecheck`, and `npm run build` after adding an adapter. `npm run test:cline-runtime` is the bounded Cline smoke flow: it loads the built Workflow fixture through the real `@cline/core` plugin loader supplied by an installed Cline CLI, then exercises the loaded `beforeTool` hook without starting a model session. It intentionally fails when that host runtime is unavailable rather than silently downgrading runtime evidence. This host check does not replace conformance tests.

## Vendor anthropic cache-marker probes

P8 (issue #287) asks whether anthropic-compatible endpoints accept the
Messages-schema `cache_control` markers that `applyCacheMarkers`
(`src/integrations/model-profile.ts`) emits on the system block, the last tool
definition, and (since P13, issue #292) the previous turn's boundary block. The
**deployed** lane is a reseller/provider route (Azure AI Foundry or OpenRouter),
not direct vendor API keys; the direct per-family arms measure the vendor
contracts themselves. One dated entry per lane, in the probe-verdict prose
style used above. Gate: `WORKFLOW_VENDOR_CACHE_PROBE`; the live-run runbook is
`docs/P8_LIVE_RUN_RECIPE.md`.

**2026-09-30 (vendor anthropic cache-marker probe — provider: OpenRouter `anthropic/claude-sonnet-4.5` — live on `https://openrouter.ai/api/v1`):**
`test/vendor-anthropic-cache-probe.test.ts` (`WORKFLOW_VENDOR_CACHE_PROBE=provider`,
`WORKFLOW_PROVIDER_ANTHROPIC_URL=https://openrouter.ai/api/v1`,
`WORKFLOW_PROVIDER_MODEL=anthropic/claude-sonnet-4.5`) ran live against
OpenRouter — the deployed reseller route — via the operator's cline-api-key
OpenRouter credential. The composed body carried the ephemeral markers on the
system block, the last tool, and the previous turn's boundary block (recorded
`request.*Marker` = `{"type":"ephemeral"}`). The endpoint, served by **Amazon
Bedrock**, returned 2xx with a well-formed Messages body and `stop_reason:
"end_turn"`; observed `cacheUsage` = `cache_creation_input_tokens: 0`,
`cache_read_input_tokens: 0`, `input_tokens: 581`, `output_tokens: 4`. Verdict:
**accepted but no cache accounting** — the endpoint took the marked body but did
not account for the markers. Register row `vendor-anthropic-cache-provider` moved
`blocked -> negative`; posture advisory (observability, not enforcement).
Caveat: one marked request can only show cache **creation**, so a cache **read**
needs a second turn with the same prefix. The direct **deepseek/glm/kimi** family
arms were **not run** (no keys) and are recorded separately as
`vendor-anthropic-cache-families`, still `blocked`/`unqualified`; the provider
verdict does not cover them, and the W109 `cacheMarkers` opt-in stays dark for
every family.

**2026-09-30 (vendor anthropic cache-marker probe — families via OpenRouter: `deepseek/deepseek-v4-flash`, `z-ai/glm-5.3-flash`, `moonshotai/kimi-k2.6` — live on `https://openrouter.ai/api/v1/messages`):**
The operator reaches these families **through OpenRouter**, so this is the
deployed-route measurement — it does **not** claim direct-vendor coverage.
`test/vendor-anthropic-cache-probe.test.ts` (`WORKFLOW_VENDOR_CACHE_PROBE=<family>`,
`WORKFLOW_PROVIDER_ANTHROPIC_URL=https://openrouter.ai/api/v1`) ran live; the
composed anthropic Messages body carried the three ephemeral markers on the
system block, the last tool, and the previous turn's boundary block (recorded
`request.*Marker` = `{"type":"ephemeral"}`). One line per family:
`deepseek/deepseek-v4-flash` — 2xx, `stop_reason: "end_turn"`, response provider
**DeepInfra**, `cache_creation_input_tokens: null`, `cache_read_input_tokens: 0`;
`z-ai/glm-5.3-flash` — 2xx, `stop_reason: "max_tokens"`, provider **Relace**,
`cache_creation_input_tokens: null`, `cache_read_input_tokens: 0`;
`moonshotai/kimi-k2.6` — 2xx, `stop_reason: "max_tokens"`, provider **Inceptron**,
`cache_creation_input_tokens: null`, `cache_read_input_tokens: 0`. Verdict:
**accepted but no cache accounting** for all three — the endpoints took the
marked body but did not account for the markers. Register row
`vendor-anthropic-cache-families` moved `blocked -> negative`; posture advisory
(observability, not enforcement). Caveat: one marked request can only show cache
**creation**, so a cache **read** needs a second turn with the same prefix. A
green cache effect was **not** observed: the W109 `cacheMarkers` opt-in's value
here is marker pass-through, not a measured saving.

**2026-09-30 (vendor anthropic cache-marker probe — CORRECTION: the
sub-minimum-prefix confound — provider lane re-ran green, family row retracted):**
The provider and family entries above recorded `negative` on a probe body of
~581 input tokens (559 chars serialized; 177 marked-text chars), which is
**below** Anthropic's ~1024-token cache minimum: at that size a `cache_control`
marker is not cache-**eligible**, so the endpoint returns 2xx with
`cache_creation_input_tokens: 0` whether or not it understands the marker. The
recorded 0/0 was therefore a prefix-size artifact, not evidence the endpoints
ignore the markers. The probe's marked system prefix is now generated
(`buildSharedPrefix`, `test/vendor-anthropic-cache-probe.test.ts`) to ~8341
chars (~2000 tokens), with an ungated floor pin so it cannot silently shrink
under the minimum again. The provider lane re-ran live on 2026-09-30
(`WORKFLOW_VENDOR_CACHE_PROBE=provider`,
`https://openrouter.ai/api/v1/messages`, `anthropic/claude-sonnet-4.5`, served
by **Amazon Bedrock**): 2xx, well-formed Messages body, `stop_reason:
"end_turn"`, markers system/lastTool/boundary each `{"type":"ephemeral"}`,
observed `cacheUsage` = `cache_creation_input_tokens: 2035`,
`cache_read_input_tokens: 0`, `input_tokens: 3`, `output_tokens: 4`. Independent
orchestrator-run direct evidence on the same route with a ~4.8k-token marked
prefix confirms both halves: turn 1 `cache_creation_input_tokens: 4802` /
`cache_read_input_tokens: 0`, turn 2 (same prefix)
`cache_creation_input_tokens: 0` / `cache_read_input_tokens: 4802`. A
single-request probe can only show cache **creation**; the two-turn direct run
supplies the **read**. Register row `vendor-anthropic-cache-provider` moved
`negative -> green`; posture advisory (observability, not enforcement). The
direct **deepseek/glm/kimi** family row (`vendor-anthropic-cache-families`) is
retracted to `blocked`/`unqualified`: its bodies carried the same sub-minimum
prefix, so its `negative` was an artifact, and the family arms must be re-run
with the enlarged prefix (no family keys were available for this correction).
The W109 `cacheMarkers` opt-in still stays dark for every family until those
per-family verdicts land. Full record: `docs/ledger/p8-prefix-correction.md`.

**2026-09-30 (vendor anthropic cache-marker probe — families via OpenRouter DIRECT two-turn run, part 2: per-family verdicts — `deepseek/deepseek-v4-flash`, `z-ai/glm-5.3-flash`, `moonshotai/kimi-k2.6`):**
An orchestrator-run direct evidence pass supersedes the retracted family
`negative` for the OpenRouter route. `POST https://openrouter.ai/api/v1/messages`
with a ~4.8k-token system block carrying `cache_control:{type:"ephemeral"}`, two
sequential turns sharing the same prefix (operator's OpenRouter key). Field
shape: these non-anthropic endpoints report `cache_creation_input_tokens` as
`null` (no creation field) but DO surface `cache_read_input_tokens`, so
accounting is observable as a nonzero cache READ on turn 2. Verdicts, one line
per family:
`deepseek/deepseek-v4-flash` (served by **DeepInfra**) — turn 1 `null` /
`cache_read_input_tokens: 0`, turn 2 `null` / `cache_read_input_tokens: 4608` →
**green** (accepted AND accounted);
`z-ai/glm-5.3-flash` (served by **Relace**) — turn 1 `null` / `0`, turn 2 `null`
/ `0` → **negative** (accepted, no cache accounting observed);
`moonshotai/kimi-k2.6` (served by **Inceptron**) — turn 1 `null` / `0`, turn 2
`null` / `cache_read_input_tokens: 4784` → **green** (accepted AND accounted).
This is the **OpenRouter route**, NOT direct-vendor (native) coverage. The mixed
per-family outcome is recorded as three register rows
(`vendor-anthropic-cache-deepseek` green, `vendor-anthropic-cache-glm` negative,
`vendor-anthropic-cache-kimi` green) replacing the former single
`vendor-anthropic-cache-families` umbrella row; posture advisory (observability,
not enforcement). The earlier single-request probe could not show this — its
`cache_creation_input_tokens` is `null` on these endpoints, and one turn can only
show creation. The W109 `cacheMarkers` opt-in stays dark for every family. Full
record: `docs/ledger/p8-prefix-correction.md`.
