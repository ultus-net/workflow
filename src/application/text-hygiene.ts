/** W138: control-plane text hygiene — the named-class strip of hidden
 * Unicode at the prompt seat.
 *
 * Why: invisible characters carry prompt-injection pressure the operator
 * cannot see — bidi controls (U+202E and friends) REORDER the rendered
 * text so what the operator reads is not what the model reads; zero-width
 * separators and Unicode tag characters carry out-of-band payloads; C0/C1
 * controls smuggle protocol noise. THREAT_MODEL.md records the injection
 * pressure class as a residual (the reviewer/candidate lanes read
 * agent-authored text); this strip is the control-plane's first seat
 * against it, NOT a solve (recorded residuals below).
 *
 * The seat: every operator/authority prompt crosses
 * WorkflowCodingSession.submit (web channel, TUI, hub turn lanes, and the
 * reviewer lane through hub-run-gates), so one sanitize here covers every
 * surface. The web channel sanitizes BEFORE storing the transcript item so
 * the operator sees exactly what the agent receives.
 *
 * THE CLAIM IS PRECISE (named classes only):
 * - control: C0/C1 controls and DEL, EXCEPT tab (U+0009), newline (U+000A),
 *   and carriage return (U+000D) — protocol/state confusion carriers.
 * - bidi: U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069 — the
 *   reading-order spoofing class.
 * - zero-width: U+200B (ZWSP), U+2060 (word joiner), U+FEFF (BOM/ZWNBSP) —
 *   invisible separators with NO joining semantics to preserve.
 * - tag: U+E0000-U+E007F — the Unicode tag characters (an out-of-band
 *   data channel inside otherwise-visible text).
 * - noncharacter: U+FDD0-U+FDEF and every plane's xxFFFE/xxFFFF — never
 *   legitimate in interchange.
 *
 * PRESERVED ON PURPOSE (the honest boundary — recorded residuals):
 * - U+200C (ZWNJ) and U+200D (ZWJ): joining semantics — Arabic/Persian
 *   shaping and emoji ZWJ sequences (👨‍👩‍👧) break without them.
 * - Variation selectors U+FE00-FE0F and U+E0100-U+E01EF: presentation
 *   selectors for adjacent visible characters (VS16 forces emoji style).
 *   They CAN smuggle low-bandwidth data — a strict mode could strip them;
 *   queued, not assumed.
 * - Every other character: the strip is a NAMED-CLASS denylist, not an
 *   "anything invisible" oracle — an unlisted future glyph passes. The
 *   denylist stays auditable; the allowlist alternative would mangle
 *   legitimate scripts wholesale.
 *
 * Purity: deterministic, allocation-local, no IO — safe for the kernel
 * purity rule if the kernel ever needs it, and idempotent (sanitizing
 * sanitized text strips nothing). */

export type HiddenTextKind =
  | "control"
  | "bidi"
  | "zero-width"
  | "tag"
  | "noncharacter";

export interface HiddenTextHit {
  readonly kind: HiddenTextKind;
  readonly codePoint: number;
}

export interface SanitizedText {
  readonly text: string;
  readonly stripped: readonly HiddenTextHit[];
}

const BIDI_CODE_POINTS: readonly number[] = [
  0x061c, // ARABIC LETTER MARK
  0x200e, // LEFT-TO-RIGHT MARK
  0x200f, // RIGHT-TO-LEFT MARK
  ...range(0x202a, 0x202e), // LRE RLE PDF LRO RLO
  ...range(0x2066, 0x2069), // LRI RLI FSI PDI
];

const ZERO_WIDTH_CODE_POINTS: readonly number[] = [
  0x200b, // ZERO WIDTH SPACE
  0x2060, // WORD JOINER
  0xfeff, // ZERO WIDTH NO-BREAK SPACE (BOM mid-text)
];

function range(fromInclusive: number, toInclusive: number): number[] {
  const out: number[] = [];
  for (let cp = fromInclusive; cp <= toInclusive; cp += 1) out.push(cp);
  return out;
}

const BIDI = new Set(BIDI_CODE_POINTS);
const ZERO_WIDTH = new Set(ZERO_WIDTH_CODE_POINTS);

function classify(cp: number): HiddenTextKind | undefined {
  if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return "control";
  if (cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return "control";
  if (BIDI.has(cp)) return "bidi";
  if (ZERO_WIDTH.has(cp)) return "zero-width";
  if (cp >= 0xe0000 && cp <= 0xe007f) return "tag";
  if ((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xffff) === 0xfffe || (cp & 0xffff) === 0xffff) {
    return "noncharacter";
  }
  return undefined;
}

/** Strips the named hidden classes; returns the clean text and EVERY hit
 * (kind + code point) so callers can surface the strip instead of
 * silently mutating content. Idempotent by construction. */
export function sanitizeControlPlaneText(text: string): SanitizedText {
  let clean = "";
  const stripped: HiddenTextHit[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const kind = classify(cp);
    if (kind === undefined) {
      clean += ch;
      continue;
    }
    stripped.push({ kind, codePoint: cp });
  }
  return { text: clean, stripped };
}