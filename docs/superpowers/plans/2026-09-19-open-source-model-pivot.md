# Open-source-first model pivot — routing, optimization, and tool-usage enforcement

**Plan date:** 2026-09-19. **Status:** OPERATOR-DIRECTED (2026-09-19, chat): pivot the daily-driver model pool to open-source models exclusively — **DeepSeek, GLM, Kimi** — and optimize the harness for them, including deterministic enforcement of tool usage where appropriate. Items **W070a** (routing pivot) and **W070b** (open-model optimization + tool-usage enforcement) are proposed task numbers; TASKS.md promotion still awaits operator sign-off, but implementation is authorized to start now.

**Companion plan:** `docs/superpowers/plans/2026-09-19-ai-landscape-followups.md` (W070 extends W061's model-pool slice into a full policy item; W061's off-peak/effort work folds into W070a). **Research basis:** `docs/AI_LANDSCAPE_RESEARCH.md` §1.

**Wave-1 status (2026-09-19):** W051 (`e7a01c9`), W054 (`f672a48`), W063 (`bd7d403`), W057+W064 (`5485233`) committed in isolated worktrees; gates green (lint/typecheck/build + focused tests); five-axis reviews queued, not yet recorded. Not merged.

---

## 1. Grounded vendor facts (fetched 2026-09-19)

| | DeepSeek (`deepseek-flash` = V4.1-Flash) | GLM (`glm-5.3`, `glm-5.3-flash`) | Kimi (`kimi-k3`) |
|---|---|---|---|
| Thinking | Opt-in (`thinking: {type: "enabled"}`); tool use supported in thinking mode since V3.2 | **Always on.** `thinking.type: "disabled"` now **fails** — a hard migration trap for GPT-era configs | **Always on**, returns `reasoning_content` |
| Reasoning effort | `reasoning_effort` (API guide shows `high`) | `low`/`high`/`max`, **default `max`** | `low`/`high`/`max`, **default `max`** |
| Tool-call strictness | **`strict` mode (Beta, `/beta` base URL):** server-validated JSON schemas — all object properties `required`, `additionalProperties: false`, no `minLength/maxLength/minItems/maxItems` | Function calling + structured output supported (docs.z.ai capability guides) | Tool choice + **dynamic tool loading** supported (platform.kimi.ai quickstart) |
| Message-replay rules | Tool calls **cannot** be inserted mid-conversation via Chat Completion (use Anthropic or Responses API for that); system messages insertable | Standard chat replay | **Preserved thinking history:** the complete assistant message — `reasoning_content` *and* `tool_calls`, not just `content` — must be passed back as-is on multi-turn/tool loops. Stripping it degrades the model |
| Endpoints | OpenAI `api.deepseek.com`; **Anthropic `api.deepseek.com/anthropic`**; beta `api.deepseek.com/beta` | OpenAI Chat `api.z.ai/api/paas/v4` (coding plan: `api.z.ai/api/coding/paas/v4`); Responses `api.z.ai/api/v1`; **Anthropic `api.z.ai/api/anthropic`** | **OpenAI + Anthropic-compatible** on `platform.kimi.ai` |
| Cost levers | **Off-peak = 50% of peak**; context caching (KV hits cheap) | **GLM Coding Plan points; off-peak + all weekend = 50% points**; context caching | Context caching (platform docs) |
| Notables | 1M ctx cheaper to serve (¼ HBM KV cache); OpenCode official partner | 1M ctx / 128K out; text-only input; Terminal-Bench 3.0 open SOTA | 1M ctx; native vision; Terminal-Bench 2.1 88.3, MCPMark-Verified 94.5, Toolathlon-Verified 76.5 (Kimi Code harness) |

**The structural insight:** all three vendors expose **Anthropic-compatible or OpenAI-compatible** endpoints, so one wire discipline can serve the whole pool — but every one of them has a GPT-era assumption it will punish (see §2).

---

## 2. Why the GPT-tuned plugin discipline degrades on these models

