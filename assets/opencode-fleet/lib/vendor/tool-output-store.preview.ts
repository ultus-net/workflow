/**
 * tool-output-store.preview.ts — VENDORED, DO NOT EDIT.
 *
 * The pure preview math from opencode-src, copied verbatim so the n=12 ruler's
 * port (`install/lib/measure-tool-output.cjs`) is diff-testable without the host
 * checked out. Guarded by `install/lib/test-host-vendor.cjs`; re-vendor with
 * `install/lib/vendor-host-preview.cjs --src DIR --write`. The region between the
 * sentinels must stay byte-identical to the host slice.
 *
 *   repo:  opencode-src
 *   rev:   3dd1b3053979971d8eb03ef37b29de07b892d95c
 *   path:  packages/core/src/tool-output-store.ts
 *   file:  sha256 3eea248408c62f7ce4c56433dabdbabf8507095dda812b41a1e1168b713536b2
 *   region: lines 13-14,50-110  sha256 2fc8b6788bf64bc6bf71604bd6364f7ef2c14d53f6bf937cd2148f6853f29bdf
 *   license: MIT (c) 2025 opencode — see LICENSE-opencode-src
 *
 * Node >=22 strips the TypeScript types at load time, so this is runnable as-is;
 * if type-stripping is unavailable the import throws, which the fixture catches.
 */

// >>> VENDORED REGION (verbatim)
export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024

const takePrefix = (input: string, maximumBytes: number) => {
  let bytes = 0
  let content = ""
  for (const char of input) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content += char
    bytes += size
  }
  return content
}

const takeSuffix = (input: string, maximumBytes: number) => {
  let bytes = 0
  const content: string[] = []
  for (const char of Array.from(input).toReversed()) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content.unshift(char)
    bytes += size
  }
  return content.join("")
}

const preview = (text: string, maxLines: number, maxBytes: number) => {
  const lines = text.split("\n")
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = Math.floor(maxLines / 2)
  const sampled =
    lines.length <= maxLines
      ? text
      : [
          lines.slice(0, headLines).join("\n"),
          ...(tailLines > 0 ? [lines.slice(lines.length - tailLines).join("\n")] : []),
        ].join("\n")
  if (Buffer.byteLength(sampled, "utf-8") <= maxBytes) {
    return lines.length <= maxLines
      ? { head: sampled, tail: "" }
      : {
          head: lines.slice(0, headLines).join("\n"),
          tail: tailLines > 0 ? lines.slice(lines.length - tailLines).join("\n") : "",
        }
  }
  const headBytes = Math.ceil(maxBytes / 2)
  const tailBytes = Math.floor(maxBytes / 2)
  return { head: takePrefix(sampled, headBytes), tail: takeSuffix(sampled, tailBytes) }
}

const boundedPreview = (text: string, marker: string, maxLines: number, maxBytes: number) => {
  const markerOnly = takePrefix(marker, maxBytes).split("\n").slice(0, maxLines).join("\n")
  const markerBytes = Buffer.byteLength(marker, "utf-8")
  if (maxLines <= 4 || maxBytes <= markerBytes + 4) return markerOnly
  const bounded = preview(text, maxLines - 4, maxBytes - markerBytes - 4)
  return bounded.tail ? `${bounded.head}\n\n${marker}\n\n${bounded.tail}` : `${bounded.head}\n\n${marker}`
}

const lineCount = (text: string) => {
  let count = 1
  for (const char of text) if (char === "\n") count++
  return count
}
// <<< VENDORED REGION

export { takePrefix, takeSuffix, preview, boundedPreview, lineCount }
