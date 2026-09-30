import assert from "node:assert/strict";
import test from "node:test";

import { applyCacheMarkers, modelProfile, VENDOR_DEFAULTS, type ModelFamily } from "../src/integrations/model-profile.js";
import { OPEN_MODEL_KEY_ENV, loadOpenModelKeys } from "../src/integrations/open-model-keys.js";
import { DEFAULT_OPEN_SOURCE_POOL } from "../src/integrations/open-source-pool.js";

/**
 * P8 / #287 + P14 / #293 — the VENDOR anthropic-compatible cache-marker probe.
 *
 * The exact question park row P8 (docs/PARKED_AND_LIMITATIONS.md) asks: do the
 * anthropic-compatible vendor endpoints (deepseek / glm / kimi) ACCEPT the
 * Messages-schema `cache_control` markers that the W109 opt-in
 * (`applyCacheMarkers`, src/integrations/model-profile.ts) emits on the system
 * block and the last tool definition? The W109 opt-in stays dark until the
 * per-vendor probes land — probe-gated, never date-gated.
 *
 * GATING (mirrors the ACP probe pattern): the live arm runs ONLY when
 * WORKFLOW_VENDOR_CACHE_PROBE names the family to probe — `deepseek`, `glm`,
 * `kimi`, a comma/space list of those, or `all` — AND that family's key is
 * present (env names in OPEN_MODEL_KEY_ENV, or the 0600
 * ~/.config/workflow/<family>-api-key file). Ungated, every family arm skips
 * with its own named reason and NO network call is made. CI never reaches a
 * vendor. The operator runs it; the observed shape is RECORDED in its output
 * and the dated per-version verdict is written up (see
 * docs/ledger/P8-vendor-cache-probe-harness.md and
 * docs/ledger/P8p-provider-lane-probe.md for the run recipes and the recording
 * location).
 *
 * P8 LANE RE-FRAME (issue #287): the operator does NOT send production traffic
 * with direct vendor API keys — it crosses a reseller/provider (Azure AI
 * Foundry or OpenRouter) anthropic-compatible lane. The per-family arms stay
 * because they measure the vendor contracts themselves, but they are NOT the
 * deployed lane and this file says so. The GENERIC provider lane below is the
 * operator-runnable path to the deployed route: `provider` in the gate plus
 * WORKFLOW_PROVIDER_ANTHROPIC_URL / WORKFLOW_PROVIDER_API_KEY /
 * WORKFLOW_PROVIDER_MODEL points the same marker-shaped anthropic body at
 * whatever base URL the reseller exposes.
 *
 * The committed assertions are STRUCTURAL ONLY: the composed request carries
 * the ephemeral markers (ungated pins below, one per lane), and a live response
 * is a well-formed Messages body with a numeric `usage`. The cache fields
 * (`cache_creation_input_tokens` / `cache_read_input_tokens`) are OBSERVED and
 * printed, never asserted present or positive — the live verdict belongs in the
 * operator's dated record, not in this file.
 *
 * Red-first is NOT applicable to the LANE itself: with no keys and no gate
 * nothing runs, so there is no marker-shape red to earn. That rationale is
 * narrowed, not waved: the provider lane's NEW helper logic (the base-URL
 * normalizer and the `provider`-token selection) DID exist to be pinned, even
 * though no live marker-shape red was available at the time — those helpers are
 * now covered by the ungated unit pins below. The request the lane composes and
 * the response fields it reads are likewise pinned ungated, so neither the
 * helpers nor a weakened request can hide behind the gate.
 */

/** The live gate. Without it, every family arm skips before any network use. */
const VENDOR_CACHE_PROBE_GATE = "WORKFLOW_VENDOR_CACHE_PROBE";

const FAMILIES: readonly ModelFamily[] = ["deepseek", "glm", "kimi"];

/**
 * P8 lane re-frame (issue #287): the GENERIC reseller/provider lane. Production
 * traffic does not use direct vendor keys; it crosses a reseller (Azure AI
 * Foundry or OpenRouter) anthropic-compatible endpoint. The `provider` gate
 * token selects this lane, and the endpoint/key/model come from env so the
 * operator points it at whatever their provider exposes. The direct per-family
 * arms above are retained (they measure the vendor contracts), but they are NOT
 * the deployed lane.
 */
