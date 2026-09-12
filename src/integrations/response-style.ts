/**
 * Response/build styles for the coding session, inspired by the caveman
 * (terse speech) and ponytail (YAGNI minimal-code) prompt rulesets. Both are
 * model-advisory system-prompt styles — token savings come from shaping the
 * model's output, never from altering code semantics or skipping Workflow
 * authorization.
 */

export const SPEECH_STYLES = ["normal", "caveman"] as const;
export type SpeechStyle = typeof SPEECH_STYLES[number];

export const BUILD_STYLES = ["normal", "ponytail-lite", "ponytail-full", "ponytail-ultra"] as const;
export type BuildStyle = typeof BUILD_STYLES[number];

export interface SessionStyle {
  readonly speech: SpeechStyle;
  readonly build: BuildStyle;
}

const CAVEMAN_RULES = `# Response Style: Caveman
Speak like caveman. Fewest words that carry the meaning.
- Short words. Small sentences. No preamble, no filler, no restating the question.
- No "Great question", no apologies, no narrating what you are about to do.
- Code and commands over prose. Bullets over paragraphs.
- BUT keep the summary: when work is done, close with a compact summary of what changed and why — summary is cargo, not filler.`;

const PONYTAIL_BASE = `# Build Style: Ponytail (YAGNI)
You are the laziest senior dev in the room. The best code is the code you never wrote.
- Solve the stated problem with the simplest thing that works. Nothing more.
- No features that were not asked for. No abstractions without two real callers today.
- Prefer editing/deleting existing code over adding new code. Smallest correct diff.`;

const PONYTAIL_FULL_EXTRA = `
- Name the thing you chose NOT to build, in one line, when a heavier approach was plausible.`;

const PONYTAIL_ULTRA_EXTRA = `
- Deletion is a feature: when you touch code, look for what can be removed.
- Reject gold-plating in review: call out over-engineering you find, and propose the deletion.`;

export function stylePromptAddendum(style: SessionStyle): string {
  const parts: string[] = [];
  if (style.speech === "caveman") parts.push(CAVEMAN_RULES);
  if (style.build !== "normal") {
    let build = PONYTAIL_BASE;
    if (style.build === "ponytail-full" || style.build === "ponytail-ultra") build += PONYTAIL_FULL_EXTRA;
    if (style.build === "ponytail-ultra") build += PONYTAIL_ULTRA_EXTRA;
    parts.push(build);
  }
  return parts.join("\n\n");
}

export function nextSpeechStyle(current: SpeechStyle): SpeechStyle {
  return SPEECH_STYLES[(SPEECH_STYLES.indexOf(current) + 1) % SPEECH_STYLES.length]!;
}

export function nextBuildStyle(current: BuildStyle): BuildStyle {
  return BUILD_STYLES[(BUILD_STYLES.indexOf(current) + 1) % BUILD_STYLES.length]!;
}

export function resolveStyleFromEnv(env: { WORKFLOW_SPEECH_STYLE?: string; WORKFLOW_BUILD_STYLE?: string }): SessionStyle {
  const speech = (SPEECH_STYLES as readonly string[]).includes(env.WORKFLOW_SPEECH_STYLE ?? "")
    ? env.WORKFLOW_SPEECH_STYLE as SpeechStyle
    : "normal";
  const build = (BUILD_STYLES as readonly string[]).includes(env.WORKFLOW_BUILD_STYLE ?? "")
    ? env.WORKFLOW_BUILD_STYLE as BuildStyle
    : "normal";
  return { speech, build };
}

export function formatStyleStatus(style: SessionStyle): string {
  const parts: string[] = [];
  if (style.speech === "caveman") parts.push("🪨");
  if (style.build !== "normal") parts.push(`pt·${style.build.replace("ponytail-", "")}`);
  return parts.join(" ");
}
