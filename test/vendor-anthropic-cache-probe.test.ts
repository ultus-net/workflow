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
 * docs/ledger/P8-vendor-cache-probe-harness.md for the run recipe and the
 * recording location).
 *
 * The committed assertions are STRUCTURAL ONLY: the composed request carries
 * the ephemeral markers (an ungated pin below), and a live response is a
 * well-formed Messages body with a numeric `usage`. The cache fields
 * (`cache_creation_input_tokens` / `cache_read_input_tokens`) are OBSERVED and
 * printed, never asserted present or positive — the live verdict belongs in the
 * operator's dated record, not in this file.
 *
 * Red-first is NOT applicable: with no keys and no gate nothing runs, so there
 * is no red to earn. The discriminating artifact is the gated path's structure —
 * the request it composes and the response fields it reads — which is pinned
 * ungated so a weakened request cannot hide behind the gate.
 */

/** The live gate. Without it, every family arm skips before any network use. */
const VENDOR_CACHE_PROBE_GATE = "WORKFLOW_VENDOR_CACHE_PROBE";

const FAMILIES: readonly ModelFamily[] = ["deepseek", "glm", "kimi"];

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

/** The vendor model id whose anthropic wire this family's probe exercises. */
function vendorModel(family: ModelFamily): string {
  const def = DEFAULT_OPEN_SOURCE_POOL.find((entry) => entry.family === family);
  return def?.model ?? family;
}

/** `https://host/anthropic` → `https://host/anthropic/v1/messages`. */
function messagesUrl(family: ModelFamily): string {
  return `${VENDOR_DEFAULTS[family].anthropicEndpoint.replace(/\/+$/, "")}/v1/messages`;
}

/** The minimal anthropic-wire body the probe sends, with the production markers. */
function probeRequestBody(family: ModelFamily): Record<string, unknown> {
  const model = vendorModel(family);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---- the ungated structural pin: the request the live arm would send ----
// This is the discriminator that survives the gate: the marker shape and its
// placement are frozen here, so a change to the request (a dropped marker, a
// marker on the wrong block) goes red in the ordinary suite with no keys.
test("vendor cache probe: the composed anthropic request carries the ephemeral markers on the stable prefixes", () => {
  for (const family of FAMILIES) {
    const body = probeRequestBody(family);
    assert.equal(body.model, vendorModel(family), `${family}: the vendor model id must ride the body`);
    const system = body.system;
    assert.ok(Array.isArray(system) && system.length === 1, `${family}: a string system prompt becomes one marked block`);
    const systemBlock = system[0];
    assert.ok(isRecord(systemBlock), `${family}: the system block must be an object`);
    assert.deepEqual(systemBlock.cache_control, EPHEMERAL, `${family}: the system block carries the ephemeral marker`);
    assert.equal(systemBlock.type, "text", `${family}: the system block stays a text block`);
    const tools = body.tools;
    assert.ok(Array.isArray(tools) && tools.length > 0, `${family}: the tool list is present`);
    const lastTool = tools[tools.length - 1];
    assert.ok(isRecord(lastTool), `${family}: the last tool must be an object`);
    assert.deepEqual(lastTool.cache_control, EPHEMERAL, `${family}: the last tool definition carries the ephemeral marker`);
    assert.ok(Array.isArray((body.messages as unknown[])), `${family}: the messages lane is present`);
    // The messages lane is deliberately NOT marked (the P13 boundary policy owns
    // that decision); the probe proves the static head only.
    const message = (body.messages as unknown[])[0];
    assert.ok(isRecord(message) && message.cache_control === undefined, `${family}: no marker is placed on the messages lane`);
  }
});

// ---- the gated live arms: one per family, each with its own skip reason ----
const gateValue = process.env[VENDOR_CACHE_PROBE_GATE];
const selected = selectedFamilies(gateValue);
const { keys } = loadOpenModelKeys();

for (const family of FAMILIES) {
  const key = keys[family];
  const skip = gateValue === undefined || gateValue.trim() === ""
    ? `${VENDOR_CACHE_PROBE_GATE} is unset`
    : selected.length === 0
      ? `${VENDOR_CACHE_PROBE_GATE}='${gateValue}' selects no family (use deepseek, glm, kimi, a comma list, or all)`
      : !selected.includes(family)
        ? `family '${family}' is not selected by ${VENDOR_CACHE_PROBE_GATE}='${gateValue}'`
        : key === undefined
          ? `no ${family} key: set ${OPEN_MODEL_KEY_ENV[family].join(" / ")} or write ~/.config/workflow/<family>-api-key`
          : false;

  test(
    `vendor anthropic cache probe: ${family} accepts the Messages-schema cache_control markers`,
    { skip, timeout: 60_000 },
    async () => {
      const url = messagesUrl(family);
      const body = probeRequestBody(family);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": key as string,
        },
        body: JSON.stringify(body),
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
      // RECORD the observed shape verbatim — this is what the operator copies
      // into the dated per-vendor verdict (see the ledger fragment's recipe).
      console.log(JSON.stringify({
        probe: "vendor-anthropic-cache",
        family,
        model: body.model,
        endpoint: url,
        gate: VENDOR_CACHE_PROBE_GATE,
        request: {
          systemMarker: isRecord((body.system as unknown[])[0]) ? (body.system as unknown[])[0] : null,
          lastToolMarker: Array.isArray(body.tools) ? (body.tools[body.tools.length - 1] as Record<string, unknown> | undefined)?.cache_control : undefined,
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

      // Structural asserts only. A non-2xx is a real live finding (the endpoint
      // rejected the marker/request) and fails this arm — but the committed
      // test never asserts that a vendor accepts caching.
      assert.ok(response.ok, `${family} ${url} returned HTTP ${response.status}: ${text.slice(0, 400)}`);
      assert.ok(isRecord(payload), `${family}: the response must be a JSON Messages body`);
      assert.ok(usage !== undefined, `${family}: the response must carry a usage object`);
      assert.equal(typeof usage.input_tokens, "number", `${family}: usage.input_tokens must be numeric`);
      assert.equal(typeof usage.output_tokens, "number", `${family}: usage.output_tokens must be numeric`);
      // The cache fields are OBSERVED (printed above), never required: absence is
      // the finding the operator records, not a failure this test manufactures.
    },
  );
}