const PROVIDER_LANE_TOKEN = "provider";
const PROVIDER_URL_ENV = "WORKFLOW_PROVIDER_ANTHROPIC_URL";
const PROVIDER_KEY_ENV = "WORKFLOW_PROVIDER_API_KEY";
const PROVIDER_MODEL_ENV = "WORKFLOW_PROVIDER_MODEL";

/**
 * The provider lane is FAMILY-AGNOSTIC: under the boolean opt-in `true` the
 * marker pass admits every family before it consults the profile's family
 * (`cacheMarkersEnabled`), so the composed marker shape does not depend on it.
 * This nominal family only satisfies `modelProfile`'s contract; `shapeRequestBody`
 * is never applied, so no vendor reasoning/sampling field rides the wire.
 */
const PROVIDER_LANE_PROFILE_FAMILY: ModelFamily = "deepseek";

const EPHEMERAL = { type: "ephemeral" } as const;

/**
 * Parses the gate value into the families to probe. Accepts `all`, one family,
 * or a comma/space separated subset. An unrecognized token selects nothing —
 * the arm then skips with the offending value named, never a guessed family.
 */
export function selectedFamilies(raw: string | undefined): readonly ModelFamily[] {
  const value = raw?.trim() ?? "";
  if (value === "") return [];
  if (value === "all") return FAMILIES;
  const tokens = value.split(/[\s,]+/).filter((token) => token.length > 0);
  return FAMILIES.filter((family) => tokens.includes(family));
}

/**
 * True when the gate names the GENERIC provider lane. `all` stays families-only
 * (the direct arms); the deployed reseller route is opted in with the explicit
 * `provider` token so it is never run implicitly by `all`.
 */
export function providerLaneSelected(raw: string | undefined): boolean {
  const value = raw?.trim() ?? "";
  if (value === "") return false;
  return value.split(/[\s,]+/).filter((token) => token.length > 0).includes(PROVIDER_LANE_TOKEN);
}

/** The vendor model id whose anthropic wire this family's probe exercises. */
function vendorModel(family: ModelFamily): string {
  const def = DEFAULT_OPEN_SOURCE_POOL.find((entry) => entry.family === family);
  return def?.model ?? family;
}

/** `https://host/anthropic` → `https://host/anthropic/v1/messages`. */
function messagesUrl(family: ModelFamily): string {
  return `${VENDOR_DEFAULTS[family].anthropicEndpoint.replace(/\/+$/, "")}/v1/messages`;
}

/** The minimal anthropic-wire body the probe sends, through the PRODUCTION marker pass. */
function markerRequestBody(family: ModelFamily, model: string): Record<string, unknown> {
  const profile = modelProfile({ family, model, wire: "anthropic", cacheMarkers: true });
  return applyCacheMarkers(profile, {
    model,
    max_tokens: 16,
    system: "The Workflow vendor cache-marker probe. Read the user message and reply.",
    tools: [{
      name: "probe_noop",
      description: "A no-op probe tool whose definition carries the last-position cache marker.",
      input_schema: { type: "object", properties: {}, required: [] },
    }],
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word: ok" }] }],
  });
}

/** The direct per-family arm's body: the vendor's own model id on its family profile. */
function probeRequestBody(family: ModelFamily): Record<string, unknown> {
  return markerRequestBody(family, vendorModel(family));
}

/** The generic provider lane's body: the operator's model id on a family-agnostic profile. */
function providerProbeRequestBody(model: string): Record<string, unknown> {
  return markerRequestBody(PROVIDER_LANE_PROFILE_FAMILY, model);
}

/**
 * `https://host/anthropic` → `https://host/anthropic/v1/messages`; a base that
 * already ends in `/v1` or `/messages` is not doubled, so one env accepts
 * OpenRouter's `…/api/v1` and an anthropic-native base alike.
 */
export function providerMessagesUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/messages")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The frozen marker shape, asserted for every lane. The static head (system +
 * last tool) AND the P13 option-B per-turn boundary on the last message's
 * final content block are asserted, because the probe body is composed by the
 * PRODUCTION marker pass — the probe proves the deployed shape including the
 * conversation boundary.
 */
