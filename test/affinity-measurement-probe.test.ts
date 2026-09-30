import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { launchContainedAcpAgent } from "../src/adapters/acp-contained-agent.js";
import { AcpSubprocessClient, type AcpPermissionDecision } from "../src/adapters/acp-subprocess.js";
import { LinuxBubblewrapContainment } from "../src/containment/linux-bwrap.js";
import { METERED_PLACEHOLDER_KEY, createModelUsageProxy } from "../src/integrations/model-usage-proxy.js";
import {
  autoLatestConfigFromEnv,
  createAliasResolver,
  narrowToAffinityPin,
  type AffinityPinEvent,
  type AutoLatestConfig,
} from "../src/integrations/openrouter-auto-latest.js";
import {
  globalOpencodeBinary,
  meteredOpencodeConfig,
  OPENCODE_V2_METERED_ENV_KEY,
  resolveOpencodeLaunch,
} from "../src/integrations/opencode-agent-config.js";
import { opencodeMajorVersion } from "../src/integrations/acp-runtime.js";
import { loadClineApiKey } from "./cline-probe-helpers.js";
import { opencodeProbeArgs } from "./opencode-probe-helpers.js";

/**
 * P11 (#290) — the with/without-affinity cache-hit MEASUREMENT, per
 * docs/P11_AFFINITY_MEASUREMENT_RECIPE.md §3.
 *
 * The matched pair: the SAME OpenRouter Auto Router pool, the same two-turn
 * prompt shape with a large shared stable prefix, run TWICE — Arm "without"
 * (affinity OFF, the default free-route) and Arm "with" (affinity ON via the
 * `WORKFLOW_OPENROUTER_AUTO_AFFINITY` env opt-in, so the resolved
 * `allowed_models` pool is narrowed to ONE slug). This probe RECORDS the
 * turn-1/turn-2 cache fields; it does NOT assert a delta. The live verdict
 * belongs in docs/ledger/P11-affinity-measurement.md.
 *
 * Observability (recipe §2). The anthropic wire names ride the hub proxy as
 * `cacheCreateTokens` / `cacheReadTokens` on the anthropic Messages lane. The
 * deployed OpenCode lane is the OpenAI-shaped chat-completions lane
 * (`openrouter/openrouter/auto` via `@ai-sdk/openai-compatible`), so the
 * proxy's first-class cache fields stay at their measured zero there (W123:
 * cached reads ride `prompt_tokens`; the `prompt_tokens_details` split is the
 * named queued refinement). This probe therefore reads the provider's own
 * accounting from several seams, all crossed through the hub proxy:
 *   1. `proxy.metrics()` cache fields (the recipe's named seam; expected 0
 *      on this lane);
 *   2. the proxy's raw per-response usage records (`onUsage`), from which the
 *      OpenAI-lane `prompt_tokens_details.cached_tokens` is read;
 *   3. the ACP per-turn prompt result's `usage` (opencode's projection);
 *   4. a RECORDING upstream in front of the metering proxy, which captures the
 *      injected `allowed_models` per request AND the concrete served
 *      `model`/`provider` from the response body — the recipe §3/§6 "resolved
 *      slug/model per arm" and the injection-narrowing confirmation.
 *
 * CONTAINMENT OF CONFOUNDS (see the ledger for why these matter):
 * - Each arm uses a UNIQUE prefix nonce, so a turn-2 cache read can only be a
 *   within-arm read (turn 1 of the same arm), never provider cache left by a
 *   earlier run/arm.
 * - The recording upstream lets the ledger state WHICH concrete model served
 *   each turn, so a free-route model bounce is visible rather than inferred.
 *
 * GATING: the live arms run ONLY under `WORKFLOW_AFFINITY_MEASUREMENT=1`; an
 * ungated run makes no network call. No committed assertion requires a cache
 * delta — a green test can never manufacture a savings claim.
 */
const runMeasurement = process.env.WORKFLOW_AFFINITY_MEASUREMENT === "1";

const UPSTREAM = process.env.WORKFLOW_ACP_UPSTREAM ?? "https://openrouter.ai";
const CATALOG_URL = "https://openrouter.ai/api/v1/models";

const TURN_TIMEOUT_MS = 120_000;
const ARM_TIMEOUT_MS = 300_000;

