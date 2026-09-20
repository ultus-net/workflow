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

/* --- OpenCode-style edit diff -------------------------------------------------
 * An edit tool call carries the file path and the change. We prefer the
 * agent's unified patch (real file line numbers) and fall back to a small LCS
 * over the before/after strings when only the input is known. This mirrors the
 * OpenCode TUI's edit block: a header (Edit <path> +N -N) over a line-numbered
 * two-column code view with red/green rows. */

interface EditRow {
  readonly oldNo?: number;
  readonly newNo?: number;
  /** "@" hunk separator; "+"/"-"/" " for added/removed/context. */
  readonly sign: "@" | "+" | "-" | " ";
  readonly text: string;
}

export interface EditToolData {
  readonly path?: string;
  readonly patch?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly before?: string;
  readonly after?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const asString = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 ? value : undefined;
const asNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const parseJson = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** Extracts the file path, unified patch, stats, and before/after strings from
 * an edit tool's rawInput/rawOutput (both JSON strings, best-effort). */
export function parseEditTool(rawInput: string | undefined, rawOutput: string | undefined): EditToolData | undefined {
  const input = asRecord(parseJson(rawInput));
  const output = asRecord(parseJson(rawOutput));
  const metadata = asRecord(output?.["metadata"]);
  const filediff = asRecord(metadata?.["filediff"]);
  const path = asString(input?.["filePath"]) ?? asString(input?.["path"])
    ?? asString(filediff?.["file"]) ?? asString(metadata?.["file"]);
  const patch = asString(filediff?.["patch"]) ?? asString(metadata?.["diff"]);
  const additions = asNumber(filediff?.["additions"]);
  const deletions = asNumber(filediff?.["deletions"]);
  const before = asString(input?.["oldString"]) ?? asString(input?.["old_text"]);
  const after = asString(input?.["newString"]) ?? asString(input?.["new_text"]);
  if (path === undefined && patch === undefined && before === undefined && after === undefined) return undefined;
  return {
    ...(path === undefined ? {} : { path }),
    ...(patch === undefined ? {} : { patch }),
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

/** Rows from a unified patch, tracking real old/new file line numbers. */
function rowsFromPatch(patch: string): EditRow[] {
  const rows: EditRow[] = [];
  const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let oldNo = 0;
  let newNo = 0;
  // File headers only precede the first hunk: inside a hunk, a deleted line
  // whose payload starts with "--" renders as "---…" and must stay content.
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const match = hunk.exec(line);
      if (match !== null) {
        oldNo = Number(match[1]);
        newNo = Number(match[2]);
      }
      inHunk = true;
      rows.push({ sign: "@", text: line });
    } else if (!inHunk && (
      line.startsWith("diff --git") || line.startsWith("index ") ||
      line.startsWith("---") || line.startsWith("+++ ") ||
      line.startsWith("new file") || line.startsWith("deleted file")
    )) {
      // File headers are not code; the EditDiff header carries the path.
    } else if (line.startsWith("+")) {
      rows.push({ newNo, sign: "+", text: line.slice(1) });
      newNo += 1;
    } else if (line.startsWith("-")) {
      rows.push({ oldNo, sign: "-", text: line.slice(1) });
      oldNo += 1;
    } else if (line.startsWith(" ")) {
      rows.push({ oldNo, newNo, sign: " ", text: line.slice(1) });
      oldNo += 1;
      newNo += 1;
    }
  }
  return rows;
}

/** Bounded LCS line diff for the input-only case (before/after strings). */
function rowsFromContents(before: string, after: string): EditRow[] {
  const a = before.length === 0 ? [] : before.split("\n");
  const b = after.length === 0 ? [] : after.split("\n");
  const MAX = 800;
  if (a.length > MAX || b.length > MAX) {
    return [
      ...a.map((text, index) => ({ oldNo: index + 1, sign: "-" as const, text })),
      ...b.map((text, index) => ({ newNo: index + 1, sign: "+" as const, text })),
    ];
  }
  const width = b.length + 1;
  const dp = new Int32Array((a.length + 1) * width);
  const at = (i: number, j: number): number => dp[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const rows: EditRow[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ oldNo, newNo, sign: " ", text: a[i] ?? "" });
      i += 1;
      j += 1;
      oldNo += 1;
      newNo += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      rows.push({ oldNo, sign: "-", text: a[i] ?? "" });
      i += 1;
      oldNo += 1;
    } else {
      rows.push({ newNo, sign: "+", text: b[j] ?? "" });
      j += 1;
      newNo += 1;
    }
  }
  while (i < a.length) { rows.push({ oldNo, sign: "-", text: a[i] ?? "" }); i += 1; oldNo += 1; }
  while (j < b.length) { rows.push({ newNo, sign: "+", text: b[j] ?? "" }); j += 1; newNo += 1; }
  return rows;
}

const rowClass = (sign: EditRow["sign"]): string =>
  sign === "+" ? "edit-diff-add" : sign === "-" ? "edit-diff-del" : sign === "@" ? "edit-diff-hunk" : "edit-diff-ctx";

/** OpenCode-style edit block: header + numbered two-column code view. */
export function EditDiff({ data }: { readonly data: EditToolData }) {
  const rows = data.patch !== undefined
    ? rowsFromPatch(data.patch)
    : rowsFromContents(data.before ?? "", data.after ?? "");
  const additions = data.additions ?? rows.filter((row) => row.sign === "+").length;
  const deletions = data.deletions ?? rows.filter((row) => row.sign === "-").length;
  return (
    <div className="edit-diff">
      <div className="edit-diff-head">
        {data.path !== undefined && <code className="edit-diff-path" title={data.path}>{data.path}</code>}
        <span className="edit-diff-stats" aria-label={`${additions} additions, ${deletions} deletions`}>
          <span className="edit-diff-add-stat">+{additions}</span>
          <span className="edit-diff-del-stat">-{deletions}</span>
        </span>
      </div>
      <div className="edit-diff-body">
        {rows.length === 0
          ? <p className="muted edit-diff-empty">no textual changes</p>
          : rows.map((row, index) => (
            <div className={`edit-diff-row ${rowClass(row.sign)}`} key={index}>
              <span className="edit-diff-ln" aria-hidden="true">{row.oldNo ?? ""}</span>
              <span className="edit-diff-ln" aria-hidden="true">{row.newNo ?? ""}</span>
              <span className="edit-diff-sign" aria-hidden="true">{row.sign === "@" ? "" : row.sign}</span>
              <code className="edit-diff-code">{row.text || " "}</code>
            </div>
          ))}
      </div>
    </div>
  );
}
