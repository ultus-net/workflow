import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { audienceDirective, type Audience } from "./audience.js";

/**
 * A style pack is data, not code. It declares a mode (which fixes the shape),
 * a voice, an illustration policy, and carries an exemplar note as the
 * few-shot anchor. Swapping taste means editing YAML plus an exemplar.
 */

export const ModeSchema = z.enum(["notes", "essay", "hybrid"]);
export type Mode = z.infer<typeof ModeSchema>;

export const StylePackSchema = z.object({
  id: z.string(),
  mode: ModeSchema,
  description: z.string().default(""),
  illustration: z.object({
    /** woven = folded into prose; labeled = a standalone Example:/Analogy: line. */
    render: z.enum(["woven", "labeled"]).default("labeled"),
    labels: z.array(z.enum(["example", "analogy", "idiom"])).default(["example", "analogy"]),
    /** off = never; optional = when the gate says it earns its place; required = every section. */
    idiom: z.enum(["off", "optional", "required"]).default("optional"),
    /** Diagram policy mirrors idiom. */
    diagram: z.enum(["off", "optional", "required"]).default("optional"),
    /**
     * Diagram fence format. "text" is the ASCII glyph drawing the packs have
     * always asked for. "mermaid" asks for Mermaid source text instead, which a
     * surface capable of rendering it turns into a real diagram. Source text
     * only; augur renders nothing.
     */
    diagramFormat: z.enum(["text", "mermaid"]).default("text"),
  }).default({}),
  voice: z.object({
    person: z.enum(["third", "first-plural", "second"]).default("third"),
    tense: z.enum(["present", "past"]).default("present"),
    tone: z.string().default("terse senior engineer"),
  }).default({}),
  /** Lintable rules. The linter reads these and checks the output against them. */
  rules: z.object({
    maxHeadingDepth: z.number().int().min(1).max(6).default(2),
    requireSourceLine: z.boolean().default(true),
    requireDiagramPerSection: z.boolean().default(false),
    requireRuleLine: z.boolean().default(false),
    bannedPhrases: z.array(z.string()).default([]),
  }).default({}),
  /** Inline text of the exemplar note, loaded from exemplar.md beside the pack. */
  exemplar: z.string().default(""),
});
export type StylePack = z.infer<typeof StylePackSchema>;

function packsDir(): string {
  if (process.env.AUGUR_STYLES) return process.env.AUGUR_STYLES;
  // Resolve assets/augur/styles from the module location. In the checkout the
  // module sits at src/assistant/style/ and the built copy at
  // dist/assistant/style/, so the package root is three levels up from this
  // file in both trees.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "assets", "augur", "styles");
}

export function listStyles(): string[] {
  const dir = packsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function loadStyle(id: string): StylePack {
  const dir = join(packsDir(), id);
  const manifest = join(dir, "style.yaml");
  if (!existsSync(manifest)) {
    throw new Error(`Style pack not found: ${id} (looked in ${manifest})`);
  }
  const pack = parseYaml(readFileSync(manifest, "utf8")) as Record<string, unknown>;
  const exemplarPath = join(dir, "exemplar.md");
  const exemplar = existsSync(exemplarPath) ? readFileSync(exemplarPath, "utf8") : "";
  return StylePackSchema.parse({ id, exemplar, ...pack });
}

/** The system prompt is assembled from the pack plus the audience, so it is data-driven. */
export function buildSystemPrompt(pack: StylePack, langDirective: string, audience: Audience = "mid"): string {
  const shape: Record<Mode, string> = {
    notes: [
      "Produce study notes.",
      "Open with an H1 title, then a `Source:` line carrying URL, duration, and date.",
      "Split the body into H2 sections, one topic each.",
      "Inside each section use terse bullets. One claim per bullet. Carry the evidence: a number, a name, a mechanism.",
      "Prefer concrete numbers over adjectives. No prose paragraphs. No headings deeper than H2.",
    ].join(" "),
    essay: [
      "Produce a long-form retrospective essay.",
      "Open with a short present-tense vignette that states the concrete situation.",
      "Use prose paragraphs, not bullets, except where a list is genuinely enumerable.",
      "State load-bearing lessons as standalone bolded lines.",
      "Include a synthesis section and a forward-application section before the close.",
    ].join(" "),
    hybrid: [
      "Produce a hybrid document.",
      "Open with an H1 title and a `Source:` line.",
      "Lead each section with one or two prose sentences, then bullets for the enumerable detail.",
      "State load-bearing lessons as standalone bolded lines.",
    ].join(" "),
  };

  const ill = pack.illustration;
  const illRule =
    ill.render === "labeled"
      ? `Where an illustration earns its place, add one standalone line beginning with one of: ${ill.labels
          .map((l) => l[0]!.toUpperCase() + l.slice(1) + ":")
          .join(", ")}.`
      : "Where an illustration earns its place, weave it into the prose as a sentence. Do not add standalone labels.";

  const textDiagramRule =
    "Where a section describes structure, flow, or a comparison, end it with a fenced ```text diagram. Use a fixed glyph set: ──► ▲ ▼ │ ┌ ┐ └ ┘ ├ ┤.";
  const mermaidDiagramRule =
    "Where a section describes structure, flow, or a hierarchy, end it with a fenced ```mermaid block. Emit valid Mermaid source only: a `flowchart` (or `graph`) for structure and flow, and a hierarchy/nested form for trees. Keep node labels short.";

  const diagramRule =
    ill.diagram === "off"
      ? "Do not add diagrams."
      : ill.diagramFormat === "mermaid"
        ? mermaidDiagramRule
        : textDiagramRule;

  const rules = pack.rules;
  const banned = rules.bannedPhrases.length
    ? `Never use these phrases: ${rules.bannedPhrases.join(", ")}.`
    : "";

  return [
    "You are a tutor. You turn a source into a document that teaches the material.",
    "You write for a learner who wants the mechanism, not the summary.",
    shape[pack.mode],
    audienceDirective(audience),
    illRule,
    diagramRule,
    `Voice: ${pack.voice.person} person, ${pack.voice.tense} tense, ${pack.voice.tone}.`,
    banned,
    langDirective,
    pack.exemplar
      ? `Here is a reference output. Match its structure, density, and voice.\n\n---\n${pack.exemplar}\n---`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
