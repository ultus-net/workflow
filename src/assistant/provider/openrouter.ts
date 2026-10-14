import type { Lang } from "../model/source.js";

/**
 * Thin OpenRouter client. One job: send a chat completion and return text.
 * Supports the native multimodal parts we need (image_url, file), the
 * `models` fallback array (failover on rate limits, downtime, and moderation
 * refusals), the `openrouter:web_search` server tool for grounded research,
 * and streamed responses.
 */

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
  | { type: "file"; file: { filename: string; file_data: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface ProviderConfig {
  models: string[];
  variant: string;
  order?: string[] | undefined;
  only?: string[] | undefined;
  ignore?: string[] | undefined;
  allowFallbacks: boolean;
}

/** Web search server tool configuration. */
export interface WebSearchConfig {
  enabled: boolean;
  engine?: string;
  maxResults?: number;
  maxUses?: number;
  searchContextSize?: "low" | "medium" | "high";
  allowedDomains?: string[];
  excludedDomains?: string[];
}

/** JSON schema enforced response, when the caller needs structured output. */
export type ResponseFormat =
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
    };

export interface ChatOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: ResponseFormat;
  /** Grant the model the web search server tool for this call. */
  webSearch?: WebSearchConfig;
  signal?: AbortSignal;
}

/** A citation OpenRouter surfaces from the web search tool. */
export interface Citation {
  url: string;
  title?: string;
  content?: string;
}

export interface ChatResult {
  text: string;
  modelUsed: string;
  usage: { promptTokens: number; completionTokens: number; webSearches: number };
  citations: Citation[];
  raw: unknown;
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** Loose shape of an untrusted OpenRouter JSON body. */
type Json = Record<string, unknown>;

function withVariant(id: string, variant: string): string {
  return variant ? `${id}${variant}` : id;
}

/** Pull `url_citation` annotations off a completion message. */
export function extractCitations(message: unknown): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  const anns = (message as { annotations?: unknown } | undefined)?.annotations;
  if (!Array.isArray(anns)) return out;
  for (const a of anns as Array<Record<string, unknown>>) {
    if (a?.type !== "url_citation" && a?.type !== "citation") continue;
    const cited = a.url_citation as { url?: string; title?: string; content?: string } | undefined;
    const url: string | undefined = cited?.url ?? (a.url as string | undefined);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = cited?.title ?? (a.title as string | undefined);
    const content = cited?.content ?? (a.content as string | undefined);
    out.push({
      url,
      ...(title === undefined ? {} : { title }),
      ...(content === undefined ? {} : { content }),
    });
  }
  return out;
}

function parseUsage(raw: unknown): ChatResult["usage"] {
  const usage = (raw as { usage?: Record<string, unknown> } | undefined)?.usage;
  const serverToolUse = usage?.server_tool_use as { web_search_requests?: number } | undefined;
  return {
    promptTokens: (usage?.prompt_tokens as number | undefined) ?? (usage?.input_tokens as number | undefined) ?? 0,
    completionTokens: (usage?.completion_tokens as number | undefined) ?? (usage?.output_tokens as number | undefined) ?? 0,
    webSearches: serverToolUse?.web_search_requests ?? 0,
  };
}

export class OpenRouterProvider {
  constructor(
    private readonly apiKey: string,
    private readonly config: ProviderConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private buildBody(opts: ChatOptions, stream: boolean): Record<string, unknown> {
    if (this.config.models.length === 0) {
      throw new Error("No models configured. Set provider.models in config or AUGUR_MODELS.");
    }
    const [primary, ...fallbacks] = this.config.models;
    const body: Record<string, unknown> = {
      model: withVariant(primary!, this.config.variant),
      messages: opts.messages,
      temperature: opts.temperature ?? 0.4,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.responseFormat) body.response_format = opts.responseFormat;
    if (stream) body.stream = true;
    if (fallbacks.length > 0) {
      body.models = fallbacks.map((m) => withVariant(m, this.config.variant));
    }

    if (opts.webSearch?.enabled) {
      const params: Record<string, unknown> = {};
      if (opts.webSearch.engine) params.engine = opts.webSearch.engine;
      if (opts.webSearch.maxResults) params.max_results = opts.webSearch.maxResults;
      if (opts.webSearch.maxUses) params.max_uses = opts.webSearch.maxUses;
      if (opts.webSearch.searchContextSize) params.search_context_size = opts.webSearch.searchContextSize;
      if (opts.webSearch.allowedDomains) params.allowed_domains = opts.webSearch.allowedDomains;
      if (opts.webSearch.excludedDomains) params.excluded_domains = opts.webSearch.excludedDomains;
      const tool: Record<string, unknown> = { type: "openrouter:web_search" };
      if (Object.keys(params).length > 0) tool.parameters = params;
      body.tools = [tool];
      body.max_tool_calls = (opts.webSearch.maxUses ?? 3) + 1;
    }

    const provider: Record<string, unknown> = { allow_fallbacks: this.config.allowFallbacks };
    if (this.config.order) provider.order = this.config.order;
    if (this.config.only) provider.only = this.config.only;
    if (this.config.ignore) provider.ignore = this.config.ignore;
    body.provider = provider;
    return body;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
      "x-title": "augur",
    };
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const body = this.buildBody(opts, false);
    const res = await this.fetchImpl(ENDPOINT, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: opts.signal ?? null,
    });