/** The shared stable prefix: ~220 reference lines (well past the minimum cacheable prefix). */
function sharedPrefix(nonce: string): string {
  const lines: string[] = [`Affinity measurement run ${nonce}.`];
  for (let index = 0; index < 220; index += 1) {
    lines.push(
      `Reference line ${index}: the Workflow control plane deterministically owns task state, evidence freshness, and mutation authorization at the kernel boundary.`,
    );
  }
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asAsyncIterable(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  return body as unknown as AsyncIterable<Uint8Array>;
}

/** The ACP prompt result's `usage` projection, when present. */
function usageFromPrompt(result: unknown): Record<string, unknown> | undefined {
  if (!isRecord(result)) return undefined;
  return isRecord(result.usage) ? result.usage : undefined;
}

/** The OpenAI-lane prompt-side cache read from the raw provider usage record. */
function openAiCachedTokens(usage: Record<string, unknown>): number {
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const cached = details?.cached_tokens;
  return typeof cached === "number" && Number.isFinite(cached) ? cached : 0;
}

function allowedModelsFromBody(body: Record<string, unknown>): readonly string[] | null {
  const plugins = Array.isArray(body.plugins) ? body.plugins : [];
  for (const plugin of plugins) {
    if (!isRecord(plugin)) continue;
    if (plugin.id === "auto-router" || plugin.id === "auto-beta-router") {
      return Array.isArray(plugin.allowed_models) ? plugin.allowed_models.map(String) : null;
    }
  }
  return null;
}

/** One request seen by the recording upstream (post-injection) plus its response. */
interface ProxyCall {
  readonly path: string;
  readonly requestModel: unknown;
  readonly allowedModels: readonly string[] | null;
  readonly status: number;
  readonly responseModel: string | null;
  readonly responseProvider: string | null;
}

interface RecordingUpstream {
  readonly url: string;
  readonly calls: ProxyCall[];
  close(): Promise<void>;
}

/**
 * A pass-through recorder in front of the metering proxy's upstream. It buffers
 * each response body (SSE included) while streaming it back unchanged, then
 * extracts the served `model`/`provider`. Observability only: it never shapes
 * the request or response.
 */
async function startRecordingUpstream(target: string): Promise<RecordingUpstream> {
  const calls: ProxyCall[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const requestChunks: Buffer[] = [];
      for await (const chunk of req) requestChunks.push(Buffer.from(chunk));
      const requestText = Buffer.concat(requestChunks).toString("utf8");
      let requestModel: unknown;
      let allowed: readonly string[] | null = null;
      try {
        const parsed = JSON.parse(requestText) as Record<string, unknown>;
        requestModel = parsed.model;
        allowed = allowedModelsFromBody(parsed);
      } catch {
        // Non-JSON body: nothing to record on the request side.
      }
      const init: RequestInit = {
        method: req.method ?? "GET",
        headers: { ...req.headers } as Record<string, string>,
        redirect: "manual",
      };
      if (req.method !== "GET" && req.method !== "HEAD") init.body = requestText;
      const upstreamResponse = await fetch(new URL(req.url ?? "/", target), init);
      const responseChunks: Buffer[] = [];
      res.writeHead(upstreamResponse.status, { "content-type": upstreamResponse.headers.get("content-type") ?? "application/json" });
      if (upstreamResponse.body !== null) {
        for await (const chunk of asAsyncIterable(upstreamResponse.body)) {
          const buffer = Buffer.from(chunk);
          responseChunks.push(buffer);
          res.write(buffer);
        }
      }
      res.end();
      const responseText = Buffer.concat(responseChunks).toString("utf8");
      calls.push({
        path: req.url ?? "",
        requestModel,
        allowedModels: allowed,
        status: upstreamResponse.status,
        responseModel: responseText.match(/"model"\s*:\s*"([^"]+)"/)?.[1] ?? null,
        responseProvider: responseText.match(/"provider"\s*:\s*"([^"]+)"/)?.[1] ?? null,
      });
    })().catch(() => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "recording upstream failure" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

interface ProxyMetricsSnapshot {
  readonly requests: number;
  readonly usageEvents: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreateTokens: number;
}

interface TurnReading {
  readonly stopReason: string | undefined;
  readonly proxyDelta: {
    readonly requests: number;
    readonly usageEvents: number;
    readonly promptTokens: number;
    readonly totalTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheCreateTokens: number;
  };
  /** Summed `prompt_tokens_details.cached_tokens` over this turn's raw usage records. */
  readonly openAiCachedTokens: number;
  readonly rawOpenAiUsageRecords: readonly Record<string, unknown>[];
  /** opencode's per-turn usage projection (cache fields as the agent reports them). */
  readonly acpUsage: Record<string, unknown> | undefined;
  /** The requests this turn (post-injection) plus the served model/provider. */
  readonly calls: readonly ProxyCall[];
}

interface ArmResult {
  readonly arm: "without" | "with";
  readonly affinityEnabled: boolean;
  readonly configuredAliases: readonly string[];
  readonly resolvedPool: readonly { readonly alias: string; readonly slug: string }[];
  readonly affinityEvents: readonly AffinityPinEvent[];
  readonly turn1: TurnReading;
  readonly turn2: TurnReading;
}

function snapshot(metrics: ProxyMetricsSnapshot): ProxyMetricsSnapshot {
  return { ...metrics };
}

function numericDelta(before: number, after: number): number {
  return after - before;
}

/**
 * Runs one arm: launch the metered OpenCode lane against a proxy composed with
 * (or without) the affinity opt-in, drive two sequential prompts on ONE
 * session with a unique shared prefix, and return the per-turn cache readings.
 */
async function runArm(arm: "without" | "with"): Promise<ArmResult> {
  const workspace = await mkdtemp(path.join(tmpdir(), `workflow-affinity-${arm}-ws-`));
  const scratchHome = await mkdtemp(path.join(tmpdir(), `workflow-affinity-${arm}-home-`));
  const configDir = path.join(scratchHome, "config");
  await mkdir(path.join(configDir, "opencode"), { recursive: true });

  // Arm "with" opts in through the env surface (the landed P19 opt-in); Arm
  // "without" explicitly strips it so it is the free-route baseline.
  const armEnv: NodeJS.ProcessEnv = { ...process.env };
  if (arm === "with") {
    armEnv.WORKFLOW_OPENROUTER_AUTO_AFFINITY = "1";
    armEnv.WORKFLOW_OPENROUTER_AUTO_AFFINITY_ROLE = "rsi";
  } else {
    delete armEnv.WORKFLOW_OPENROUTER_AUTO_AFFINITY;
    delete armEnv.WORKFLOW_OPENROUTER_AUTO_AFFINITY_ROLE;
    delete armEnv.WORKFLOW_OPENROUTER_AUTO_AFFINITY_TIER;
  }

  const upstreamKey = await loadClineApiKey("P11 affinity measurement");
  const configured = autoLatestConfigFromEnv({ upstream: UPSTREAM, env: armEnv });
  assert.ok(configured !== undefined, "the OpenRouter upstream must compose an autoLatest config");

  // Capture the affinity pin/degradation events instead of the env default
  // console logger, so the injected narrowing is recorded (recipe §6).
  const affinityEvents: AffinityPinEvent[] = [];
  const autoLatest: AutoLatestConfig = configured.affinity === undefined
    ? configured
    : { ...configured, affinity: { ...configured.affinity, onEvent: (event) => affinityEvents.push(event) } };
  const affinityEnabled = autoLatest.affinity?.enabled === true;

  // The recording upstream sits in front of OpenRouter; the metering proxy
  // forwards to it. The alias resolver still reads the REAL catalog.
  const recorder = await startRecordingUpstream(UPSTREAM);
  const openAiUsageRecords: Record<string, unknown>[] = [];
  const proxy = await createModelUsageProxy({
    upstream: recorder.url,
    apiKey: upstreamKey,
    autoLatest: { ...autoLatest, modelsUrl: CATALOG_URL },
    // The raw per-response provider usage records (the OpenAI-lane cache read
    // lives in prompt_tokens_details.cached_tokens, which the proxy does not
    // fold into its first-class cache fields on this lane).
    onUsage: (usage) => {
      openAiUsageRecords.push(usage);
    },
  });

  // The concrete resolved pool (alias -> slug) per arm, resolved through the
  // same catalog the proxy's affinity pin consumes.
  const reportResolver = createAliasResolver({ modelsUrl: CATALOG_URL, aliases: autoLatest.aliases });
  const resolvedPool = await reportResolver.resolvePairs();

  const opencode = resolveOpencodeLaunch({
    envBinOverride: process.env.WORKFLOW_OPENCODE_BIN,
    opencodeOnPath: globalOpencodeBinary(),
  });
  const major = await opencodeMajorVersion(opencode.executable);
  const v2 = major !== undefined && major >= 2;
  const config = meteredOpencodeConfig({
    proxyUrl: proxy.url,
    model: process.env.WORKFLOW_OPENCODE_MODEL,
    opencodeMajor: major,
  });
  await writeFile(path.join(configDir, "opencode", "opencode.json"), JSON.stringify(config), "utf8");

  const args = await opencodeProbeArgs(opencode.executable);
  const child = launchContainedAcpAgent(new LinuxBubblewrapContainment(), {
    executable: opencode.executable,
    args: [...args],
    workspace,
    home: scratchHome,
    environment: {
      XDG_CONFIG_HOME: configDir,
      ...(v2 ? { [OPENCODE_V2_METERED_ENV_KEY]: METERED_PLACEHOLDER_KEY } : {}),
    },
  });
  const stderrChunks: string[] = [];
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderrChunks.push(chunk));
  const client = new AcpSubprocessClient({
    child,
    resolvePermission: (): AcpPermissionDecision => ({ kind: "allow" }),
  });

  // A unique per-arm nonce: turn 2 can only read a prefix written by turn 1 of
  // THIS arm, never provider cache left by an earlier run or the other arm.
  const nonce = `${Date.now().toString(36)}-${arm}-${Math.random().toString(36).slice(2, 10)}`;
  const prefix = sharedPrefix(nonce);

  async function driveTurn(sessionId: string, text: string): Promise<TurnReading> {
    const before = snapshot(proxy.metrics());
    const usageBefore = openAiUsageRecords.length;
    const callsBefore = recorder.calls.length;
    const result = await Promise.race([
      client.prompt({ sessionId, prompt: [{ type: "text", text }] }),
      new Promise((resolve) => setTimeout(() => resolve({ stopReason: "probe_timeout" }), TURN_TIMEOUT_MS)),
    ]);
    const after = snapshot(proxy.metrics());
    const turnRecords = openAiUsageRecords.slice(usageBefore);
    const promptResult = isRecord(result) ? result : {};
    return {
      stopReason: typeof promptResult.stopReason === "string" ? promptResult.stopReason : undefined,
      proxyDelta: {
        requests: numericDelta(before.requests, after.requests),
        usageEvents: numericDelta(before.usageEvents, after.usageEvents),
        promptTokens: numericDelta(before.promptTokens, after.promptTokens),
        totalTokens: numericDelta(before.totalTokens, after.totalTokens),
        cacheReadTokens: numericDelta(before.cacheReadTokens, after.cacheReadTokens),
        cacheCreateTokens: numericDelta(before.cacheCreateTokens, after.cacheCreateTokens),
      },
      openAiCachedTokens: turnRecords.reduce((sum, usage) => sum + openAiCachedTokens(usage), 0),
      rawOpenAiUsageRecords: turnRecords,
      acpUsage: usageFromPrompt(result),
      calls: recorder.calls.slice(callsBefore),
    };
  }

  try {
    await client.initialize();
    const session = await client.newSession({ cwd: workspace });
    if (v2) {
      await client.setConfigOption({ sessionId: session.sessionId, configId: "model", value: String(config.model) });
    }
    const turn1 = await driveTurn(
      session.sessionId,
      `Read the following reference block and reply with exactly the text ACK-ONE. Do not call any tools.\n\n${prefix}\n\nReply with exactly: ACK-ONE`,
    );
    const turn2 = await driveTurn(
      session.sessionId,
      "Using the reference block from the previous message, reply with exactly the text ACK-TWO. Do not call any tools.",
    );
    return {
      arm,
      affinityEnabled,
      configuredAliases: autoLatest.aliases,
      resolvedPool,
      affinityEvents,
      turn1,
      turn2,
    };
  } finally {
    const agentStderr = stderrChunks.join("");
    if (agentStderr.length > 0) console.log(`[affinity ${arm}] agent stderr:`, agentStderr.slice(0, 2000));
    await client.close();
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    await proxy.close();
    await recorder.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(scratchHome, { recursive: true, force: true });
  }
}

