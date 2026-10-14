import { z } from "zod";

/**
 * The normalized source model. Every ingest adapter returns one of these.
 * The rest of the pipeline only ever sees a SourceBundle, so the prompt stays
 * stable no matter where the text came from.
 */

export const LangSchema = z.enum(["en", "zh-Hans"]).describe("BCP-47-ish language tag");
export type Lang = z.infer<typeof LangSchema>;

export const SourceKindSchema = z.enum([
  "youtube",
  "url",
  "file",
  "pdf",
  "epub",
  "image",
  "stdin",
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/** A contiguous run of source text with a locator back into the original. */
export const SourceBlockSchema = z.object({
  id: z.string(),
  kind: z.enum(["heading", "paragraph", "transcript", "caption"]),
  /** Heading text, chapter title, or speaker label where known. */
  label: z.string().optional(),
  /** Character offsets into SourceBundle.text. */
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string(),
  /** Seconds into the source, where the source is time-based. */
  timestamp: z.number().nonnegative().optional(),
  /** Page number, where the source is paginated. */
  page: z.number().int().nonnegative().optional(),
});
export type SourceBlock = z.infer<typeof SourceBlockSchema>;

/** An image or PDF carried alongside the text and sent as a native part. */
export const AttachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "pdf"]),
  mime: z.string(),
  /** Exactly one of url or path is set. Path is read and base64-encoded at send time. */
  url: z.string().url().optional(),
  path: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const SourceBundleSchema = z.object({
  id: z.string(),
  kind: SourceKindSchema,
  title: z.string(),
  uri: z.string().optional(),
  lang: LangSchema,
  /** ISO date of the source, not of the ingest. */
  date: z.string().optional(),
  /** Source duration in seconds, where time-based. */
  duration: z.number().nonnegative().optional(),
  /** Full normalized text. Blocks carry offsets into this string. */
  text: z.string(),
  blocks: z.array(SourceBlockSchema),
  attachments: z.array(AttachmentSchema).default([]),
  /** Free-form, adapter-specific facts (channel, author, page count). */
  meta: z.record(z.unknown()).default({}),
});
export type SourceBundle = z.infer<typeof SourceBundleSchema>;

export function emptyBundle(partial: Partial<SourceBundle> & { title: string; lang: Lang }): SourceBundle {
  return SourceBundleSchema.parse({
    id: `src_${Math.random().toString(36).slice(2, 10)}`,
    kind: "stdin",
    text: "",
    blocks: [],
    attachments: [],
    meta: {},
    ...partial,
  });
}