function assertMarkerShape(label: string, body: Record<string, unknown>, expectedModel: string): void {
  assert.equal(body.model, expectedModel, `${label}: the model id must ride the body`);
  const system = body.system;
  assert.ok(Array.isArray(system) && system.length === 1, `${label}: a string system prompt becomes one marked block`);
  const systemBlock = system[0];
  assert.ok(isRecord(systemBlock), `${label}: the system block must be an object`);
  assert.deepEqual(systemBlock.cache_control, EPHEMERAL, `${label}: the system block carries the ephemeral marker`);
  assert.equal(systemBlock.type, "text", `${label}: the system block stays a text block`);
  const tools = body.tools;
  assert.ok(Array.isArray(tools) && tools.length > 0, `${label}: the tool list is present`);
  const lastTool = tools[tools.length - 1];
  assert.ok(isRecord(lastTool), `${label}: the last tool must be an object`);
  assert.deepEqual(lastTool.cache_control, EPHEMERAL, `${label}: the last tool definition carries the ephemeral marker`);
  const messages = body.messages;
  assert.ok(Array.isArray(messages) && messages.length > 0, `${label}: the messages lane is present`);
  const lastMessage = messages[messages.length - 1];
  assert.ok(isRecord(lastMessage), `${label}: the last message must be an object`);
  const content = lastMessage.content;
  assert.ok(Array.isArray(content) && content.length > 0, `${label}: the last message carries content blocks`);
  assert.deepEqual((content[content.length - 1] as { cache_control?: unknown }).cache_control, EPHEMERAL, `${label}: the previous turn's end carries the P13 boundary marker`);
}

// ---- the ungated structural pins: the requests the live arms would send ----
// These are the discriminators that survive the gate: the marker shape and its
// placement are frozen here, so a change to the request (a dropped marker, a
// marker on the wrong block) goes red in the ordinary suite with no keys.
test("vendor cache probe: the composed anthropic request carries the ephemeral markers on the stable prefixes", () => {
  for (const family of FAMILIES) {
    assertMarkerShape(family, probeRequestBody(family), vendorModel(family));
  }
});

test("vendor cache probe: the composed provider-lane request carries the same ephemeral markers", () => {
  // The provider lane reuses the production marker pass, so it emits the same
  // shape as the direct arms; this pin freezes that for the deployed lane.
  assertMarkerShape("provider", providerProbeRequestBody("provider-lane-model"), "provider-lane-model");
});

/**
 * The provider base-URL normalizer is load-bearing NEW logic: it decides
 * whether the operator's one env value becomes a valid Messages endpoint, and a
 * path-doubling regression (`…/api/v1/v1/messages`, `…/messages/messages`) would
 * only ever surface inside the gated live arm — i.e. never in CI. These pins
 * are ungated (no network, no gate) so the normalization holds in the ordinary
 * suite: a bare host, a `/v1` base, a full `/messages` URL, a trailing slash,
 * and the no-doubling property all resolve to exactly one `/v1/messages` suffix.
 */
