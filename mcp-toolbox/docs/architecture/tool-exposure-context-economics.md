# Tool Exposure And Context Economics

## Status

Accepted for the Stage 7 P702A gate on 2026-08-29.

## Context

The repository currently exposes 19 tools across seven independently publishable MCP servers. A compact serialization of their current `tools/list` responses totals 27,955 bytes. Output schemas account for 16,127 bytes, about 58% of that payload. A `bytes / 4` estimate gives roughly 6,989 tokens, but that estimate is reconnaissance only: MCP wire size is not the resource being optimized. The scarce resource is the model context a host actually makes visible.

Current MCP 2026-07-28 client guidance explicitly recommends progressive discovery when tool definitions become a significant share of context. Hosts still fetch complete definitions through `tools/list`, but can defer injecting them into model context and expose lightweight search/discovery instead. The guidance suggests a context-window threshold such as 1%-5% and separately recommends caching definitions host-side and preserving provider prompt-cache stability.

Current host behavior is heterogeneous. Claude Code defers MCP tools by default on supported models and exposes threshold-based tool search; OpenAI Responses supports deferred MCP servers and tool search; OpenCode documents that enabled MCP tools add to context and provides server/tool enablement but does not document progressive schema injection; Codex documents server and per-tool allow/deny controls but its MCP host documentation does not establish deferred schema injection; VS Code exposes server and individual-tool enablement, but its MCP management documentation does not establish progressive schema injection. Undocumented behavior must not be assumed.

The existing product boundaries are therefore useful context-budget boundaries. Collapsing all tools into one mandatory toolbox server would make selective exposure harder on eager hosts without improving MCP interoperability.

## Decision

Model-visible token cost is the primary tool-exposure metric. Exact serialized `tools/list` size is the deterministic, host-neutral secondary regression metric.

The normal/default tool surface targets at most 1% of the usable model context window. If the initial model-visible definitions would exceed 2%, the deployment must use progressive discovery or explicitly reduce the enabled server/tool set. The 2% value is a ceiling, not a target. These repository limits deliberately sit near the low end of MCP's current 1%-5% example range because coding-agent context is also needed for repository state, instructions, tool results, and reasoning.

Primary measurements use the actual model-visible request representation and tokenizer for representative hosts/models where that representation is observable. When exact host token accounting is unavailable, record that limitation and use exact serialized schema bytes as the portable comparison; do not promote `bytes / 4` or another heuristic to an acceptance criterion.

Measure eager and progressive hosts separately:

- Eager exposure measures the entire enabled model-visible definition surface.
- Progressive exposure measures the initial catalog/search surface and the definitions subsequently loaded for representative tasks.
- Prompt-cache hits are reported separately. Caching can reduce billed repeated input, but does not make definitions free of context-window occupancy or tool-selection effects.

MCP servers continue to publish complete, stable, interoperable capabilities. Progressive disclosure belongs to the host/provider boundary: a host can fetch `tools/list` normally while deciding which definitions enter model context and when. Servers must not implement connection-local or model-use-dependent tool catalogs to simulate lazy loading.

Keep the seven product servers independently addressable. Prefer native host/provider tool search where available. For eager hosts, use explicit server/tool enablement to keep the default surface within budget. A toolbox-specific `search_tools`/`get_tool_details`/`call_tool` gateway is deferred unless measurements show that native progressive discovery and explicit enablement cannot meet the budget; adding such a gateway prematurely would duplicate host functionality and complicate trust, approval, and provenance routing.

Do not remove useful `outputSchema` definitions solely to shrink discovery payloads. Current MCP guidance uses output schemas for typed and programmatic tool calling. Schema simplification is appropriate only when it improves the contract itself, not when it merely shifts validation/context responsibility to consumers.

## P702A Gate

P702A must establish the exposure baseline before Project Memory handoff dogfooding in P703 so handoff measurements are not contaminated by accidental eager tool loading.

Acceptance requires:

