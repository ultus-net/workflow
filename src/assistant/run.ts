import { loadConfigFile, resolveConfig, apiKey, type Config } from "./config.js";
import { AUDIENCES, isAudience, type Audience } from "./style/audience.js";
import { buildSystemPrompt, loadStyle, type StylePack } from "./style/pack.js";
import { ingestPath, ingestStdin, isUrl } from "./ingest/index.js";
import { ingestUrl } from "./ingest/web.js";
import { sourceToContent } from "./attachment.js";
import {
  OpenRouterProvider,
  langDirective,
  renderReferences,
  timeContext,
  type ChatMessage,
} from "./provider/openrouter.js";
import { lint, type LintResult } from "./lint.js";
import { applyVerification, verify, type Verification } from "./verify.js";
import type { SourceBundle } from "./model/source.js";

/**
 * The core pipeline, shared by the CLI and the TUI. Both front ends call
 * `run` or `runStream` and render the result. No UI logic lives here.
 */

export interface RunRequest {
  source: string;
  audience: Audience;
  style?: string;
  lang?: Config["lang"];
  research?: boolean;
  out?: string;
  /** Run the post-generation verification pass. Default true. */
  verify?: boolean;
}

export interface RunCallbacks {
  onStatus?: (msg: string) => void;
  onDelta?: (chunk: string) => void;
}

export interface RunResult {
  markdown: string;
  lint: LintResult;
  modelUsed: string;
  citations: number;
  usage: { promptTokens: number; completionTokens: number; webSearches: number };
  verification: Verification | null;
  blocked: boolean;
}

export function resolveRunConfig(req: RunRequest): Config {
  return resolveConfig(loadConfigFile(), {
    style: req.style,
    lang: req.lang,
    out: req.out,
  });
}

export async function ingestSource(
  source: string,
  lang: Config["lang"],
  readStdin: () => Promise<string>,
): Promise<SourceBundle> {
  if (source === "-") return ingestStdin(await readStdin(), { lang });
  if (isUrl(source)) return ingestUrl(source, { lang });
  return ingestPath(source, { lang });
}

export function buildMessages(
  pack: StylePack,
  src: SourceBundle,
  audience: Audience,
  lang: Config["lang"],
  research: boolean,
  now: Date,
): ChatMessage[] {
  const system = [
    buildSystemPrompt(pack, langDirective(lang), audience),
    timeContext(now, research),
    research
      ? "Ground anything time-sensitive in a source. Do not invent citations; only list sources you actually retrieved."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: sourceToContent(src) },
  ];
}

/** Assemble the final markdown, appending a references section when present. */
export function assemble(text: string, citations: Parameters<typeof renderReferences>[0], lang: Config["lang"]): string {
  return (text.trim() + renderReferences(citations, lang)).trimEnd() + "\n";
}

export async function run(
  req: RunRequest,
  readStdin: () => Promise<string>,
  cb: RunCallbacks = {},
): Promise<RunResult> {
  const cfg = resolveRunConfig(req);
  const audience: Audience = isAudience(req.audience) ? req.audience : "mid";
  const research = req.research !== false;
  cb.onStatus?.(`style: ${cfg.style} | audience: ${AUDIENCES[audience].label}`);
  const pack = loadStyle(cfg.style);
  cb.onStatus?.(`ingesting ${req.source}`);

  const src = await ingestSource(req.source, cfg.lang, readStdin);
  cb.onStatus?.(`title: ${src.title} | blocks: ${src.blocks.length}`);

  const messages = buildMessages(pack, src, audience, cfg.lang, research, new Date());
  const provider = new OpenRouterProvider(apiKey(), cfg.provider);
  const webSearch = { enabled: research, engine: "auto", maxResults: 5, maxUses: 3 };

  let result;
  if (cb.onDelta) {
    result = await provider.chatStream({ messages, webSearch, temperature: 0.4 }, cb.onDelta);
  } else {
    result = await provider.chat({ messages, webSearch, temperature: 0.4 });
  }

  const markdown = assemble(result.text, result.citations, cfg.lang);
  cb.onStatus?.(
    `model: ${result.modelUsed} | tokens: ${result.usage.promptTokens}+${result.usage.completionTokens} | searches: ${result.usage.webSearches}`,
  );

  let finalMarkdown = markdown;
  let verification: Verification | null = null;
  let blocked = false;

  if (req.verify !== false) {
    cb.onStatus?.("verifying claims against the source and the live web…");
    try {
      const vr = await verify({
        draft: markdown,
        sourceText: src.text,
        now: new Date(),
        research,
        lang: cfg.lang,
        provider,
        config: cfg.provider,
      });
      verification = vr.verification;
      const gated = applyVerification(markdown, vr.verification, cfg.lang);
      finalMarkdown = gated.annotated;
      blocked = gated.blocked;
      cb.onStatus?.(
        `verify: ${vr.verification.verdicts.filter((c) => c.status !== "supported").length} flagged | confidence ${Math.round(
          vr.verification.confidence * 100,
        )}%${blocked ? " | HELD for review" : ""}`,
      );
    } catch (e) {
      cb.onStatus?.(`verify skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const lintResult = lint(finalMarkdown, pack, audience);

  return {
    markdown: finalMarkdown,
    lint: lintResult,
    modelUsed: result.modelUsed,
    citations: result.citations.length,
    usage: result.usage,
    verification,
    blocked,
  };
}
