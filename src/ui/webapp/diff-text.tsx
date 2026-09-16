/**
 * Unified-diff rendering shared by the git rail and tool output cards. Line
 * classification is presentational only — the server owns diff content, and
 * non-diff text renders through the caller's ordinary <pre> path.
 */
export function looksLikeDiff(text: string): boolean {
  if (text.length === 0) return false;
  let markers = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("diff --git")) markers += 2;
    else if (/^[+-]/.test(line)) markers += 1;
  }
  return markers >= 3;
}

function diffLineClass(line: string): string {
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