function report(arm: ArmResult): void {
  const pinEvent = arm.affinityEvents.find((event) => event.event === "pin");
  const degradedEvent = arm.affinityEvents.find((event) => event.event === "degraded");
  console.log(JSON.stringify({
    probe: "p11-affinity-measurement",
    arm: arm.arm,
    affinityEnabled: arm.affinityEnabled,
    configuredAliases: arm.configuredAliases,
    resolvedPool: arm.resolvedPool,
    boundSlug: pinEvent?.slug ?? null,
    degradation: degradedEvent?.reason ?? null,
    turn1: {
      stopReason: arm.turn1.stopReason,
      proxyDelta: arm.turn1.proxyDelta,
      openAiCachedTokens: arm.turn1.openAiCachedTokens,
      acpUsage: arm.turn1.acpUsage,
      calls: arm.turn1.calls,
      rawUsageRecords: arm.turn1.rawOpenAiUsageRecords,
    },
    turn2: {
      stopReason: arm.turn2.stopReason,
      proxyDelta: arm.turn2.proxyDelta,
      openAiCachedTokens: arm.turn2.openAiCachedTokens,
      acpUsage: arm.turn2.acpUsage,
      calls: arm.turn2.calls,
      rawUsageRecords: arm.turn2.rawOpenAiUsageRecords,
    },
  }, null, 2));
}