test("vendor cache probe: the provider base-URL normalizer accepts every deployed shape without doubling the path", () => {
  assert.equal(
    providerMessagesUrl("https://openrouter.ai/api"),
    "https://openrouter.ai/api/v1/messages",
    "a bare host/base gets the full `/v1/messages` suffix",
  );
  assert.equal(
    providerMessagesUrl("https://openrouter.ai/api/v1"),
    "https://openrouter.ai/api/v1/messages",
    "a base already ending in `/v1` gets only `/messages` appended",
  );
  assert.equal(
    providerMessagesUrl("https://openrouter.ai/api/v1/messages"),
    "https://openrouter.ai/api/v1/messages",
    "a full `/messages` URL is returned unchanged",
  );
  assert.equal(
    providerMessagesUrl("https://openrouter.ai/api/"),
    "https://openrouter.ai/api/v1/messages",
    "a trailing slash is trimmed, not treated as a path segment",
  );
  // The no-doubling property across the deployed shapes: every input resolves
  // to a URL ending in `/messages` and carrying exactly one `/v1/messages`, so
  // no input can produce `/v1/v1/messages` or `/messages/messages`.
  const inputs = [
    "https://openrouter.ai/api",
    "https://openrouter.ai/api/",
    "https://openrouter.ai/api/v1",
    "https://openrouter.ai/api/v1/",
    "https://openrouter.ai/api/v1/messages",
    "https://example.services.azure.com/anthropic",
    "https://example.services.azure.com/anthropic/v1",
  ];
  for (const input of inputs) {
    const url = providerMessagesUrl(input);
    assert.ok(url.endsWith("/messages"), `${input} → ${url}: every resolved URL ends in /messages`);
    const v1Messages = url.match(/\/v1\/messages/g) ?? [];
    assert.equal(v1Messages.length, 1, `${input} → ${url}: exactly one /v1/messages suffix (no path doubling)`);
    assert.ok(!url.includes("/v1/v1"), `${input} → ${url}: a /v1 base is not doubled`);
  }
});

/**
 * The gate's lane selection is also new logic: the provider lane must be opted
 * in with the explicit `provider` token, while `all` stays families-only so the
 * deployed reseller route is never run implicitly by `all`. A regression here
 * would either silently arm the provider lane under `all` or silently drop it.
 */
test("vendor cache probe: only the explicit provider token selects the provider lane, never `all`", () => {
  assert.equal(providerLaneSelected(undefined), false, "no gate selects nothing");
  assert.equal(providerLaneSelected(""), false, "empty gate selects nothing");
  assert.equal(providerLaneSelected("all"), false, "`all` stays families-only");
  assert.equal(providerLaneSelected("deepseek"), false, "a family token is not the provider lane");
  assert.equal(providerLaneSelected("provider"), true, "the explicit provider token selects the lane");
  assert.equal(providerLaneSelected("all provider"), true, "the provider token composes with a space list");
  assert.equal(providerLaneSelected("provider,glm"), true, "the provider token composes with a comma list");
  assert.equal(providerLaneSelected("all, deepseek"), false, "a family-only list leaves the lane dark");
});

/**
 * The shared live arm: POST the composed body, RECORD the observed shape
 * verbatim (what the operator copies into the dated verdict — see the ledger
 * fragment's recipe), then assert ONLY the structural contract. A non-2xx is a
 * real live finding (the endpoint rejected the marker/request) and fails the
 * arm; the cache fields are OBSERVED, never required, so a committed green can
 * never manufacture a caching claim.
 */