The retired `opencode workflow-guard plugin` (and the hub's prompt-side discipline generally) leaned on GPT models' strong instruction-following from prose guidance. Three concrete failure modes against the open pool:

1. **Thinking-mode flags**: any code path that sends `thinking: disabled` (or omits it assuming default-off) fails hard on GLM-5.3 and silently mis-configures K3.
2. **Message-history replay**: GPT-era harnesses routinely strip or summarize assistant internals when replaying history (compaction, steering, permission replays). K3 *requires* preserved `reasoning_content` + `tool_calls` replay; degraded replay = degraded tool discipline — which then looks like "the model is bad at tools" when it is the harness breaking the contract.
3. **Schema looseness**: loose JSON schemas (optional fields, unconstrained objects) that GPT models navigate fine waste open-model tool calls. DeepSeek offers server-enforced `strict` mode — the deterministic enforcement lever the pivot should adopt rather than prompt-nagging.

---

## 3. W070a (proposed) - Routing pivot: open-source-only default pool

**Objective:** The hub's default model pool becomes DeepSeek + GLM + Kimi exclusively, composed through the metering proxy with per-vendor endpoints and effort/cost levers. Closed models become non-default (operator-overridable), not deleted.

**Approach sketch (slices):**
1. **Pool definition:** default alias pool = `deepseek-flash` (V4.1-Flash), `glm-5.3`, `glm-5.3-flash`, `kimi-k3`. Endpoint strategy: **direct vendor endpoints first** (all three documented above; cost + caching benefits), **OpenRouter as uniform fallback** for any model/endpoint that is unavailable — the resolver must verify IDs live (API or vendor docs) and record evidence before committing names; no guessed IDs.
2. **Provider composition:** metering-proxy composition per provider (placeholder key inside the boundary, real key proxy-side — the existing pattern). DeepSeek/GLM/Kimi API keys enter credential custody like OpenRouter's. Anthropic-compatible endpoints are preferred where a single wire format simplifies the adapter; record the choice per vendor in `docs/HUB.md`.
3. **Request-parameter profile layer (shared with W070b):** per-family request shaping — `reasoning_effort` (low/high/max) with per-task defaults (coding: `high` for DeepSeek per its guide, `max` where budget allows), correct `thinking` flags per vendor (never `disabled` for GLM/K3), temperature/top-p guidance from vendor docs. Encoded in one `ModelProfile` type, not scattered conditionals.
4. **Off-peak scheduling hook:** DeepSeek 50% off-peak and GLM Coding-Plan 50% weekend/off-peak points make deferred batch/CI work materially cheaper; wire the existing scheduler to an off-peak window option (deepseek/GLM-specific), measure, record.
5. **Docs:** update the routing sections (`README.md` current-model routing paragraph, `docs/HUB.md`) with the new pool, endpoint table, and the honest note that closed models remain available via explicit operator override.

**Acceptance criteria:**
- [ ] Default pool resolves to the four open-source models with **live-verified** endpoint/IDs; evidence (response bodies or doc quotes) recorded in the item's notes.
- [ ] Metering proxy composes all three vendors (placeholder-key discipline preserved); a live probe per vendor records a successful completion through the proxy.
- [ ] `ModelProfile` request shaping exists with per-vendor tests (GLM request never contains `thinking.type: "disabled"`; K3/DeepSeek effort fields valid).
- [ ] Off-peak window option exists with a measured cost delta on one batch task (or a dated no-go).
- [ ] Routing docs updated; closed-model override path documented and tested.

**Verification:** focused tests on profile/pool resolution; env-gated live probes per vendor with recorded verdicts; lint/typecheck/build green.

**Honest-claims note:** routing is not an enforcement claim — no probe-family impact — but any change to what the hub sends must keep the ACP conformance family green for the remaining agent kinds.

## 4. W070b (proposed) - Open-model optimization + deterministic tool-usage enforcement

**Objective:** Make the harness itself open-model-native: fix the GPT-era replay/flag assumptions, adopt server-side schema strictness, and convert guidance-that-GPT-obeyed into deterministic tool-usage enforcement.

**Approach sketch (slices):**
1. **Replay-policy audit:** find every place assistant messages are replayed (steering, permission replays, compaction, mid-conversation injection) and give the message pipeline an explicit per-model replay policy: K3 → preserve `reasoning_content` + `tool_calls` verbatim; DeepSeek → never synthesize tool-call turns via Chat Completion (route mid-conversation insertions through the Anthropic-format path); GLM → standard replay. Add regression tests with per-family fixtures.
2. **Strict-schema adapter (DeepSeek):** when the active profile targets DeepSeek, emit `strict: true` tool schemas through the `/beta` base URL — with a schema translator that enforces the strict-mode subset (all-required, `additionalProperties: false`, unsupported keywords removed) and **fails loudly** when a toolbox schema cannot be strictified (that failure is the signal to fix the schema, not to silently loosen it).
3. **Tool-usage enforcement (the operator's ask), deterministic layers in order:**
   a. **Deny-with-redirect (already deterministic; tune for open models):** guard denials name the expected tool class and the exact alternative in short, imperative language — prose guidance is where open models drift most, so keep denial text minimal and mechanical.
   b. **Tool-expected-turn detection:** when the model is mid-execution on a mutation-scoped task and a turn produces no tool call, the harness injects a bounded corrective re-prompt (≤2 retries, then escalates to the operator surface) naming the expected tool class. This is harness-level steering, not a security control — observable in the monitor TUI, counted per session.
   c. **Required-tool evidence gates stay in the kernel** (unchanged): state transitions still demand evidence from tools with documented authority — this is the strongest "tool usage where appropriate" enforcement that already exists.
   d. **Model-visible guidance slimming:** audit the toolbox guidance text for GPT-flattering verbosity; for open models prefer schema descriptions + denial redirects over long prose.
4. **Previous-plugin audit:** locate the retired `opencode workflow-guard plugin` (and any remaining prompt-side discipline in hub injections), inventory each pattern that relied on GPT instruction-following, and record per-pattern disposition: converted-to-(a/b/c) or kept-advisory-with-eyes-open. Output: a dated section in `docs/HOST_ADAPTERS.md` or a new `docs/OPEN_MODEL_ENFORCEMENT.md`.
5. **Vendor verification probes (feeds W062):** a small golden corpus per vendor (tool-call shape, schema adherence, replay integrity) run through the metering proxy; results recorded with provenance — this doubles as the drift detector for the new pool.

**Acceptance criteria:**
- [ ] Per-model replay policy implemented with K3 preserved-thinking fixture tests (a stripped-replay fixture is detected or prevented).
- [ ] DeepSeek strict-schema adapter with translator tests; at least one toolbox tool served through strict mode in a gated live probe.
- [ ] Deny-with-redirect text audited and tightened; bounded tool-expected-turn re-prompt implemented with retry cap and monitor visibility; tests prove the cap.
- [ ] Previous-plugin pattern inventory exists with per-pattern disposition; no enforcement-claim wording added without probe evidence.
- [ ] Golden-probe corpus per vendor defined; one recorded run per vendor.

**Verification:** focused adapter/pipeline tests; toolbox `pnpm run verify` where touched; env-gated live probes (DeepSeek strict, K3 replay, GLM flags) with recorded verdicts; lint/typecheck/build green.

**Honest-claims note:** tool-expected-turn steering and deny-with-redirect are behavioral nudges, not guarantees; nothing in this item may be described as preventing anything. Probe-gated surfaces remain probe-gated.

---

## 5. Sequencing and waves

- **Wave 2a (now):** W070a worker (routing pool + profiles + composition) and W070b worker (replay policy + strict adapter + enforcement) run in parallel isolated worktrees. W070b touches adapter/message-pipeline code; W070a touches hub proxy/routing/docs — overlap is limited to the shared `ModelProfile` type, so **W070a owns the type**, W070b consumes it (worker B: if the type is absent in your branch, stub against the documented interface and flag the dependency in your report).
- **Wave 2b (queued):** W062 vendor-verification productization on top of W070b's corpus; W052/W065/W066/W068/W058/W059 per the follow-ups plan sequencing.
- **Reviews:** wave-1 worktrees + wave-2 worktrees all get independent five-axis reviews before anything merges; the operator reviews merge order.

**Deliberate non-goals:** no removal of closed-model support (operator override remains); no change to probe gating or enforcement claims; no silent schema loosening to satisfy strict mode; no guessed model IDs — every pool entry verified live with recorded evidence.