    const raw = (await res.json()) as {
      error?: { message?: string };
      choices?: Array<{ message?: unknown }>;
      model?: string;
    };
    if (!res.ok) {
      const msg = raw.error?.message ?? res.statusText;
      throw new Error(`OpenRouter ${res.status}: ${msg}`);
    }
    const choice = raw.choices?.[0];
    return {
      text: (choice?.message as { content?: string } | undefined)?.content ?? "",
      modelUsed: raw.model ?? this.config.models[0]!,
      usage: parseUsage(raw),
      citations: extractCitations(choice?.message),
      raw,
    };
  }

  /**
   * Stream a completion. Calls onDelta for each text chunk. Returns the
   * assembled result plus any citations seen on the final message.
   */
  async chatStream(
    opts: ChatOptions,
    onDelta: (chunk: string) => void,
  ): Promise<ChatResult> {
    const body = this.buildBody(opts, true);
    const res = await this.fetchImpl(ENDPOINT, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: opts.signal ?? null,
    });
    if (!res.ok || !res.body) {
      const raw = await res.json().catch(() => ({}));
      const msg = (raw as { error?: { message?: string } })?.error?.message ?? res.statusText;
      throw new Error(`OpenRouter ${res.status}: ${msg}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let modelUsed = this.config.models[0]!;
    let usage: ChatResult["usage"] = { promptTokens: 0, completionTokens: 0, webSearches: 0 };
    let citations: Citation[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        let evt: Json;
        try {
          evt = JSON.parse(payload) as Json;
        } catch {
          continue;
        }
        if (evt.model) modelUsed = evt.model as string;
        if (evt.usage) usage = parseUsage(evt);
        const choice = (evt.choices as Array<{ delta?: unknown }> | undefined)?.[0];
        const delta: string = (choice?.delta as { content?: string } | undefined)?.content ?? "";
        if (delta) {
          text += delta;
          onDelta(delta);
        }
        const cites = extractCitations(choice?.delta);
        if (cites.length) citations = cites;
      }
    }
    return { text, modelUsed, usage, citations, raw: null };
  }
}

/** Language directive appended to system prompts so output lang is explicit. */
export function langDirective(lang: Lang): string {
  return lang === "zh-Hans"
    ? "Write in Simplified Chinese (简体中文). Keep code, identifiers, and file paths in their original form."
    : "Write in English.";
}

/**
 * Grounding preamble. Tells the model the actual current date and time (the
 * model's training cutoff is stale), and that it has search for currency.
 */
export function timeContext(now: Date, webSearch: boolean): string {
  const iso = now.toISOString();
  const human = now.toUTCString();
  const base = `Current date and time: ${human} (${iso}). Treat this as the present moment.`;
  return webSearch
    ? `${base} You have a web search tool. Before asserting anything that may have changed since your training, search and ground the claim in a source. Prefer primary and recent sources.`
    : base;
}

/** Render citations as a `## Further reading` section, deduped by URL. */
export function renderReferences(citations: Citation[], lang: Lang): string {
  if (citations.length === 0) return "";
  const heading = lang === "zh-Hans" ? "## 延伸阅读" : "## Further reading";
  const lines = citations.map((c) => {
    const title = c.title ? `[${c.title}](${c.url})` : c.url;
    const note = c.content ? ` — ${c.content.slice(0, 160).trim()}` : "";
    return `- ${title}${note}`;
  });
  return `\n\n${heading}\n\n${lines.join("\n")}\n`;
}