async function probeLiveMessages(options: {
  readonly label: string;
  readonly lane: "family" | "provider";
  readonly family: ModelFamily | null;
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}): Promise<void> {
  const response = await fetch(options.url, {
    method: "POST",
    headers: options.headers,
    body: JSON.stringify(options.body),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    payload = undefined;
  }
  const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : undefined;
  // P13 (issue #292): the recorded request witnesses the per-turn boundary
  // marker too, not only the static head, so the operator's live verdict sees
  // the deployed placement on the last message's final content block.
  const messageLane = options.body.messages;
  const lastMessage = Array.isArray(messageLane) ? messageLane[messageLane.length - 1] : undefined;
  const lastContent = isRecord(lastMessage) && Array.isArray(lastMessage.content) ? lastMessage.content : undefined;
  const boundaryMarker = lastContent !== undefined
    ? (lastContent[lastContent.length - 1] as Record<string, unknown> | undefined)?.cache_control
    : undefined;
  console.log(JSON.stringify({
    probe: "vendor-anthropic-cache",
    lane: options.lane,
    family: options.family,
    model: options.body.model,
    endpoint: options.url,
    gate: VENDOR_CACHE_PROBE_GATE,
    request: {
      systemMarker: isRecord((options.body.system as unknown[])[0]) ? (options.body.system as unknown[])[0] : null,
      lastToolMarker: Array.isArray(options.body.tools)
        ? (options.body.tools[options.body.tools.length - 1] as Record<string, unknown> | undefined)?.cache_control
        : undefined,
      boundaryMarker,
    },
    status: response.status,
    cacheUsage: {
      cache_creation_input_tokens: usage?.cache_creation_input_tokens,
      cache_read_input_tokens: usage?.cache_read_input_tokens,
      input_tokens: usage?.input_tokens,
      output_tokens: usage?.output_tokens,
    },
    responseBody: payload ?? text.slice(0, 600),
  }, null, 2));

  assert.ok(response.ok, `${options.label} ${options.url} returned HTTP ${response.status}: ${text.slice(0, 400)}`);
  assert.ok(isRecord(payload), `${options.label}: the response must be a JSON Messages body`);
  assert.ok(usage !== undefined, `${options.label}: the response must carry a usage object`);
  assert.equal(typeof usage.input_tokens, "number", `${options.label}: usage.input_tokens must be numeric`);
  assert.equal(typeof usage.output_tokens, "number", `${options.label}: usage.output_tokens must be numeric`);
}

// ---- the gated live arms: one per family plus the generic provider lane, each with its own skip reason ----
const gateValue = process.env[VENDOR_CACHE_PROBE_GATE];
const selected = selectedFamilies(gateValue);
const { keys } = loadOpenModelKeys();

for (const family of FAMILIES) {
  const key = keys[family];
  const skip = gateValue === undefined || gateValue.trim() === ""
    ? `${VENDOR_CACHE_PROBE_GATE} is unset`
    : selected.length === 0
      ? `${VENDOR_CACHE_PROBE_GATE}='${gateValue}' selects no family (use deepseek, glm, kimi, a comma list, all, or provider for the reseller lane)`
      : !selected.includes(family)
        ? `family '${family}' is not selected by ${VENDOR_CACHE_PROBE_GATE}='${gateValue}'`
        : key === undefined
          ? `no ${family} key: set ${OPEN_MODEL_KEY_ENV[family].join(" / ")} or write ~/.config/workflow/<family>-api-key`
          : false;

  test(
    `vendor anthropic cache probe: ${family} accepts the Messages-schema cache_control markers`,
    { skip, timeout: 60_000 },
    async () => {
      await probeLiveMessages({
        label: family,
        lane: "family",
        family,
        url: messagesUrl(family),
        body: probeRequestBody(family),
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": key as string,
        },
      });
    },
  );
}

// ---- the generic provider lane: the deployed reseller route (issue #287) ----
{
  const providerSelected = providerLaneSelected(gateValue);
  const providerUrl = process.env[PROVIDER_URL_ENV]?.trim();
  const providerKey = process.env[PROVIDER_KEY_ENV]?.trim();
  const providerModel = process.env[PROVIDER_MODEL_ENV]?.trim();
  const skip = gateValue === undefined || gateValue.trim() === ""
    ? `${VENDOR_CACHE_PROBE_GATE} is unset`
    : !providerSelected
      ? `provider lane is not selected by ${VENDOR_CACHE_PROBE_GATE}='${gateValue}' (add the 'provider' token)`
      : providerUrl === undefined || providerUrl === ""
        ? `no provider base URL: set ${PROVIDER_URL_ENV} (an anthropic-compatible reseller endpoint)`
        : providerKey === undefined || providerKey === ""
          ? `no provider key: set ${PROVIDER_KEY_ENV}`
          : providerModel === undefined || providerModel === ""
            ? `no provider model: set ${PROVIDER_MODEL_ENV}`
            : false;

  test(
    "vendor anthropic cache probe: the provider lane accepts the Messages-schema cache_control markers",
    { skip, timeout: 60_000 },
    async () => {
      await probeLiveMessages({
        label: "provider",
        lane: "provider",
        family: null,
        url: providerMessagesUrl(providerUrl as string),
        body: providerProbeRequestBody(providerModel as string),
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          // The reseller lanes split on auth shape: anthropic-native endpoints
          // (and Azure's anthropic-compatible surface) read `x-api-key`, while
          // OpenRouter's Anthropic Messages input authenticates with a Bearer
          // token. Both common forms ride so one env points at either; an
          // endpoint that rejects the extra header is a live finding to record,
          // not something this probe guesses around.
          "x-api-key": providerKey as string,
          authorization: `Bearer ${providerKey as string}`,
        },
      });
    },
  );
}
