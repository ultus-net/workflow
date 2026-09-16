/**
 * Unified-diff rendering shared by the git rail and tool output cards. Line
 * classification is presentational only — the server owns diff content, and
 * non-diff text renders through the caller's ordinary <pre> path.
 */
export function looksLikeDiff(text: string): boolean {
  // A structural marker is required: +/- prefixes alone also occur in ordinary
  // content (markdown bullets, flag lists), and tinting those as deletions
  // would misreport file contents to the operator.
  if (text.length === 0) return false;
  const lines = text.split("\n");
  const hasMarker = lines.some((line) => line.startsWith("@@") || line.startsWith("diff --git"));
  if (!hasMarker) return false;
  return lines.some((line) => /^[+-]/.test(line));
}

/**
 * One-line classification. Prefix-based by necessity: a deleted line whose
 * content itself starts with `--` (SQL comments, `---` rules) reads as a file
 * header here — inherent to unified-diff text without hunk offsets, and only
 * a tinting nuance, never a content change.
 */
export function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "diff-hunk";
  if (
    line.startsWith("diff --git") || line.startsWith("index ") ||
    line.startsWith("+++") || line.startsWith("---") ||
    line.startsWith("new file") || line.startsWith("deleted file")
  ) {
    return "diff-meta";
  }
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "diff-ctx";
}

/** Renders a unified diff with add/remove/hunk coloring, one block line each. */
export function DiffText({ text }: { readonly text: string }) {
  return (
    <pre className="diff-text">
      {text.split("\n").map((line, index) => (
        <span className={diffLineClass(line)} key={index}>{line || " "}</span>
      ))}
    </pre>
  );
}
