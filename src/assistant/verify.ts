import { z } from "zod";
import type { Lang } from "./model/source.js";
import {
  OpenRouterProvider,
  type ChatMessage,
  type Citation,
  type ProviderConfig,
} from "./provider/openrouter.js";

/**
 * Output verification. Runs after generation, before the note is emitted.
 *
 * Two things it guards against:
 *   1. Dated answers. A claim that was true at the model's training cutoff and
 *      is no longer true now. The verifier is told the current date and, when
 *      research is on, has web search to check currency.
 *   2. Ungrounded claims. Assertions of fact that the source does not support
 *      and, with search on, that no retrieved page supports.
 *
 * It returns structured findings, not prose, so the caller can annotate the
 * note, drop unsupported claims, or hold the whole run.
 */

export const ClaimVerdictSchema = z.object({
  claim: z.string().describe("The specific claim as stated in the draft."),
  line: z.number().int().nonnegative().describe("1-based line number in the draft, else 0."),
  status: z.enum(["supported", "unsupported", "dated", "uncertain"]),
  severity: z.enum(["info", "warn", "block"]).describe("block = the note must not ship with this claim unqualified."),
  rationale: z.string().describe("One sentence: why this verdict."),
});
export type ClaimVerdict = z.infer<typeof ClaimVerdictSchema>;

export const VerificationSchema = z.object({
  verdicts: z.array(ClaimVerdictSchema),
  /** Overall confidence that the note is current and grounded, 0..1. */
  confidence: z.number().min(0).max(1),
  summary: z.string(),
});
export type Verification = z.infer<typeof VerificationSchema>;

const JSON_SCHEMA = {
  name: "verification",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdicts", "confidence", "summary"],
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claim", "line", "status", "severity", "rationale"],
          properties: {
            claim: { type: "string" },
            line: { type: "integer" },
            status: { type: "string", enum: ["supported", "unsupported", "dated", "uncertain"] },
            severity: { type: "string", enum: ["info", "warn", "block"] },
            rationale: { type: "string" },
          },
        },
      },
      confidence: { type: "number" },
      summary: { type: "string" },
    },
  },
};

export interface VerifyOptions {
  draft: string;
  sourceText: string;
  now: Date;
  research: boolean;
  lang: Lang;
  provider: OpenRouterProvider;
  config: ProviderConfig;
}

/** Post-model verification config. Kept separate from the generation provider. */
export function verificationConfig(base: ProviderConfig): ProviderConfig {
  return base;
}

function buildVerifierMessages(opts: VerifyOptions): ChatMessage[] {
  const system = [
    "You are a fact-checking auditor. You receive a draft document and its source.",
    `Current date and time: ${opts.now.toUTCString()} (${opts.now.toISOString()}).`,
    "Your job is to find claims in the draft that are unsupported by the source, or that were true in the past but may be stale now.",
    "For each claim you flag, give the verdict and a one-sentence rationale.",
    "Use status 'dated' for a claim whose truth depends on the current date (prices, versions, 'the latest', 'state of the art', rankings, leadership).",
    "Use status 'unsupported' for a factual claim with no basis in the source.",
    "Use status 'uncertain' when you cannot tell without checking.",
    "Use severity 'block' only for a claim that would mislead if shipped as written.",
    opts.research
      ? "You have a web search tool. Check time-sensitive claims against the live web before verdicting. Do not mark a claim 'dated' without checking, and do not mark it 'supported' on assumption."
      : "You have no web access for this task. Base verdicts on the source and on how time-sensitive the claim is.",
    opts.lang === "zh-Hans" ? "Write rationales in Simplified Chinese." : "Write rationales in English.",
    "Return only the structured object. Do not rewrite the draft.",
  ].join("\n");

  const user = [
    "# Draft to verify",
    opts.draft,
    "",
    "# Source the draft was built from",
    opts.sourceText.slice(0, 24000),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export interface VerifyResult {
  verification: Verification;
  citations: Citation[];
  modelUsed: string;
}

export async function verify(opts: VerifyOptions): Promise<VerifyResult> {
  const messages = buildVerifierMessages(opts);
  const result = await opts.provider.chat({
    messages,
    temperature: 0,
    responseFormat: { type: "json_schema", json_schema: JSON_SCHEMA },
    webSearch: { enabled: opts.research, engine: "auto", maxResults: 5, maxUses: 4 },
  });

  // The provider accepts a json_object format here; parse defensively because
  // not every endpoint honors the schema strictly.
  let parsed: Verification;
  try {
    parsed = VerificationSchema.parse(JSON.parse(result.text));
  } catch {
    parsed = {
      verdicts: [],
      confidence: 0.5,
      summary: "Verifier returned unparseable output; treat the note as unverified.",
    };
  }
  return { verification: parsed, citations: result.citations, modelUsed: result.modelUsed };
}

export interface GatedNote {
  /** The note with unsupported/dated claims annotated in place. */
  annotated: string;
  /** True when a 'block' finding exists and the caller asked to gate. */
  blocked: boolean;
  verification: Verification;
}

/**
 * Apply verification to the draft. Default behavior is to annotate, not to
 * silently rewrite: the learner sees exactly what was flagged and why.
 * A `block` severity turns the note into a held review item.
 */
export function applyVerification(draft: string, v: Verification, lang: Lang): GatedNote {
  const lines = draft.split("\n");
  const byLine = new Map<number, ClaimVerdict[]>();
  for (const verdict of v.verdicts) {
    if (verdict.status === "supported" || verdict.severity === "info") continue;
    const arr = byLine.get(verdict.line) ?? [];
    arr.push(verdict);
    byLine.set(verdict.line, arr);
  }

  for (const [line, verdicts] of byLine) {
    if (line <= 0 || line > lines.length) continue;
    const tag = lang === "zh-Hans" ? "⚠ 待核实" : "⚠ verify";
    const notes = verdicts.map((c) => `${c.status}: ${c.rationale}`).join("; ");
    lines[line - 1] = `${lines[line - 1]}  <!-- ${tag}: ${notes} -->`;
  }

  const heading = lang === "zh-Hans" ? "## 核实说明" : "## Verification notes";
  const body =
    v.summary ||
    (lang === "zh-Hans"
      ? "未发现需要标注的问题。"
      : "No flagged claims.");
  const detail = v.verdicts
    .filter((c) => c.status !== "supported" && c.severity !== "info")
    .map((c) => `- **${c.status}** (${c.severity}) — ${c.claim}\n  - ${c.rationale}`)
    .join("\n");

  const section = `\n\n${heading}\n\n${body}${detail ? `\n\n${detail}` : ""}\n`;
  const blocked = v.verdicts.some((c) => c.severity === "block");
  return { annotated: `${lines.join("\n").trimEnd()}${section}`, blocked, verification: v };
}