- Exact serialized `tools/list` bytes for every current server and the aggregate portfolio, recorded reproducibly.
- Actual model-visible token measurements for at least two materially different host strategies where observable, including one progressive-discovery strategy and one eager or explicitly enabled strategy.
- A documented normal/default exposure configuration for eager hosts that meets the 1% target for the representative context window. A measured 1%-2% configuration requires a documented exception and exposure-reduction follow-up rather than silently passing as the default; any initial exposure above 2% must use progressive discovery or explicit exposure reduction before the gate can pass.
- Progressive-host measurements that separate initial discovery/catalog cost from definitions loaded during representative tasks.
- Per-server/tool schema budgets sufficient to identify regressions, including input versus output-schema contribution where useful.
- Prompt-cache behavior reported separately from context occupancy.
- Any host behavior that cannot be established from first-party documentation or observable requests recorded as unknown rather than inferred.

## Baseline Evidence

Measured on 2026-08-29 after a clean build. Each server was launched through the MCP SDK stdio client, `client.listTools()` was called, and bytes were counted with `Buffer.byteLength(JSON.stringify(response))`. Input/output schema columns apply the same compact serialization to each tool schema and sum the results. This uses the real compiled MCP boundary rather than source-code estimates.

| Server | Tools | `tools/list` bytes | Input schema bytes | Output schema bytes |
| --- | ---: | ---: | ---: | ---: |
| Workflow Guard | 2 | 1,243 | 602 | 272 |
| Git Intelligence | 4 | 4,923 | 1,219 | 2,621 |
| Code Intelligence | 5 | 6,032 | 1,710 | 3,045 |
| Test Intelligence | 3 | 3,898 | 949 | 2,095 |
| CI Intelligence | 2 | 2,681 | 570 | 1,541 |
| Change Intelligence | 1 | 5,778 | 826 | 4,633 |
| Project Memory | 2 | 3,400 | 870 | 1,920 |
| Portfolio | 19 | 27,955 | 6,746 | 16,127 |

The first observable host measurement used OpenCode 1.18.25 with Azure `gpt-chat-latest`. OpenCode reports this model with a 128,000-token context window and a 111,616-token input limit. Three fresh one-turn sessions used the identical prompt `Reply with exactly OK.`, `--pure`, the same repository snapshot, and disabled unrelated configured MCP tools. Provider-reported input usage was 9,090 tokens with no toolbox MCP enabled, 9,202 with only Project Memory enabled, and 9,991 with all seven toolbox servers enabled. All three reported zero prompt-cache reads and writes.

The measured deltas are therefore 112 model-visible input tokens for the two-tool Project Memory surface (about 0.10% of the 111,616-token input limit) and 901 tokens for the complete 19-tool portfolio (about 0.81%). The complete eager OpenCode surface meets the 1% normal/default target for this representative model. These are provider-reported request deltas, not a conversion from MCP bytes; notably, the 27,955-byte wire catalog becomes a much smaller host/provider-visible token delta than `bytes / 4` would predict.

OpenCode's current first-party MCP documentation describes eager MCP context plus global/per-agent server/tool enablement and warns that enabled MCP tools add to context. It does not establish progressive schema injection. No progressive-discovery coding-agent host is installed in the measurement environment, so the required progressive-host measurement remains open rather than being inferred from another host or from documentation. P702A does not pass until that second strategy is exercised. The user subsequently approved a sequencing exception allowing P703 cross-context dogfooding to proceed using this eager evidence while the progressive measurement remains backlogged as P702B; that exception changes task ordering, not this acceptance result.

## Sources

- MCP Client Best Practices, 2026-07-28: <https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices>
- MCP Tools specification, 2026-07-28: <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>
- OpenAI Tool Search: <https://developers.openai.com/api/docs/guides/tools-tool-search>
- Claude Code MCP documentation: <https://docs.anthropic.com/en/docs/claude-code/mcp>
- OpenCode MCP servers: <https://opencode.ai/docs/mcp-servers/>
- OpenAI Codex MCP: <https://developers.openai.com/codex/mcp>
- VS Code MCP servers: <https://code.visualstudio.com/docs/copilot/customization/mcp-servers>

## Consequences

P703 and later Stage 7 dogfood measurements must state their tool-exposure strategy and model-visible context cost. Adding tools or materially expanding schemas now has an explicit context-economics cost in addition to API and implementation cost.

The architecture remains portable across MCP hosts: capable hosts can progressively disclose complete server definitions, while eager hosts can select the independently useful product surfaces they need. The repository does not depend on non-standard dynamic `tools/list` semantics for acceptable context economics.
