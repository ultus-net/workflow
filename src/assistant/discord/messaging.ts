/**
 * Discord message chunking (pure). Design donor: `elizaos/plugin-discord`
 * (MIT) — the line-boundary split with a per-chunk limit is modeled on it.
 * This is an independent implementation, not a copy.
 *
 * Discord rejects a message body longer than `DISCORD_MESSAGE_LIMIT`
 * characters, so a reply is split on line boundaries into ordered chunks.
 */

/** Discord's hard per-message character ceiling. */
export const DISCORD_MESSAGE_LIMIT = 2000;

/** Drop a trailing run of blank lines so the seam carries no blank-line gap. */
function collapseTrailingBlank(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

/**
 * Split `text` into ordered chunks that each fit within `limit`.
 *
 * Lines are packed greedily. A line that alone exceeds `limit` is hard-split at
 * the limit. A chunk never starts with a blank line and a trailing run of blank
 * lines is collapsed at a chunk boundary, so a blank-line run straddling a
 * boundary is not duplicated into either neighbour. Empty or whitespace-only
 * input returns `[]`.
 */
export function chunkMessage(text: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  if (limit < 1) throw new Error(`chunkMessage limit must be >= 1, got ${limit}`);
  if (text.trim() === "") return [];

  const lines = text.split("\n");
  const chunks: string[] = [];
  // The pending chunk as lines, plus its joined length, kept in step so each
  // append is O(1) instead of re-joining the chunk on every line.
  let current: string[] = [];
  let currentLen = 0;

  const flush = (): void => {
    const kept = collapseTrailingBlank(current);
    if (kept.length > 0) chunks.push(kept.join("\n"));
    current = [];
    currentLen = 0;
  };

  const append = (line: string): void => {
    if (current.length === 0) {
      // A blank line at a chunk start is part of a boundary run: skip it.
      if (line === "") return;
      current = [line];
      currentLen = line.length;
      return;
    }
    const candidate = currentLen + 1 + line.length;
    if (candidate <= limit) {
      current.push(line);
      currentLen = candidate;
      return;
    }
    flush();
    if (line === "") return;
    current = [line];
    currentLen = line.length;
  };

  for (const line of lines) {
    if (line.length > limit) {
      flush();
      for (let i = 0; i < line.length; i += limit) {
        const piece = line.slice(i, i + limit);
        if (piece.length === limit) chunks.push(piece);
        else {
          // A short final piece stays pending so following lines can join it.
          current = [piece];
          currentLen = piece.length;
        }
      }
      continue;
    }
    append(line);
  }
  flush();
  return chunks;
}
