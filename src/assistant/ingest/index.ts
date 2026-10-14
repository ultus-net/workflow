import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import {
  SourceBundleSchema,
  type Attachment,
  type Lang,
  type SourceBundle,
  type SourceBlock,
} from "../model/source.js";

/**
 * Ingest adapters. Each one returns the same SourceBundle. The model never
 * learns whether the text came from a video, a page, or a PDF, so the prompt
 * stays stable as adapters are added.
 */

export interface IngestOptions {
  lang: Lang;
  /** Optional title override for stdin and file sources. */
  title?: string;
  /** Second language for the source, when the source is bilingual. */
  fetchImpl?: typeof fetch;
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

const MIN_BLOCK = 24;

/** Split plain text into paragraph blocks by blank lines, tracking offsets. */
export function blocksFromText(text: string): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  const re = /\S[^\n]*(?:\n(?!\s*\n)[^\n]*)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (raw.trim().length < MIN_BLOCK) continue;
    const isHeading = raw.length < 80 && !raw.trimEnd().endsWith(".") && !raw.includes("\n");
    blocks.push({
      id: newId("blk"),
      kind: isHeading ? "heading" : "paragraph",
      start: m.index,
      end: m.index + raw.length,
      text: raw.trim(),
    });
  }
  return blocks;
}

export function ingestStdin(raw: string, opts: IngestOptions): SourceBundle {
  const text = raw.replace(/\r\n/g, "\n").trim();
  return SourceBundleSchema.parse({
    id: newId("src"),
    kind: "stdin",
    title: opts.title ?? "stdin",
    lang: opts.lang,
    text,
    blocks: blocksFromText(text),
    attachments: [],
    meta: {},
  });
}

export function ingestFile(path: string, opts: IngestOptions): SourceBundle {
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") return ingestPdf(path, opts);
  const raw = readFileSync(path, "utf8");
  const text = raw.replace(/\r\n/g, "\n").trim();
  return SourceBundleSchema.parse({
    id: newId("src"),
    kind: "file",
    title: opts.title ?? basename(path, ext),
    uri: path,
    lang: opts.lang,
    text,
    blocks: blocksFromText(text),
    attachments: [],
    meta: { ext },
  });
}

/** A PDF is carried as a native `file` part, not pre-parsed. */
function ingestPdf(path: string, opts: IngestOptions): SourceBundle {
  const attachment: Attachment = {
    id: newId("att"),
    kind: "pdf",
    mime: "application/pdf",
    path,
  };
  return SourceBundleSchema.parse({
    id: newId("src"),
    kind: "pdf",
    title: opts.title ?? basename(path, ".pdf"),
    uri: path,
    lang: opts.lang,
    text: "",
    blocks: [],
    attachments: [attachment],
    meta: {},
  });
}

export function ingestImage(path: string, opts: IngestOptions): SourceBundle {
  const ext = extname(path).toLowerCase().replace(".", "");
  const mime = ext === "jpg" ? "image/jpeg" : `image/${ext || "png"}`;
  const attachment: Attachment = { id: newId("att"), kind: "image", mime, path };
  return SourceBundleSchema.parse({
    id: newId("src"),
    kind: "image",
    title: opts.title ?? basename(path),
    uri: path,
    lang: opts.lang,
    text: "",
    blocks: [],
    attachments: [attachment],
    meta: {},
  });
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** Route a filesystem path to the right adapter. */
export function ingestPath(path: string, opts: IngestOptions): SourceBundle {
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXT.has(ext)) return ingestImage(path, opts);
  return ingestFile(path, opts);
}

export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}
