import type { Audience } from "./style/audience.js";
import type { StylePack } from "./style/pack.js";

/**
 * Deterministic checks on the mechanical rules. Catches the failures a model
 * reliably makes (missing source line, too-deep headings, a banned phrase,
 * a section with no illustration). Cheap and debuggable versus blind regen.
 */

export interface LintFinding {
  rule: string;
  line: number;
  message: string;
}

export interface LintResult {
  ok: boolean;
  findings: LintFinding[];
}

function lines(md: string): string[] {
  return md.split("\n");
}

/** A section is a run of lines from one H2 to the next. */
function sections(md: string): Array<{ title: string; startLine: number; body: string }> {
  const out: Array<{ title: string; startLine: number; body: string }> = [];
  const ls = lines(md);
  let cur: { title: string; startLine: number; body: string } | null = null;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]!;
    const h2 = l.match(/^##\s+(.*)$/);
    if (h2) {
      if (cur) out.push(cur);
      cur = { title: h2[1]!.trim(), startLine: i + 1, body: "" };
      continue;
    }
    if (cur) cur.body += l + "\n";
  }
  if (cur) out.push(cur);
  return out;
}

export function lint(md: string, pack: StylePack, audience: Audience = "mid"): LintResult {
  const findings: LintFinding[] = [];
  const ls = lines(md);

  // H1 title present.
  const h1 = ls.findIndex((l) => /^#\s+\S/.test(l));
  if (h1 < 0) findings.push({ rule: "h1", line: 1, message: "No H1 title found." });

  // Source line, when the pack requires it.
  if (pack.rules.requireSourceLine) {
    const hasSource = ls.some((l) => /^Source:\s*\S+/i.test(l.trim()));
    if (!hasSource) findings.push({ rule: "source-line", line: h1 + 2, message: "No `Source:` line found." });
  }

  // Heading depth cap.
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i]!.match(/^(#{1,6})\s+/);
    if (m && m[1]!.length > pack.rules.maxHeadingDepth) {
      findings.push({
        rule: "heading-depth",
        line: i + 1,
        message: `Heading depth ${m[1]!.length} exceeds max ${pack.rules.maxHeadingDepth}.`,
      });
    }
  }

  // Banned phrases.
  for (const phrase of pack.rules.bannedPhrases) {
    const lower = phrase.toLowerCase();
    for (let i = 0; i < ls.length; i++) {
      if (ls[i]!.toLowerCase().includes(lower)) {
        findings.push({ rule: "banned-phrase", line: i + 1, message: `Banned phrase: "${phrase}".` });
      }
    }
  }

  // Illustration policy per section, read from the pack.
  const ill = pack.illustration;
  const labelRe = new RegExp(`^(?:[-*]\\s+)?(${ill.labels.join("|")}):\\s*\\S`, "i");
  for (const sec of sections(md)) {
    const body = sec.body;
    const hasLabel = body.split("\n").some((l) => labelRe.test(l.trim()));
    const hasDiagram = /```text[\s\S]*?```/.test(body);
    const hasWoven = ill.render === "woven" && sec.body.length > 240;

    if (ill.idiom === "required" && !hasLabel) {
      findings.push({ rule: "illustration-required", line: sec.startLine, message: `Section "${sec.title}" has no labeled illustration.` });
    }
    if (ill.diagram === "required" && !hasDiagram) {
      findings.push({ rule: "diagram-required", line: sec.startLine, message: `Section "${sec.title}" has no \`\`\`text diagram.` });
    }
    if (pack.rules.requireDiagramPerSection && !hasDiagram && !hasWoven) {
      findings.push({ rule: "diagram-per-section", line: sec.startLine, message: `Section "${sec.title}" has no diagram.` });
    }

    // Audience checks. Junior notes must define terms and carry a Background line.
    if (audience === "junior") {
      const hasBackground = /^[-*]?\s*Background:/im.test(body);
      if (!hasBackground) {
        findings.push({ rule: "audience-junior-background", line: sec.startLine, message: `Junior style: section "${sec.title}" has no \`Background:\` line.` });
      }
      const definesTerm = /[A-Za-z][A-Za-z0-9 ]{1,40} = [A-Za-z]/.test(body) || /^[-*]?\s*\*\*[^*]+\*\*\s*[—-]/.test(body);
      if (!definesTerm) {
        findings.push({ rule: "audience-junior-define", line: sec.startLine, message: `Junior style: section "${sec.title}" defines no term.` });
      }
    }
  }

  return { ok: findings.length === 0, findings };
}

export function formatFindings(res: LintResult): string {
  if (res.ok) return "lint: ok";
  return res.findings.map((f) => `  ${f.line}: [${f.rule}] ${f.message}`).join("\n");
}
