/**
 * Audience presets: the depth axis. This is orthogonal to `mode` (the shape
 * axis). mode fixes the document's structure; audience fixes how much is
 * explained and how terse it reads. A run is mode x audience.
 */

export const AudienceSchema = ["junior", "mid", "senior"] as const;
export type Audience = (typeof AudienceSchema)[number];

export function isAudience(v: string): v is Audience {
  return (AudienceSchema as readonly string[]).includes(v);
}

export interface AudiencePreset {
  id: Audience;
  label: string;
  /** One line for a picker. */
  blurb: string;
  /** Appended to the system prompt as the depth directive. */
  directive: string;
}

export const AUDIENCES: Record<Audience, AudiencePreset> = {
  junior: {
    id: "junior",
    label: "Junior",
    blurb: "Simplified breakdowns, fundamentals included",
    directive: [
      "Audience: a junior engineer or newcomer to the topic.",
      "Assume no prior knowledge of the domain's vocabulary.",
      "Define every term and acronym at first use, in the form TERM = definition.",
      "Add one `Background:` line per section that supplies the minimum context a newcomer needs.",
      "Prefer plain analogies over jargon. Prefer more, shorter bullets over dense ones.",
      "Explain the why, not just the what. Never assume a step is obvious.",
    ].join(" "),
  },
  mid: {
    id: "mid",
    label: "Mid",
    blurb: "Balanced: mechanism plus context",
    directive: [
      "Audience: an engineer who knows the fundamentals of the field.",
      "Define only terms that are non-obvious or specific to this source.",
      "Give the mechanism and the trade-off, without re-explaining basics.",
      "Keep bullets tight but complete. One illustrative example per section where it helps.",
    ].join(" "),
  },
  senior: {
    id: "senior",
    label: "Senior",
    blurb: "Terse, mechanism-first, no hand-holding",
    directive: [
      "Audience: a senior engineer in the field.",
      "Assume fluency. Do not define standard terms or explain prerequisites.",
      "Lead with the mechanism, the number, and the trade-off. Cut every sentence that only restates.",
      "Bullets are terse. Illustrations only where they add non-obvious intuition.",
    ].join(" "),
  },
};

export function audienceDirective(a: Audience): string {
  return AUDIENCES[a].directive;
}
