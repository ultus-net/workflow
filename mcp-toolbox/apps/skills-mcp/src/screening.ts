/**
 * Static screening for skill content (operator request 2026-09-15): skills
 * loaded from the web or copied in manually are untrusted input, so every
 * delivery path screens before content reaches the model.
 *
 * Honest scope: this is heuristic screening, not a sandbox. It catches the
 * loud markers of malicious skills (remote-code-execution pipelines,
 * credential harvesting, instruction hijacking, hidden-unicode obfuscation,
 * absurd size). A cleverly written benign-looking malicious skill can still
 * pass screening — prompts are never a security boundary, and the guard
 * dispatcher still gates every executed command at run time. Screening makes
 * bad skills noisy and denies delivery by default; it does not make
 * delivered skills trustworthy.
 */

export interface SkillScreening {
  readonly verdict: "clean" | "flagged";
  readonly findings: readonly string[];
}

/** Skills twice the delivery bound are truncated anyway and are suspect. */
const MAX_CLEAN_CONTENT_CHARS = 96_000;

const REMOTE_CODE_EXECUTION = [
  /(?:curl|wget|fetch)[^\n|;`]{0,400}\|\s*(?:ba|z|da|k)?sh\b/i,
  /(?:curl|wget|fetch)[^\n|;`]{0,400}\|\s*(?:ba|z|da)?sh\s+-s\b/i,
  /\b(?:curl|wget)[^\n|;`]{0,200}\|\s*(?:node|python3?|perl|ruby|eval)\b/i,
  /base64\s+(?:-d|--decode)[^\n|;]{0,200}\|\s*(?:ba|z|da)?sh\b/i,
];

const CREDENTIAL_HARVESTING = [
  /cat\s+[^\n]{0,80}\/\.ssh\/(?:id_rsa|id_ed25519|identity)/i,
  /cat\s+[^\n]{0,80}\/\.aws\/credentials/i,
  /cat\s+[^\n]{0,80}\/\.netrc/i,
  /(?:cat|printenv|env)\s+[^\n]{0,120}(?:\||>){1}?\s*(?:curl|wget|nc|netcat|POST)/i,
];

const INSTRUCTION_HIJACK = [
  /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|rules|prompts?)/i,
  /do\s+not\s+tell\s+the\s+(?:user|operator)/i,
  /without\s+the\s+(?:user'?s?|operator'?s?)\s+(?:knowledge|consent|approval)/i,
  /hide\s+this\s+(?:from\s+the\s+)?(?:user|operator|log)/i,
];

const EXFILTRATION = [
  /exfiltrat/i,
  /(?:upload|send|post)\s+(?:the\s+)?(?:contents?|files?|secrets?|tokens?|keys?|credentials?)\s+(?:of\s+)?[^\n]{0,120}(?:to|at)\s+(?:a|an|the|this)?\s*(?:url|endpoint|webhook|server|pastebin|gist|discord|telegram)/i,
];

/** Zero-width and bidi characters are prompt-injection obfuscation. */
const HIDDEN_UNICODE = /[\u200B-\u200D\u2060\uFEFF\u202A-\u202E]/;

const SCREENERS: readonly { readonly label: string; readonly patterns: readonly RegExp[] }[] = [
  { label: "remote-code-execution pipeline", patterns: REMOTE_CODE_EXECUTION },
  { label: "credential harvesting", patterns: CREDENTIAL_HARVESTING },
  { label: "instruction hijacking", patterns: INSTRUCTION_HIJACK },
  { label: "exfiltration instruction", patterns: EXFILTRATION },
];

export function screenSkillContent(content: string): SkillScreening {
  const findings: string[] = [];
  for (const screener of SCREENERS) {
    for (const pattern of screener.patterns) {
      if (pattern.test(content)) {
        findings.push(screener.label);
        break;
      }
    }
  }
  if (HIDDEN_UNICODE.test(content)) findings.push("hidden unicode (prompt-injection obfuscation)");
  if (content.length > MAX_CLEAN_CONTENT_CHARS) {
    findings.push(`oversized content (${content.length} chars; suspect)`);
  }
  return findings.length === 0 ? { verdict: "clean", findings: [] } : { verdict: "flagged", findings };
}