/** The `openrouter/auto` (Auto Router) calls in a turn; title/summary requests are not the treatment. */
function autoRouterCalls(turn: TurnReading): readonly ProxyCall[] {
  return turn.calls.filter((call) => call.allowedModels !== null);
}

// ---- ungated instrument pin: the treatment-validity discriminator ----
// The "with" arm is only the treatment if the resolved pool actually narrows
// to ONE slug (recipe §6). This freezes that property with no network: given
// the configured-order pool and the pinned slug, the injected list is exactly
// one candidate. (The pin itself and the env parse are pinned in
// test/affinity-pin.test.ts; this is the measurement's read-side contract.)
test("affinity measurement: the injected allowed_models narrows to exactly the pinned slug", () => {
  const pool = ["anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5.5", "openai/gpt-6-astra"];
  assert.deepEqual(narrowToAffinityPin(pool, pool[0]), ["anthropic/claude-opus-5.5"]);
  assert.equal(narrowToAffinityPin(pool, pool[0]).length, 1);
  assert.deepEqual(narrowToAffinityPin(pool, "not/in-pool"), [], "an absent pin yields no candidates (free-routes, never silently pins a later alias)");
});

// ---- the live matched-pair arms ----
test(
  "P11 affinity measurement arm 'without': free-route baseline, two turns, shared prefix",
  { skip: runMeasurement ? false : "WORKFLOW_AFFINITY_MEASUREMENT is unset", timeout: ARM_TIMEOUT_MS },
  async () => {
    const result = await runArm("without");
    report(result);
    assert.equal(result.affinityEnabled, false, "the baseline arm must run affinity OFF");
    assert.equal(result.turn1.stopReason, "end_turn", "turn 1 must complete for the reading to count");
    assert.equal(result.turn2.stopReason, "end_turn", "turn 2 must complete for the reading to count");
    assert.ok(result.resolvedPool.length > 0, "the baseline arm must resolve a non-empty Auto Router pool");
    // The baseline free-route must inject the UN-narrowed pool (affinity OFF).
    const autoCalls = [...autoRouterCalls(result.turn1), ...autoRouterCalls(result.turn2)];
    assert.ok(autoCalls.length > 0, "the Auto Router injection must be observed on the baseline arm");
    assert.ok(
      autoCalls.some((call) => (call.allowedModels?.length ?? 0) > 1),
      "affinity OFF must inject the full resolved pool, not a single slug",
    );
  },
);

