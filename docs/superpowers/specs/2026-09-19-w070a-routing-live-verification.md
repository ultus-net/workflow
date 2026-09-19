# W070a live verification — open-source routing pivot

**Date:** 2026-09-19. **Item:** W070a (proposed) — routing pivot: open-source-only
default pool. **Status:** evidence gathered live; two gaps recorded honestly
(no vendor API keys available for completion probes; DeepSeek's exact off-peak
hours published only as an image).

This note is append-only evidence for `src/integrations/open-source-pool.ts`,
`model-profile.ts`, `open-model-keys.ts`, `open-model-proxy.ts`, and
`off-peak.ts`. Every model id committed to code was either returned by a live
API/doc fetch or is explicitly left uncommitted.

## 1. Direct vendor endpoints are live (auth-gated)

`GET /models` (or a minimal `POST /chat/completions`) against each vendor was
reached on 2026-09-19; each returned HTTP 401 with a vendor-shaped auth error,
which proves the host and path are live without a key:

| Request | HTTP | Response body (verbatim) |
|---|---|---|
| `GET https://api.deepseek.com/models` | 401 | `{"error":{"message":"Authentication Fails, Your api key: test is invalid","type":"authentication_error","param":null,"code":"invalid_request_error"}}` |
| `POST https://api.z.ai/api/paas/v4/chat/completions` `{"model":"glm-5.3",...}` | 401 | `{"error":{"code":"401","message":"token expired or incorrect"}}` |
| `POST https://api.moonshot.ai/v1/chat/completions` `{"model":"kimi-k3",...}` | 401 | `{"error":{"message":"Invalid Authentication","type":"invalid_authentication_error"}}` |

## 2. Vendor docs confirm ids, base URLs, and required params

- **DeepSeek** — `https://api-docs.deepseek.com/`:
  - OpenAI base `https://api.deepseek.com`, Anthropic base
    `https://api.deepseek.com/anthropic`; model `deepseek-flash`
    (= DeepSeek-V4.1-Flash; legacy `deepseek-v4-flash` accepted).
  - Thinking is opt-in (`thinking: { "type": "enabled" }`);
    `reasoning_effort` is `low`/`high`/`max`, default `high`
    (`/guides/thinking_mode`).
  - Off-peak pricing is "50% lower than peak" (`/news/news260813`); the exact
    hours are an **image** (`/img/v4_260813_price_en.png`), so they are not
    committed — `WORKFLOW_OFF_PEAK_DEEPSEEK_PEAK_UTC` supplies them.
- **GLM** — `https://docs.z.ai/guides/llm/glm-5.3` and
  `https://docs.z.ai/guides/vlm/glm-5.3-flash`:
  - OpenAI Chat base `https://api.z.ai/api/paas/v4` (coding plan:
    `https://api.z.ai/api/coding/paas/v4`), Responses `https://api.z.ai/api/v1`,
    Anthropic `https://api.z.ai/api/anthropic`; models `glm-5.3`,
    `glm-5.3-flash` (`glm-5.3-flashx` also exists).
  - "GLM-5.3 always operates with reasoning enabled"; `thinking.type` only
    supports `enabled`, and `"disabled"` **fails** (migration notice).
    `reasoning_effort` is `low`/`high`/`max`, default `max`.
  - GLM Coding Plan peak: **Monday–Friday 14:00–18:00 Singapore Standard Time
    (UTC+8)**; off-peak (including all weekend) is 0.5× points
    (`https://docs.z.ai/devpack/overview`).
- **Kimi** — `https://platform.kimi.ai/docs/api/chat` and `/docs/api/messages`:
  - OpenAI base `https://api.moonshot.ai/v1`, Anthropic Messages base
    `https://api.moonshot.ai/anthropic`; model `kimi-k3`.
  - `kimi-k3` "always reasons" and uses top-level `reasoning_effort`
    (`low`/`high`/`max`, default `max`); Preserved Thinking requires replaying
    `reasoning_content` + `tool_calls` verbatim (W070b's concern).

## 3. OpenRouter fallback ids from the live catalog

`GET https://openrouter.ai/api/v1/models` → HTTP 200, 447 entries, fetched
2026-09-19. Extracted entries (fields `id`, `alias_target.slug`):

| Pool id | Direct vendor model | Verified OpenRouter fallback | Alias shown by catalog |
|---|---|---|---|
| `deepseek-flash` | `deepseek-flash` | `deepseek/deepseek-v4.1-flash` | `~deepseek/deepseek-flash-latest` → `deepseek/deepseek-v4.1-flash` |
| `glm-5.3` | `glm-5.3` | `z-ai/glm-5.3` | `~z-ai/glm-latest` → `z-ai/glm-5.3` |
| `glm-5.3-flash` | `glm-5.3-flash` | `z-ai/glm-5.3-flash` | `~z-ai/glm-flash-latest` → `z-ai/glm-5.3-flash` |
| `kimi-k3` | `kimi-k3` | `moonshotai/kimi-k3` | `~moonshotai/kimi-latest` → `moonshotai/kimi-k3` |

Representative catalog rows (verbatim excerpts):

```json
{"id":"~deepseek/deepseek-flash-latest","name":"DeepSeek: DeepSeek Flash Latest","context_length":1048576,"alias_target":{"slug":"deepseek/deepseek-v4.1-flash"},"pricing":{"prompt":"0.000000135"}}
{"id":"z-ai/glm-5.3","name":"Z.ai: GLM 5.3","context_length":1310720,"pricing":{"prompt":"0.00000091"}}
{"id":"z-ai/glm-5.3-flash","name":"Z.ai: GLM 5.3 Flash","context_length":1310720,"pricing":{"prompt":"0.00000009"}}
{"id":"moonshotai/kimi-k3","name":"MoonshotAI: Kimi K3","context_length":1048576,"pricing":{"prompt":"0.0000021"}}
```

No id in `DEFAULT_OPEN_SOURCE_POOL` is guessed. The four fallbacks are concrete
catalog ids, not `~...-latest` aliases (aliases do not resolve inside the Auto
Router's `allowed_models`; see `openrouter-auto-latest.ts`).

## 4. Gaps (stated, not papered over)

1. **No vendor completion probe ran.** `test/open-model-probe.test.ts` is
   gated by `WORKFLOW_OPEN_MODEL_LIVE=1` plus a real key; the machine had no
   `DEEPSEEK_API_KEY` / `ZAI_API_KEY` / `MOONSHOT_API_KEY` (or key file), so
   the probe skipped. Re-run it once keys exist; the item's acceptance
   ("a live probe per vendor records a successful completion through the
   proxy") is therefore **not yet satisfied**, only wired.
2. **DeepSeek off-peak hours are uncommitted.** The window is published as an
   image; the scheduler treats the window as unknown (fail-open + logged) until
   `WORKFLOW_OFF_PEAK_DEEPSEEK_PEAK_UTC` is provided.

## 5. Off-peak measurement plan (W070a slice 4)

1. Pick one representative batch task (a single non-interactive summarization
   or classification job) and run it twice on `deepseek-flash` (or `glm-5.3`)
   through the metering proxy: once inside peak, once inside off-peak.
2. Record `proxy.metrics().costUsd` (or GLM points from the vendor console) and
   wall-clock duration for each run; the expected delta is ≈50% on the
   discounted run.
3. Record the observed delta with the run date and model id here (append-only).
   A live cost measurement is optional while keys are unavailable — the
   scheduler option and this plan ship either way.

## 6. Independent re-verification (2026-09-19, second pass)

Re-ran the live checks from a second session before committing; results:

- `GET https://api.deepseek.com/models` → HTTP 401, body
  `Authentication Fails (governor)` (auth-gated; body text differs from §1's
  quoted JSON, likely edge variance — both prove the host/path is live).
- `POST https://api.z.ai/api/paas/v4/chat/completions` `{"model":"glm-5.3",…}`
  → HTTP 401 `{"error":{"code":"1001","message":"Authentication parameter not
  received in Header, unable to authenticate"}}`.
- `POST https://api.moonshot.ai/v1/chat/completions` `{"model":"kimi-k3",…}`
  → HTTP 401 `{"error":{"message":"Incorrect API key provided","type":"incorrect_api_key_error"}}`.
- Anthropic bases also reached (401 each): `api.deepseek.com/anthropic`,
  `api.z.ai/api/anthropic`, `api.moonshot.ai/anthropic`.
- `GET https://openrouter.ai/api/v1/models` → HTTP 200, 447 entries; the four
  fallback ids and alias targets in §3 are present verbatim —
  `deepseek/deepseek-v4.1-flash`, `z-ai/glm-5.3`, `z-ai/glm-5.3-flash`,
  `moonshotai/kimi-k3` (pricing prompt `0.00000015`, `0.00000091`,
  `0.00000009`, `0.0000000021`).
- Docs re-fetched: `docs.z.ai/guides/llm/glm-5.3` confirms `thinking.type`
  supports only `enabled` on GLM-5.3 and `reasoning_effort` default `max`;
  `docs.z.ai/api-reference/llm/chat-completion` confirms `glm-5.3-flash` (and
  `glm-5.3-flashx`) exist and that GLM defaults are `temperature: 1.0`,
  `top_p: 0.95`; `docs.z.ai/devpack/overview` confirms **peak = Monday–Friday
  14:00–18:00 SGT (UTC+8)**, off-peak 50% of standard credit; Kimi docs confirm
  OpenAI base `https://api.moonshot.ai/v1`, `kimi-k3` always reasons with
  top-level `reasoning_effort` low/high/max default `max`; DeepSeek thinking-mode
  guide confirms OpenAI `thinking: {type: enabled/disabled}` +
  `reasoning_effort` low/high/max default `high`.

No id was changed as a result. §4's gaps (no vendor keys; DeepSeek off-peak
hours image-only) still stand.

## 7. Request shaping is applied at the vendor boundary (2026-09-19)

`createOpenModelMeteringPool` now passes a `transformBody` to the metering
proxy that resolves the request's `model` to its `ModelProfile` and calls
`shapeRequestBody`, so the GLM/K3 never-`disabled` invariant holds on the wire
(not only in the type). Pinned by `test/open-model-proxy.test.ts` (a GLM/K3
request sent with `thinking: {type: "disabled"}` is asserted to reach the fake
upstream as `enabled` / field-dropped).