test(
  "P11 affinity measurement arm 'with': affinity pin ON, two turns, shared prefix",
  { skip: runMeasurement ? false : "WORKFLOW_AFFINITY_MEASUREMENT is unset", timeout: ARM_TIMEOUT_MS },
  async () => {
    const result = await runArm("with");
    report(result);
    assert.equal(result.affinityEnabled, true, "the pinned arm must run affinity ON");
    assert.equal(result.turn1.stopReason, "end_turn", "turn 1 must complete for the reading to count");
    assert.equal(result.turn2.stopReason, "end_turn", "turn 2 must complete for the reading to count");
    // Treatment validity (recipe §6): the pin must have run. A degraded
    // resolver leaves the arm free-routed — recorded, not asserted as a pin,
    // so an honest degradation is still a runnable measurement.
    assert.ok(result.affinityEvents.length > 0, "the affinity path must have logged at least one pin/degradation event");
    const pinnedSlug = result.affinityEvents.find((event) => event.event === "pin")?.slug;
    if (pinnedSlug !== undefined) {
      // With a live pin, the injected `allowed_models` must be exactly the one
      // pinned slug on every Auto Router request — otherwise the "with" arm is
      // not the treatment.
      const autoCalls = [...autoRouterCalls(result.turn1), ...autoRouterCalls(result.turn2)];
      assert.ok(autoCalls.length > 0, "the Auto Router injection must be observed on the pinned arm");
      for (const call of autoCalls) {
        assert.equal(call.allowedModels?.length, 1, "the affinity pin must narrow the injected allowed_models to exactly one slug");
        assert.equal(call.allowedModels?.[0], pinnedSlug, "the narrowed slug must be the pinned slug");
      }
      assert.ok(
        result.resolvedPool.some((entry) => entry.slug === pinnedSlug),
        "the pinned slug must be one of the resolved pool slugs",
      );
    }
  },
);
